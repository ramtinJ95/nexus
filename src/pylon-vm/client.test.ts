import { AsyncLocalStorage } from "node:async_hooks";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import fs, { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run, sweepScratch } from "./client.ts";
import { directory, scratchDirectory } from "./instance-layout.ts";
import { identityOf, publishIdentity } from "./identity.ts";
import { saveJson } from "../node-base/json-file.ts";
import { privateDirectory } from "./storage.ts";

type Inspection = { connected: boolean; status: { state: string } };

/**
 * A controller of one instance that queues every action but inspect, as daemon.ts does, and ends a stop as it
 * does: it answers, closes its server and removes its socket. A queued action that runs after the stop is refused.
 * Its stop waits for `finishStop`, so a test can queue a request behind it. It counts the requests that arrive
 * after its stop, and every action that arrives, and `closed` settles once its last connection ends, which is when a
 * real controller removes its controller.pid.
 */
async function controller(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "nxc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const name = "pylon-t1";
	const dir = directory(root, "instances", name);
	await privateDirectory(dir);
	await saveJson(join(dir, "record.json"), { version: 1, name, config: {}, createdAt: new Date().toISOString(), labels: {} });
	const socket = join(dir, "control.sock");
	let state = "running";
	let afterStop = 0;
	const arrived: string[] = [];
	let finishStop!: () => void;
	const stopFinished = new Promise<void>((accept) => (finishStop = accept));
	const waiting = new Map<string, () => void>();
	let queue: Promise<unknown> = Promise.resolve();
	const server = http.createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => {
			const { action } = JSON.parse(body) as { action: string };
			arrived.push(action);
			if (state === "stopped") afterStop++;
			waiting.get(action)?.();
			const reply = (value: unknown) => res.end(JSON.stringify(value));
			const inspection = () => ({ ok: true, result: { name, status: { name, state }, connected: true } });
			if (action === "inspect") return reply(inspection());
			queue = queue.then(async () => {
				if (action !== "stop") return reply(state === "running" ? { ok: true, result: [] } : { ok: false, error: `Sandbox is ${state}, so ${action} waits until it runs again` });
				await stopFinished;
				state = "stopped";
				await saveJson(join(dir, "status.json"), { name, state });
				reply(inspection());
				server.close();
				await rm(socket, { force: true });
			});
		});
	});
	const closed = once(server, "close").then(() => "closed");
	await new Promise<void>((accept) => server.listen(socket, accept));
	const arrival = (action: string) => new Promise<void>((accept) => waiting.set(action, accept));
	return { root, dir, name, server, closed, arrival, finishStop, afterStop: () => afterStop, arrived };
}

test("once its controller stops, an instance is read from its directory and the stopped controller is left to exit", async (t) => {
	const c = await controller(t);
	const stopArrived = c.arrival("stop");
	const stop = run(c.root, { action: "stop", name: c.name });
	await stopArrived;
	// A probe snapshot's services read can land behind a pause's stop like this one.
	const servicesArrived = c.arrival("services");
	const services = run(c.root, { action: "services", name: c.name, op: "status" });
	await servicesArrived;
	c.finishStop();
	assert.equal(((await stop) as Inspection).status.state, "stopped");
	await assert.rejects(services, /Sandbox is stopped/);
	const inspected = await run(c.root, { action: "inspect", name: c.name });
	assert.equal(inspected.connected, false, "an inspect after the stop reached the stopped controller");
	assert.equal(inspected.status.state, "stopped");
	assert.equal(c.afterStop(), 0, "requests reached the controller after its stop");
	assert.equal(await Promise.race([c.closed, delay(1000, "open", { ref: false })]), "closed", "the stopped controller still has a client connection, so it keeps its controller.pid");
});

test("an action reaches its controller in one request, with no inspect before it", async (t) => {
	const c = await controller(t);
	t.after(() => c.server.close());
	assert.deepEqual(await run(c.root, { action: "services", name: c.name, op: "status" }), []);
	assert.deepEqual(c.arrived, ["services"]);
});

