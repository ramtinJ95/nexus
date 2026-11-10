/**
 * The in-pylon `nexus` CLI (images/pylon/nexus) against the probe's real API over HTTP, with a fake guest behind
 * it. The bridge here names every caller pylon-t1, as a pylon's controller would.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Guest } from "../backends/backend.ts";
import { fakeGuest } from "../backends/fake-guest.ts";
import { renderOverlay } from "../control/overlay.ts";
import type { ProjectId } from "../ids.ts";
import type { ServiceDecl } from "../services-file.ts";
import type { NodeName, PylonId } from "../ids.ts";
import type { DeclaredOutput, ServiceFact } from "../protocol/observations.ts";
import { listenHostBridge } from "../host-bridge.ts";
import { createServer } from "node:http";
import { createPylonApi, type PylonApiDeps } from "../probe/pylon-api.ts";
import { freePort } from "../test-support/kit.ts";
import { pylonInfoFile, sessionKinds } from "../../images/pylon/nexus-contract.ts";

const cli = fileURLToPath(new URL("../../images/pylon/nexus", import.meta.url));
const pylonId = "pylon-t1" as PylonId;
const pylonJson = renderOverlay({
  pylonId, threadId: "t1", project: "acme" as ProjectId, node: "infra-testbench" as NodeName, allowedHosts: ["github.com"],
  previews: [], logins: [], dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, repo: { kind: "empty", branch: "main" }, secrets: [], reviewsBuilders: false,
}).find((f) => f.path === pylonInfoFile)!.content;
const web: ServiceFact = { name: "web", state: "ready", port: 3000, declared: true, wantsPreview: true };
const output: DeclaredOutput = { id: "out-1-00000000", kind: "file", path: "/home/user/workspace/repo/shot.png", title: "Shot", sha256: "0".repeat(64) };

/** Every guest call the CLI caused, as [member, ...args]. */
async function probe(t: TestContext, guest: Partial<Guest> = {}, deps: Partial<PylonApiDeps> = {}) {
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
    ...deps,
  });
  const bridge = await listenHostBridge({ host: "127.0.0.1", port }, async (req) => req.url === "/token/v1/request" ? pylonId : null)(api.answer);
  t.after(() => bridge.close());
  return { nexus: (args: string[], cwd?: string) => run(`http://127.0.0.1:${port}/token`, args, cwd), calls };
}

function run(api: string, args: string[], cwd = process.cwd()) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("node", [cli, ...args], { cwd, env: { ...process.env, NEXUS_API: api } }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout, stderr });
    });
  });
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

test("preview without a URL in time prints nothing on stdout, says why on stderr, and exits 1", async (t) => {
  const { nexus, calls } = await probe(t);
  const { code, stdout, stderr } = await nexus(["preview", "6006", "--title", "Storybook"]);
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /no preview URL for port-6006 yet.*Port 6006 stays published, and `nexus preview 6006 --wait` waits for its URL\n$/);
  assert.deepEqual(calls, [["linkPort", 6006, "Storybook"]]);
  assert.deepEqual(await nexus(["preview", "6006", "--json"]), { code: 0, stdout: `${JSON.stringify({ service: "port-6006", port: 6006, url: null }, null, 2)}\n`, stderr: "" });
});

test("preview --wait asks again until the port has a URL, and prints only the URL", async (t) => {
  let links = 0;
  const url = "https://pylon-t1.example.ts.net:8443/";
  const { nexus, calls } = await probe(t, { async linkPort(p) { links += 1; return `port-${p}`; } }, {
    published: () => links < 2 ? [] : [{ service: "port-3000", httpsPort: 8443 }],
    previewUrls: async () => new Map([[8443, url]]),
  });
  assert.deepEqual(await nexus(["preview", "3000", "--wait"]), { code: 0, stdout: `${url}\n`, stderr: "" });
  assert.equal(links, 2, "the first reply had no URL, so it asked once more");
});

