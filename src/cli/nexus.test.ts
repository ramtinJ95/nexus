/**
 * The Mac nexus CLI as a process, against the control plane's real API with a fake harness behind it. Most calls
 * go through a fake SOCKS5 proxy that alone can resolve the API's name, as ts-home's proxy alone knows MagicDNS.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startApi } from "../control/api.ts";
import { fakeHarness } from "../control/fake-harness.ts";
import { openRegistry, type Thread } from "../control/registry.ts";
import type { ImageId, ImageManifest } from "../images.ts";
import type { Project, ProjectId } from "../project.ts";
import type { CommandResult, NodeName, PylonCommand, PylonId, ServiceFact, TailnetNodeId } from "../protocol.ts";
import { CliError, follow } from "./transport.ts";

const cli = fileURLToPath(new URL("./nexus.ts", import.meta.url));
const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
/** Only the fake proxy resolves this name, so a call that reaches the API went through it. */
const apiName = "nexus.test";
const project: Project = {
  id: "acme" as ProjectId, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image: ImageManifest = {
  id: "img-0123456789ab" as ImageId, gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: "d", node: "24.22.1", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f",
  },
};

async function listening(t: TestContext, server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as { port: number }).port;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A SOCKS5 proxy without authentication. A `reply` other than 0 refuses every CONNECT with that code, and "close"
 * hangs up after the greeting instead.
 */
async function socksProxy(t: TestContext, reply: number | "close" = 0) {
  const connects: string[] = [];
  const server = createServer((client) => {
    client.on("error", () => {});
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      if (reply === "close") return void client.end();
      client.once("data", (req: Buffer) => {
        const length = req[4]!;
        const host = req.subarray(5, 5 + length).toString();
        const port = req.readUInt16BE(5 + length);
        connects.push(`${host}:${port}`);
        if (reply !== 0) return void client.end(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
        const upstream = connect(port, host === apiName ? "127.0.0.1" : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(upstream).pipe(client);
        });
        upstream.on("error", () => client.destroy());
      });
    });
  });
  return { port: await listening(t, server), connects };
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
  const registry = openRegistry(join(dir, "registry.db"));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.createProject(project);
  registry.saveImage(image);
  registry.setCurrentImage(image.id);
  let caller: TailnetNodeId = laptop;
  /** What the node's probe answers a guest command with. Tests replace it. */
  let answer = async (command: PylonCommand): Promise<CommandResult> =>
    command.kind === "unlink-port" ? { kind: "unlink-port", refused: null }
    : command.kind === "open-session" ? { kind: "open-session", herdrPane: "w1:p1" }
    : command.kind === "close-session" ? { kind: "close-session" }
    : { kind: "link-port", service: `port-${(command as { port: number }).port}` };
  const commands: PylonCommand[] = [];
  const fake = fakeHarness();
  const options = (port: number) => ({
    registry, host: "127.0.0.1", port, whois: async () => caller, allowed: new Set([laptop]),
    hostnames: new Set([apiName, "127.0.0.1"]), dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
    harness: fake.harness, wake: () => {}, previewPorts: { first: 10200, last: 10299 },
    probes: new Map([[node, { command: (_pylonId: PylonId, command: PylonCommand) => { commands.push(command); return answer(command); } }]]),
  });
  let api = await startApi(options(0));
  t.after(async () => {
    await api.close();
    registry.close();
    await rm(dir, { recursive: true });
  });
  const proxy = await socksProxy(t);
  const home = join(dir, "home");
  await mkdir(home);
  /** The environment of a CLI run: a home of its own, and the API through the proxy. */
  const env = (overrides: Record<string, string> = {}) => ({
    PATH: process.env.PATH!, HOME: home, NEXUS_URL: `http://${apiName}:${api.port}`, NEXUS_SOCKS: `127.0.0.1:${proxy.port}`, ...overrides,
  });
  function nexus(args: readonly string[], overrides?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(process.execPath, [cli, ...args], { env: env(overrides) }, (err, stdout, stderr) => {
        resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout, stderr });
      });
    });
  }
  async function json(args: readonly string[], overrides?: Record<string, string>): Promise<any> {
    const res = await nexus([...args, "--json"], overrides);
    assert.equal(res.code, 0, res.stderr);
    return JSON.parse(res.stdout);
  }
  return {
    registry, fake, proxy, home, api, env, nexus, json, commands,
    callAs(id: TailnetNodeId) { caller = id; },
    probeAnswers(next: typeof answer) { answer = next; },
    localUrl: `http://127.0.0.1:${api.port}`,
    /** Stops the control plane, which drops every connection, and returns a function that starts it again on its port. */
    async stop() {
      const { port } = api;
      await api.close();
      return async () => { api = await startApi(options(port)); };
    },
  };
}

