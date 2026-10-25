import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobFailure } from "../backend.ts";
import type { PylonId } from "../protocol.ts";
import { startGateway } from "./gateway.ts";
import { createTailscaleServe, readRoutes } from "./serve.ts";
import { fakeTailscale, nodeHost, viaGateway } from "./fake-tailscale.ts";

const a = "pylon-a" as PylonId;
const b = "pylon-b" as PylonId;
const foreign = "http://127.0.0.1:3000";

async function setup(t: import("node:test").TestContext, initial?: (gatewayOrigin: string) => Promise<string>) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-serve-"));
  t.after(() => rm(dir, { recursive: true }));
  const routesFile = join(dir, "routes.json");
  const gateway = await startGateway({ port: 0, routes: new Map(), origin: () => { throw new Error("unused"); }, onHit: () => {} });
  t.after(() => gateway.close());
  const tailscale = fakeTailscale(initial && await initial(gateway.origin));
  const warm = viaGateway(() => gateway.origin);
  const serve = createTailscaleServe({ cli: tailscale.cli, gateway, routesFile, get: warm.get });
  const signal = AbortSignal.timeout(5000);
  return { gateway, tailscale, warm, serve, signal, routesFile };
}

test("converge publishes exactly the assigned ports, warms each through the gateway, and a repeat changes nothing", async (t) => {
  const { gateway, tailscale, warm, serve, signal } = await setup(t);
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }, { service: "api", httpsPort: 10001 }], signal);
  assert.deepEqual(tailscale.entries(), { 10000: gateway.origin, 10001: gateway.origin });
  assert.deepEqual(warm.urls.sort(), [`https://${nodeHost}:10000/`, `https://${nodeHost}:10001/`]);

  const before = tailscale.changes.length;
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }, { service: "api", httpsPort: 10001 }], signal);
  assert.equal(tailscale.changes.length, before);
});

test("converge removes only this pylon's other ports, never another pylon's or a foreign entry", async (t) => {
  const { gateway, tailscale, serve, signal } = await setup(t);
  await tailscale.cli(["serve", "--bg", "--https=8443", foreign], signal);
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }, { service: "api", httpsPort: 10001 }], signal);
  await serve.converge(b, [{ service: "web", httpsPort: 10002 }], signal);

  await serve.converge(a, [{ service: "api", httpsPort: 10001 }], signal);
  assert.deepEqual(tailscale.entries(), { 8443: foreign, 10001: gateway.origin, 10002: gateway.origin });

  await serve.converge(a, [], signal);
  assert.deepEqual(tailscale.entries(), { 8443: foreign, 10002: gateway.origin });
});

test("after a restart, gateway entries no pylon has claimed are swept, and foreign ones are kept", async (t) => {
  // S6's capture of six live entries, pointed at this gateway, plus one entry Nexus does not own.
  const s6 = new URL("../../spikes/evidence/logs/s6-status-all-active-json.txt", import.meta.url);
  const { gateway, tailscale, serve, signal } = await setup(t, async (origin) => (await readFile(s6, "utf8")).replaceAll("http://127.0.0.1:18090", origin));
  await tailscale.cli(["serve", "--bg", "--https=8080", foreign], signal);

  await serve.converge(b, [{ service: "web", httpsPort: 10001 }], signal);
  assert.deepEqual(tailscale.entries(), { 8080: foreign, 10001: gateway.origin });
  assert.ok(!tailscale.changes.includes("serve --bg --https=10001 " + gateway.origin), "the existing entry is reused, not re-added");
});

test("a port that something else serves fails the job as invalid and changes nothing", async (t) => {
  const { tailscale, serve, signal } = await setup(t);
  await tailscale.cli(["serve", "--bg", "--https=10000", foreign], signal);
  const before = tailscale.changes.length;
  await assert.rejects(serve.converge(a, [{ service: "web", httpsPort: 10000 }], signal), (err) => err instanceof JobFailure && err.code === "invalid");
  assert.equal(tailscale.changes.length, before);
});

