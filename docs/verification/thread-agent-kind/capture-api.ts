// Starts the real control-plane API on loopback, as src/control/api.test.ts does, with the tests' fake harness and a
// fake probe whose pipes read a Claude transcript from a local folder, and writes what clients see of a harness
// thread, a Claude worker thread (started, and one still pending) and a bare thread: every agent route's status and
// reply, each event stream's bytes, the thread page, and the nexus CLI's show, conversation, send and watch, while
// active, archived and deleted.
// Run from the root of a checkout: node docs/verification/thread-agent-kind/capture-api.ts <out-file>
import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { json, normaliser } from "./normalise.ts";

// One fixed clock, so the two checkouts store and print the same times.
const now = Date.parse("2026-10-27T12:00:00Z");
Date.now = () => now;

const { startApi } = await import("../../../src/control/api.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
const { claudeProjects } = await import("../../../src/claude-transcript.ts");
const { processStream } = await import("../../../src/process-stream.ts");
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;
type NodeName = import("../../../src/protocol.ts").NodeName;
type PylonCommand = import("../../../src/protocol.ts").PylonCommand;
type CommandResult = import("../../../src/protocol.ts").CommandResult;
type ImageId = import("../../../src/images.ts").ImageId;
type Thread = import("../../../src/control/registry.ts").Thread;

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);
const dir = await mkdtemp(join(tmpdir(), "agent-kind-capture-"));

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const project = {
  id: "acme", repoUrl: "https://example.com/acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
const session = "11111111-2222-4333-8444-555555555501";
const fixture = (await readFile("src/fixtures/claude-transcript.jsonl", "utf8")).split("\n").filter((l) => l !== "").map((l) => `${l}\n`);
const projects = join(dir, "projects");
await mkdir(join(projects, "-home-user-workspace-repo"), { recursive: true });
const transcript = join(projects, "-home-user-workspace-repo", `${session}.jsonl`);
await writeFile(transcript, fixture.slice(0, 40).join(""));

const registry = openRegistry(join(dir, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
const fake = fakeHarness({ onParked: (id, parked) => registry.recordParked(id as never, parked) });
const commands: PylonCommand[] = [];
const answer = async (command: PylonCommand): Promise<CommandResult> => {
  if (command.kind === "send-claude") return { kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false };
  throw new Error(`unexpected ${command.kind} command`);
};
const startThread = threadStarter({
  registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  mirror: { setupInputs: () => Promise.reject(new Error("no remote")) },
});
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, whois: async () => laptop, allowed: new Set([laptop]),
  hostnames: new Set(["127.0.0.1"]), harness: fake.harness, startThread, wake: () => {},
  probes: new Map([[node, {
    command: (_pylonId: unknown, command: PylonCommand) => { commands.push(command); return answer(command); },
    stream: (_pylonId: unknown, argv: readonly string[]) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {}),
  }]]) as never,
  previewPorts: { first: 10200, last: 10299 },
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; type: string | undefined; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    request({
      host: "127.0.0.1", port: api.port, method, path,
      headers: { host: `127.0.0.1:${api.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], text }));
    }).on("error", reject).end(payload);
  });
}

/** An open event stream: its status and headers, and each event's raw bytes as they arrive. */
function openStream(path: string) {
  const events: string[] = [];
  let held = "";
  let wake = () => {};
  const req = request({ host: "127.0.0.1", port: api.port, path, headers: { host: `127.0.0.1:${api.port}`, accept: "text/event-stream" } });
  req.on("error", () => {});
  req.end();
  const response = new Promise<{ status: number; type: string | undefined; cache: string | undefined; error: string }>((resolve) => {
    req.on("response", (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (chunk: string) => {
        if (res.statusCode !== 200) { body += chunk; return; }
        held += chunk;
        const blocks = held.split("\n\n");
        held = blocks.pop()!;
        events.push(...blocks);
        wake();
      });
      res.on("error", () => {});
      res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], cache: res.headers["cache-control"], error: body }));
      if (res.statusCode === 200) resolve({ status: 200, type: res.headers["content-type"], cache: res.headers["cache-control"], error: "" });
    });
  });
  return {
    response,
    /** The next event's bytes, or a note that none came within 5 s. */
    async next(): Promise<string> {
      for (const deadline = performance.now() + 5_000; events.length === 0 && performance.now() < deadline;) {
        await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), sleep(100)]);
      }
      return events.shift() ?? "(no event within 5 s)";
    },
    close() { req.destroy(); },
  };
}

const scrubbers: [string, string][] = [];
// The CLI runs on the real clock, so how long ago the frozen clock's times were depends on when the capture runs.
const scrub = (text: string) => scrubbers.reduce((t, [from, to]) => t.replaceAll(from, to), text).replaceAll(`127.0.0.1:${api.port}`, "127.0.0.1:<port>").replace(/\b\d+[smhd] ago\b/g, "<ago>");
const named = (t: Thread, name: string) => { scrubbers.push([t.pylonId, `<${name} pylon>`], [t.id, `<${name}>`]); return t; };

if ((await call("POST", "/v1/projects", project)).status !== 201) throw new Error("the project was refused");
if ((await call("POST", "/v1/images", image)).status !== 201) throw new Error("the image was refused");
registry.setCurrentImage(image.id as ImageId);

log("# POST /v1/threads for a harness thread with a first message, a Claude worker and a pending Claude worker, and the bare thread's start");
const started = async (body: object, name: string) => {
  const res = await call("POST", "/v1/threads", body);
  const t = named(JSON.parse(res.text) as Thread, name);
  log(scrub(`${json(body)} => ${res.status} ${res.type} ${res.text}`));
  return t;
};
const harness = await started({ project: "acme", title: "Harness", message: "first message" }, "harness");
const claude = await started({ project: "acme", title: "Claude", claude: "fix it", model: "claude-sonnet-5-5" }, "claude");
const pending = await started({ project: "acme", title: "Pending", claude: "later" }, "pending");
const bare = named(await startThread({ project: "acme", title: "Bare", bare: true }, laptop), "bare");
log(scrub(`bare start => ${JSON.stringify(bare)}`));
const threads = { harness, claude, pending, bare };
log(scrub(`harness calls: ${json(fake.calls.splice(0))}`));

registry.setClaudeWorker(claude.id, "/poteto-mode fix it", "started", undefined, session);
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
registry.apply({ record: "node", node, state: "online", capacity });
const running = (t: Thread) => ({
  pylonId: t.pylonId, phase: "running" as const, liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
  bootedFrom: { image: image.id as `img-${string}`, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
});
registry.ingested({ node, observedAt: new Date(now).toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: Object.values(threads).map(running), grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
fake.transcript(harness.id).messages.push({ role: "assistant", content: [{ type: "text", text: "On it." }], api: "x", provider: "openai", model: "gpt-6-astra", usage: {}, stopReason: "stop", timestamp: now } as never);
fake.commit(harness.id);

const body = (res: { status: number; type: string | undefined; text: string }) => scrub(`${res.status} ${res.type ?? ""} ${res.text}`);
const streamPaths = (t: Thread) => [`/v1/threads/${t.id}/events`, `/v1/threads/${t.id}/claude/events`, `/threads/${t.id}/stream`];

async function routes(when: string) {
  for (const [name, t] of Object.entries(threads)) {
    log("");
    log(`## ${name} thread, ${when}`);
    log(`GET /v1/threads/<${name}> => ${body(await call("GET", `/v1/threads/${t.id}`))}`);
    log(`GET /v1/threads/<${name}>/conversation => ${body(await call("GET", `/v1/threads/${t.id}/conversation`))}`);
    for (const path of streamPaths(t)) {
      const stream = openStream(path);
      const res = await stream.response;
      log(scrub(`GET ${path} => ${res.status} ${res.type} ${res.cache ?? ""} ${res.error}`));
      if (res.status === 200) log(scrub(`  first event: ${await stream.next()}`));
      stream.close();
    }
    const page = await call("GET", `/threads/${t.id}`);
    log(`GET /threads/<${name}> => ${page.status} ${page.type}`);
    for (const line of page.text.split("\n")) log(scrub(`  | ${line}`));
  }
}

async function actions(when: string, requestId: string) {
  log("");
  log(`## the agent actions, ${when}`);
  for (const [name, t] of Object.entries(threads)) {
    for (const [method, path, payload] of [
      ["POST", `/v1/threads/${t.id}/messages`, { text: `hello ${name}`, requestId }],
      ["POST", `/v1/threads/${t.id}/messages`, { text: "", requestId }],
      ["POST", `/v1/threads/${t.id}/abort`, undefined],
      ["POST", `/v1/threads/${t.id}/retry`, undefined],
    ] as const) {
      const res = await call(method, path, payload);
      log(scrub(`${method} ${path.replace(t.id, `<${name}>`)} ${payload === undefined ? "" : json(payload)} => ${body(res)} probe got ${json(commands.splice(0))} harness got ${json(fake.calls.splice(0))}`));
    }
  }
}

const nexus = (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
  execFile(process.execPath, ["--no-warnings", "src/cli/nexus.ts", ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent/nexus-capture-home", NEXUS_URL: `http://127.0.0.1:${api.port}`, NEXUS_SOCKS: "none" } }, (err, stdout, stderr) => {
    resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr });
  });
});
const printed = (prefix: string, text: string) => text.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1).map((l) => scrub(`${prefix}: ${l}`));

