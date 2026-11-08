import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import {
	appendFile,
	constants,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import http from "node:http";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	type Action,
	actionSchema,
	type BootSpec,
	replySchema,
	statusSchema,
} from "./contracts.ts";
import { alive, groupMembers, identityOf, identitySchema, type ProcessIdentity, publishIdentity, readIdentity } from "./identity.ts";
import { directory, instanceFiles, isTombstone, kinds, scratchDirectory, stagingDirectory, stateFiles, tombstoneDirectory } from "./instance-layout.ts";
import {
	existsError,
	privateDirectory,
	readLogTail,
	readRecord,
} from "./storage.ts";
import { reapGroup, signalGroup } from "../process-group.ts";
import { saveJson } from "../json-file.ts";

/** sun_path holds 104 bytes on macOS and 108 on Linux, including the terminating NUL. The shorter rules. */
export const socketPathLimit = 104;
function request(
	dir: string,
	action: Action,
	signal?: AbortSignal,
): Promise<unknown> {
	return new Promise((accept, reject) => {
		const req = http.request(
			{
				socketPath: instanceFiles(dir).socket,
				// A stopping controller stops listening, but a connection with a request in flight stays open. Pooled,
				// it would reach the stopped controller after its socket is gone and keep it, and its controller.pid, alive.
				agent: false,
				method: "POST",
				path: "/",
				signal: signal ?? AbortSignal.timeout(180000),
				headers: { "content-type": "application/json" },
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
					if (body.length > 2097152)
						req.destroy(new Error("Sandbox response exceeds 2 MiB"));
				});
				res.on("error", reject);
				res.on("end", () => {
					try {
						const reply = replySchema.parse(JSON.parse(body));
						if (!reply.ok) reject(new Error(reply.error));
						else accept(reply.result);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(action));
	});
}
/** What no controller answered, since none listens on the socket: the request reached nothing, so falling back is safe. */
const absent = Symbol("no controller");
async function send(
	dir: string,
	action: Action,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		return await request(dir, action, signal);
	} catch (error) {
		if (existsError(error, "ENOENT") || existsError(error, "ECONNREFUSED"))
			return absent;
		throw error;
	}
}
/** An inspect that asks only whether a controller is up, so it waits at most 1 s. */
const liveness = (dir: string, name: string, signal?: AbortSignal) =>
	send(
		dir,
		{ action: "inspect", name },
		signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000),
	);
/** Each state root this process found private. A failed check is dropped, so the next call checks again. */
const privateRoots = new Map<string, Promise<void>>();
function privateRoot(root: string): Promise<void> {
	let checked = privateRoots.get(root);
	if (checked === undefined) {
		checked = privateDirectory(root);
		privateRoots.set(root, checked);
		checked.catch(() => privateRoots.delete(root));
	}
	return checked;
}
const controllerAlive = (dir: string) => published(instanceFiles(dir).pid);
/** A client that holds the launch lock is still to start the controller, or waits for it to come up. */
const launching = (dir: string) => published(join(instanceFiles(dir).launchLock, "owner"));
/**
 * Takes a lock directory with this process's identity already in it, so no one finds it without an owner. A rename
 * replaces only an empty directory, which is all a taker that died before publishing its identity left. Returns the
 * empty directory its release renames the lock onto, made now so a release needs no new space and named in the lock so
 * the recovery of a dead owner's lock reuses it, or null when another process holds the lock.
 */
async function takeLock(lock: string): Promise<string | null> {
	const release = await mkdtemp(`${lock}-`);
	let aside: string | undefined;
	try {
		aside = await mkdtemp(`${lock}-`);
		await publishIdentity(join(aside, "owner"));
		await writeFile(join(aside, "release"), basename(release), { mode: 0o600 });
		await rename(aside, lock);
		return release;
	} catch (error) {
		await rm(release, { recursive: true, force: true });
		if (aside !== undefined) await rm(aside, { recursive: true, force: true });
		if (existsError(error, "ENOTEMPTY") || existsError(error, "EEXIST")) return null;
		throw error;
	}
}
/**
 * Renamed onto the empty directory made for it in one step, because a removal in place passes through the empty
 * directory takeLock would take. A rename onto an existing name needs no new space, so a full disk keeps no lock.
 */