test("--help and -h print usage without calling the probe, the whole of it at the top and a command's own lines after one", async (t) => {
  const { nexus, calls } = await probe(t);
  const top = await nexus(["-h"]);
  assert.equal(top.code, 0);
  assert.match(top.stdout, /^nexus \S+, the Nexus pylon CLI\n/);
  assert.equal((await nexus(["--help"])).stdout, top.stdout);
  for (const args of [["preview", "--help"], ["preview", "3000", "-h"], ["help", "preview"]]) {
    const { code, stdout } = await nexus(args);
    assert.equal(code, 0, args.join(" "));
    assert.match(stdout, /^ {2}nexus preview <port> \[--title T\] \[--wait\]/, args.join(" "));
    assert.doesNotMatch(stdout, /nexus service|nexus unpreview/, args.join(" "));
  }
  const service = (await nexus(["service", "--help"])).stdout;
  assert.match(service, /nexus service start <name>/);
  assert.doesNotMatch(service, /nexus services/);
  assert.match((await nexus(["output", "add", "--help"])).stdout, /nexus output add file[\s\S]*nexus output list/);
  assert.equal((await nexus(["show", "--help"])).code, 64);
  assert.deepEqual(calls, []);
});

test("bare services and service list the services", async (t) => {
  const { nexus, calls } = await probe(t);
  for (const word of ["services", "service"]) assert.deepEqual(await nexus([word]), { code: 0, stdout: "web\tready\t3000\t-\n", stderr: "nexus: no preview URL for web yet. Nexus publishes it once the control plane assigns a port, and `nexus services list` shows it then\n" });
  assert.deepEqual(calls, [["services", "list", undefined, undefined], ["services", "list", undefined, undefined]]);
});

test("an event of an unknown kind names the kinds", async (t) => {
  const { nexus, calls } = await probe(t);
  const { code, stderr } = await nexus(["event", "foo"]);
  assert.equal(code, 64);
  assert.match(stderr, new RegExp(`^nexus: not a pylon event kind: foo\\. The kinds are ${sessionKinds.join(", ")}\\.`));
  assert.deepEqual(calls, []);
});

test("a command of the person's CLI says this is the pylon's CLI and what it offers", async (t) => {
  const { nexus, calls } = await probe(t);
  const { code, stderr } = await nexus(["show", "th-1"]);
  assert.equal(code, 64);
  assert.match(stderr, /^nexus: unknown command: show th-1\. This is the pylon's nexus CLI, .* The person's nexus CLI, which docs\/cli\.md describes, runs on their machine and is not here\. This one offers event, info, services, service, preview, unpreview, output\. Run nexus --help/);
  assert.deepEqual(calls, []);
});

test("under --json every failure is one JSON line on stderr with the probe's status", async (t) => {
  const { nexus } = await probe(t, { async services() { throw new Error("Unknown service nope"); } });
  assert.deepEqual(await nexus(["service", "restart", "nope", "--json"]), { code: 1, stdout: "", stderr: `${JSON.stringify({ error: "Unknown service nope", status: 500 })}\n` });
  const usage = await nexus(["preview", "abc", "--json"]);
  assert.equal(usage.code, 64);
  assert.equal(JSON.parse(usage.stderr).status, null);
  assert.match(JSON.parse(usage.stderr).error, /^the port must be a whole number, got abc\./);
  const port = await freePort();
  const gone = await run(`http://127.0.0.1:${port}`, ["info", "--json"]);
  assert.equal(gone.code, 1);
  assert.deepEqual({ ...JSON.parse(gone.stderr), error: "" }, { error: "", status: null });
  assert.match(JSON.parse(gone.stderr).error, /^cannot reach /);
});

test("a 200 whose body is not JSON is a failure, not a stack trace", async (t) => {
  const server = createServer((_, res) => res.end("<html>proxy</html>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.deepEqual(await run(api, ["info"]), { code: 1, stdout: "", stderr: "nexus: the probe answered 200 with a body that is not JSON: <html>proxy</html>\n" });
  assert.deepEqual(await run(api, ["info", "--json"]), { code: 1, stdout: "", stderr: `${JSON.stringify({ error: "the probe answered 200 with a body that is not JSON: <html>proxy</html>", status: 200 })}\n` });
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