/** A watch's lines until it has been quiet for a second, then it is stopped. */
function watch(args: readonly string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "src/cli/nexus.ts", "watch", ...args, "--interval", "200"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent/nexus-capture-home", NEXUS_URL: `http://127.0.0.1:${api.port}`, NEXUS_SOCKS: "none" } });
    let stdout = "";
    let stderr = "";
    let quiet: NodeJS.Timeout;
    const settle = () => { clearTimeout(quiet); quiet = setTimeout(() => child.kill(), 1_000); };
    child.stdout.on("data", (chunk) => { stdout += chunk; settle(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; settle(); });
    settle();
    child.on("exit", (code, signal) => resolve([`exit ${code ?? signal}`, ...printed("stdout", stdout), ...printed("stderr", stderr)]));
  });
}

async function cli(when: string, send: boolean) {
  log("");
  log(`## the nexus CLI, as a process, ${when}`);
  for (const [name, t] of Object.entries(threads)) {
    for (const args of [["show", t.id], ["conversation", t.id], ["conversation", t.id, "--json"], ...send ? [["send", t.id, "from", "the", "cli", "--request-id", `cli:${when}`]] : []]) {
      const r = await nexus(args);
      log(scrub(`$ nexus ${args.join(" ")} => exit ${r.code}, probe got ${json(commands.splice(0))}, harness got ${json(fake.calls.filter(([kind]) => kind !== "watch" && kind !== "unwatch"))}`));
      fake.calls.length = 0;
      for (const line of [...printed("stdout", r.stdout), ...printed("stderr", r.stderr)]) log(line);
    }
    for (const args of [[t.id], [t.id, "--json"]]) {
      log(scrub(`$ nexus watch ${args.join(" ")}`));
      for (const line of await watch(args)) log(scrub(line));
    }
    fake.calls.length = 0;
  }
}

