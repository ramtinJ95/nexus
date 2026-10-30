/**
 * The in-pylon `nexus` CLI (images/pylon/nexus) against the probe's real API over HTTP, with a fake guest behind
 * it. The bridge here names every caller pylon-t1, as a pylon's controller would.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Guest } from "./backend.ts";
import { fakeGuest } from "./fake-guest.ts";
import { renderOverlay, type ProjectId, type ServiceDecl } from "./project.ts";
import type { DeclaredOutput, NodeName, PylonId, ServiceFact } from "./protocol.ts";
import { listenHostBridge } from "./host-bridge.ts";
import { createPylonApi, pylonInfoFile } from "./probe/pylon-api.ts";
import { freePort } from "./test-kit.ts";

const cli = fileURLToPath(new URL("../images/pylon/nexus", import.meta.url));
const pylonId = "pylon-t1" as PylonId;
const pylonJson = renderOverlay({
  pylonId, threadId: "t1", project: "acme" as ProjectId, node: "infra-testbench" as NodeName, allowedHosts: ["github.com"],
  previews: [], logins: [], dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, repo: { kind: "empty", branch: "main" }, secrets: [],
}).find((f) => f.path === pylonInfoFile)!.content;
const web: ServiceFact = { name: "web", state: "ready", port: 3000, declared: true, wantsPreview: true };
const output: DeclaredOutput = { id: "out-1-00000000", kind: "file", path: "/home/user/workspace/repo/shot.png", title: "Shot", sha256: "0".repeat(64) };

/** Every guest call the CLI caused, as [member, ...args]. */
async function probe(t: TestContext, guest: Partial<Guest> = {}) {
  const calls: unknown[][] = [];
  const port = await freePort();
  const base = fakeGuest((argv) => {
    calls.push(["exec", ...argv]);
    if (argv[0] === "cat") return { exitCode: 0, output: pylonJson };
    // listOutputs prints each record as "<file>\t<json>".
    if (argv[2]?.includes("for f in")) return { exitCode: 0, output: `${output.id}.json\t${JSON.stringify(output)}\n` };
    if (argv[2]?.includes("sha256sum")) return { exitCode: 0, output: `${"a".repeat(64)}  -\n` };
    if (argv[2]?.includes(".json.partial")) return { exitCode: 0, output: "" };
    return { exitCode: 127, output: "unexpected" };
  });
  const pylon: Guest = {
    ...base,
    async services(op, name, lines) { calls.push(["services", op, name, lines]); return { services: [web], logs: "line 1\nline 2\n" }; },
    async startService(name, decl) { calls.push(["startService", name, decl]); return [{ ...web, name, declared: false }]; },
    async linkPort(p, title) { calls.push(["linkPort", p, title]); return `port-${p}`; },
    async unlinkPort(p) { calls.push(["unlinkPort", p]); return null; },
    ...guest,
  };
  const api = createPylonApi({
    event: (pylon, event) => { calls.push(["event", pylon, event]); },
    guest: () => pylon,
    published: () => [],
    changed() {},
    previewUrls: async () => new Map(),
    ports: {
      link: (_pylonId, p, title) => pylon.linkPort(p, title),
      async unlink(_pylonId, p) {
        const refused = await pylon.unlinkPort(p);
        if (refused === null) calls.push(["withdraw", `port-${p}`]);
        return refused;
      },
    },
    previewWaitMs: 50,
  });
  const bridge = await listenHostBridge({ host: "127.0.0.1", port }, async (req) => req.url === "/token/v1/request" ? pylonId : null)(api.answer);
  t.after(() => bridge.close());
  const nexus = (args: string[], cwd = process.cwd()) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("node", [cli, ...args], { cwd, env: { ...process.env, NEXUS_API: `http://127.0.0.1:${port}/token` } }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout, stderr });
    });
  });
  return { nexus, calls };
}

test("--version prints what the image smoke check expects", async (t) => {
  const { nexus, calls } = await probe(t);
  const { code, stdout } = await nexus(["--version"]);
  assert.equal(code, 0);
  assert.match(stdout, /^nexus \S+\n$/);
  assert.deepEqual(calls, []);
});

test("info prints the probe's reply, as JSON with --json", async (t) => {
  const { nexus } = await probe(t);
  assert.deepEqual(JSON.parse((await nexus(["info", "--json"])).stdout), JSON.parse(pylonJson));
  const human = await nexus(["info"]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /^Pylon: pylon-t1\nThread: t1\nProject: acme\nNode: infra-testbench\n/);
});

test("output add file sends the path resolved against the shell's working directory", async (t) => {
  const { nexus, calls } = await probe(t);
  const { code, stdout } = await nexus(["output", "add", "file", "shot.png", "--title", "Shot"], import.meta.dirname);
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`^Declared out-\\S+\\tfile\\t${import.meta.dirname}/shot.png\\tShot\\n$`));
  assert.equal(calls.find((c) => String(c[3]).includes("sha256sum"))?.at(-1), `${import.meta.dirname}/shot.png`, "the probe hashed the resolved path");
});