test("the CLI runs a thread's life through the SOCKS proxy, and --json prints the API's replies", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.json(["projects"]), [project]);
  assert.deepEqual((await s.json(["nodes"])).map((n: { name: string }) => n.name), [node]);

  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "\n  Fix the build  \nand run the tests"]);
  assert.equal(thread.title, "Fix the build", "a thread started with a message is titled by its first line");
  // The first message is human activity, so only the time of the last one moved since the start replied.
  const stable = ({ lastHumanActivityAt: _, ...rest }: Thread) => rest;
  assert.deepEqual(stable(s.registry.thread(thread.id)!), stable(thread));
  assert.deepEqual(s.fake.calls.at(-1)?.slice(0, 3), ["send", thread.id, "\n  Fix the build  \nand run the tests"]);
  assert.deepEqual((await s.json(["threads"])).map(stable), [{ ...stable(thread), desired: "running", pylon: { node, actualState: "unknown", failed: null } }],
    "a row carries what the planner wants of the pylon and what its node last reported");
  assert.deepEqual(await s.json(["threads", "--project", "other"]), []);

  assert.deepEqual(await s.json(["send", thread.id, "now", "the", "lint"]), { submission: 7 });
  const [, , text, requestId, mode] = s.fake.calls.at(-1)!;
  assert.deepEqual([text, mode], ["now the lint", "followUp"]);
  assert.match(requestId as string, /^msg:[0-9a-f-]{36}$/);
  await s.json(["send", thread.id, "stop that", "--steer", "--request-id", "msg:fixed"]);
  assert.deepEqual(s.fake.calls.at(-1), ["send", thread.id, "stop that", "msg:fixed", "steer"]);

  const shown = await s.json(["show", thread.id]);
  assert.equal(shown.thread.id, thread.id);
  assert.equal(shown.desired, "running", "a thread with fresh human activity wants its pylon running");
  assert.deepEqual(shown.pylon, { id: thread.pylonId, node, actualState: "unknown", failed: null, observedAt: null, retryRefused: null });
  assert.deepEqual((await s.json(["conversation", thread.id])).entries.map((e: { id: number }) => e.id), [1, 2, 3]);
  const human = await s.nexus(["conversation", thread.id]);
  assert.equal(human.stdout, "> \n>   Fix the build  \n> and run the tests\n\n> now the lint\n\n> stop that\n");

  assert.equal((await s.json(["archive", thread.id])).status, "archived");
  assert.equal((await s.nexus(["send", thread.id, "x"])).code, 5, "an archived thread takes no messages");
  assert.equal((await s.json(["unarchive", thread.id])).status, "active");
  assert.equal(await s.json(["abort", thread.id]), null, "a route that answers 204 prints null");
  assert.equal(await s.json(["retry", thread.id]), null);
  assert.equal(await s.json(["wake", thread.id]), null);
  assert.deepEqual(s.fake.calls.slice(-2).map((c) => c[0]), ["abort", "retry"]);

  assert.equal((await s.json(["delete", thread.id])).status, "deleted");
  assert.deepEqual(await s.json(["threads"]), [], "deleted threads are hidden");
  assert.equal((await s.json(["threads", "--all"]))[0].status, "deleted");
  assert.ok(s.proxy.connects.length > 0 && s.proxy.connects.every((c) => c === `${apiName}:${s.api.port}`), "the proxy resolved the API's name");
});

