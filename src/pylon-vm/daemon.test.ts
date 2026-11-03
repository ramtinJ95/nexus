import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { saveJson } from "../json-file.ts";
import { publishIdentity, readIdentity } from "./identity.ts";
import { scratchDirectory } from "./client.ts";
import { directory, existsError, privateDirectory } from "./storage.ts";

const name = "pylon-t1";
const spec = { resources: { cpus: 1, memoryGiB: 1 }, allowedHosts: [], secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null };

/** The real daemon.ts over an instance directory, with fake-runtime.ts in place of the VM, and its scratch directory made as a launch makes it. */
async function launched(t: TestContext, instance = name) {
	const root = await mkdtemp(join(tmpdir(), "nxd-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = directory(root, "instances", instance);
	await privateDirectory(dir);
	await saveJson(join(dir, "record.json"), { version: 1, name: instance, config: {}, createdAt: new Date().toISOString(), labels: {} });
	await saveJson(join(dir, "intent.json"), { prepare: false });
	const scratch = scratchDirectory(root, dir);
	await privateDirectory(scratch);
	await writeFile(join(scratch, "overlay.qcow2"), "overlay");
	const child = spawn(
		process.execPath,
		["--import", fileURLToPath(new URL("./fake-runtime.ts", import.meta.url)), fileURLToPath(new URL("./daemon.ts", import.meta.url)), dir],
		{ stdio: ["pipe", "ignore", "pipe"] },
	);
	t.after(() => child.kill("SIGKILL"));
	let log = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (log += chunk));
	child.stdin.end(JSON.stringify(spec));
	const exited = once(child, "exit").then(([code]) => code as number | null);
	return { dir, scratch, child, exited, log: () => log };
}

async function controller(t: TestContext, instance = name) {
	const { dir, scratch, child, exited, log } = await launched(t, instance);
	const post = (body: string) =>
		new Promise<{ ok: boolean; error?: string; result?: { status: { state: string } } }>((accept, reject) => {
			const req = http.request({ socketPath: join(dir, "control.sock"), agent: false, method: "POST", path: "/" }, (res) => {
				let reply = "";
				res.setEncoding("utf8").on("data", (chunk: string) => (reply += chunk));
				res.on("end", () => accept(JSON.parse(reply)));
			});
			req.on("error", reject);
			req.end(body);
		});
	const inspect = async () => (await post(JSON.stringify({ action: "inspect", name }))).result!.status.state;
	const until = async (done: () => boolean) => {
		while (!done()) {
			if (child.exitCode !== null) throw new Error(`controller exited ${child.exitCode}:\n${log()}`);
			await delay(10);
		}
	};
	/** Fails one accept on the controller's server, and resolves once the controller has handled it. */
	const failAccept = async (n: number) => {
		child.kill("SIGUSR2");
		await until(() => log().includes(`injected accept error ${n}\n`));
	};
	// bind creates control.sock before listen, so a connect between them is refused.
	for (const deadline = Date.now() + 30_000; ; await delay(10)) {
		if (child.exitCode !== null) throw new Error(`controller exited ${child.exitCode}:\n${log()}`);
		const refused = await new Promise<boolean>((accept, reject) => {
			const socket = connect(join(dir, "control.sock"));
			socket.once("connect", () => (socket.destroy(), accept(false)));
			socket.once("error", (error) => (existsError(error, "ECONNREFUSED") || existsError(error, "ENOENT") ? accept(true) : reject(error)));
		});
		if (!refused) break;
		if (Date.now() > deadline) throw new Error(`controller did not listen within 30 s:\n${log()}`);
	}
	return { dir, scratch, child, exited, post, inspect, failAccept, log };
}

test("the controller logs each server error after it listens, and keeps serving", async (t) => {
	const { dir, child, exited, inspect, failAccept, log } = await controller(t);
	assert.equal(await inspect(), "running");
	await failAccept(1);
	assert.match(log(), /accept ENOBUFS[\s\S]*injected accept error 1/);
	assert.equal(await inspect(), "running");
	await failAccept(2);
	assert.equal(log().match(/accept ENOBUFS/g)?.length, 2);
	assert.equal(await inspect(), "running");
	child.kill("SIGTERM");
	assert.equal(await exited, 0);
	assert.equal(existsSync(join(dir, "control.sock")), false);
	assert.equal(existsSync(join(dir, "controller.pid")), false);
});

test("every line of the controller log starts with the time it was written, and each controller's start is a line of its own", async (t) => {
	const { child, inspect, failAccept, log } = await controller(t);
	assert.equal(await inspect(), "running");
	await failAccept(1);
	const lines = log().split("\n").filter((line) => line !== "");
	for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, `a line with no timestamp:\n${log()}`);
	assert.ok(lines.some((line) => / controller \d+ started for pylon-t1$/.test(line)), `no start line:\n${log()}`);
	assert.ok(lines.some((line) => / injected accept error 1$/.test(line)));
	child.kill("SIGTERM");
});

