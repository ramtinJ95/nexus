import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import {
	constants,
	copyFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type Action,
	actionSchema,
	type BootSpec,
	inspectionSchema,
	replySchema,
	statusSchema,
} from "./contracts.ts";
import { alive, publishIdentity, readIdentity } from "./identity.ts";
import {
	directory,
	existsError,
	privateDirectory,
	readLogTail,
	readRecord,
	saveJson,
} from "./storage.ts";

/** sun_path holds 104 bytes on macOS and 108 on Linux, including the terminating NUL. The shorter rules. */
export const socketPathLimit = 104;
export const controlSocket = (dir: string) => join(dir, "control.sock");
function request(
	dir: string,
	action: Action,
	signal?: AbortSignal,
): Promise<unknown> {
	return new Promise((accept, reject) => {
		const req = http.request(
			{
				socketPath: join(dir, "control.sock"),
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
async function reachable(
	dir: string,
	name: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		await request(
			dir,
			{ action: "inspect", name },
			signal
				? AbortSignal.any([signal, AbortSignal.timeout(1000)])
				: AbortSignal.timeout(1000),
		);
		return true;
	} catch (error) {
		if (existsError(error, "ENOENT") || existsError(error, "ECONNREFUSED"))
			return false;
		throw error;
	}
}
const controllerAlive = (dir: string) => published(join(dir, "controller.pid"));
/** A client that holds the launch lock is still to start the controller, or waits for it to come up. */
const launching = (dir: string) => published(join(dir, "launch.lock", "owner"));
/** A missing identity file means the process has not published itself yet, or is gone. */
async function published(file: string): Promise<boolean> {
	const identity = await readIdentity(file);
	return identity !== null && (await alive(identity));
}
/** Short, because the instance directory's path would push Gondolin's socket paths past their limit. */
const scratchDirectory = (root: string, dir: string) =>
	join(root, "tmp", createHash("sha256").update(dir).digest("hex").slice(0, 12));
/** An instance whose controller already runs keeps the spec it booted with. */
async function launch(
	root: string,
	dir: string,
	name: string,
	spec: BootSpec,
	signal?: AbortSignal,
): Promise<unknown> {
	signal?.throwIfAborted();
	if (await reachable(dir, name, signal))
		return request(dir, { action: "inspect", name }, signal);
	if (await controllerAlive(dir))
		throw new Error(
			"Sandbox controller is still starting or unavailable. Read controller logs before retrying",
		);
	if (Buffer.byteLength(controlSocket(dir)) >= socketPathLimit)
		throw new Error(
			`Sandbox state path ${dir} is too long for a local control socket. Choose a shorter state root`,
		);
	let nodeVersion: string;
	try {
		nodeVersion = execFileSync("node", ["--version"], {
			encoding: "utf8",
			timeout: 3000,
		}).trim();
	} catch {
		throw new Error(
			"Starting a sandbox requires Node.js 24 or newer on PATH. Install Node.js, then retry start",
		);
	}
	if (Number(nodeVersion.match(/^v(\d+)\./)?.[1] ?? 0) < 24)
		throw new Error(
			`Node.js 24 or newer is required, found ${nodeVersion}. Update Node.js, then retry start`,
		);
	const daemonPath = fileURLToPath(new URL("./daemon.ts", import.meta.url));
	if (!existsSync(daemonPath))
		throw new Error(
			`Sandbox controller ${daemonPath} is missing`,
		);
	const lock = join(dir, "launch.lock");
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if (!existsError(error, "EEXIST")) throw error;
		const recovery = join(lock, "recovery");
		try {
			await mkdir(recovery, { mode: 0o700 });
		} catch {
			throw new Error(
				"Sandbox start or recovery is already in progress. Retry inspect shortly",
			);
		}
		try {
			const owner = await readIdentity(join(lock, "owner"));
			if (owner === null)
				throw new Error(
					"Sandbox start ownership is unavailable. Read controller logs before retrying",
				);
			if (await alive(owner))
				throw new Error(
					"Sandbox start is already in progress. Retry inspect shortly",
				);
			if (await controllerAlive(dir))
				throw new Error(
					"Sandbox controller is still starting. Retry inspect shortly",
				);
			await rm(lock, { recursive: true });
			await mkdir(lock, { mode: 0o700 });
		} finally {
			await rm(recovery, { recursive: true, force: true });
		}
	}
	try {
		await publishIdentity(join(lock, "owner"));
		// The boot's resources, so the node counts what a VM still coming up holds.
		await saveJson(join(dir, "status.json"), { state: "starting", name, resources: spec.resources });
		await rm(join(dir, "control.sock"), { force: true });
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["PATH", "HOME", "XDG_CACHE_HOME"])
			if (process.env[key]) env[key] = process.env[key];
		// Gondolin puts the running disk's overlay and its sockets in the temporary directory. The system one is
		// often a tmpfs, where every byte a pylon writes to its disk would take host memory until the next pause.
		// No controller runs here now, so whatever a crashed one left in it is garbage.
		env.TMPDIR = scratchDirectory(root, dir);
		await rm(env.TMPDIR, { recursive: true, force: true });
		await privateDirectory(env.TMPDIR);
		const fd = openSync(join(dir, "controller.log"), "a", 0o600);
		// The spec carries secret values, so it goes over a pipe and never through the environment or a file.
		const child = spawn("node", [daemonPath, dir], {
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
				JSON.parse(await readFile(join(dir, "status.json"), "utf8")),
			);
			if (status.state === "prepared") return offline(dir);
			if (status.state === "failed" || failure)
				throw (
					failure ??
					new Error(
						"Sandbox start failed. Read controller logs before retrying start",
					)
				);
			if (await reachable(dir, name, signal)) {
				const result = await request(dir, { action: "inspect", name }, signal);
				const inspect = inspectionSchema.parse(result);
				if (inspect.status.startupError)
					throw new Error(
						`${name} is running, but ${inspect.status.startupError}`,
					);
				return result;
			}
		}
		throw new Error(
			"Sandbox start has not completed. Use inspect or logs before retrying",
		);
	} finally {
		await rm(lock, { recursive: true, force: true });
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
	await privateDirectory(join(root, kind));
	if (existsSync(dir))
		throw new Error(
			`${action.name} already exists. Use inspect or choose a new name`,
		);
	// Built aside and renamed in, so a crash never leaves an instance without its record and intent.
	const staging = join(root, kind, `.${action.name}.creating`);
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { mode: 0o700 });
	try {
		await saveJson(join(staging, "record.json"), {
			version: 1,
			name: action.name,
			config: action.config,
			createdAt: new Date().toISOString(),
			labels: action.labels,
		});
		// A reflink where the filesystem has them, so a large template disk costs no copy.
		if (disk)
			await copyFile(disk, join(staging, "disk.qcow2"), constants.COPYFILE_FICLONE);
		await saveJson(join(staging, "intent.json"), { prepare: kind === "templates" });
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
		const log = await readLogTail(join(dir, "controller.log"), 20);
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
	await privateDirectory(root);
	if (action.action === "create" || action.action === "prepare")
		return create(root, action, signal);
	if (action.action === "list") {
		const base = join(root, action.kind);
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
				.filter((name) => name.startsWith(".") && name.endsWith(".deleting"))
				.map((name) => rm(join(base, name), { recursive: true, force: true })),
		);
		const found = await Promise.all(
			names
				.filter((name) => !name.startsWith("."))
				.sort()
				.map(async (name) => {
					const dir = join(base, name);
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
		const doomed = join(root, kind, `.${action.name}.deleting`);
		if (existsSync(dir)) {
			await readRecord(dir);
			if (await reachable(dir, action.name)) await request(dir, action, signal);
			else if (await controllerAlive(dir))
				throw new Error(
					"Sandbox controller is still starting or unavailable. Read its logs and wait before destroying it",
				);
			await rm(doomed, { recursive: true, force: true });
			await rename(dir, doomed);
		}
		await rm(doomed, { recursive: true, force: true });
		await rm(scratchDirectory(root, dir), { recursive: true, force: true });
		await rm(join(root, kind, `.${action.name}.creating`), {
			recursive: true,
			force: true,
		});
		return { name: action.name, state: "destroyed" };
	}
	await readRecord(dir);
	if (action.action === "logs" && !action.service) {
		return {
			name: action.name,
			...(await readLogTail(join(dir, "controller.log"), action.lines)),
		};
	}
	if (action.action === "start")
		return launch(root, dir, action.name, action.boot, signal);
	if (!(await reachable(dir, action.name))) {
		if (action.action === "stop") return settle(dir);
		if (action.action === "inspect") return offline(dir);
		throw new Error(`${action.name} is not running. Use start first`);
	}
	return request(dir, action, signal);
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
	await saveJson(join(dir, "status.json"), status);
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
			JSON.parse(await readFile(join(dir, "status.json"), "utf8")),
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