test("each failure has its own exit code, and with --json its error is one JSON line on stderr", async (t) => {
  const s = await setup(t);
  const fails = async (args: readonly string[], code: number, error: Record<string, unknown>, overrides?: Record<string, string>) => {
    const res = await s.nexus([...args, "--json"], overrides);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    const reported = JSON.parse(res.stderr);
    assert.deepEqual(Object.fromEntries(Object.keys(error).map((k) => [k, reported[k]])), error);
    return reported.error as string;
  };

  await fails(["show", "th-missing"], 4, { kind: "not-found", status: 404, error: "no thread th-missing" });
  await fails(["start", "--project", "nope", "--title", "x"], 4, { kind: "not-found", status: 404 });
  const { id } = await s.json(["start", "--project", "acme", "--title", "x"]);
  await fails(["unarchive", id], 5, { kind: "conflict", status: 409 });
  await fails(["retry-pylon", id], 5, { kind: "conflict", status: 409, error: `pylon pylon-${id} has not failed` });
  await fails(["start", "--title", "x"], 64, { kind: "invalid", status: null });
  await fails(["start", "--project", "acme", "--node", "nowhere", "--title", "x"], 64, { kind: "invalid", status: 400, error: "no node nowhere" });
  await fails(["show"], 64, { kind: "invalid", status: null });

  const down = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${await closedPort()}` });
  assert.match(down, /nothing is listening on the SOCKS proxy .*ts-home/);
  const refusing = await socksProxy(t, 4);
  const offline = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${refusing.port}` });
  assert.match(offline, /could not reach nexus\.test:\d+: host unreachable\. The node may be offline/);
  const hangingUp = await socksProxy(t, "close");
  const closed = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${hangingUp.port}` });
  assert.match(closed, /closed the connection before answering the CONNECT/);

  s.callAs("nSTRANGER" as TailnetNodeId);
  await fails(["threads"], 3, { kind: "refused", status: 403 });

  const human = await s.nexus(["threads"]);
  assert.deepEqual([human.code, human.stderr], [3, "nexus: caller is not a tailnet node this control plane allows\n"], "without --json the error is plain text");
});

test("the URL and the proxy come from the flags, then the environment, then the config file", async (t) => {
  const s = await setup(t);
  const unset = { NEXUS_URL: "", NEXUS_SOCKS: "" };
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const config = join(s.home, ".config", "nexus", "cli.json");
  await mkdir(join(s.home, ".config", "nexus"), { recursive: true });

  await writeFile(config, JSON.stringify({ url: s.localUrl, socks: "none" }));
  assert.deepEqual(await s.json(["projects"], unset), [project], "the config file connects directly");
  assert.equal((await s.nexus(["projects"], { ...unset, NEXUS_URL: dead })).code, 2, "the environment overrides the file");
  assert.deepEqual(await s.json(["projects", "--url", s.localUrl], { ...unset, NEXUS_URL: dead }), [project], "a flag overrides the environment");
  assert.deepEqual(await s.json(["projects", "--socks", "none", "--url", s.localUrl]), [project], "--socks none overrides the environment's proxy");

  await writeFile(config, JSON.stringify({ url: s.localUrl, proxy: "x" }));
  const bad = await s.nexus(["projects"], unset);
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /cli\.json is not a CLI config/);
});

test("project add creates a project with the contract's defaults or its flags, and maps the API's refusals", async (t) => {
  const s = await setup(t);
  const repo = "https://github.com/octocat/Hello-World.git";
  const added = await s.nexus(["project", "add", "hello", repo, "--node", node]);
  assert.deepEqual([added.code, added.stdout, added.stderr], [0, `Added project hello (${repo}) on ${node}\n`, ""]);
  assert.deepEqual(s.registry.project("hello" as ProjectId), {
    id: "hello", repoUrl: repo, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  }, "an unflagged project gets main, 2 CPUs, 4 GiB of memory and 10 GiB of disk");

  const custom = await s.json([
    "project", "add", "custom", "git@github.com:octocat/Spoon-Knife.git", "--node", node, "--branch", "dev", "--cpus", "4", "--memory", "8", "--disk", "20",
    "--allow-host", "registry.npmjs.org", "--login", "claude", "--allow-host", "api.stripe.com", "--login", "chatgpt",
  ]);
  assert.deepEqual(custom, {
    id: "custom", repoUrl: "git@github.com:octocat/Spoon-Knife.git", defaultBranch: "dev", defaultNode: node,
    resources: { cpus: 4, memoryGiB: 8, diskGiB: 20 }, allowedHosts: ["registry.npmjs.org", "api.stripe.com"], secrets: [], logins: ["claude", "chatgpt"], preSetup: null,
  }, "--json prints the created project, with each repeated flag's values in order");
  assert.deepEqual(s.registry.project("custom" as ProjectId), custom);
  assert.deepEqual((await s.json(["projects"])).map((p: Project) => p.id).toSorted(), ["acme", "custom", "hello"]);

  const fails = async (args: readonly string[], code: number, error: Record<string, unknown>, overrides?: Record<string, string>) => {
    const res = await s.nexus([...args, "--json"], overrides);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    const reported = JSON.parse(res.stderr);
    assert.deepEqual(Object.fromEntries(Object.keys(error).map((k) => [k, reported[k]])), error);
  };
  await fails(["project", "add", "hello", repo, "--node", node], 5, { kind: "conflict", status: 409, error: "project hello exists" });
  await fails(["project", "add", "other", repo, "--node", "nowhere"], 64, { kind: "invalid", status: 400, error: "no node nowhere" });
  await fails(["project", "add", "Not_An_Id", repo, "--node", node], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", "https://", "--node", node], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", repo, "--node", node, "--login", "gemini"], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", repo, "--node", node, "--cpus", "two"], 64, { kind: "invalid", status: null, error: "--cpus takes a whole number, got two" });
  await fails(["project", "add", "other", repo], 64, { kind: "invalid", status: null, error: "project add needs --node. Run nexus nodes to list them" });
  await fails(["project", "add", "other", repo], 64, { kind: "invalid", status: null, error: "project add needs --node. Run nexus nodes to list them" },
    { NEXUS_SOCKS: `127.0.0.1:${await closedPort()}` }); // with no proxy too, because it sends no request
  await fails(["project", "add", "other"], 64, { kind: "invalid", status: null, error: "project add takes 2 arguments, got 1" });
  await fails(["project", "other"], 64, { kind: "invalid", status: null, error: "unknown command project" });
  assert.deepEqual(s.registry.projects().map((p) => p.id).toSorted(), ["acme", "custom", "hello"], "no refused project was created");

  const human = await s.nexus(["project", "add", "other", repo]);
  assert.deepEqual([human.code, human.stderr], [64, "nexus: project add needs --node. Run nexus nodes to list them. Run nexus --help for usage\n"]);
});

/** The JSON lines a watch prints, one at a time. */
function watchLines(t: TestContext, s: Awaited<ReturnType<typeof setup>>, args: readonly string[], interval = 50) {
  const child = spawn(process.execPath, [cli, "watch", ...args, "--json", "--interval", String(interval)], { env: s.env() });
  t.after(() => { child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    async next(): Promise<any> {
      const timeout = AbortSignal.timeout(10_000);
      const line = await Promise.race([lines.next(), once(timeout, "abort").then(() => assert.fail(`no line from watch. stderr: ${stderr}`))]);
      assert.ok(!line.done, `watch ended early. stderr: ${stderr}`);
      return JSON.parse(line.value);
    },
  };
}

/** Reports the node online with the thread's pylon running these services and listening on these ports. */
function observeRunning(s: Awaited<ReturnType<typeof setup>>, thread: Thread, services: ServiceFact[], ports: number[]) {
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested({
    node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], previewRoutes: [],
    pylons: [{
      pylonId: thread.pylonId, phase: "running", liveHash: s.registry.pylon(thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
      bootedFrom: { image: image.id, checkpoint: null }, services, listening: ports.map((port) => ({ port })), previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    }],
  }, []);
}

test("ports lists what the pylon listens on, and preview publishes one and waits until it is served", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "ports"]);
  assert.deepEqual(await s.json(["ports", thread.id]), [], "a pylon that does not run listens on nothing");
  observeRunning(s, thread, [], [3000]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 3000, service: null, preview: null }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `3000  -  -\n\`nexus preview ${thread.id} <port>\` publishes a port.\n`);

  const preview = { pylon: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual(await s.json(["preview", thread.id, "3000"]), preview, "the reply names the URL before it is served");
  const waiting = s.json(["preview", thread.id, "3000", "--wait"]);
  await new Promise((r) => setTimeout(r, 1500)); // the wait polls a published preview that is not served yet
  observeRunning(s, thread, [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], [3000]);
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: true });
  assert.deepEqual(await waiting, { ...preview, ready: true });
  assert.equal((await s.nexus(["preview", thread.id, "3000", "--wait"])).stdout, `${preview.url}\n`);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `3000  port-3000  ${preview.url}\n`);
  assert.equal((await s.nexus(["preview", thread.id, "http"])).code, 64);
});

