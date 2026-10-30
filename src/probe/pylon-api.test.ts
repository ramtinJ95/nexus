import { test } from "node:test";
import assert from "node:assert/strict";
import type { Guest } from "../backend.ts";
import { fakeGuest } from "../fake-guest.ts";
import { renderOverlay, type ProjectId, type PylonOverlay, type ServiceDecl } from "../project.ts";
import type { NodeName, PylonId } from "../ids.ts";
import type { ServiceFact } from "../protocol/observations.ts";
import { createPylonApi, pylonInfoFile, type PylonApiDeps } from "./pylon-api.ts";
import { until } from "../test-kit.ts";

const pylonId = "pylon-t1" as PylonId;
const overlay: PylonOverlay = {
  pylonId, threadId: "t1", project: "acme" as ProjectId, node: "infra-testbench" as NodeName,
  allowedHosts: ["github.com"], previews: [{ service: "web", url: "https://infra-testbench.tail0.ts.net:10101/" }],
  logins: ["claude"], dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, repo: { kind: "empty", branch: "main" }, secrets: [],
};
const pylonJson = renderOverlay(overlay).find((f) => f.path === pylonInfoFile)!.content;
const fact = (name: string, wantsPreview: boolean): ServiceFact => ({ name, state: "ready", port: 3000, declared: true, wantsPreview });
const url = (port: number) => `https://infra-testbench.tail0.ts.net:${port}/`;

/** The tailscale serve stand-in serves every port the test publishes. A call's wait for a URL only ends a hang, unless the test sets its own. */
function setup(guest: Partial<Guest>, deps: Partial<PylonApiDeps> = {}) {
  let changes = 0;
  const withdrawn: string[] = [];
  const relinked: string[] = [];
  const served = new Set<number>();
  let published: { service: string; httpsPort: number }[] = [];
  let serveStatusReads = 0;
  const base = fakeGuest((argv) => argv[0] === "cat" && argv[1] === pylonInfoFile ? { exitCode: 0, output: pylonJson } : { exitCode: 127, output: "unexpected" });
  const pylon = { ...base, ...guest };
  const api = createPylonApi({
    guest: () => pylon,
    published: () => published,
    changed: () => { changes++; },
    async previewUrls() {
      serveStatusReads++;
      return new Map([...served].map((port) => [port, url(port)]));
    },
    ports: {
      async link(_pylonId, port, title) {
        const service = await pylon.linkPort(port, title);
        relinked.push(service);
        return service;
      },
      async unlink(_pylonId, port) {
        const refused = await pylon.unlinkPort(port);
        if (refused === null) withdrawn.push(`port-${port}`);
        return refused;
      },
    },
    previewWaitMs: 60_000,
    ...deps,
  });
  return {
    api,
    changes: () => changes,
    withdrawn,
    relinked,
    serveStatusReads: () => serveStatusReads,
    publish(previews: { service: string; httpsPort: number }[]) {
      for (const p of previews) served.add(p.httpsPort);
      published = previews;
      api.republished();
    },
    async call(request: unknown) {
      const { status, body } = await api.answer(pylonId, typeof request === "string" ? request : JSON.stringify(request));
      return { status, reply: status === 200 ? JSON.parse(body) as unknown : body };
    },
  };
}

test("info prints the pylon.json the overlay wrote", async () => {
  const { call } = setup({});
  assert.deepEqual(await call({ op: "info" }), { status: 200, reply: JSON.parse(pylonJson) });
});

test("info refuses a pylon.json that names another pylon than the one the bridge named", async () => {
  const other = pylonJson.replace(pylonId, "pylon-other");
  const { call } = setup({ exec: async () => ({ exitCode: 0, output: other, truncated: false }) });
  const { status, reply } = await call({ op: "info" });
  assert.equal(status, 500);
  assert.match(String(reply), /names pylon-other, but the request came from pylon-t1/);
});