test("with no controller listening, an inspect reads the instance offline, a stop settles it, and any other action is refused", async (t) => {
	const c = await controller(t);
	await saveJson(join(c.dir, "status.json"), { name: c.name, state: "interrupted" });
	c.server.close();
	await c.closed;
	const inspected = await run(c.root, { action: "inspect", name: c.name });
	assert.deepEqual([inspected.connected, inspected.status.state], [false, "interrupted"]);
	await assert.rejects(run(c.root, { action: "services", name: c.name, op: "status" }), /^Error: pylon-t1 is not running\. Use start first$/);
	assert.equal(((await run(c.root, { action: "stop", name: c.name })) as Inspection).status.state, "stopped");
	assert.deepEqual(c.arrived, []);
});

test("the start sweep removes an old scratch directory no controller owns, and keeps a young one and one a running controller or a launch owns", async (t) => {
	const c = await controller(t);
	t.after(() => c.server.close());
	await publishIdentity(join(c.dir, "controller.pid"));
	const hour = 60 * 60_000;
	const scratch = async (path: string, age: number) => {
		await privateDirectory(path);
		await writeFile(join(path, "overlay.qcow2"), "overlay");
		const at = new Date(Date.now() - age);
		await utimes(path, at, at);
		return path;
	};
	const owned = await scratch(scratchDirectory(c.root, c.dir), 2 * hour);
	const stoppedDir = directory(c.root, "instances", "pylon-t2");
	await privateDirectory(stoppedDir);
	const stopped = await scratch(scratchDirectory(c.root, stoppedDir), 2 * hour);
	const launchingDir = directory(c.root, "instances", "pylon-t3");
	await privateDirectory(join(launchingDir, "launch.lock"));
	await publishIdentity(join(launchingDir, "launch.lock", "owner"));
	const launching = await scratch(scratchDirectory(c.root, launchingDir), 2 * hour);
	const destroyed = await scratch(join(c.root, "tmp", "f7352d554b6b"), 2 * hour);
	const young = await scratch(join(c.root, "tmp", "0123456789ab"), 60_000);
	assert.deepEqual((await sweepScratch(c.root)).sort(), [basename(destroyed), basename(stopped)].sort());
	assert.deepEqual([owned, stopped, launching, destroyed, young].map((path) => existsSync(path)), [true, false, true, false, true]);
	assert.equal(existsSync(join(stoppedDir, "launch.lock")), false, "the sweep left the launch lock it held");
	assert.equal(existsSync(join(launchingDir, "launch.lock")), true, "the sweep removed a launch's lock");
});

test("the start sweep keeps a directory whose controller.pid it cannot read or whose lock it cannot take, logs it, and sweeps the rest", { skip: process.getuid?.() === 0 && "root writes to a read-only directory" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nxc-"));
	t.after(async () => {
		await chmod(directory(root, "instances", "pylon-locked"), 0o700);
		await rm(root, { recursive: true, force: true });
	});
	const errors = t.mock.method(console, "error", () => {});
	const scratch = async (dir: string) => {
		await privateDirectory(dir);
		const path = scratchDirectory(root, dir);
		await privateDirectory(path);
		const at = new Date(Date.now() - 2 * 60 * 60_000);
		await utimes(path, at, at);
		return path;
	};
	const tornDir = directory(root, "instances", "pylon-torn");
	const torn = await scratch(tornDir);
	// What a power loss before saveJson's data reached the disk leaves.
	await writeFile(join(tornDir, "controller.pid"), "");
	const lockedDir = directory(root, "instances", "pylon-locked");
	const locked = await scratch(lockedDir);
	// Refuses the lock as a full disk would.
	await chmod(lockedDir, 0o500);
	const stopped = await scratch(directory(root, "instances", "pylon-stopped"));
	assert.deepEqual(await sweepScratch(root), [basename(stopped)]);
	assert.deepEqual([torn, locked, stopped].map((path) => existsSync(path)), [true, true, false]);
	assert.equal(existsSync(join(tornDir, "launch.lock")), false, "the sweep left the launch lock it held");
	const logged = errors.mock.calls.map((call) => String(call.arguments[0]));
	assert.deepEqual(logged.sort(), [basename(locked), basename(torn)].sort().map((name) => `scratch sweep kept ${name}:`));
});