test("show reports a published preview whose service failed as not ready, and why", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "failed web"]);
  const web = (state: ServiceFact["state"]): ServiceFact => ({ name: "web", state, port: 8003, declared: true, wantsPreview: true });
  observeRunning(s, thread, [web("ready")], [8003]);
  s.registry.allocatePreviews(thread.pylonId, ["web"], { first: 10200, last: 10299 });
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "web", httpsPort: 10200, ready: true });
  const preview = { pylon: thread.pylonId, service: "web", httpsPort: 10200, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual((await s.json(["show", thread.id])).previews, [preview]);

  observeRunning(s, thread, [web("failed")], []);
  const failed = "the service web failed. `nexus service logs web` in the pylon shows why";
  assert.deepEqual((await s.json(["show", thread.id])).previews, [{ ...preview, ready: false, failed }], "the node still publishes it, but nothing answers");
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^preview: web at ${preview.url}, not ready: the service web failed\\. \`nexus service logs web\` in the pylon shows why$`, "m"));

  // A service that listens but fails its health check is failed too.
  observeRunning(s, thread, [web("failed")], [8003]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 8003, service: "web", preview: { ...preview, ready: false, failed } }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `8003  web  ${preview.url} (its service failed)\n`);

  observeRunning(s, thread, [web("ready")], [8003]);
  assert.deepEqual((await s.json(["show", thread.id])).previews, [preview], "a restarted service's preview is ready again");
});