async function releaseLock(lock: string, release: string): Promise<void> {
	try {
		await rename(lock, release);
	} catch (error) {
		if (!existsError(error, "ENOENT")) throw error;
	}
	await rm(release, { recursive: true, force: true });
}
/** Whether `name` is one that mkdtemp(`${lock}-`) makes. */
function reservedName(lock: string, name: string): boolean {
	const prefix = `${basename(lock)}-`;
	return name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length));
}
/**
 * Whether the lock's owner died. A launch killed while it wrote its owner in the lock, as launches did before takes
 * published it aside, left only the owner's temporary file. The same owner names the lock in the same text.
 */
async function abandoned(lock: string): Promise<boolean> {
	const read = () => readFile(join(lock, "owner"), "utf8").catch((error: unknown) =>
		existsError(error, "ENOENT") ? null : Promise.reject(error));
	const text = await read();
	if (text === null) {
		const names = await readdir(lock).catch((error: unknown) =>
			// Released since.
			existsError(error, "ENOENT") ? null : Promise.reject(error));
		if (names === null) return false;
		if (!names.includes("owner") && names.some((name) => /^owner\.\d+\.\d+\.tmp$/.test(name))) return true;
		throw new Error("Sandbox start ownership is unavailable. Read controller logs before retrying");
	}
	// An owner is renamed in whole, so only a power loss leaves one unreadable, and its process died with the host.
	let owner: ProcessIdentity | null = null;
	try {
		owner = identitySchema.parse(JSON.parse(text));
	} catch {}
	if (owner !== null && (await alive(owner))) return false;
	// It may have released the lock to a live owner before it died, so only a lock that still names it is abandoned.
	return (await read()) === text;
}
/**
 * takeLock, or the recovery of a lock whose owner died. A recovery holds the next level's lock beside it,
 * `${base}.recovery1` for the base lock, `${base}.recovery2` for that one and so on, taken and recovered the same way,
 * so one process at a time moves a dead owner's lock aside, and one killed while it held a recovery leaves a dead owner
 * there in turn. Only a recovery moves a dead owner's lock, so what it reads in that lock stays that lock's until it
 * moves it. Beside, not inside, because a lock that moves would take a recovery still held with it, and the recovery's
 * paths would then lead into whichever lock replaced it. `check` throws why a lock whose owner died must still be kept.
 * Returns null when a live process holds the lock or its recovery.
 */
async function holdLock(base: string, check = async () => {}, level = 0): Promise<string | null> {
	const lock = level === 0 ? base : `${base}.recovery${level}`;
	const release = await takeLock(lock);
	if (release !== null) return release;
	const recovering = await holdLock(base, undefined, level + 1);
	if (recovering === null) return null;
	try {
		if (!(await abandoned(lock))) return null;
		await check();
		// A power loss can leave the name empty or cut short, since nothing is synced.
		const name = await readFile(join(lock, "release"), "utf8").catch((error: unknown) =>
			existsError(error, "ENOENT") ? "" : Promise.reject(error));
		await releaseLock(lock, reservedName(lock, name) ? join(dirname(lock), name) : await mkdtemp(`${lock}-`));
		return await takeLock(lock);
	} finally {
		await releaseLock(`${base}.recovery${level + 1}`, recovering);
	}
}
/** A missing identity file means the process has not published itself yet, or is gone. */
async function published(file: string): Promise<boolean> {
	const identity = await readIdentity(file);
	return identity !== null && (await alive(identity));
}
/**
 * Short, because the instance directory's path would push Gondolin's socket paths past their limit. It lives as long as
 * the controller of `dir`: a launch makes it, and the controller removes it before it gives up its controller.pid.
 */
/** How long a scratch directory no controller owns is kept, measured from the last entry made or removed in it. */
export const scratchSweepAgeMs = 60 * 60_000;
/**
 * Removes the scratch directories older than scratchSweepAgeMs that no running controller owns: those a controller
 * killed outright left, and those of instances destroyed or controllers stopped before a controller removed its own.
 * It holds an instance's launch lock while it checks and removes that instance's directory, so no launch remakes the
 * directory in between. Holding each instance's lock, with a scratch directory or not, it also removes the directories
 * that takes killed partway left beside the lock. A directory it cannot check or remove is logged and kept. Returns the
 * scratch names it removed.
 */