const spec = { resources: { cpus: 1, memoryGiB: 1 }, allowedHosts: [], secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null };

test("a launch lock that an interrupted sweep or launch left without an owner is taken by the next sweep and the next launch", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nxc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const interrupted = async (instance: string, age: number) => {
		const dir = directory(root, "instances", instance);
		await privateDirectory(dir);
		await saveJson(join(dir, "record.json"), { version: 1, name: instance, config: {}, createdAt: new Date().toISOString(), labels: {} });
		// What a probe killed between making the lock and publishing its identity in it left.
		await privateDirectory(join(dir, "launch.lock"));
		const scratch = scratchDirectory(root, dir);
		await privateDirectory(scratch);
		const at = new Date(Date.now() - age);
		await utimes(scratch, at, at);
		return { dir, scratch };
	};
	const dead = await interrupted("pylon-dead", 2 * 60 * 60_000);
	const paused = await interrupted("pylon-paused", 60_000);
	assert.deepEqual(await sweepScratch(root), [basename(dead.scratch)]);
	assert.equal(existsSync(paused.scratch), true);
	assert.deepEqual([dead, paused].map(({ dir }) => existsSync(join(dir, "launch.lock"))), [false, false], "the sweep left an ownerless lock");

	const starting = await interrupted("pylon-starting", 60_000);
	// Fails the launch at its first write after it holds the lock, so no controller is spawned.
	await mkdir(join(starting.dir, "status.json"));
	await assert.rejects(run(root, { action: "start", name: "pylon-starting", boot: spec }), /EISDIR/);
	assert.equal(existsSync(join(starting.dir, "launch.lock")), false, "the launch left the lock it took");
});

/** Who the code under a test's `caller.run` acts for, so a test can tell apart callers that share this process. */
const caller = new AsyncLocalStorage<string>();
/**
 * The most callers that held one launch lock, or one of its recovery locks, at once. A caller holds it from its rename of an aside directory onto the
 * lock until its own rename of the lock away, and a rename of the lock by any other caller leaves the hold counted. A
 * hold ends as its release starts, because the take it lets in may settle first. On a full disk, a rename onto a new
 * name, which needs a new directory entry, is refused, while one onto an existing name is not.
 */
const isLock = (name: string) => /^launch\.lock(?:\.recovery\d+)?$/.test(name);
function holders(t: TestContext, { full = false } = {}): () => number {
	const { rename } = fs;
	const held = new Map<string, Set<string | undefined>>();
	const holding = (lock: string) => held.get(lock) ?? held.set(lock, new Set()).get(lock)!;
	let most = 0;
	t.mock.method(fs, "rename", async (from: string, to: string) => {
		if (full && basename(from) === "launch.lock" && !existsSync(to))
			throw Object.assign(new Error(`ENOSPC: no space left on device, rename '${from}' -> '${to}'`), { code: "ENOSPC" });
		if (isLock(basename(to))) {
			await rename(from, to);
			most = Math.max(most, holding(to).add(caller.getStore()).size);
			return;
		}
		const ended = isLock(basename(from)) && holding(from).delete(caller.getStore());
		try {
			await rename(from, to);
		} catch (error) {
			if (ended) holding(from).add(caller.getStore());
			throw error;
		}
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return () => most;
}

for (const disk of ["free", "full"] as const)
	test(`sweeps that race over the same instances never hold a launch lock at once, never fail to take or release one, and leave none behind, on a ${disk} disk`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "nxc-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const errors = t.mock.method(console, "error", () => {});
		const most = holders(t, { full: disk === "full" });
		const dirs = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
			const dir = directory(root, "instances", `pylon-race${i}`);
			await privateDirectory(dir);
			await privateDirectory(scratchDirectory(root, dir));
			return dir;
		}));
		for (let round = 0; round < 20; round++) await Promise.all(Array.from({ length: 4 }, (_, i) => caller.run(`sweep ${i}`, () => sweepScratch(root))));
		assert.deepEqual(errors.mock.calls.map((call) => call.arguments.map(String).join(" ")), []);
		assert.deepEqual(dirs.filter((dir) => existsSync(join(dir, "launch.lock"))), []);
		assert.equal(most(), 1);
	});