test("output list prints one line per output", async (t) => {
  const { nexus } = await probe(t);
  assert.deepEqual(await nexus(["output", "list"]), { code: 0, stdout: `${output.id}\tfile\t${output.path}\tShot\n`, stderr: "" });
  assert.deepEqual(JSON.parse((await nexus(["output", "list", "--json"])).stdout), { outputs: [output] });
});

test("service commands map to the probe's service operations", async (t) => {
  const { nexus, calls } = await probe(t);
  await nexus(["services", "ensure"]);
  await nexus(["services", "restart"]);
  await nexus(["service", "restart", "web"]);
  await nexus(["service", "stop", "web"]);
  assert.deepEqual(await nexus(["service", "logs", "web", "--lines", "50"]), { code: 0, stdout: "line 1\nline 2\n", stderr: "" });
  assert.deepEqual(calls, [
    ["services", "ensure", undefined, undefined],
    ["services", "restart", undefined, undefined],
    ["services", "restart", "web", undefined],
    ["services", "stop", "web", undefined],
    ["services", "logs", "web", 50],
  ]);
});

test("service start builds the declaration from its flags", async (t) => {
  const { nexus, calls } = await probe(t);
  await nexus(["service", "start", "storybook", "--command", "pnpm storybook --port $PORT", "--preview"]);
  await nexus(["service", "start", "docs", "--command", "serve", "--port", "6006", "--env", "A=1=2", "--title", "Docs", "--health", "/"]);
  const decls: ServiceDecl[] = [
    { command: "pnpm storybook --port $PORT", preview: true },
    { command: "serve", port: 6006, env: { A: "1=2" }, health: "/", preview: { title: "Docs" } },
  ];
  assert.deepEqual(calls, [["startService", "storybook", decls[0]], ["startService", "docs", decls[1]]]);
});

test("preview without a URL in time names the service, notes the wait, and exits 0", async (t) => {
  const { nexus, calls } = await probe(t);
  const { code, stdout, stderr } = await nexus(["preview", "6006", "--title", "Storybook"]);
  assert.equal(code, 0);
  assert.equal(stdout, "port-6006\t6006\t-\n");
  assert.match(stderr, /no preview URL for port-6006 yet/);
  assert.deepEqual(calls, [["linkPort", 6006, "Storybook"]]);
});

test("unpreview unlinks the port, and a port a service's preview owns is refused with the guest's message", async (t) => {
  const { nexus, calls } = await probe(t);
  const { code, stdout } = await nexus(["unpreview", "6006"]);
  assert.equal(code, 0);
  assert.match(stdout, /^Unpublished port 6006\./);
  assert.deepEqual(JSON.parse((await nexus(["unpreview", "6006", "--json"])).stdout), { port: 6006 });
  assert.deepEqual(calls, [["unlinkPort", 6006], ["withdraw", "port-6006"], ["unlinkPort", 6006], ["withdraw", "port-6006"]]);
  const owned = await probe(t, { unlinkPort: async () => "Port 3000 is the preview of service web, not a linked port" });
  assert.deepEqual(await owned.nexus(["unpreview", "3000"]), { code: 1, stdout: "", stderr: "nexus: Port 3000 is the preview of service web, not a linked port\n" });
});

test("a refused call prints the probe's message and exits 1", async (t) => {
  const { nexus } = await probe(t, { async services() { throw new Error("Unknown service nope"); } });
  assert.deepEqual(await nexus(["service", "restart", "nope"]), { code: 1, stdout: "", stderr: "nexus: Unknown service nope\n" });
});

test("bad arguments exit 64 without calling the probe", async (t) => {
  const { nexus, calls } = await probe(t);
  for (const args of [["preview", "abc"], ["unpreview", "abc"], ["service", "start", "x"], ["output", "add", "file"], ["info", "--bogus"], ["frobnicate"]]) {
    const { code, stderr } = await nexus(args);
    assert.equal(code, 64, args.join(" "));
    assert.match(stderr, /Run nexus --help/);
  }
  assert.deepEqual(calls, []);
});


test("event preserves the hook timestamp rather than replacing it at send time", async (t) => {
  const { nexus, calls } = await probe(t);
  const reply = await nexus(["event", "session.turn-ended", "--session", "c1", "--at", "1700000000000"]);
  assert.equal(reply.code, 0, reply.stderr);
  assert.deepEqual(calls, [["event", pylonId, { kind: "session.turn-ended", session: "c1", at: 1700000000000 }]]);
  assert.equal((await nexus(["event", "session.heartbeat", "--at", "-1"])).code, 64);
});
