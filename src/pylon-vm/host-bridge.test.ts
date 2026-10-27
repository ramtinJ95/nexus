import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nexusApi } from "../project.ts";
import type { PylonId } from "../protocol.ts";
import { pylonVmHostBridge, type HostBridgeAnswer } from "../probe/pylon-api.ts";
import type { BootSpec } from "./contracts.ts";
import { bridgeHost, hostBridgeHook, hostBridgeSocket } from "./host-bridge.ts";
import { networkOptions } from "./network.ts";

/** A probe-side bridge on a fresh state root that records every call and answers each with its body echoed. */
async function probeSide(t: TestContext) {
  const stateRoot = await mkdtemp(join(tmpdir(), "nexus-bridge-"));
  t.after(() => rm(stateRoot, { recursive: true }));
  const calls: [PylonId, string][] = [];
  const answer: HostBridgeAnswer = async (pylonId, body) => {
    calls.push([pylonId, body]);
    return { status: 200, body: JSON.stringify({ echoed: body }) };
  };
  const bridge = await pylonVmHostBridge(stateRoot)(answer);
  t.after(() => bridge.close());
  return { stateRoot, socket: hostBridgeSocket(stateRoot), calls };
}

const post = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"op":"info"}' });

test("the bridge host is the host NEXUS_API names", () => {
  assert.equal(new URL(nexusApi).hostname, bridgeHost);
});

test("a request to the bridge host reaches the probe as the instance the controller runs, whatever the guest claims", async (t) => {
  const { socket, calls } = await probeSide(t);
  const reply = await hostBridgeHook(socket, "pylon-t1")(post(`${nexusApi}/v1/request`, { "x-nexus-pylon": "pylon-other" }));
  assert.ok(reply instanceof Response);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("content-type"), "application/json");
  assert.deepEqual(await reply.json(), { echoed: '{"op":"info"}' });
  assert.deepEqual(calls, [["pylon-t1", '{"op":"info"}']]);
});

test("requests to other hosts fall through to the allowlist and secrets", async (t) => {
  const { socket, calls } = await probeSide(t);
  assert.equal(await hostBridgeHook(socket, "pylon-t1")(post("https://api.github.com/zen")), undefined);
  assert.deepEqual(calls, []);
});

test("with no probe listening, the guest gets a 503 that says so", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-bridge-"));
  t.after(() => rm(dir, { recursive: true }));
  const reply = await hostBridgeHook(hostBridgeSocket(dir), "pylon-t1")(post(`${nexusApi}/v1/request`));
  assert.ok(reply instanceof Response);
  assert.equal(reply.status, 503);
  assert.match(await reply.text(), /the probe on this node is not answering nexus.pylon/);
});

test("the VM's hooks answer the bridge host though no allowlist names it, and still refuse every other unlisted host", async (t) => {
  const { socket, calls } = await probeSide(t);
  const spec: BootSpec = { resources: { cpus: 1, memoryGiB: 3 }, allowedHosts: ["github.com"], secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: socket };
  const { httpHooks } = networkOptions(spec, "pylon-t1");
  const reply = await httpHooks!.onRequest!(post(`${nexusApi}/v1/request`));
  assert.ok(reply instanceof Response);
  assert.equal(reply.status, 200);
  assert.deepEqual(calls, [["pylon-t1", '{"op":"info"}']]);
  assert.equal(await httpHooks!.isIpAllowed!({ hostname: "example.com", ip: "93.184.215.14", family: 4, port: 443, protocol: "https" }), false);
});

test("the probe's socket is private to its user, and a request without the controller's header is not answered", async (t) => {
  const { socket, calls } = await probeSide(t);
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  const status = await new Promise<number>((resolve, reject) => {
    request({ socketPath: socket, method: "POST", path: "/v1/request" }, (res) => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end('{"op":"info"}');
  });
  assert.equal(status, 404);
  assert.deepEqual(calls, []);
});

test("a body over a mebibyte is refused with 413 and never answered", async (t) => {
  const { socket, calls } = await probeSide(t);
  const reply = await new Promise<{ status: number; type: string | undefined; text: string }>((resolve, reject) => {
    request({ socketPath: socket, method: "POST", path: "/v1/request", headers: { "x-nexus-pylon": "pylon-t1" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], text }));
    }).on("error", reject).end("x".repeat((1 << 20) + 1));
  });
  assert.deepEqual(reply, { status: 413, type: "text/plain; charset=utf-8", text: "request body over 1048576 bytes" });
  assert.deepEqual(calls, []);
});

test("a new probe takes over a socket left behind", async (t) => {
  const { stateRoot } = await probeSide(t);
  const second = await pylonVmHostBridge(stateRoot)(async () => ({ status: 200, body: "{}" }));
  t.after(() => second.close());
  const reply = await hostBridgeHook(hostBridgeSocket(stateRoot), "pylon-t1")(post(`${nexusApi}/v1/request`));
  assert.equal((reply as Response).status, 200);
});

test("a probe that starts before any pylon makes the state root, private to its user, as the backend would", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "nexus-bridge-"));
  t.after(() => rm(parent, { recursive: true }));
  const stateRoot = join(parent, "pylons");
  const bridge = await pylonVmHostBridge(stateRoot)(async () => ({ status: 200, body: "{}" }));
  t.after(() => bridge.close());
  assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
  const reply = await hostBridgeHook(hostBridgeSocket(stateRoot), "pylon-t1")(post(`${nexusApi}/v1/request`));
  assert.equal((reply as Response).status, 200);
});

test("a state root other users can read is refused, as the backend refuses it", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "nexus-bridge-"));
  t.after(() => rm(stateRoot, { recursive: true }));
  await chmod(stateRoot, 0o755);
  await assert.rejects(pylonVmHostBridge(stateRoot)(async () => ({ status: 200, body: "{}" })), /requires a private directory. .* is readable by others/);
});