test("a launch that ends on a full disk still releases its lock, so the next launch is not refused by the probe that is still running", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nxc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = directory(root, "instances", "pylon-full");
	await privateDirectory(dir);
	await saveJson(join(dir, "record.json"), { version: 1, name: "pylon-full", config: {}, createdAt: new Date().toISOString(), labels: {} });
	// Fails the launch at its first write after it holds the lock, so no controller is spawned.
	await mkdir(join(dir, "status.json"));
	const lock = join(dir, "launch.lock");
	const full = (path: unknown) => Object.assign(new Error(`ENOSPC: no space left on device, '${String(path)}'`), { code: "ENOSPC" });
	const { mkdtemp: original } = fs;
	// The disk fills while the launch holds its lock.
	t.mock.method(fs, "mkdtemp", (prefix: string, ...rest: unknown[]) =>
		existsSync(lock) ? Promise.reject(full(prefix)) : (original as (...args: unknown[]) => Promise<string>)(prefix, ...rest));
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(run(root, { action: "start", name: "pylon-full", boot: spec }), /EISDIR/);
	assert.equal(existsSync(lock), false, "a launch on a full disk kept its lock");
	t.mock.restoreAll();
	syncBuiltinESMExports();
	await assert.rejects(run(root, { action: "start", name: "pylon-full", boot: spec }), /EISDIR/);
});

test("a launch that recovers the lock of a launch that died releases it onto the dead launch's reserved directory, and leaves no directory beside the lock", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nxc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = directory(root, "instances", "pylon-orphaned");
	await privateDirectory(dir);
	await saveJson(join(dir, "record.json"), { version: 1, name: "pylon-orphaned", config: {}, createdAt: new Date().toISOString(), labels: {} });
	// What a launch killed while it held its lock left.
	const lock = join(dir, "launch.lock");
	await privateDirectory(lock);
	await saveJson(join(lock, "owner"), { ...(await identityOf(process.pid))!, start: "an earlier process" });
	await writeFile(join(lock, "release"), "launch.lock-dead01");
	await privateDirectory(join(dir, "launch.lock-dead01"));
	// Fails the launch at its first write after it holds the lock, so no controller is spawned.
	await mkdir(join(dir, "status.json"));
	await assert.rejects(run(root, { action: "start", name: "pylon-orphaned", boot: spec }), /EISDIR/);
	assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("launch.lock")), []);
});

/** An instance whose launch fails at its first write after it holds the lock, so no controller is spawned. */
async function unlaunchable(t: TestContext, name: string) {
	const root = await mkdtemp(join(tmpdir(), "nxc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = directory(root, "instances", name);
	await privateDirectory(dir);
	await saveJson(join(dir, "record.json"), { version: 1, name, config: {}, createdAt: new Date().toISOString(), labels: {} });
	await mkdir(join(dir, "status.json"));
	return { root, dir, lock: join(dir, "launch.lock") };
}
const dead = async () => ({ ...(await identityOf(process.pid))!, start: "an earlier process" });
/** What a process killed while it held `lock`, taken as takeLock takes it, left. `named` is what its release file holds. */
async function abandon(lock: string, named = `${basename(lock)}-dead01`) {
	await privateDirectory(lock);
	await saveJson(join(lock, "owner"), await dead());
	await writeFile(join(lock, "release"), named);
	await privateDirectory(`${lock}-dead01`);
}

/** Each leaves its state on disk and names the directories the recovery cannot know to remove, which the sweep does. */
const crashes: Record<string, (lock: string) => Promise<string[]>> = {
	"a recoverer was killed holding the recovery": async (lock) => {
		await abandon(lock);
		await abandon(`${lock}.recovery1`);
		return [];
	},
	"thirty recoverers were killed, each while it recovered the one before": async (lock) => {
		await abandon(lock);
		for (let level = 1; level <= 30; level++) await abandon(`${lock}.recovery${level}`);
		return [];
	},
	"an older recoverer was killed holding its empty recovery": async (lock) => {
		await abandon(lock);
		await privateDirectory(join(lock, "recovery"));
		return [];
	},
	"a power loss emptied the release file": async (lock) => {
		await abandon(lock, "");
		return ["launch.lock-dead01"];
	},
	"a power loss cut the release file short": async (lock) => {
		await abandon(lock, "launch.lock-de");
		return ["launch.lock-dead01"];
	},
	"a power loss emptied the owner file": async (lock) => {
		await abandon(lock);
		await writeFile(join(lock, "owner"), "");
		return [];
	},
	"an older launch was killed writing its owner in place": async (lock) => {
		await privateDirectory(lock);
		await writeFile(join(lock, "owner.4242.1.tmp"), '{"pid": 42');
		return [];
	},
};
for (const [crash, leave] of Object.entries(crashes))
	test(`after ${crash}, the next launch recovers the lock`, async (t) => {
		const { root, dir, lock } = await unlaunchable(t, "pylon-crashed");
		const left = await leave(lock);
		await assert.rejects(run(root, { action: "start", name: "pylon-crashed", boot: spec }), /EISDIR/);
		assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("launch.lock")), left);
	});