test("a body that is not a request this API takes is refused with 400", async () => {
  const { call } = setup({});
  for (const body of ["not json", { op: "shell" }, { op: "info", pylonId: "pylon-other" }, { op: "output-add", output: { kind: "file", path: "relative.png" } }, { op: "service-logs", name: "web", lines: 501 }]) {
    assert.equal((await call(body)).status, 400, JSON.stringify(body));
  }
  assert.match(String((await call("not json")).reply), /^not a request this API takes: request: Unexpected token/);
});

test("preview links the port, reports the change at once, and answers with the URL once a spawn publishes it", async () => {
  const linked: unknown[] = [];
  const t = setup({ async linkPort(port, title) { linked.push([port, title]); return "storybook"; } });
  const reply = t.call({ op: "preview", port: 6006, title: "Storybook" });
  await until("the call waits for the URL", () => t.changes() === 1);
  assert.deepEqual(linked, [[6006, "Storybook"]]);
  assert.equal(t.changes(), 1, "the control plane hears of the new service before the wait");
  assert.deepEqual(t.relinked, ["storybook"], "spawns may route it again after an earlier unpreview");
  t.publish([{ service: "storybook", httpsPort: 10102 }]);
  assert.deepEqual(await reply, { status: 200, reply: { service: "storybook", port: 6006, url: url(10102) } });
});

test("preview answers with no URL when nothing is published within the wait", async () => {
  const t = setup({ linkPort: async () => "storybook" }, { previewWaitMs: 50 });
  assert.deepEqual(await t.call({ op: "preview", port: 6006 }), { status: 200, reply: { service: "storybook", port: 6006, url: null } });
});

test("a preview published before the call answers at once", async () => {
  const t = setup({ linkPort: async () => "storybook" }, { previewWaitMs: 60_000 });
  t.publish([{ service: "storybook", httpsPort: 10102 }]);
  assert.deepEqual(await t.call({ op: "preview", port: 6006 }), { status: 200, reply: { service: "storybook", port: 6006, url: url(10102) } });
});

test("unpreview unlinks the port, withdraws its route and reports the change, and a refusal comes back as a 409 with the pylon's reason", async () => {
  const unlinked: number[] = [];
  const t = setup({ async unlinkPort(port) { unlinked.push(port); return null; } });
  assert.deepEqual(await t.call({ op: "unpreview", port: 6006 }), { status: 200, reply: { port: 6006 } });
  assert.deepEqual(unlinked, [6006]);
  assert.equal(t.changes(), 1, "the control plane hears the port is gone, which drops its preview");
  assert.deepEqual(t.withdrawn, ["port-6006"], "the gateway stops routing its URL before the reply");
  const owned = setup({ unlinkPort: async () => "Port 3000 is the preview of service web, not a linked port" });
  assert.deepEqual(await owned.call({ op: "unpreview", port: 3000 }), { status: 409, reply: "Port 3000 is the preview of service web, not a linked port" });
  assert.deepEqual([owned.changes(), owned.withdrawn], [0, []]);
});

test("services ensure waits for the URL of every service that wants a preview", async () => {
  const ops: unknown[] = [];
  const t = setup({ async services(op, name) { ops.push([op, name]); return { services: [fact("web", true), fact("worker", false)] }; } });
  const reply = t.call({ op: "services", action: "ensure" });
  await until("the call waits for the URL", () => t.changes() === 1);
  t.publish([{ service: "web", httpsPort: 10101 }]);
  assert.deepEqual(await reply, { status: 200, reply: { services: [{ ...fact("web", true), url: url(10101) }, { ...fact("worker", false), url: null }] } });
  assert.deepEqual(ops, [["ensure", undefined]]);
  assert.equal(t.changes(), 1);
});

test("services list neither waits nor reports a change", async () => {
  const t = setup({ services: async () => ({ services: [fact("web", true)] }) }, { previewWaitMs: 60_000 });
  assert.deepEqual(await t.call({ op: "services", action: "list" }), { status: 200, reply: { services: [{ ...fact("web", true), url: null }] } });
  assert.equal(t.changes(), 0);
});