test("a preview from a control plane older than Preview.failed reads as not failed", async (t) => {
  const s = await setup(t);
  // That control plane's shapes: a Preview with no `failed`.
  const web = { pylon: "pylon-th-old", service: "web", httpsPort: 10200, ready: true, url: "https://rj-firebat.tail.ts.net:10200/" };
  const api = { ...web, service: "api", httpsPort: 10201, ready: false, url: "https://rj-firebat.tail.ts.net:10201/" };
  const detail = {
    thread: { id: "th-old", title: "old", project: "acme", status: "active", agentTurnRunning: false },
    pylon: { id: "pylon-th-old", node, actualState: "running", failed: null, observedAt: null, retryRefused: null },
    sessions: [], previews: [api, web], ports: [{ port: 3000, service: "web", preview: web }, { port: 4000, service: "api", preview: api }], outputs: [], agent: null,
  };
  const old = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "POST" ? web : detail));
  });
  const overrides = { NEXUS_URL: `http://${apiName}:${await listening(t, old)}` };
  const run = async (args: string[]) => {
    const res = await s.nexus(args, overrides);
    assert.equal(res.code, 0, res.stderr);
    return res.stdout;
  };
  const shown = await run(["show", "th-old"]);
  assert.match(shown, /^preview: api at https:\/\/rj-firebat\.tail\.ts\.net:10201\/, not ready$/m);
  assert.match(shown, /^preview: web at https:\/\/rj-firebat\.tail\.ts\.net:10200\/$/m);
  assert.equal(await run(["ports", "th-old"]), `3000  web  ${web.url}\n4000  api  ${api.url} (not served yet)\n`);
  assert.equal(await run(["preview", "th-old", "3000"]), `${web.url}\n`);
});

test("unpreview unpublishes a port, waits for a paused pylon to run, and fails with the contract's exit codes", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "unpreview"]);
  observeRunning(s, thread, [], [3000]);
  const preview = await s.json(["preview", thread.id, "3000"]);
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 3000, service: null, preview: null }]);
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null, "a port with no linked preview succeeds");
  assert.equal((await s.nexus(["unpreview", thread.id, "3000"])).stdout, `Unpublished port 3000 of ${thread.id}.\n`);
  assert.deepEqual(await s.json(["preview", thread.id, "3000"]), preview, "the port can be published again");

  let refusals = 2;
  s.probeAnswers(async (command) => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return { kind: "unlink-port", refused: null };
  });
  s.commands.length = 0;
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null, "a paused pylon is woken and asked again until it runs");
  assert.deepEqual(s.commands, Array(3).fill({ kind: "unlink-port", port: 3000 }));

  const fails = async (args: string[], code: number) => {
    const res = await s.nexus([...args, "--json"]);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    return JSON.parse(res.stderr) as { error: string; kind: string; status: number | null };
  };
  const reason = "Port 5173 is the preview of service web, not a linked port. Remove the preview from /home/user/workspace/repo/.nexus/services.yaml to unpublish it";
  s.probeAnswers(async () => ({ kind: "unlink-port", refused: reason }));
  s.commands.length = 0;
  assert.deepEqual(await fails(["unpreview", thread.id, "5173"], 1), { error: reason, kind: "failed", status: 422 }, "the refusal is the pylon's reason alone, and is not tried again");
  assert.equal(s.commands.length, 1);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  await fails(["unpreview", thread.id, "3000"], 1);
  s.commands.length = 0;
  for (const port of ["http", "0", "70000"]) await fails(["unpreview", thread.id, port], 64);
  assert.deepEqual(s.commands, [], "a bad port never reaches the API");
  await s.json(["archive", thread.id]);
  await fails(["unpreview", thread.id, "3000"], 5);
  await s.json(["delete", thread.id]);
  await fails(["unpreview", thread.id, "3000"], 5);
});