/**
 * Stops a caller's code at a point it reaches: as it reads `lock`'s owner, once it has read it, as it reads the lock's
 * release, as it renames its aside directory onto a lock to take it, or as it writes status.json once it holds the lock. `arrival` settles once it does, and `open` lets it go on.
 */
function gates(t: TestContext, lock: string) {
	const stops = new Map<string, { reached: () => void; opened: Promise<void> }>();
	const at = async (point: string) => {
		const key = `${caller.getStore()} ${point}`;
		const stop = stops.get(key);
		if (stop === undefined) return;
		stops.delete(key);
		stop.reached();
		await stop.opened;
	};
	const { readFile, rename } = fs;
	t.mock.method(fs, "readFile", async (path: string, ...rest: unknown[]) => {
		if (path === join(lock, "owner")) await at("reads the owner");
		if (path === join(lock, "release")) await at("reads the release");
		const read = await (readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
		if (path === join(lock, "owner")) await at("has read the owner");
		return read;
	});
	t.mock.method(fs, "rename", async (from: string, to: string) => {
		if (basename(to) === "status.json") await at("holds the lock");
		if (isLock(basename(to))) await at(`takes ${basename(to)}`);
		return rename(from, to);
	});
	syncBuiltinESMExports();
	return (who: string, point: string) => {
		let reached!: () => void;
		let open!: () => void;
		const arrival = new Promise<void>((accept) => (reached = accept));
		stops.set(`${who} ${point}`, { reached, opened: new Promise<void>((accept) => (open = accept)) });
		return { arrival, open };
	};
}
const settled = (launch: Promise<unknown>) => launch.then(() => "started", (error: unknown) => String(error));

test("a recovery whose lock is released and taken again while it holds the recovery, and one that finds the new owner dead, never both hold the lock", async (t) => {
	const { root, lock } = await unlaunchable(t, "pylon-replaced");
	await privateDirectory(lock);
	await publishIdentity(join(lock, "owner"));
	await writeFile(join(lock, "release"), "launch.lock-live01");
	await privateDirectory(`${lock}-live01`);
	const most = holders(t);
	const gate = gates(t, lock);
	const start = () => run(root, { action: "start", name: "pylon-replaced", boot: spec });

	const rOwner = gate("R", "reads the owner");
	const rHolds = gate("R", "holds the lock");
	const cRelease = gate("C", "reads the release");
	const r = settled(caller.run("R", start));
	await rOwner.arrival;
	// The live owner releases, and another launch takes the lock and is killed.
	await rm(lock, { recursive: true, force: true });
	await rm(`${lock}-live01`, { recursive: true, force: true });
	await abandon(lock);
	const c = settled(caller.run("C", start));
	await Promise.race([cRelease.arrival, c]);
	rOwner.open();
	await Promise.race([rHolds.arrival, r]);
	cRelease.open();
	const cResult = await c;
	rHolds.open();
	const rResult = await r;
	assert.equal(most(), 1);
	assert.match(rResult, /EISDIR/);
	assert.match(cResult, /already in progress|EISDIR/);
});

test("a recovery that read an owner which released the lock to a live launch and then died leaves that launch's lock alone", async (t) => {
	const { root, lock } = await unlaunchable(t, "pylon-handed-on");
	const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	t.after(() => owner.kill("SIGKILL"));
	await privateDirectory(lock);
	await saveJson(join(lock, "owner"), (await identityOf(owner.pid!))!);
	await writeFile(join(lock, "release"), "launch.lock-live01");
	await privateDirectory(`${lock}-live01`);
	const most = holders(t);
	const gate = gates(t, lock);
	const start = () => run(root, { action: "start", name: "pylon-handed-on", boot: spec });

	const rOwner = gate("R", "has read the owner");
	const bHolds = gate("B", "holds the lock");
	const r = settled(caller.run("R", start));
	await rOwner.arrival;
	// The owner releases, another launch takes the lock, and the owner is killed.
	await rm(lock, { recursive: true, force: true });
	await rm(`${lock}-live01`, { recursive: true, force: true });
	const b = settled(caller.run("B", start));
	await bHolds.arrival;
	owner.kill("SIGKILL");
	await once(owner, "exit");
	rOwner.open();
	const rResult = await r;
	bHolds.open();
	const bResult = await b;
	assert.equal(most(), 1);
	assert.match(rResult, /already in progress/);
	assert.match(bResult, /EISDIR/);
});

test("launches that race to recover a dead launch's lock and its dead recoverer never hold the lock at once", async (t) => {
	const { root, dir, lock } = await unlaunchable(t, "pylon-contested");
	const most = holders(t);
	for (let round = 0; round < 20; round++) {
		await abandon(lock);
		await abandon(`${lock}.recovery1`);
		const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => caller.run(`launch ${i}`, () => run(root, { action: "start", name: "pylon-contested", boot: spec }))));
		const errors = results.map((result) => (result.status === "rejected" ? String(result.reason) : "started"));
		assert.equal(errors.filter((error) => !/EISDIR|already in progress/.test(error)).join("\n"), "");
		assert.ok(errors.some((error) => /EISDIR/.test(error)), `no launch recovered the lock: ${errors.join("; ")}`);
		assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("launch.lock")), []);
	}
	assert.equal(most(), 1);
});