export async function sweepScratch(root: string, now = Date.now()): Promise<string[]> {
	const names = async (path: string) => {
		try {
			return await readdir(path);
		} catch (error) {
			if (existsError(error, "ENOENT")) return [];
			throw error;
		}
	};
	const owners = new Map<string, string>();
	for (const kind of kinds)
		for (const name of await names(stateFiles(root).kind(kind))) {
			const dir = directory(root, kind, name);
			owners.set(scratchDirectory(root, dir), dir);
		}
	const old = async (path: string) => {
		const modified = await stat(path).then((s) => s.mtimeMs, (error: unknown) => {
			if (existsError(error, "ENOENT")) return null;
			throw error;
		});
		return modified !== null && now - modified >= scratchSweepAgeMs;
	};
	/** Holds the instance's launch lock while `held` runs, and removes what takes killed partway left beside it. */
	const holding = async (owner: string, held: () => Promise<boolean>) => {
		const lock = instanceFiles(owner).launchLock;
		const release = await takeLock(lock).catch((error: unknown) => {
			// Its instance is gone.
			if (existsError(error, "ENOENT")) return null;
			throw error;
		});
		// A launch holds it, or one that died left it, which the next launch recovers.
		if (release === null) return false;
		try {
			const names = await readdir(owner);
			const reserved = new Set([basename(release)]);
			for (const name of names)
				if (/^launch\.lock\.recovery\d+$/.test(name))
					reserved.add(await readFile(join(owner, name, "release"), "utf8").catch(() => ""));
			// Only a take stalled as long could still be using one. Moved away before it is removed, because a removal in
			// place empties it first, and a stalled take could rename the empty one onto a lock and hold it without an owner.
			for (const leaked of names)
				if (/^launch\.lock(?:\.recovery\d+)?-[A-Za-z0-9]{6}$/.test(leaked) && !reserved.has(leaked) && (await old(join(owner, leaked)))) {
					const trash = await mkdtemp(join(owner, "launch.lock.trash-"));
					await rename(join(owner, leaked), trash).catch((error: unknown) => {
						if (!existsError(error, "ENOENT")) throw error;
					});
					await rm(trash, { recursive: true, force: true });
				} else if (/^launch\.lock\.trash-[A-Za-z0-9]{6}$/.test(leaked)) await rm(join(owner, leaked), { recursive: true, force: true });
			return await held();
		} finally {
			await releaseLock(lock, release);
		}
	};
	const sweep = async (name: string) => {
		const path = join(stateFiles(root).scratch, name);
		const owner = owners.get(path);
		if (owner === undefined) {
			if (!(await old(path))) return false;
			await rm(path, { recursive: true, force: true });
			return true;
		}
		owners.delete(path);
		return holding(owner, async () => {
			if (await controllerAlive(owner) || !(await old(path))) return false;
			await rm(path, { recursive: true, force: true });
			return true;
		});
	};
	const swept: string[] = [];
	for (const name of await names(stateFiles(root).scratch))
		try {
			if (await sweep(name)) swept.push(name);
		} catch (error) {
			// One unreadable controller.pid, or a full disk refusing the lock, keeps only that directory.
			console.error(`scratch sweep kept ${name}:`, error);
		}
	for (const owner of owners.values())
		try {
			await holding(owner, async () => false);
		} catch (error) {
			console.error(`scratch sweep kept what takes left beside the launch lock of ${owner}:`, error);
		}
	return swept;
}
/**
 * An instance whose controller already runs keeps the spec it booted with. Returns the controller's inspection once it
 * runs, with any startupError its setup or services left.
 */