test("a body over 8 MiB is refused with a reply, and the controller keeps serving", async (t) => {
	const { post, inspect } = await controller(t);
	const refused = await post(JSON.stringify({ action: "inspect", name, padding: "x".repeat(8 << 20) }));
	assert.deepEqual(refused, { ok: false, error: "request body over 8388608 bytes" });
	assert.equal(await inspect(), "running");
});

test("a body that is no action is answered without waiting behind the lifecycle queue", async (t) => {
	const { post } = await controller(t);
	void post(JSON.stringify({ action: "services", name, op: "status" })).catch(() => {});
	const answered = await Promise.race([post(JSON.stringify({ action: "frob", name })), delay(5000, "still waiting")]);
	assert.notEqual(answered, "still waiting", "the reply to a body that is no action waited for the queue");
	assert.equal((answered as { ok: boolean }).ok, false);
	assert.match((answered as { error: string }).error, /^action\.action: /);
});

test("a controller removes its scratch directory before its controller.pid when it stops, and when its boot fails, even if it cannot record the failure", async (t) => {
	const stopped = await controller(t);
	assert.equal((await stopped.post(JSON.stringify({ action: "stop", name }))).ok, true);
	assert.equal(await stopped.exited, 0);
	assert.equal(existsSync(stopped.scratch), false, "a stopped controller left its scratch directory");
	assert.equal(existsSync(join(stopped.dir, "controller.pid")), false);

	const shut = await controller(t);
	shut.child.kill("SIGTERM");
	assert.equal(await shut.exited, 0);
	assert.equal(existsSync(shut.scratch), false, "a controller shut down by a signal left its scratch directory");

	const broken = await launched(t, "pylon-broken");
	assert.equal(await broken.exited, 1);
	assert.match(broken.log(), /boot failed/);
	assert.equal(existsSync(broken.scratch), false, "a controller whose boot failed left its scratch directory");
	assert.equal(existsSync(join(broken.dir, "controller.pid")), false);

	const unreported = await launched(t, "pylon-unreported");
	assert.equal(await unreported.exited, 1);
	assert.equal(existsSync(unreported.scratch), false, "a controller that could not record its failed boot left its scratch directory");
	assert.equal(existsSync(join(unreported.dir, "controller.pid")), false);
});

test("a controller whose shutdown fails, and the report of it too, still closes and removes its scratch directory and controller.pid", async (t) => {
	const c = await controller(t, "pylon-full");
	c.child.kill("SIGTERM");
	await c.exited;
	assert.match(c.log(), /ENOSPC/);
	assert.equal(existsSync(c.scratch), false, "a controller that could not record its failed shutdown left its scratch directory");
	assert.equal(existsSync(join(c.dir, "controller.pid")), false);
});

test("a controller retired by a failed stop leaves the scratch directory and controller.pid of the controller launched after it", async (t) => {
	const instance = "pylon-interrupted";
	const c = await controller(t, instance);
	// Accepted before the stop, so the old controller handles it after its retirement.
	let late!: Promise<string>;
	const sent = new Promise<void>((accept, reject) => {
		const req = http.request({ socketPath: join(c.dir, "control.sock"), agent: false, method: "POST", path: "/" }, (res) => {
			let reply = "";
			res.setEncoding("utf8").on("data", (chunk: string) => (reply += chunk));
			late = once(res, "end").then(() => reply);
			accept();
		});
		req.on("error", reject);
		req.flushHeaders();
		void delay(100).then(async () => {
			assert.equal((await c.post(JSON.stringify({ action: "stop", name: instance }))).error, "stop failed");
			assert.equal(existsSync(c.scratch), false, "the retired controller left its scratch directory");
			await privateDirectory(c.scratch);
			await publishIdentity(join(c.dir, "controller.pid"));
			req.end(JSON.stringify({ action: "logs", name: instance, lines: 1 }));
		});
	});
	await sent;
	assert.match(await late, /the controller is retired/);
	assert.equal(existsSync(c.scratch), true, "the retired controller removed the scratch directory of the controller after it");
	assert.equal((await readIdentity(join(c.dir, "controller.pid")))?.pid, process.pid, "the retired controller removed the controller.pid of the controller after it");
});