test("the start sweep removes the old directories that killed takes left beside each launch lock, while it holds the lock, scratch directory or not", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nxc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const leaky = async (name: string) => {
		const dir = directory(root, "instances", name);
		await privateDirectory(dir);
		const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
		await privateDirectory(join(dir, "launch.lock-old001"));
		await privateDirectory(join(dir, "launch.lock-old002"));
		await publishIdentity(join(dir, "launch.lock-old002", "owner"));
		await writeFile(join(dir, "launch.lock-old002", "release"), "launch.lock-old001");
		for (const leaked of ["launch.lock-old001", "launch.lock-old002"]) await utimes(join(dir, leaked), hoursAgo, hoursAgo);
		// A take still in progress made it moments ago.
		await privateDirectory(join(dir, "launch.lock-new003"));
		// What a recovery's take killed partway left, and a recoverer killed while it held its recovery.
		await privateDirectory(join(dir, "launch.lock.recovery1-old004"));
		await abandon(join(dir, "launch.lock.recovery1"));
		for (const leaked of ["launch.lock.recovery1-old004", "launch.lock.recovery1-dead01"]) await utimes(join(dir, leaked), hoursAgo, hoursAgo);
		return dir;
	};
	const running = await leaky("pylon-running");
	await privateDirectory(scratchDirectory(root, running));
	const stopped = await leaky("pylon-stopped");
	await sweepScratch(root);
	for (const dir of [running, stopped])
		assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("launch.lock")).sort(), ["launch.lock-new003", "launch.lock.recovery1", "launch.lock.recovery1-dead01"], dir);
});