async function launch(
	root: string,
	dir: string,
	name: string,
	spec: BootSpec,
	signal?: AbortSignal,
): Promise<unknown> {
	signal?.throwIfAborted();
	if (existsSync(instanceFiles(dir).retryStop)) throw new Error("Retry stop is unfinished; finish it before starting the sandbox");
	const running = await liveness(dir, name, signal);
	if (running !== absent) return running;
	if (await controllerAlive(dir))
		throw new Error(
			"Sandbox controller is still starting or unavailable. Read controller logs before retrying",
		);
	if (Buffer.byteLength(instanceFiles(dir).socket) >= socketPathLimit)
		throw new Error(
			`Sandbox state path ${dir} is too long for a local control socket. Choose a shorter state root`,
		);
	const daemonPath = fileURLToPath(new URL("./daemon.ts", import.meta.url));
	if (!existsSync(daemonPath))
		throw new Error(
			`Sandbox controller ${daemonPath} is missing`,
		);
	const lock = instanceFiles(dir).launchLock;
	const release = await holdLock(lock, async () => {
		if (await controllerAlive(dir))
			throw new Error(
				"Sandbox controller is still starting. Retry inspect shortly",
			);
	});
	if (release === null)
		throw new Error(
			"Sandbox start or recovery is already in progress. Retry inspect shortly",
		);
	try {
		if (existsSync(instanceFiles(dir).retryStop)) throw new Error("Retry stop is unfinished; finish it before starting the sandbox");
		// The boot's resources, so the node counts what a VM still coming up holds.
		await saveJson(instanceFiles(dir).status, { state: "starting", name, resources: spec.resources });
		await rm(instanceFiles(dir).socket, { force: true });
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["PATH", "HOME", "XDG_CACHE_HOME", "GONDOLIN_DEBUG"])
			if (process.env[key]) env[key] = process.env[key];
		// Gondolin puts the running disk's overlay and its sockets in the temporary directory. The system one is
		// often a tmpfs, where every byte a pylon writes to its disk would take host memory until the next pause.
		// No controller runs here now, so whatever a crashed one left in it is garbage.
		env.TMPDIR = scratchDirectory(root, dir);
		await rm(env.TMPDIR, { recursive: true, force: true });
		await privateDirectory(env.TMPDIR);
		const fd = openSync(instanceFiles(dir).log, "a", 0o600);
		// The spec carries secret values, so it goes over a pipe and never through the environment or a file.
		const child = spawn(process.execPath, [daemonPath, dir], {
			detached: true,
			stdio: ["pipe", fd, fd],
			env,
		});
		closeSync(fd);
		let failure: Error | undefined;
		child.on("error", (error) => {
			failure = error;
		});
		child.stdin!.on("error", (error) => {
			failure = error;
		});
		child.stdin!.end(JSON.stringify(spec));
		child.on("exit", (code) => {
			failure = new Error(
				`Sandbox controller exited (${code}). Inspect controller logs before retrying`,
			);
		});
		child.unref();
		for (let attempt = 0; attempt < 6000; attempt++) {
			await delay(250, undefined, { signal });
			const status = statusSchema.parse(
				JSON.parse(await readFile(instanceFiles(dir).status, "utf8")),
			);
			if (status.state === "prepared") return offline(dir);
			if (status.state === "failed" || failure)
				throw (
					failure ??
					new Error(
						"Sandbox start failed. Read controller logs before retrying start",
					)
				);
			const inspection = await liveness(dir, name, signal);
			if (inspection !== absent) return inspection;
		}
		throw new Error(
			"Sandbox start has not completed. Use inspect or logs before retrying",
		);
	} finally {
		await releaseLock(lock, release);
	}
}
async function create(
	root: string,
	action: Extract<Action, { action: "create" | "prepare" }>,
	signal?: AbortSignal,
): Promise<unknown> {
	const kind = action.action === "prepare" ? "templates" : "instances";
	const dir = directory(root, kind, action.name);
	const disk = action.action === "create" ? action.disk : undefined;
	await privateDirectory(stateFiles(root).kind(kind));
	if (existsSync(dir))
		throw new Error(
			`${action.name} already exists. Use inspect or choose a new name`,
		);
	// Built aside and renamed in, so a crash never leaves an instance without its record and intent.
	const staging = stagingDirectory(root, kind, action.name);
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { mode: 0o700 });
	try {
		await saveJson(instanceFiles(staging).record, {
			version: 1,
			name: action.name,
			config: action.config,
			createdAt: new Date().toISOString(),
			labels: action.labels,
		});
		// A reflink where the filesystem has them, so a large template disk costs no copy.
		if (disk)
			await copyFile(disk, instanceFiles(staging).disk, constants.COPYFILE_FICLONE);
		await saveJson(instanceFiles(staging).intent, { prepare: kind === "templates" });
		await rename(staging, dir);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		if (existsError(error, "ENOTEMPTY") || existsError(error, "EEXIST"))
			throw new Error(
				`${action.name} already exists. Use inspect or choose a new name`,
			);
		throw error;
	}
	try {
		return await launch(root, dir, action.name, action.boot, signal);
	} catch (error) {
		if (signal?.aborted || action.action !== "prepare") throw error;
		const log = await readLogTail(instanceFiles(dir).log, 20);
		const output = log.output.slice(-4096);
		const detail =
			output ||
			(error instanceof Error
				? error.message
				: "No preparation output available");
		throw new Error(
			`Template ${action.name} preparation did not complete. Use list with kind templates to check its state. After its controller exits, destroy with kind templates, name ${action.name}, confirm ${action.name}, correct the YAML and prepare again. Preparation log${log.truncated || log.output.length > output.length ? " (earlier output omitted)" : ""}:\n${detail}`,
		);
	}
}
export async function run(
	root: string,
	input: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const action = actionSchema.parse(input);
	await privateRoot(root);
	if (action.action === "create" || action.action === "prepare")
		return create(root, action, signal);
	if (action.action === "list") {
		const base = stateFiles(root).kind(action.kind);
		let names: string[];
		try {
			names = await readdir(base);
		} catch (error) {
			if (existsError(error, "ENOENT")) return [];
			throw error;
		}
		// A tombstone is garbage whoever left it, and once its instance is gone no destroy of that name may follow.
		await Promise.all(
			names
				.filter(isTombstone)
				.map((name) => rm(join(base, name), { recursive: true, force: true })),
		);
		const found = await Promise.all(
			names
				.filter((name) => !name.startsWith("."))
				.sort()
				.map(async (name) => {
					const dir = directory(root, action.kind, name);
					try {
						return await request(
							dir,
							{ action: "inspect", name },
							AbortSignal.timeout(1500),
						);
					} catch {
						try {
							return await offline(dir);
						} catch (error) {
							// Destroyed since readdir: it is absent now.
							if (existsError(error, "ENOENT")) return null;
							throw error;
						}
					}
				}),
		);
		return found.filter((instance) => instance !== null);
	}
	const kind = action.action === "destroy" ? action.kind : "instances";
	const dir = directory(root, kind, action.name);
	if (action.action === "destroy") {
		if (action.confirm !== action.name)
			throw new Error("confirm must match name");
		// Renamed aside before removal, so a crash midway never leaves an instance without its record.
		const doomed = tombstoneDirectory(root, kind, action.name);
		if (existsSync(dir)) {
			await readRecord(dir);
			if ((await send(dir, action, signal)) === absent && (await controllerAlive(dir)))
				throw new Error(
					"Sandbox controller is still starting or unavailable. Read its logs and wait before destroying it",
				);
			await rm(doomed, { recursive: true, force: true });
			await rename(dir, doomed);
		}
		await rm(doomed, { recursive: true, force: true });
		await rm(scratchDirectory(root, dir), { recursive: true, force: true });
		await rm(stagingDirectory(root, kind, action.name), {
			recursive: true,
			force: true,
		});
		return { name: action.name, state: "destroyed" };
	}
	await readRecord(dir);
	if (action.action === "logs" && !action.service) {
		return {
			name: action.name,
			...(await readLogTail(instanceFiles(dir).log, action.lines)),
		};
	}
	if (action.action === "start")
		return launch(root, dir, action.name, action.boot, signal);
	const reply = await send(dir, action, signal);
	if (reply !== absent) return reply;
	if (action.action === "stop") return settle(dir);
	if (action.action === "inspect") return offline(dir);
	throw new Error(`${action.name} is not running. Use start first`);
}
/** Stop gets 30 s; group termination then gets 10 s before SIGKILL and 10 s to confirm exit. */
export async function stopForRetry(root: string, name: string, signal: AbortSignal): Promise<void> {
	await privateRoot(root);
	const dir = directory(root, "instances", name);
	await readRecord(dir);
	signal.throwIfAborted();
	const lock = instanceFiles(dir).launchLock;
	const release = await holdLock(lock);
	if (release === null) throw new Error("Sandbox start or recovery is already in progress. Retry stop shortly");
	const journal = instanceFiles(dir).retryStop;
	const log = (line: string) => appendFile(instanceFiles(dir).log, `${new Date().toISOString()} retry: ${line}\n`, { mode: 0o600 });
	try {
		const saved = await readFile(journal, "utf8").catch((error: unknown) => {
			if (existsError(error, "ENOENT")) return null;
			throw error;
		});
		let owner = saved === null ? null : z.object({ controller: identitySchema, members: z.array(identitySchema) }).parse(JSON.parse(saved));
		if (owner === null) {
			const controller = await readIdentity(instanceFiles(dir).pid);
			if (controller !== null) {
				const members = await groupMembers(controller.pid);
				if (members.length > 0) {
					if (!(await alive(controller)) || !members.includes(controller.pid)) throw new Error("Cannot verify the retry controller's process group; refusing to kill it");
					const identities = await Promise.all(members.map(identityOf));
					owner = { controller, members: identities.filter((id) => id !== null) };
					// Persist before stop: a probe crash must not lose the QEMU identities when its controller exits first.
					await saveJson(journal, owner);
				}
			}
		}
		if (owner !== null) {
			const current = await readIdentity(instanceFiles(dir).pid);
			if (current !== null && (current.pid !== owner.controller.pid || current.start !== owner.controller.start || current.boot !== owner.controller.boot))
				throw new Error("The controller changed during retry stop; refusing to stop another boot");
		}
		try {
			const reply = await send(dir, { action: "stop", name }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
			if (reply === absent && owner === null) await settle(dir);
		} catch (error) {
			if (owner === null) throw error;
			await log(`stop failed or timed out for controller ${owner.controller.pid}: ${error instanceof Error ? error.message : String(error)}; terminating its process group`);
		}
		if (owner !== null) {
			const { controller, members } = owner;
			const checkedSignal = async (name: NodeJS.Signals | 0): Promise<boolean> => {
				const current = await groupMembers(controller.pid);
				if (current.length === 0) return false;
				if (name === 0) return true;
				if (!(await Promise.all(members.filter((id) => current.includes(id.pid)).map(alive))).some(Boolean))
					throw new Error(`Cannot verify controller ${controller.pid}'s remaining process group; refusing to kill it`);
				return signalGroup(controller.pid, name);
			};
			await checkedSignal("SIGTERM");
			await reapGroup(controller.pid, `controller ${controller.pid}`, checkedSignal);
			await log(`stopped old controller ${controller.pid} (start ${controller.start}, host boot ${controller.boot}) and its process group`);
			await rm(instanceFiles(dir).socket, { force: true });
			await rm(instanceFiles(dir).pid, { force: true });
		}
		await settle(dir);
		await rm(journal, { force: true });
	} finally {
		await releaseLock(lock, release);
	}
}
/**
 * Stop without a controller. An instance whose controller died settles as stopped on its last completed
 * checkpoint, or on no disk, so its next start boots fresh. Booting it only to stop it again would need
 * boot inputs and would give the same disk.
 */
async function settle(dir: string): Promise<unknown> {
	const found = await offline(dir);
	if (found.status.state !== "interrupted" && found.status.state !== "failed")
		return found;
	const status = statusSchema.parse({ name: found.name, state: "stopped" });
	await saveJson(instanceFiles(dir).status, status);
	return { ...found, status };
}
async function offline(dir: string) {
	const record = await readRecord(dir);
	let status = statusSchema.parse({
		name: record.name,
		state: "interrupted",
		recovery:
			"Use start. Only the last completed stop is preserved after a controller crash",
	});
	try {
		status = statusSchema.parse(
			JSON.parse(await readFile(instanceFiles(dir).status, "utf8")),
		);
	} catch (error) {
		if (!existsError(error, "ENOENT")) throw error;
	}
	if (["starting", "running", "stopping"].includes(status.state)) {
		// The launching client writes starting before the controller publishes its PID.
		const alive =
			(await controllerAlive(dir)) ||
			(status.state === "starting" && (await launching(dir)));
		status = {
			...status,
			state: alive ? "unavailable" : "interrupted",
			previews: {},
			recovery: alive
				? "Controller is starting or unavailable. Read controller logs and retry inspect"
				: "Controller exited without completing stop. Start restores only the last completed disk checkpoint",
		};
	}
	return {
		name: record.name,
		createdAt: record.createdAt,
		labels: record.labels,
		workspace: record.config.workspace,
		status,
		connected: false,
		services: Object.keys(record.config.services),
	};
}
