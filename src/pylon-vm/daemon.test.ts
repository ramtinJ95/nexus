import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { saveJson } from "../json-file.ts";
import { directory, privateDirectory } from "./storage.ts";

const name = "pylon-t1";
const spec = { resources: { cpus: 1, memoryGiB: 1 }, allowedHosts: [], secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null };

/** The real daemon.ts over an instance directory, with fake-runtime.ts in place of the VM. */
async function controller(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "nxd-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = directory(root, "instances", name);
	await privateDirectory(dir);
	await saveJson(join(dir, "record.json"), { version: 1, name, config: {}, createdAt: new Date().toISOString(), labels: {} });
	await saveJson(join(dir, "intent.json"), { prepare: false });
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
	const inspect = () =>
		new Promise<string>((accept, reject) => {
			const req = http.request({ socketPath: join(dir, "control.sock"), agent: false, method: "POST", path: "/" }, (res) => {
				let body = "";
				res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
				res.on("end", () => accept((JSON.parse(body) as { result: { status: { state: string } } }).result.status.state));
			});
			req.on("error", reject);
			req.end(JSON.stringify({ action: "inspect", name }));
		});
	const until = async (done: () => boolean) => {
		while (!done()) {
			if (child.exitCode !== null) throw new Error(`controller exited ${child.exitCode}:\n${log}`);
			await delay(10);
		}
	};
	/** Fails one accept on the controller's server, and resolves once the controller has handled it. */
	const failAccept = async (n: number) => {
		child.kill("SIGUSR2");
		await until(() => log.includes(`injected accept error ${n}\n`));
	};
	await until(() => existsSync(join(dir, "control.sock")));
	return { dir, child, exited, inspect, failAccept, log: () => log };
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