test("a warm-up that times out is retried until the URL answers", async (t) => {
  const { warm, serve, signal } = await setup(t);
  warm.failNext(2);
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }], signal);
  assert.equal(warm.urls.length, 3);
});

test("a URL that never answers stops at the job's deadline", async (t) => {
  const { warm, serve } = await setup(t);
  warm.failNext(Infinity);
  await assert.rejects(serve.converge(a, [{ service: "web", httpsPort: 10000 }], AbortSignal.timeout(300)), { name: "TimeoutError" });
});

test("a slow warm-up for one pylon does not hold up another pylon's publish", async (t) => {
  const { gateway, tailscale, warm, serve, signal } = await setup(t);
  const release = warm.hold(`https://${nodeHost}:10000/`);
  let aDone = false;
  const aConverged = serve.converge(a, [{ service: "web", httpsPort: 10000 }], signal).then(() => { aDone = true; });
  await serve.converge(b, [{ service: "web", httpsPort: 10001 }], signal);
  assert.equal(aDone, false);
  assert.deepEqual(tailscale.entries(), { 10000: gateway.origin, 10001: gateway.origin });
  release();
  await aConverged;
});

test("a converge that failed partway converges on retry", async (t) => {
  const { gateway, tailscale, serve, signal } = await setup(t);
  const previews = [{ service: "web", httpsPort: 10000 }, { service: "api", httpsPort: 10001 }];
  tailscale.failOnce(`serve --bg --https=10001 ${gateway.origin}`);
  await assert.rejects(serve.converge(a, previews, signal), /injected failure/);
  assert.deepEqual(tailscale.entries(), { 10000: gateway.origin });
  await serve.converge(a, previews, signal);
  assert.deepEqual(tailscale.entries(), { 10000: gateway.origin, 10001: gateway.origin });
  assert.deepEqual([...gateway.routes].sort(), [[10000, { pylonId: a, service: "web" }], [10001, { pylonId: a, service: "api" }]]);
});

test("every converge writes the route table, a missing file reads as empty, and a malformed one is refused", async (t) => {
  const { serve, signal, routesFile } = await setup(t);
  assert.deepEqual(await readRoutes(routesFile), new Map());
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }], signal);
  await serve.converge(b, [{ service: "api", httpsPort: 10001 }], signal);
  assert.deepEqual(await readRoutes(routesFile), new Map([[10000, { pylonId: a, service: "web" }], [10001, { pylonId: b, service: "api" }]]));
  await serve.converge(a, [], signal);
  assert.deepEqual(await readRoutes(routesFile), new Map([[10001, { pylonId: b, service: "api" }]]));
  await writeFile(routesFile, JSON.stringify({ 10001: "pylon-b" }));
  await assert.rejects(readRoutes(routesFile), /is not a list/);
});

test("withdraw stops routing a service's port at once, and the next converge of any pylon removes its entry", async (t) => {
  const { gateway, tailscale, warm, serve, signal, routesFile } = await setup(t);
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }, { service: "port-6006", httpsPort: 10001 }], signal);
  const unlinked = `https://${nodeHost}:10001/`;
  assert.equal(await warm.get(unlinked, {}, signal), 503, "a routed port whose pylon has no origin gets the waking answer");

  await serve.withdraw(a, "port-6006");
  assert.equal(await warm.get(unlinked, {}, signal), 404);
  assert.deepEqual(await readRoutes(routesFile), new Map([[10000, { pylonId: a, service: "web" }]]));
  assert.deepEqual(tailscale.entries(), { 10000: gateway.origin, 10001: gateway.origin });
  const before = tailscale.changes.length;
  await serve.withdraw(a, "port-6006");
  assert.equal(tailscale.changes.length, before);

  await serve.converge(b, [{ service: "web", httpsPort: 10002 }], signal);
  assert.deepEqual(tailscale.entries(), { 10000: gateway.origin, 10002: gateway.origin });
});