await routes("active");
await actions("active", "msg:active");

log("");
log("## each stream after a change: a harness message, and the Claude transcript growing");
const followed = [
  [`/v1/threads/${harness.id}/events`, harness], [`/threads/${harness.id}/stream`, harness],
  [`/v1/threads/${claude.id}/claude/events`, claude], [`/threads/${claude.id}/stream`, claude],
] as const;
const streams = followed.map(([path]) => ({ path, stream: openStream(path) }));
for (const { path, stream } of streams) log(scrub(`GET ${path} => ${(await stream.response).status}, first event: ${await stream.next()}`));
fake.transcript(harness.id).messages.push({ role: "user", content: "and then?", timestamp: now });
fake.commit(harness.id);
await appendFile(transcript, fixture.slice(40).join(""));
await call("GET", `/v1/threads/${claude.id}/conversation`);
for (const { path, stream } of streams) {
  log(scrub(`GET ${path}, next event: ${await stream.next()}`));
  stream.close();
}
fake.calls.length = 0;

log("");
log(`GET /v1/threads => ${body(await call("GET", "/v1/threads"))}`);
await cli("active", true);

for (const t of Object.values(threads)) log(scrub(`POST /v1/threads/${t.id}/archive => ${body(await call("POST", `/v1/threads/${t.id}/archive`))}`));
await routes("archived");
await actions("archived", "msg:archived");
await cli("archived", true);
for (const t of Object.values(threads)) log(scrub(`POST /v1/threads/${t.id}/unarchive => ${body(await call("POST", `/v1/threads/${t.id}/unarchive`))}`));
fake.calls.length = 0;

for (const t of Object.values(threads)) log(scrub(`DELETE /v1/threads/${t.id} => ${body(await call("DELETE", `/v1/threads/${t.id}`))} harness got ${json(fake.calls.splice(0))}`));
await routes("deleted");
await actions("deleted", "msg:deleted");
await cli("deleted", false);
log("");
log(`GET /v1/threads => ${body(await call("GET", "/v1/threads"))}`);

await api.close();
registry.close();
await rm(dir, { recursive: true });
const norm = normaliser();
await writeFile(out, lines.map(norm).join("\n") + "\n");
process.exit(0);