test("services list reads tailscale's routes once for every preview, and not at all with none published", async () => {
  const t = setup({ services: async () => ({ services: [fact("web", true), fact("api", true), fact("worker", false)] }) });
  assert.deepEqual(await t.call({ op: "services", action: "list" }), { status: 200, reply: { services: [{ ...fact("web", true), url: null }, { ...fact("api", true), url: null }, { ...fact("worker", false), url: null }] } });
  assert.equal(t.serveStatusReads(), 0);
  t.publish([{ service: "web", httpsPort: 10101 }, { service: "api", httpsPort: 10102 }]);
  assert.deepEqual(await t.call({ op: "services", action: "list" }), { status: 200, reply: { services: [{ ...fact("web", true), url: url(10101) }, { ...fact("api", true), url: url(10102) }, { ...fact("worker", false), url: null }] } });
  assert.equal(t.serveStatusReads(), 1);
});

test("services restart and stop pass the name through", async () => {
  const ops: unknown[] = [];
  const t = setup({ async services(op, name) { ops.push([op, name]); return { services: [] }; } });
  await t.call({ op: "services", action: "restart", name: "web" });
  await t.call({ op: "services", action: "stop" });
  assert.deepEqual(ops, [["restart", "web"], ["stop", undefined]]);
});

test("service-start hands the declaration to the guest and waits for its URL", async () => {
  const started: unknown[] = [];
  const decl: ServiceDecl = { command: "pnpm storybook --port $PORT", preview: { title: "Storybook" } };
  const t = setup({ async startService(name, d) { started.push([name, d]); return [fact(name, true)]; } });
  const reply = t.call({ op: "service-start", name: "storybook", decl });
  await until("the call waits for the URL", () => t.changes() === 1);
  t.publish([{ service: "storybook", httpsPort: 10103 }]);
  assert.deepEqual(await reply, { status: 200, reply: { services: [{ ...fact("storybook", true), url: url(10103) }] } });
  assert.deepEqual(started, [["storybook", decl]]);
});

test("service-start refuses a declaration the services file would refuse", async () => {
  const t = setup({ startService: () => assert.fail("not started") });
  assert.equal((await t.call({ op: "service-start", name: "x", decl: { command: "run", env: { PORT: "1" } } })).status, 400);
});

test("service-logs answers with the guest's logs, and a guest failure is a 500 with its message", async () => {
  const t = setup({ async services(op, name, lines) { if (name === "gone") throw new Error("Unknown service gone"); return { services: [], logs: `${op} ${name} ${lines}\n` }; } });
  assert.deepEqual(await t.call({ op: "service-logs", name: "web", lines: 200 }), { status: 200, reply: { logs: "logs web 200\n" } });
  assert.deepEqual(await t.call({ op: "service-logs", name: "gone", lines: 10 }), { status: 500, reply: "Unknown service gone" });
});

test("the pylon CLI bridge refuses deploy, release mutation and arbitrary forwarded API routes", async () => {
  const { call } = setup({});
  for (const request of [
    { op: "deploy", commit: "main" },
    { op: "release", commit: "a".repeat(40) },
    { op: "request", method: "PUT", path: "/v1/release", body: { commit: "main" } },
    { op: "info", method: "PUT", path: "/v1/release" },
  ]) assert.equal((await call(request)).status, 400);
});

test("events are scoped by the bridge and reject guest-supplied thread identity", async () => {
  const accepted: unknown[] = [];
  const { call } = setup({}, { event: (pylon, event) => accepted.push({ pylon, event }) });
  assert.equal((await call({ op: "event", kind: "session.turn-ended", session: "c1" })).status, 200);
  assert.deepEqual(accepted, [{ pylon: pylonId, event: { kind: "session.turn-ended", session: "c1" } }]);
  for (const extra of [{ thread: "other" }, { kind: "thread.failed" }, { message: "a".repeat(2049) }]) {
    assert.equal((await call({ op: "event", kind: "session.turn-ended", ...extra })).status, 400);
  }
  assert.equal(accepted.length, 1);
});