test("a spawn that carries a released port another pylon now holds fails, and leaves that pylon's route and entry alone", async (t) => {
  const { gateway, tailscale, warm, serve, signal } = await setup(t);
  const stale = [{ service: "web", httpsPort: 10000 }, { service: "port-6006", httpsPort: 10001 }];
  await serve.converge(a, stale, signal);
  await serve.withdraw(a, "port-6006");
  await serve.converge(b, [{ service: "web", httpsPort: 10001 }], signal);

  await assert.rejects(serve.converge(a, stale, signal), (err) => err instanceof JobFailure && err.code === "backend" && /10001 routes to pylon-b/.test(err.message));
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }], signal);
  assert.deepEqual(gateway.routes.get(10001), { pylonId: b, service: "web" });
  assert.deepEqual(tailscale.entries(), { 10000: gateway.origin, 10001: gateway.origin });
  assert.equal(await warm.get(`https://${nodeHost}:10001/`, { "x-nexus-warm": "pylon-b/web" }, signal), 204);
});

test("two pylons that each want the port the other still routes drop their own first, so both converge on retry", async (t) => {
  const { gateway, tailscale, serve, signal } = await setup(t);
  await serve.converge(a, [{ service: "web", httpsPort: 10001 }], signal);
  await serve.converge(b, [{ service: "web", httpsPort: 10002 }], signal);

  await assert.rejects(serve.converge(a, [{ service: "web", httpsPort: 10002 }], signal), (err) => err instanceof JobFailure && err.code === "backend");
  assert.deepEqual(tailscale.entries(), { 10002: gateway.origin }, "a's own obsolete entry went before its converge failed");
  await serve.converge(b, [{ service: "web", httpsPort: 10001 }], signal);
  await serve.converge(a, [{ service: "web", httpsPort: 10002 }], signal);
  assert.deepEqual([gateway.routes.get(10001), gateway.routes.get(10002)], [{ pylonId: b, service: "web" }, { pylonId: a, service: "web" }]);
});

test("a withdraw whose write failed writes the table when it is asked again", async (t) => {
  const { serve, signal, routesFile } = await setup(t);
  await serve.converge(a, [{ service: "web", httpsPort: 10000 }, { service: "port-6006", httpsPort: 10001 }], signal);
  // A directory where the write's temporary file goes makes the write fail.
  await mkdir(`${routesFile}.tmp`);
  await assert.rejects(serve.withdraw(a, "port-6006"), { code: "EISDIR" });
  await rm(`${routesFile}.tmp`, { recursive: true });
  await serve.withdraw(a, "port-6006");
  assert.deepEqual(await readRoutes(routesFile), new Map([[10000, { pylonId: a, service: "web" }]]));
});


test("an existing Unix target blocks an operator's preview additions and removals", async (t) => {
  const initial = JSON.stringify({
    TCP: { 443: { HTTPS: true }, 10200: { HTTPS: true } },
    Web: {
      [`${nodeHost}:443`]: { Handlers: { "/": { Proxy: "unix:/run/nexus-control/dashboard.sock" } } },
      [`${nodeHost}:10200`]: { Handlers: { "/": { Proxy: "GATEWAY" } } },
    },
  });
  const { tailscale, serve, signal } = await setup(t, async (origin) => initial.replace("GATEWAY", origin));
  const before = tailscale.entries();
  await assert.rejects(serve.converge(a, [{ service: "web", httpsPort: 10200 }, { service: "api", httpsPort: 10201 }], signal), /must be root/);
  await assert.rejects(serve.converge(a, [], signal), /must be root/);
  assert.deepEqual(tailscale.entries(), before);
  const admin = fakeTailscale(initial, true);
  await admin.cli(["serve", "--https=10200", "off"], signal);
  assert.deepEqual(admin.entries(), { 443: "unix:/run/nexus-control/dashboard.sock" });
});
