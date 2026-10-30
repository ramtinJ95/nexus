import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./client.ts";
import { saveJson } from "../json-file.ts";
import { directory, privateDirectory } from "./storage.ts";

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
	const inspected = (await run(c.root, { action: "inspect", name: c.name })) as Inspection;
	assert.equal(inspected.connected, false, "an inspect after the stop reached the stopped controller");
	assert.equal(inspected.status.state, "stopped");
	assert.equal(c.afterStop(), 0, "requests reached the controller after its stop");
	assert.equal(await Promise.race([c.closed, delay(1000, "open", { ref: false })]), "closed", "the stopped controller still has a client connection, so it keeps its controller.pid");
});

test("an action reaches its controller in one request, with no inspect before it", async (t) => {
	const c = await controller(t);
	assert.deepEqual(await run(c.root, { action: "services", name: c.name, op: "status" }), []);
	assert.deepEqual(c.arrived, ["services"]);
	c.server.close();
});

test("with no controller listening, an inspect reads the instance offline, a stop settles it, and any other action is refused", async (t) => {
	const c = await controller(t);
	await saveJson(join(c.dir, "status.json"), { name: c.name, state: "interrupted" });
	c.server.close();
	await c.closed;
	const inspected = (await run(c.root, { action: "inspect", name: c.name })) as Inspection;
	assert.deepEqual([inspected.connected, inspected.status.state], [false, "interrupted"]);
	await assert.rejects(run(c.root, { action: "services", name: c.name, op: "status" }), /^Error: pylon-t1 is not running\. Use start first$/);
	assert.equal(((await run(c.root, { action: "stop", name: c.name })) as Inspection).status.state, "stopped");
	assert.deepEqual(c.arrived, []);
});