test("session open opens Claude Code by default, waits for a paused pylon, and session close closes a pane", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "sessions"]);
  assert.deepEqual(await s.json(["session", "open", thread.id]), { herdrPane: "w1:p1", harness: "claude-code", title: "claude-code" });
  assert.equal((await s.nexus(["session", "open", thread.id, "--harness", "pi", "--title", "plan"])).stdout,
    `Opened pi session "plan" in pane w1:p1 of ${thread.id}. \`nexus attach ${thread.id}\` attaches to it.\n`);
  assert.deepEqual(s.commands, [{ kind: "open-session", harness: "claude-code", title: "claude-code" }, { kind: "open-session", harness: "pi", title: "plan" }]);

  let refusals = 2;
  s.probeAnswers(async () => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return { kind: "close-session" };
  });
  s.commands.length = 0;
  assert.equal(await s.json(["session", "close", thread.id, "w1:p1"]), null, "a paused pylon is woken and asked again until it runs");
  assert.deepEqual(s.commands, Array(3).fill({ kind: "close-session", herdrPane: "w1:p1" }));

  assert.equal((await s.nexus(["session", "open", thread.id, "--harness", "codex"])).code, 64);
  assert.equal((await s.nexus(["session", "close", thread.id])).code, 64);
  await s.json(["archive", thread.id]);
  s.commands.length = 0;
  const archived = await s.nexus(["session", "open", thread.id]);
  assert.equal(archived.code, 5);
  assert.match(archived.stderr, /is archived, so its pylon stays paused/);
  assert.deepEqual(s.commands, []);
});