test("a take of a recovery lock stalled while the sweep cleared its aside directory never holds it beside another launch", async (t) => {
	const { root, dir, lock } = await unlaunchable(t, "pylon-stalled");
	await privateDirectory(lock);
	await publishIdentity(join(lock, "owner"));
	await writeFile(join(lock, "release"), "launch.lock-live01");
	await privateDirectory(`${lock}-live01`);
	const most = holders(t);
	const gate = gates(t, lock);
	const start = () => run(root, { action: "start", name: "pylon-stalled", boot: spec });

	const tTakes = gate("T", "takes launch.lock.recovery1");
	const tOwner = gate("T", "reads the owner");
	const tResult = settled(caller.run("T", start));
	await tTakes.arrival;
	// The owner releases, and the take stalls for longer than the sweep keeps what takes leave.
	await rm(lock, { recursive: true, force: true });
	await rm(`${lock}-live01`, { recursive: true, force: true });
	const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
	for (const name of await readdir(dir)) if (name.startsWith("launch.lock.recovery1-")) await utimes(join(dir, name), hoursAgo, hoursAgo);
	const { rm: remove } = fs;
	t.mock.method(fs, "rm", async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
		if (basename(path).startsWith("launch.lock.recovery1-") && existsSync(join(path, "owner"))) {
			// What a removal in place does: the entries go first, and the directory last. The take resumes between.
			for (const name of await readdir(path)) await remove(join(path, name), { recursive: true, force: true });
			tTakes.open();
			await Promise.race([tOwner.arrival, tResult]);
		}
		return remove(path, options);
	});
	syncBuiltinESMExports();
	await sweepScratch(root);
	tTakes.open();
	await Promise.race([tOwner.arrival, tResult]);
	// Another launch takes the lock and is killed.
	await abandon(lock);
	const uResult = await settled(caller.run("U", start));
	tOwner.open();
	await tResult;
	assert.equal(most(), 1);
	assert.match(uResult, /EISDIR/);
});

test("a recovery never leaves the lock an empty directory that another launch could take while the dead lock is removed", async (t) => {
	const { root, lock } = await unlaunchable(t, "pylon-emptied");
	await abandon(lock);
	const most = holders(t);
	const gate = gates(t, lock);
	const start = () => run(root, { action: "start", name: "pylon-emptied", boot: spec });
	const uHolds = gate("U", "holds the lock");
	let uResult: Promise<string> | undefined;
	const { rm: remove } = fs;
	t.mock.method(fs, "rm", async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
		if (path === lock && uResult === undefined) {
			// What a removal in place does: the entries go first, and the directory last.
			for (const name of await readdir(path)) await remove(join(path, name), { recursive: true, force: true });
			uResult = settled(caller.run("U", start));
			await Promise.race([uHolds.arrival, uResult]);
		}
		return remove(path, options);
	});
	syncBuiltinESMExports();
	const rResult = await settled(caller.run("R", start));
	uHolds.open();
	await uResult;
	assert.equal(most(), 1);
	assert.match(rResult, /EISDIR/);
});

for (const debug of ["exec", undefined])
	test(`a controller the probe starts gets GONDOLIN_DEBUG only when the probe has it, ${debug === undefined ? "unset" : `set to ${debug}`}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "nxc-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const dir = directory(root, "instances", "pylon-debug");
		await privateDirectory(dir);
		await saveJson(join(dir, "record.json"), { version: 1, name: "pylon-debug", config: {}, createdAt: new Date().toISOString(), labels: {} });
		const before = process.env.GONDOLIN_DEBUG;
		if (debug === undefined) delete process.env.GONDOLIN_DEBUG;
		else process.env.GONDOLIN_DEBUG = debug;
		process.env.NEXUS_TEST_SECRET = "s3cret";
		t.after(() => {
			if (before === undefined) delete process.env.GONDOLIN_DEBUG;
			else process.env.GONDOLIN_DEBUG = before;
			delete process.env.NEXUS_TEST_SECRET;
		});
		let env: NodeJS.ProcessEnv | undefined;
		t.mock.method(childProcess, "spawn", (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
			env = options.env;
			throw new Error("spawn refused");
		});
		syncBuiltinESMExports();
		t.after(() => {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		await assert.rejects(run(root, { action: "start", name: "pylon-debug", boot: spec }), /spawn refused/);
		const expected: NodeJS.ProcessEnv = { TMPDIR: scratchDirectory(root, dir) };
		for (const key of ["PATH", "HOME", "XDG_CACHE_HOME"]) if (process.env[key]) expected[key] = process.env[key];
		if (debug !== undefined) expected.GONDOLIN_DEBUG = debug;
		assert.deepEqual(env, expected);
	});