test("attach wakes the pylon, waits until it runs, and runs ssh to its node through the CLI's proxy, or the configured command", async (t) => {
  const s = await setup(t);
  const bin = join(s.home, "bin");
  await mkdir(bin);
  const ran = join(s.home, "ran");
  // A fake ssh that records its arguments, one to a line.
  await writeFile(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${ran}'\n`, { mode: 0o755 });
  const path = { PATH: `${bin}:${process.env.PATH}` };
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "attach"]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const before = Date.now();

  const attaching = s.nexus(["attach", thread.id], path);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before, "attaching is human activity, which wakes the pylon");
  observeRunning(s, thread, [], []);
  const attached = await attaching;
  assert.equal(attached.code, 0, attached.stderr);
  assert.deepEqual((await readFile(ran, "utf8")).trimEnd().split("\n"),
    ["-t", "-o", `ProxyCommand=nc -X 5 -x 127.0.0.1:${s.proxy.port} %h %p`, "rj-firebat.tail.ts.net", "nexus-attach", thread.pylonId]);

  // Without the proxy only the API's loopback address reaches it.
  const direct = await s.nexus(["attach", thread.id, "--socks", "none", "--url", s.localUrl], path);
  assert.equal(direct.code, 0, direct.stderr);
  assert.deepEqual((await readFile(ran, "utf8")).trimEnd().split("\n"), ["-t", "rj-firebat.tail.ts.net", "nexus-attach", thread.pylonId], "without a proxy, plain ssh");

  const custom = `printf '%s %s %s %s' "$NEXUS_THREAD" "$NEXUS_PYLON" "$NEXUS_NODE" "$NEXUS_NODE_HOST" > '${ran}'`;
  assert.equal((await s.nexus(["attach", thread.id], { ...path, NEXUS_ATTACH: custom })).code, 0);
  assert.equal(await readFile(ran, "utf8"), `${thread.id} ${thread.pylonId} rj-firebat rj-firebat.tail.ts.net`);
  await mkdir(join(s.home, ".config", "nexus"), { recursive: true });
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), JSON.stringify({ attach: "exit 3" }));
  const failed = await s.nexus(["attach", thread.id], path);
  assert.equal(failed.code, 1, "the config's command runs, and its failure is the CLI's");
  assert.match(failed.stderr, /attaching to th-[0-9a-f]+ on rj-firebat failed: the attach command from NEXUS_ATTACH or the config exited 3/);
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), "{}");
  await writeFile(join(bin, "ssh"), "#!/bin/sh\nexit 255\n", { mode: 0o755 });
  const unreachable = await s.nexus(["attach", thread.id], path);
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.stderr, /ssh to rj-firebat\.tail\.ts\.net exited 255. To reach the node another way, set NEXUS_ATTACH/, "a failed ssh names the escape hatch");

  await s.json(["archive", thread.id]);
  const archived = await s.nexus(["attach", thread.id], path);
  assert.equal(archived.code, 5);
  assert.match(archived.stderr, /is archived, so its pylon stays paused. `nexus unarchive/);
});

test("watch prints the backlog, then each new entry and state change, and ends when the thread is deleted", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id]);
  const exited = once(watch.child, "exit");

  const first = await watch.next();
  assert.deepEqual([first.type, first.entries.map((e: any) => [e.entry.id, e.entry.kind, e.text])], ["reset", [[1, "pi.user", "> hi"]]], "the first poll prints the context whole");
  const state = { type: "state", thread: thread.id, status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "unknown", failed: null, ports: [] };
  assert.deepEqual(await watch.next(), state);
  const quiet = { type: "live", thread: thread.id, queued: [], tools: [], partial: null, retry: null };
  assert.deepEqual(await watch.next(), quiet, "the run in flight follows the first state");

  s.fake.transcript(thread.id).messages.push({
    role: "assistant", content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
    stopReason: "toolUse", timestamp: Date.now(),
  } as never);
  s.fake.commit(thread.id);
  const answer = await watch.next();
  assert.deepEqual([answer.type, answer.entry.id, answer.text], ["entry", 2, 'On it.\n[tool] bash {"command":"npm test"}']);

  s.fake.transcript(thread.id).docs["pi.live"] = {
    run: { taskId: 1, inputs: [] },
    tools: [{ callId: "c1", status: "running", output: "PASS 3/9" }, { callId: "c0", status: "done", output: "old" }],
    generation: { message: { role: "assistant", content: [{ type: "text", text: "Tests are " }, { type: "text", text: "running." }] }, retry: { error: "overloaded" } },
  };
  s.fake.transcript(thread.id).docs["pi.inbox"] = { items: [{ id: 9, mode: "followUp", content: "and then?" }, { id: 10, mode: "write", content: "x" }] };
  s.fake.commit(thread.id);
  assert.deepEqual(await watch.next(), { ...state, run: "working", queued: 1 });
  assert.deepEqual(await watch.next(), {
    ...quiet, queued: ["and then?"], tools: [{ callId: "c1", output: "PASS 3/9" }], partial: "Tests are running.", retry: "overloaded",
  }, "live carries the queued texts, the running tools' output, the streaming answer and a pending retry");

  await s.json(["delete", thread.id]);
  assert.deepEqual(await watch.next(), { ...state, run: "idle", status: "deleted", queued: 0 }, "a deleted thread has no conversation to be busy");
  assert.deepEqual(await exited, [0, null]);
});

test("a watch whose consumer is killed outright exits, though an idle thread never writes to the dead pipe", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "idle"]);
  const out = join(await mkdtemp(join(tmpdir(), "nexus-orphan-")), "watch.jsonl");
  // The shell starts the watch with its output in a file, so killing the shell leaves no pipe for the watch to find closed.
  const sh = spawn("sh", ["-c", `"$0" "$1" watch "$2" --json --interval 50 > "$3" 2>&1 & echo $!; wait`, process.execPath, cli, thread.id, out], { env: s.env() });
  t.after(() => { sh.kill("SIGKILL"); });
  const [pidLine] = await once(sh.stdout, "data") as [Buffer];
  const pid = Number(pidLine.toString().trim());
  t.after(() => { try { process.kill(pid); } catch {} });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; !(await readFile(out, "utf8").catch(() => "")).includes('"type":"state"'); i++) {
    assert.ok(i < 200, "the watch printed the thread's state");
    await new Promise((r) => setTimeout(r, 50));
  }
  sh.kill("SIGKILL");
  await once(sh, "exit");
  for (let i = 0; alive(); i++) {
    assert.ok(i < 100, "the orphaned watch exited");
    await new Promise((r) => setTimeout(r, 50));
  }
});

/** An entry as pi-durable serves it, holding one user message. */
const userEntry = (id: number, text: string) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] }) as never;

test("watch prints the whole context again when it changes other than by an append", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "one"]);
  await s.json(["send", thread.id, "two"]);
  const transcript = s.fake.transcript(thread.id);
  const watch = watchLines(t, s, [thread.id]);
  const ids = (event: any) => [event.type, event.entries?.map((e: any) => e.entry.id) ?? event.entry.id];
  assert.deepEqual(ids(await watch.next()), ["reset", [1, 2]]);
  assert.equal((await watch.next()).type, "state");
  assert.equal((await watch.next()).type, "live");

  // A new head marker leads the active context, ahead of entries older than itself.
  transcript.entries = [userEntry(12, "summary"), userEntry(10, "one")];
  s.fake.commit(thread.id);
  const reordered = await watch.next();
  assert.deepEqual(ids(reordered), ["reset", [12, 10]]);
  assert.deepEqual(reordered.entries.map((e: any) => e.text), ["> summary", "> one"]);
  transcript.entries = [...transcript.entries, userEntry(14, "three")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["entry", 14], "an append to the new context is one entry");

  // A compaction drops what it summarized.
  transcript.entries = [userEntry(15, "compacted"), userEntry(14, "three")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["reset", [15, 14]]);
  transcript.entries = [userEntry(15, "compacted")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["reset", [15]], "a context that lost its last entry is printed whole");
});

/** The run in flight with this partial answer, as pi-durable's live document holds it. */
const streaming = (partial: string) => ({ run: { taskId: 1, inputs: [] }, tools: [], generation: { message: { role: "assistant", content: [{ type: "text", text: partial }] } } });

test("watch prints each commit of the run as it streams, between polls, and an answer's entry before the live event that drops it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  // One poll in the whole test, so everything after the first prints comes from the stream.
  const watch = watchLines(t, s, [thread.id], 600_000);
  assert.equal((await watch.next()).type, "reset");
  assert.equal((await watch.next()).type, "state");
  assert.equal((await watch.next()).partial, null);

  const transcript = s.fake.transcript(thread.id);
  transcript.docs["pi.live"] = streaming("The");
  s.fake.commit(thread.id);
  assert.deepEqual(await watch.next(), { type: "state", thread: thread.id, status: "active", run: "working", parkedTasks: 0, queued: 0, pylon: "unknown", failed: null, ports: [] });
  assert.equal((await watch.next()).partial, "The");
  for (const partial of ["The build", "The build passes", "The build passes."]) {
    transcript.docs["pi.live"] = streaming(partial);
    s.fake.commit(thread.id);
    assert.deepEqual(await watch.next(), { type: "live", thread: thread.id, queued: [], tools: [], partial, retry: null }, "each commit of the partial is one live event");
  }

  // pi-durable commits the answer and clears the live document together.
  transcript.messages.push({ role: "assistant", content: [{ type: "text", text: "The build passes." }], stopReason: "stop", timestamp: Date.now() } as never);
  transcript.docs["pi.live"] = {};
  s.fake.commit(thread.id);
  const answer = await watch.next();
  assert.deepEqual([answer.type, answer.text], ["entry", "The build passes."]);
  assert.equal((await watch.next()).run, "idle");
  assert.equal((await watch.next()).partial, null, "the partial goes once its entry is printed");
});

test("watch opens a dropped stream again, reports the outage once, and prints the state again when the control plane is back", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id]);
  assert.equal((await watch.next()).type, "reset");
  const state = await watch.next();
  assert.equal((await watch.next()).type, "live");
  assert.equal(s.fake.watching(thread.id), 1);

  const restart = await s.stop();
  const errors = [await watch.next()];
  // The poll and the stream both retry while it is down, every 50 ms.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await restart();
  let back = await watch.next();
  for (; back.type === "error"; back = await watch.next()) errors.push(back);
  assert.ok(errors.every((e) => e.type === "error" && e.kind === "unreachable"), JSON.stringify(errors));
  assert.equal(new Set(errors.map((e) => e.message)).size, errors.length, "each message is reported once, whichever source failed with it");
  assert.deepEqual(back, state, "the state again says the control plane is back");

  s.fake.transcript(thread.id).docs["pi.live"] = streaming("Back");
  s.fake.commit(thread.id);
  assert.equal((await watch.next()).run, "working");
  assert.equal((await watch.next()).partial, "Back", "the stream follows the control plane that came back");
  assert.equal(s.fake.watching(thread.id), 1, "the old stream's watch stopped when its connection dropped");
});

test("watch ends with the API's exit code when it refuses the stream", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "x"]);
  s.callAs("nSTRANGER" as TailnetNodeId);
  const res = await s.nexus(["watch", thread.id, "--json", "--interval", "50"]);
  assert.equal(res.code, 3, res.stderr);
  assert.equal(JSON.parse(res.stderr).kind, "refused");
});

test("a stream refused with a reply cut off mid-body fails as unreachable rather than hanging", { timeout: 5_000 }, async (t) => {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"err');
      setTimeout(() => socket.destroy(), 20);
    });
  });
  const port = await listening(t, server);
  await assert.rejects(follow({ url: new URL(`http://127.0.0.1:${port}`), socks: null }, "/v1/threads/th-x/events", () => {}, new AbortController().signal),
    (err) => err instanceof CliError && err.kind === "unreachable");
});

test("a config file that cannot be read fails as invalid, in JSON under --json", async (t) => {
  const s = await setup(t);
  // A directory where the file should be.
  await mkdir(join(s.home, ".config", "nexus", "cli.json"), { recursive: true });
  const res = await s.nexus(["projects", "--json"]);
  assert.equal(res.code, 64);
  const { error, ...rest } = JSON.parse(res.stderr);
  assert.deepEqual(rest, { kind: "invalid", status: null });
  assert.match(error, /^cannot read .*cli\.json: EISDIR/);
});
test("a thread ID is one path segment", async (t) => {
  const s = await setup(t);
  const res = await s.nexus(["show", `../projects?${randomUUID()}`, "--json"]);
  assert.equal(res.code, 4, res.stderr);
});
