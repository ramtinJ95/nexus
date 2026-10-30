import { createHash } from "node:crypto";
import { reportSchema, type DeploymentOptions } from "./releases.ts";
import { attentionOf } from "./attention.ts";
import { checkoutReader } from "../checkout-files.ts";
import { claudeTurn, snapshotTurn } from "../../images/pylon/nexus-turn.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { claudeProjects, maxRecordBytes, type ClaudeConversation } from "../claude-transcript.ts";
import { claudeHook } from "../../images/pylon/nexus-ask.ts";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { maxStreams, startApi } from "./api.ts";
import type { ThreadDetail, ThreadRow } from "./wire.ts";
import { version } from "../version.ts";
import type { Question } from "./questions.ts";
import type { Judgment } from "./judgment.ts";
import { threadStarter } from "./threads.ts";
import { pipeline, type PipelineItem } from "./pipeline.ts";
import { planning } from "./planning.ts";
import { planningPrefix } from "../agent-protocol.ts";
import { threadQueue, type QueuedThread } from "./queue.ts";
import { turnGate, type TurnGate } from "./drain.ts";
import type { AttachTiming } from "./attach.ts";
import type { ReviewLoop } from "./review.ts";
import { agentReader } from "./agent-conversation.ts";
import { readEvents } from "./event-reader.ts";
import { fakeHarness } from "./fake-harness.ts";
import { openRegistry, type JoinedNode, type Registry, type Thread, type ThreadId } from "./registry.ts";
import { joinTokenTtlMs, mintJoinToken } from "./join.ts";
import { startImageRollout, type ImageRollout } from "./image-rollout.ts";
import { usageBackfill, type UsageBackfillJob } from "./usage-backfill.ts";
import { imageIdOf, type ImageId, type ImageRecipe } from "../images.ts";
import { githubTokenGrant, liveHashOf, type ProjectId } from "../project.ts";
import type { ProjectMirror, TemplateRecord } from "../images.ts";
import { ingest } from "../reconcile.ts";
import { processStream } from "../process-stream.ts";
import { repoInitCommand } from "../pylon-vm-backend.ts";
import { parseProbeConfig } from "../probe/config.ts";
import { attachScript, checkoutDir, focusScript } from "../sessions.ts";
import { encodeMessage } from "../attach-wire.ts";
import { terminalSize } from "../guest-terminal.ts";
import { releaseOutcome, reportStates, tokenDigest, type ReleaseReport } from "../deploy/model.ts";
import { call as callJson, testImage, until } from "../test-kit.ts";
import type { JobId, NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { NodeObservation, PausedSession, ServiceFact } from "../protocol/observations.ts";
import type { CommandResult, InterruptClaudeOutcome, PylonCommand } from "../protocol/commands.ts";
import type { ByteStream, StreamEnd } from "../protocol/streams.ts";
import type { NodeHealth } from "../protocol/client.ts";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
/** An allowed person's device that is not a deployer. */
const phone = "nPHONE" as TailnetNodeId;
const project = {
  id: "acme", repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: ["registry.npmjs.org"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }], logins: ["chatgpt"], preSetup: null,
};
const image = testImage();

const dotfiles = { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" };

const dir = await mkdtemp(join(tmpdir(), "nexus-api-"));
after(() => rm(dir, { recursive: true }));

const claudeSession = "11111111-2222-4333-8444-555555555501";
/** The lines of a real Claude Code 2.1.308 transcript, each with its newline. */
const fixture = (await readFile(new URL("../fixtures/claude-transcript.jsonl", import.meta.url), "utf8")).split("\n").filter((line) => line !== "").map((line) => `${line}\n`);
const usageLimitRecord = (await readFile(new URL("../fixtures/claude-api-errors.jsonl", import.meta.url), "utf8")).split("\n")[0]! + "\n";

async function setup(t: import("node:test").TestContext, options: { gitIdentity?: { name: string; email: string }; https?: import("./api.ts").ApiOptions["https"]; whois?: import("../tailscale.ts").Whois; deployment?: DeploymentOptions | null; dotfiles?: typeof dotfiles; streamStallMs?: number; attachTiming?: AttachTiming; closeWaitMs?: number; reviews?: ReviewLoop; images?: (registry: Registry) => ImageRollout; queue?: boolean; pipeline?: boolean; usageBackfill?: (registry: Registry) => UsageBackfillJob; gate?: TurnGate } = {}) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  const images = options.images?.(registry);
  const backfill = options.usageBackfill?.(registry);
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  let caller: TailnetNodeId | null = laptop;
  /** Every whois waits for it, so a test can hold a request at admission, and tells `asked` it got there. */
  let admitted = Promise.resolve();
  let asked = () => {};
  const woken: NodeName[] = [];
  /** What `POST /v1/join` recorded, and the MagicDNS name whois gives each caller that joins. */
  const joined: JoinedNode[] = [];
  const hosts = new Map<TailnetNodeId, string>();
  const fake = fakeHarness({ onParked: (id, parked) => registry.recordParked(id as ThreadId, parked) });
  const { harness, calls } = fake;
  const commands: [PylonId, PylonCommand][] = [];
  /** What the node's probe answers a guest command with. Tests replace it. */
  let answer = async (command: PylonCommand): Promise<CommandResult> => {
    if (command.kind === "link-port") return { kind: "link-port", service: `port-${command.port}` };
    if (command.kind === "unlink-port") return { kind: "unlink-port", refused: null };
    if (command.kind === "open-session") return { kind: "open-session", herdrPane: "w1:p1" };
    if (command.kind === "close-session") return { kind: "close-session", outcome: "closed" };
    if (command.kind === "drop-failed-session") return { kind: "drop-failed-session", dropped: true };
    if (command.kind === "exec") return { kind: "exec", exitCode: 0, output: "", truncated: false };
    throw new Error(`unexpected ${command.kind} command`);
  };
  const streams: [PylonId, readonly string[]][] = [];
  /** What the node's probe opens a pipe to. Tests replace it. */
  let pipe = async (argv: readonly string[]): Promise<ByteStream> => { throw new Error(`unexpected stream ${argv[0]}`); };
  let health = async (): Promise<NodeHealth> => { throw new Error("unexpected node health read"); };
  /** What a project's remote answers a setup read with. Tests replace it. */
  let read: ProjectMirror["setupInputs"] = () => Promise.reject(new Error("this test has no remote"));
  const reads: Parameters<ProjectMirror["setupInputs"]>[1][] = [];
  const wake = (n: NodeName) => { woken.push(n); };
  const mirror: ProjectMirror = { setupInputs(p, ref) { reads.push(ref); return read(p, ref); } };
  const startThread = threadStarter({ registry, harness, mirror, dotfiles: options.dotfiles ?? dotfiles, gitIdentity: options.gitIdentity, wake });
  const queue = options.queue === true || options.pipeline === true ? threadQueue({ registry, startThread, gate: turnGate(() => false), send: (id, text, requestId) => harness.send(id, text, requestId, "followUp") }) : null;
  const items = options.pipeline === true ? pipeline({ registry, queue: queue! }) : null;
  const plans = items === null ? null : planning({ registry, pipeline: items, replies: agentReader(registry, harness).replies });
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0,
    ...(options.https ? { https: options.https } : {}),
    // Every loopback caller is whoever the test says. Tests never ask tailscaled.
    whois: options.whois ?? (async () => {
      asked();
      await admitted;
      return caller;
    }),
    // infra-testbench is allowed as a node in control.json's callers would be, so a test can show the API still tells it from a person.
    allowed: new Set([laptop, phone, "nFIREBAT" as TailnetNodeId, "nTESTBENCH" as TailnetNodeId]),
    joins: { configured: new Set(["nFIREBAT", "nBENCH"] as TailnetNodeId[]), whois: async () => caller === null ? null : { id: caller, host: hosts.get(caller) ?? "unnamed.tail.ts.net" }, joined: (n) => { joined.push(n); } },
    // The control plane runs on rj-firebat and deploys nothing unless a test says so. null leaves deployments off.
    ...(options.deployment === null ? {} : { deployment: options.deployment ?? { self: "nFIREBAT" as TailnetNodeId, deployers: new Set(), keys: {} } }),
    ...(options.reviews === undefined ? {} : { reviews: options.reviews }),
    ...(queue === null ? {} : { queue }),
    ...(items === null ? {} : { pipeline: items }),
    ...(plans === null ? {} : { planning: plans }),
    ...(images === undefined ? {} : { images }),
    ...(backfill === undefined ? {} : { usageBackfill: backfill }),
    ...(options.gate === undefined ? {} : { gate: options.gate }),
    hostnames: new Set(["127.0.0.1"]),
    harness,
    startThread,
    wake,
    probes: new Map([[node, {
      command: (pylonId: PylonId, command: PylonCommand) => { commands.push([pylonId, command]); return answer(command); },
      stream: (pylonId: PylonId, argv: readonly string[]) => { streams.push([pylonId, argv]); return pipe(argv); },
      health: () => health(),
    }]]),
    previewPorts: { first: 10200, last: 10299 },
    ...options.streamStallMs === undefined ? {} : { streamStallMs: options.streamStallMs },
    ...options.attachTiming === undefined ? {} : { attachTiming: options.attachTiming },
    ...options.closeWaitMs === undefined ? {} : { closeWaitMs: options.closeWaitMs },
  });
  t.after(async () => {
    await plans?.close();
    await items?.close();
    await queue?.close();
    await api.close();
    await images?.close();
    await backfill?.close();
    registry.close();
  });
  /** Sends JSON as the dashboard and CLI do. `headers` overrides any header, so tests can pose as a browser page. */
  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return callJson({ host: "127.0.0.1", port: api.port, method, path, body, headers });
  }
  /** A GET whose body is kept as bytes, with the reply's headers. */
  function raw(path: string): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port: api.port, method: "GET", path, headers: { host: `127.0.0.1:${api.port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on("error", reject).end();
    });
  }
  return {
    registry, images, queue, plans, call, raw, woken, joined, hosts, calls, commands, streams, reads, fake, startThread, port: api.port, get httpsPort() { return api.httpsPort; }, close: () => api.close(),
    callAs(id: TailnetNodeId | null) { caller = id; },
    nodeHealth(next: typeof health) { health = next; },
    /** Holds every request at whois until the returned function is called. */
    /** Holds each whois from now on until `release`. `asked` settles once one is held. */
    holdWhois() {
      const held = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      admitted = held.promise;
      asked = waiting.resolve;
      return {
        asked: waiting.promise,
        release() {
          admitted = Promise.resolve();
          asked = () => {};
          held.resolve();
        },
      };
    },
    probeAnswers(next: typeof answer) { answer = next; },
    probePipes(next: typeof pipe) { pipe = next; },
    remoteReads(next: typeof read) { read = next; },
    events: (path: string) => readEvents(api.port, path),
  };
}

async function withThread(t: import("node:test").TestContext, options: { gitIdentity?: { name: string; email: string }; deployment?: DeploymentOptions; reviews?: ReviewLoop; project?: typeof project; dotfiles?: typeof dotfiles; streamStallMs?: number; attachTiming?: AttachTiming; closeWaitMs?: number } = {}) {
  const s = await setup(t, options);
  assert.equal((await s.call("POST", "/v1/projects", options.project ?? project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Fix checkout" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  return { ...s, thread: started.body as Thread };
}

test("callers off the allowlist, or unknown to tailscaled, are refused", async (t) => {
  const s = await setup(t);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("GET", "/v1/projects")).status, 403);
  s.callAs(null);
  assert.equal((await s.call("GET", "/v1/projects")).status, 403);
  s.callAs(laptop);
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 200, body: [] });
});

test("a path that does not decode is a 400 to an allowed caller and a 403 to any other, and a Host that does not parse is a 403", async (t) => {
  const s = await setup(t);
  const bad = await s.call("GET", "/v1/%zz");
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, "string");
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.deepEqual(await s.call("GET", "/v1/%zz"), { status: 403, body: { error: "caller is not a tailnet node this control plane allows" } });
  s.callAs(laptop);
  for (const host of ["[zz", "a b"]) {
    assert.deepEqual(await s.call("GET", "/v1/projects", undefined, { host }), { status: 403, body: { error: `the API does not answer to host ${host}` } }, host);
    assert.equal((await s.call("GET", "/v1/whoami", undefined, { host })).status, 403, `whoami under ${host}`);
  }
});

test("any tailnet node may ask who it is and what it may do, under the API's names only", async (t) => {
  const s = await setup(t, { deployment });
  const asks: [string, string][] = [[laptop, "a deployer"], [phone, "a person"], ["nFIREBAT", "the control node, though listed as a deployer"], ["nSTRANGER", "a stranger"]];
  const answers = [];
  for (const [id] of asks) {
    s.callAs(id as TailnetNodeId);
    answers.push((await s.call("GET", "/v1/whoami")).body);
  }
  assert.deepEqual(answers, [
    { node: laptop, allowed: true, person: true, deployer: true },
    { node: phone, allowed: true, person: true, deployer: false },
    { node: "nFIREBAT", allowed: true, person: false, deployer: false },
    { node: "nSTRANGER", allowed: false, person: false, deployer: false },
  ], asks.map(([, who]) => who).join(", "));
  assert.deepEqual(await s.call("GET", "/v1/whoami", undefined, { host: "evil.example" }), { status: 403, body: { error: "the API does not answer to host evil.example" } });
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 403, body: { error: "caller is not a tailnet node this control plane allows" } }, "it opens no other route to a stranger");
  s.callAs(null);
  assert.deepEqual(await s.call("GET", "/v1/whoami"), { status: 403, body: { error: "caller is not a tailnet node" } });
});

const joinerKey = "b".repeat(64);
const joiner = "nJOINER" as TailnetNodeId;

test("a machine joins once with a token, as whois names it, whatever its request says", async (t) => {
  const s = await setup(t);
  const { token } = mintJoinToken(s.registry);
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const forged = { token, deployKey: joinerKey, name: "rj-firebat", node: "rj-firebat", tailnetNodeId: laptop, tailnetHost: "evil.example" };
  assert.deepEqual(await s.call("POST", "/v1/join", forged), { status: 200, body: { node: "infra-2", tailnetNodeId: joiner } });
  const recorded = { name: "infra-2", tailnetHost: "infra-2.tail.ts.net", tailnetNodeId: joiner, deployKey: joinerKey };
  assert.deepEqual(s.registry.joinedNodes().map(({ joinedAt: _, ...n }) => n), [recorded]);
  assert.deepEqual(s.joined.map(({ joinedAt: _, ...n }) => n), [recorded], "the control plane is told, so it follows the new probe");
  assert.deepEqual(s.registry.nodes().map((n) => [n.name, n.tailnetNodeId]), [["infra-2", joiner], ["rj-firebat", "nFIREBAT"]], "rj-firebat is as it was");

  s.callAs("nSECOND" as TailnetNodeId);
  s.hosts.set("nSECOND" as TailnetNodeId, "infra-3.tail.ts.net");
  const used = await s.call("POST", "/v1/join", { token, deployKey: joinerKey });
  assert.equal(used.status, 403);
  assert.match(used.body.error, /^this join token was used at .*, and each joins one node\. Mint another with sudo deploy\/install\.sh --join-token/);
  assert.deepEqual(s.registry.joinedNodes().map((n) => n.name), ["infra-2"], "a used token records nothing");
});

test("an unknown or expired token is refused with nothing recorded", async (t) => {
  const s = await setup(t);
  const expired = mintJoinToken(s.registry, Date.now() - joinTokenTtlMs - 1).token;
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const unknown = await s.call("POST", "/v1/join", { token: "not-minted", deployKey: joinerKey });
  assert.deepEqual(unknown, { status: 403, body: { error: "this join token is not one this control plane minted. Mint another with sudo deploy/install.sh --join-token on the control plane's machine" } });
  const late = await s.call("POST", "/v1/join", { token: expired, deployKey: joinerKey });
  assert.equal(late.status, 403);
  assert.match(late.body.error, /^this join token expired at \d{4}-/);
  assert.equal((await s.call("POST", "/v1/join", { token: expired })).status, 400, "a join names its deploy key");
  assert.deepEqual([s.registry.joinedNodes(), s.joined, s.registry.nodes().map((n) => n.name)], [[], [], ["rj-firebat"]]);
});

test("a caller, the control plane's machine and a node of control.json never join, and a token they send stays unused", async (t) => {
  const s = await setup(t);
  s.registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: "nBENCH" as TailnetNodeId });
  s.registry.upsertNode({ name: "retired" as NodeName, tailnetHost: "retired.tail.ts.net", tailnetNodeId: "nRETIRED" as TailnetNodeId });
  const { token } = mintJoinToken(s.registry);
  const attempts: [TailnetNodeId, string][] = [
    [laptop, "laptop.tail.ts.net"],
    ["nFIREBAT" as TailnetNodeId, "rj-firebat.tail.ts.net"],
    ["nBENCH" as TailnetNodeId, "infra-testbench.tail.ts.net"],
    ["nIMPOSTOR" as TailnetNodeId, "infra-testbench.tail.ts.net"],
    ["nBENCH" as TailnetNodeId, "renamed.tail.ts.net"],
    ["nRETIRED" as TailnetNodeId, "renamed.tail.ts.net"],
    ["nUPPER" as TailnetNodeId, "Upper.tail.ts.net"],
  ];
  const answers = [];
  for (const [id, host] of attempts) {
    s.callAs(id);
    s.hosts.set(id, host);
    const reply = await s.call("POST", "/v1/join", { token, deployKey: joinerKey });
    answers.push(`${reply.status} ${reply.body.error}`);
  }
  assert.deepEqual(answers, [
    "409 laptop.tail.ts.net is the control plane's machine or a caller in control.json, which never joins as a node",
    "409 rj-firebat.tail.ts.net is the control plane's machine or a caller in control.json, which never joins as a node",
    "409 infra-testbench.tail.ts.net is a node in control.json, which sets its deploy key",
    "409 a node named infra-testbench is already tailnet node nBENCH. Rename this machine in tailscale",
    "409 renamed.tail.ts.net is a node in control.json, which sets its deploy key",
    "409 this machine is already the node retired, and tailscale now names it renamed",
    "409 tailscale names this machine Upper.tail.ts.net, whose first label is not a node name: must be a lowercase tailnet machine name of at most 63 characters",
  ]);
  assert.equal(s.registry.joinToken(tokenDigest(token))?.usedAt, null);
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  assert.equal((await s.call("POST", "/v1/join", { token, deployKey: joinerKey })).status, 200, "the token still joins a new machine");
});

test("a joined node joins again with a new token, which replaces its deploy key, and reports with it", async (t) => {
  const s = await setup(t, { deployment });
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const report = { role: "probe", commit: deployCommit, target: deployCommit, state: "healthy", reason: null };
  assert.equal((await s.call("POST", "/v1/join", { token: mintJoinToken(s.registry).token, deployKey: tokenDigest("first") })).status, 200);
  assert.equal((await s.call("POST", "/v1/deployer/report", report, { authorization: "Bearer first" })).status, 200);
  assert.equal((await s.call("POST", "/v1/join", { token: mintJoinToken(s.registry).token, deployKey: tokenDigest("second") })).status, 200);
  assert.equal((await s.call("POST", "/v1/deployer/report", report, { authorization: "Bearer first" })).status, 403);
  assert.equal((await s.call("POST", "/v1/deployer/report", report, { authorization: "Bearer second" })).status, 200);
  assert.deepEqual((await s.call("GET", "/v1/whoami")).body, { node: joiner, allowed: false, person: false, deployer: false });
});

test("a machine neither admitted nor joined reaches only whoami and join, and a joined node only its deployer's routes", async (t) => {
  const s = await withThread(t, { deployment });
  const thread = s.thread.id;
  s.callAs(joiner);
  s.hosts.set(joiner, "infra-2.tail.ts.net");
  const requests: [string, string, unknown?, Record<string, string>?][] = [
    ["GET", "/"],
    ["GET", "/threads"],
    ["GET", `/threads/${thread}`],
    ["GET", "/v1/projects"],
    ["POST", "/v1/projects", project],
    ["GET", "/v1/threads"],
    ["POST", "/v1/threads", { project: project.id, title: "Mine" }],
    ["GET", `/v1/threads/${thread}`],
    ["POST", `/v1/threads/${thread}/messages`, { text: "hi" }],
    ["GET", "/v1/nodes"],
    ["GET", `/v1/nodes/${node}/health`],
    ["GET", "/v1/images"],
    ["PUT", "/v1/release", { commit: "main" }],
    ["GET", "/v1/events"],
    ["GET", "/v1/usage"],
    ["GET", "/v1/health?past=admission"],
    ["GET", "/v1/deployer/release", undefined, { authorization: "Bearer joiner" }],
    ["POST", "/v1/deployer/report", { role: "probe", commit: deployCommit, target: deployCommit, state: "healthy", reason: null }, { authorization: "Bearer joiner" }],
  ];
  const sweep = async () => {
    const statuses = [];
    for (const [method, path, body, headers] of requests) statuses.push(`${method} ${path} ${(await s.call(method, path, body, headers)).status}`);
    statuses.push(`attach ${(await attachTo(s.port, attachPathOf(thread)) as { status: number }).status}`);
    return statuses;
  };
  const refused = [...requests.map(([method, path]) => `${method} ${path} 403`), "attach 403"];
  assert.deepEqual(await sweep(), refused, "before it joins");
  assert.equal((await s.call("GET", "/v1/whoami")).status, 200);
  assert.equal((await s.call("POST", "/v1/join", { token: mintJoinToken(s.registry).token, deployKey: tokenDigest("joiner") })).status, 200);
  assert.deepEqual(await sweep(), [...refused.slice(0, -3), "GET /v1/deployer/release 200", "POST /v1/deployer/report 200", "attach 403"], "once it joined");
});

test("a web page on an allowed machine cannot change state", async (t) => {
  const s = await setup(t);
  // A cross-origin form or fetch without a preflight can only send a simple content type.
  const forged = await s.call("POST", "/v1/projects", JSON.stringify(project), { "content-type": "text/plain" });
  assert.equal(forged.status, 415);
  // A DNS rebinding page reaches the API under the page's own name.
  assert.equal((await s.call("GET", "/v1/projects", undefined, { host: "evil.example:80" })).status, 403);
  assert.equal((await s.call("POST", "/v1/projects", project, { host: "evil.example" })).status, 403);
  assert.deepEqual(s.registry.projects(), []);
});

test("projects are created, listed, and checked", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.call("POST", "/v1/projects", project), { status: 201, body: project });
  assert.deepEqual(await s.call("GET", "/v1/projects"), { status: 200, body: [project] });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 409);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", defaultNode: "nowhere" })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", resources: { cpus: 0, memoryGiB: 4, diskGiB: 10 } })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", extra: true })).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", repoUrl: "https://" })).status, 400, "a pylon's allowlist needs the host of an HTTPS repo");
});

test("nodes are listed with their state and capacity, without the observation", async (t) => {
  const s = await setup(t);
  const offline = { name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT", state: "offline", capacity: null, observedAt: null, overcommitted: false, pylons: null };
  assert.deepEqual(await s.call("GET", "/v1/nodes"), { status: 200, body: [offline] });
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  const none = { pylons: 0, cpus: 0, memoryGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  assert.deepEqual((await s.call("GET", "/v1/nodes")).body, [{ ...offline, state: "online", capacity, observedAt: "2027-01-01T00:01:00Z", pylons: { up: none, paused: none, archived: none, crashed: none, orphaned: [] } }]);
});

test("a thread cannot start before an image is current", async (t) => {
  const s = await setup(t);
  await s.call("POST", "/v1/projects", project);
  const res = await s.call("POST", "/v1/threads", { project: "acme", title: "x" });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no image is current/);
  assert.deepEqual((await s.call("GET", "/v1/images/current")).body, { current: null, previous: null });
  assert.equal((await s.call("POST", "/v1/threads", { project: "nope", title: "x" })).status, 404);
});

test("an image is recorded only with every pin, gh included, each in its pinned format", async (t) => {
  const s = await setup(t);
  const { gh: _, ...withoutGh } = image.pins;
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: withoutGh })).status, 400);
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: { ...image.pins, ghSha256: "not-a-digest" } })).status, 400);
  assert.equal((await s.call("POST", "/v1/images", { ...image, pins: { ...image.pins, extra: "1" } })).status, 400);
  assert.deepEqual((await s.call("GET", "/v1/images")).body.images, [], "a refused image is not recorded");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  assert.deepEqual((await s.call("GET", "/v1/images")).body.images, [{ ...image, release: null, nodes: [] }], "an image recorded by hand comes from no known release");
});

test("an image is recorded exactly when a probe's Docker backend can name it", async (t) => {
  const s = await setup(t);
  const probe = JSON.parse(await readFile(new URL("../../deploy/probe.example.json", import.meta.url), "utf8"));
  const parses = (parse: () => unknown) => { try { parse(); return true; } catch { return false; } };
  for (const id of ["img-0123456789ab", "img-custom", "img-Custom", "img-", "img-a.b", `img-${"0".repeat(41)}`]) {
    const named = parses(() => parseProbeConfig(JSON.stringify({ ...probe, backend: { kind: "docker", images: { [id]: "nexus-pylon:test" } } })));
    const recorded = (await s.call("POST", "/v1/images", { ...image, id })).status === 201;
    assert.equal(recorded, named, id);
  }
  assert.deepEqual((await s.call("GET", "/v1/images")).body.images.map((i: { id: string }) => i.id).sort(), ["img-0123456789ab", "img-custom"]);
});

test("starting a thread creates its pylon, boots fresh from the current image, and wakes its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  assert.equal(thread.status, "active");
  assert.equal(thread.startedBy, laptop);
  assert.equal(thread.pylonId, `pylon-${thread.id}`);
  assert.ok(thread.pylonId.length <= 40);
  assert.deepEqual(s.calls, [["start", { threadId: thread.id, pylonId: thread.pylonId }]]);
  assert.equal(thread.conversationId, "1");
  assert.deepEqual(s.woken, [node]);
  const row = { ...thread, attention: null, desired: "running", pylon: { node, actualState: "unknown", failed: null } };
  assert.deepEqual((await s.call("GET", "/v1/threads")).body, [row]);
  assert.deepEqual((await s.call("GET", "/v1/threads?project=acme")).body, [row]);
  assert.deepEqual((await s.call("GET", "/v1/threads?project=other")).body, []);

  const pylon = s.registry.pylon(thread.pylonId)!;
  assert.equal(pylon.node, node);
  assert.deepEqual(pylon.firstBoot, { kind: "fresh", preSetup: null });
  assert.deepEqual(pylon.boot, {
    pylonId: thread.pylonId, image: image.id, resources: project.resources,
    network: { allowedHosts: ["api.openai.com", "api.stripe.com", "auth.openai.com", "chatgpt.com", "registry.npmjs.org"], secrets: [...project.secrets, { name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] }] },
    repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "origin/main" } },
    dotfiles,
  });
  assert.deepEqual(pylon.live.previews, [], "ports are allocated once the pylon reports services that want them");
  assert.deepEqual(pylon.live.overlay.map((f) => f.path), ["/etc/profile.d/nexus.sh", "/home/user/.nexus/pylon.json", "/home/user/.nexus/PYLON.md"]);
  assert.deepEqual(JSON.parse(pylon.live.overlay[1]!.content), {
    pylonId: thread.pylonId, threadId: thread.id, project: "acme", node, api: "http://nexus.pylon",
    allowedHosts: pylon.boot.network.allowedHosts, previews: [], logins: ["chatgpt"], dotfiles,
  });
  assert.equal(pylon.liveHash, liveHashOf(pylon.live));
  assert.equal(pylon.submitted, null);
});

/** Puts a node online with this capacity and grants, holding the current image unless told otherwise. */
function observeNode(s: Awaited<ReturnType<typeof setup>>, name: string, memory: { total: number; committed: number }, over: Partial<NodeObservation> = {}) {
  const at = name as NodeName;
  s.registry.upsertNode({ name: at, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: `n${name.toUpperCase()}` as TailnetNodeId });
  const capacity = { cpus: 16, committedCpus: 4, memoryGiB: memory.total, committedMemoryGiB: memory.committed, diskFreeGiB: 200, committedDiskGiB: 60 };
  s.registry.apply({ record: "node", node: at, state: "online", capacity });
  s.registry.ingested({
    node: at, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [image.id] as NodeObservation["artifacts"], jobs: [], pylons: [],
    grants: { secrets: ["STRIPE_KEY", "NEXUS_CHATGPT_TOKEN"], gitSsh: true }, previewRoutes: [], heldSecrets: [], ...over,
  }, []);
}

async function withImage(t: import("node:test").TestContext) {
  const s = await setup(t);
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  return s;
}

test("--node auto boots the pylon on the node with the most memory left after it, and the thread records why", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 48 });
  observeNode(s, "small", { total: 32, committed: 24 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const thread = started.body as Thread;
  assert.deepEqual(thread.placement, {
    how: "auto", node: "big", weighed: [
      { node: "big", left: { cpus: 10, memoryGiB: 12, diskGiB: 190 } },
      { node: "rj-firebat", refused: "is offline" },
      { node: "small", left: { cpus: 10, memoryGiB: 4, diskGiB: 190 } },
    ],
  });
  assert.equal(s.registry.pylon(thread.pylonId)!.node, "big");
  assert.deepEqual(s.woken, ["big"]);
  assert.deepEqual((await s.call("GET", `/v1/threads/${thread.id}`)).body.thread.placement, thread.placement, "show reads it back");

  const next = await s.call("POST", "/v1/threads", { project: "acme", title: "Next", node: "auto" });
  assert.equal(next.body.placement.node, "big", "big still has 8 GiB left once its unreported pylon is counted, and small 4");
  const third = await s.call("POST", "/v1/threads", { project: "acme", title: "Third", node: "auto" });
  assert.equal(third.body.placement.node, "small", "two unreported pylons leave big as little memory as small, and fewer CPUs");
});

test("--node auto counts the memory of a paused pylon about to wake, and not of one that stays paused", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 64, committed: 0 });
  observeNode(s, "b", { total: 64, committed: 2 });
  const waking = (await s.call("POST", "/v1/threads", { project: "acme", title: "Waking", node: "a" })).body as Thread;
  observeNode(s, "a", { total: 64, committed: 0 }, { pylons: [{ pylonId: waking.pylonId, phase: "stopped", checkpoint: null, sessions: null }] });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" })).body.placement.node, "b");
  assert.equal((await s.call("POST", `/v1/threads/${waking.id}/archive`)).status, 200);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed again", node: "auto" })).body.placement.node, "a",
    "once Waking stays paused, a has 60 GiB left, and b 54 with Placed still to boot there");
});

test("--node auto counts the memory of an archived thread's paused pylon the usage backfill wakes to read", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 64, committed: 0 });
  observeNode(s, "b", { total: 64, committed: 6 });
  const archived = (await s.call("POST", "/v1/threads", { project: "acme", title: "Archived", node: "a" })).body as Thread;
  observeNode(s, "a", { total: 64, committed: 0 }, { pylons: [{ pylonId: archived.pylonId, phase: "stopped", checkpoint: null, sessions: null }] });
  assert.equal((await s.call("POST", `/v1/threads/${archived.id}/archive`)).status, 200);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" })).body.placement.node, "a");
  s.registry.startUsageBackfill([archived.id], Date.now());
  s.registry.holdUsageBackfill(archived.id, Date.now());
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Placed again", node: "auto" })).body.placement.node, "b",
    "a has 52 GiB left once Placed and the woken Archived boot, and b 54");
});

test("--node auto passes over a node whose stored observation is from a probe older than grants", async (t) => {
  const s = await withImage(t);
  observeNode(s, "old", { total: 64, committed: 0 }, { grants: undefined as never });
  observeNode(s, "new", { total: 16, committed: 8 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.placement.node, "new");
  assert.deepEqual(started.body.placement.weighed.find((w: { node: string }) => w.node === "old"), { node: "old", refused: "runs a probe too old to report what its pylons hold" });
});

test("--node auto counts a crashed pylon a person retried, which boots again, and not one whose VM still holds its memory", async (t) => {
  const s = await withImage(t);
  observeNode(s, "b", { total: 16, committed: 10 });
  observeNode(s, "a", { total: 16, committed: 0 });
  const t1 = (await s.call("POST", "/v1/threads", { project: "acme", title: "Crashed", node: "a" })).body as Thread;
  s.registry.savePylon({ ...s.registry.pylon(t1.pylonId)!, boot: { ...s.registry.pylon(t1.pylonId)!.boot, resources: { cpus: 2, memoryGiB: 12, diskGiB: 10 } }, retrying: true });
  const broken = (cause: "controller" | "services") => ({ pylonId: t1.pylonId, phase: "broken" as const, detail: "the controller exited", cause, logTail: "" });
  observeNode(s, "a", { total: 16, committed: 0 }, { pylons: [broken("controller")] });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "x", node: "auto" })).body.placement.node, "b",
    "a will boot the retried 12 GiB pylon again, which leaves it 0 GiB, and b 2");
  observeNode(s, "a", { total: 16, committed: 12 }, { pylons: [broken("services")] });
  const weighed = (await s.call("POST", "/v1/threads", { project: "acme", title: "y", node: "auto" })).body.placement.weighed;
  assert.deepEqual(weighed.find((w: { node: string }) => w.node === "a").left.memoryGiB, 0, "a broken VM that is still up is counted once, in the node's capacity");
});

test("--node auto refuses with each node's reason when none can run the pylon, and starts nothing", async (t) => {
  const s = await withImage(t);
  observeNode(s, "full", { total: 32, committed: 30 });
  observeNode(s, "no-image", { total: 64, committed: 0 }, { artifacts: [] });
  observeNode(s, "no-secret", { total: 64, committed: 0 }, { grants: { secrets: [], gitSsh: true } });
  observeNode(s, "no-token", { total: 64, committed: 0 }, { grants: { secrets: ["STRIPE_KEY"], gitSsh: true } });
  observeNode(s, "token-coming", { total: 16, committed: 0 }, { grants: { secrets: [], gitSsh: true }, heldSecrets: ["NEXUS_CHATGPT_TOKEN"] });
  observeNode(s, "no-ssh", { total: 64, committed: 0 }, { grants: { secrets: ["STRIPE_KEY", "NEXUS_CHATGPT_TOKEN"], gitSsh: false } });
  observeNode(s, "old-probe", { total: 64, committed: 0 }, { grants: null as never });
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Nowhere", node: "auto" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "no node can run this pylon: full has 30 of 32 GiB of memory committed, and the pylon needs 4; "
    + `no-image does not hold image ${image.id}; no-secret has no secret STRIPE_KEY in its secret file, NEXUS_CHATGPT_TOKEN, which its probe is too old to take from the control plane; `
    + "no-ssh has no git SSH key to reach git@example.com:acme.git and git@github.com:ramtin/dotfiles.git; no-token has no secret NEXUS_CHATGPT_TOKEN, which its probe is too old to take from the control plane; "
    + "old-probe runs a probe too old to report what its pylons hold; rj-firebat is offline; token-coming has no secret STRIPE_KEY in its secret file");
  assert.deepEqual((await s.call("GET", "/v1/threads")).body, []);
  assert.deepEqual(s.calls, [], "no conversation was started for it");
  assert.deepEqual(s.woken, []);
});

test("a pylon that asks for nested virtualization goes only to a node whose probe reports it", async (t) => {
  const s = await withImage(t);
  observeNode(s, "flat", { total: 64, committed: 0 });
  observeNode(s, "nests", { total: 16, committed: 0 }, { nestedVirtualization: true });
  const nested = await s.startThread({ project: "acme", title: "Verify", node: "auto", bare: true, resources: { memoryGiB: 8, nestedVirtualization: true } }, "nexus-verify");
  const placement = nested.placement?.how === "auto" ? nested.placement : assert.fail("placed auto");
  assert.equal(placement.node, "nests");
  assert.deepEqual(placement.weighed.find((w) => w.node === "flat"), { node: "flat", refused: "cannot give a pylon KVM of its own: its probe does not report nested virtualization" });
  assert.deepEqual(s.registry.pylon(nested.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 8, diskGiB: 10, nestedVirtualization: true });
  const plain = (await s.call("POST", "/v1/threads", { project: "acme", title: "Plain", node: "auto" })).body;
  assert.equal(plain.placement.node, "flat", "an ordinary pylon still goes where it fits best");
  assert.deepEqual(s.registry.pylon(plain.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 4, diskGiB: 10 });
});

test("--node auto places a thread that needs the ChatGPT token on a node whose probe takes it and has not got it yet", async (t) => {
  const s = await withImage(t);
  const restarted = { secrets: ["STRIPE_KEY"], gitSsh: true };
  observeNode(s, "big", { total: 64, committed: 0 }, { grants: restarted, heldSecrets: ["NEXUS_CHATGPT_TOKEN"] });
  observeNode(s, "small", { total: 32, committed: 0 }, { grants: restarted, heldSecrets: ["NEXUS_CHATGPT_TOKEN"] });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Right after a restart", node: "auto" });
  assert.equal(started.status, 201, started.body.error);
  assert.equal(started.body.placement.node, "big");
  assert.deepEqual(s.woken, ["big"]);
});

test("without --node a thread still boots on its project's default node, and a named node is taken as named", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 0 });
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "Default" });
  assert.deepEqual(plain.body.placement, { how: "default", node }, "even while the default node is offline and another has room");
  assert.equal(s.registry.pylon(plain.body.pylonId)!.node, node);
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Named", node: "big" });
  assert.deepEqual(named.body.placement, { how: "named", node: "big" });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "x", node: "nowhere" })).status, 400);
});

test("a start near a node boots there while it has room, on the roomiest node once it has none, and there all the same when no node has room", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 0 });
  observeNode(s, "full", { total: 32, committed: 40 });
  const beside = await s.startThread({ project: "acme", title: "Beside", near: "big" as NodeName }, "nexus-review");
  assert.deepEqual(beside.placement, { how: "named", node: "big" });
  const spilled = await s.startThread({ project: "acme", title: "Spilled", near: "full" as NodeName }, "nexus-review");
  assert.deepEqual(spilled.placement, {
    how: "auto", node: "big", weighed: [
      { node: "big", left: { cpus: 8, memoryGiB: 56, diskGiB: 180 } },
      { node: "full", refused: "is overcommitted, with 40 of 32 GiB of memory committed" },
      { node: "rj-firebat", refused: "is offline" },
    ],
  });
  observeNode(s, "big", { total: 64, committed: 70 });
  const stayed = await s.startThread({ project: "acme", title: "Stayed", near: "full" as NodeName }, "nexus-review");
  assert.deepEqual(stayed.placement, { how: "named", node: "full" }, "no node has room, so it stays where it was asked to be near");
});

test("the first start of a setup builds its template on the node, the next waits for it, and one after it is ready boots from it at the commit read", async (t) => {
  const s = await withImage(t);
  observeNode(s, node, { total: 64, committed: 0 });
  const [first, moved] = ["1".repeat(40), "2".repeat(40)];
  s.remoteReads(async () => ({ commit: first, setupBlob: "b".repeat(40) }));

  const building = (await s.call("POST", "/v1/threads", { project: "acme", title: "First", branch: "feature" })).body as Thread;
  const [template] = s.registry.templates(project.id as ProjectId);
  assert.ok(template?.state === "building");
  assert.deepEqual(building.setup, { how: "fresh", reason: `no template of this setup is on ${node} yet`, building: template.id });
  assert.deepEqual([template.on, template.inputs.repo, template.submitted], [node, { url: project.repoUrl, branch: "feature", commit: first }, null], "the build checks out the commit the setup was read at");
  assert.deepEqual(s.registry.pylon(building.pylonId)!.firstBoot, { kind: "fresh", preSetup: null });
  assert.deepEqual(s.registry.pylon(building.pylonId)!.boot.repo, { kind: "clone", url: project.repoUrl, checkout: { branch: "feature", commit: "origin/feature" } });

  const waiting = (await s.call("POST", "/v1/threads", { project: "acme", title: "Second", branch: "feature" })).body as Thread;
  assert.deepEqual(waiting.setup, { how: "fresh", reason: `template ${template.id} of this setup is still building on ${node}`, building: template.id });
  assert.equal(s.registry.templates(project.id as ProjectId).length, 1, "a running build is not started twice");

  const builtAt = Date.now() - 60_000;
  s.registry.saveTemplate({ id: template.id, key: template.key, state: "ready", builtOn: node, builtAt, commit: first });
  observeNode(s, node, { total: 64, committed: 0 }, { artifacts: [image.id, template.id] as NodeObservation["artifacts"] });
  s.remoteReads(async () => ({ commit: moved, setupBlob: "b".repeat(40) }));
  const reused = (await s.call("POST", "/v1/threads", { project: "acme", title: "Third", branch: "feature" })).body as Thread;
  assert.deepEqual(reused.setup, { how: "template", template: template.id, builtAt, commit: moved });
  const pylon = s.registry.pylon(reused.pylonId)!;
  assert.deepEqual(pylon.firstBoot, { kind: "template", template: template.id });
  assert.deepEqual(pylon.boot.repo, { kind: "clone", url: project.repoUrl, checkout: { branch: "feature", commit: moved } }, "the pylon checks out the commit its setup was read at, not the branch's tip at boot");
  assert.deepEqual((await s.call("GET", `/v1/threads/${reused.id}`)).body.thread.setup, reused.setup, "show reads it back");
  assert.deepEqual(s.reads, [{ branch: "feature" }, { branch: "feature" }, { branch: "feature" }]);
});

test("a start whose setup cannot be read boots fresh and says why, and only a full commit ID is read", async (t) => {
  const s = await withImage(t);
  const unread = (await s.call("POST", "/v1/threads", { project: "acme", title: "Unread" })).body as Thread;
  assert.deepEqual(unread.setup, { how: "fresh", reason: "the control plane could not read .nexus/setup at main: this test has no remote" });
  assert.deepEqual(s.registry.templates(project.id as ProjectId), []);
  assert.deepEqual(s.registry.pylon(unread.pylonId)!.firstBoot, { kind: "fresh", preSetup: null });

  const short = (await s.call("POST", "/v1/threads", { project: "acme", title: "Short", commit: "abc123" })).body as Thread;
  assert.deepEqual(short.setup, { how: "fresh", reason: "the start named commit abc123, and only a full commit ID or a branch tip can use a template" });
  assert.deepEqual(s.registry.pylon(short.pylonId)!.boot.repo, { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "abc123" } });

  const full = "f".repeat(40);
  s.remoteReads(async () => ({ commit: full, setupBlob: null }));
  const pinned = (await s.call("POST", "/v1/threads", { project: "acme", title: "Pinned", commit: full })).body as Thread;
  assert.deepEqual(s.reads, [{ branch: "main" }, { commit: full }]);
  assert.deepEqual(s.registry.templates(project.id as ProjectId).map((r: TemplateRecord) => r.state === "building" && r.inputs.repo), [{ url: project.repoUrl, branch: "main", commit: full }]);
  assert.equal(pinned.setup?.how, "fresh");
});

test("two overlapping --node auto starts take different rooms, and a start that fails gives its room back", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 16, committed: 8 });
  observeNode(s, "b", { total: 16, committed: 9 });
  const { harness } = s.fake;
  const start = harness.startThread;
  const held = Promise.withResolvers<void>();
  let entered = 0;
  harness.startThread = async (thread) => { entered++; await held.promise; return start(thread); };
  const both = [s.call("POST", "/v1/threads", { project: "acme", title: "One", node: "auto" }), s.call("POST", "/v1/threads", { project: "acme", title: "Two", node: "auto" })];
  while (entered < 2) await sleep(5);
  held.resolve();
  const placed = (await Promise.all(both)).map((r) => r.body.placement.node);
  assert.deepEqual(placed.toSorted(), ["a", "b"], "the second start sees the room the first one reserved on a");

  observeNode(s, "a", { total: 16, committed: 0 });
  observeNode(s, "b", { total: 16, committed: 0 });
  harness.startThread = async () => { throw new Error("the harness is down"); };
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Fails", node: "a" })).status, 500);
  harness.startThread = start;
  const after = await s.call("POST", "/v1/threads", { project: "acme", title: "After", node: "auto" });
  assert.deepEqual(after.body.placement.weighed.filter((w: { node: string }) => w.node !== "rj-firebat"), [
    { node: "a", left: { cpus: 8, memoryGiB: 8, diskGiB: 180 } },
    { node: "b", left: { cpus: 8, memoryGiB: 8, diskGiB: 180 } },
  ], "each node counts the one overlapping start it has yet to report, and a counts nothing of the start that failed");
});

test("a project whose default node is auto places each thread that names none, and a named node still pins", async (t) => {
  const s = await withImage(t);
  observeNode(s, "big", { total: 64, committed: 0 });
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { defaultNode: "nowhere" })).status, 400);
  const edited = await s.call("PATCH", "/v1/projects/acme", { defaultNode: "auto" });
  assert.deepEqual([edited.status, edited.body.defaultNode], [200, "auto"]);
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "Plain" });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual([plain.body.placement.how, plain.body.placement.node], ["auto", "big"]);
  const named = await s.call("POST", "/v1/threads", { project: "acme", title: "Named", node });
  assert.deepEqual(named.body.placement, { how: "named", node });
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "spread", defaultNode: "auto" })).status, 201);
});

test("--node auto refuses an overcommitted node with its reason, and places the pylon on one that fits", async (t) => {
  const s = await withImage(t);
  observeNode(s, "firebat", { total: 22.8, committed: 40 });
  observeNode(s, "testbench", { total: 32, committed: 0 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(started.body.placement.node, "testbench");
  assert.deepEqual(started.body.placement.weighed.find((w: { node: string }) => w.node === "firebat"), { node: "firebat", refused: "is overcommitted, with 40 of 22.8 GiB of memory committed" });
});

test("a start whose disk differs from its project's boots fresh without a template, and one that changes only CPUs or memory may use one", async (t) => {
  const s = await withImage(t);
  s.remoteReads(async () => ({ commit: "1".repeat(40), setupBlob: "b".repeat(40) }));
  const disk = (await s.call("POST", "/v1/threads", { project: "acme", title: "Disk", resources: { diskGiB: 40 } })).body as Thread;
  assert.deepEqual(disk.setup, { how: "fresh", reason: "the start asked for a 40 GiB disk, and this project's templates have 10 GiB" });
  assert.deepEqual([s.reads, s.registry.templates(project.id as ProjectId)], [[], []], "nothing is read, and no template of the project's size is built for it");
  const memory = (await s.call("POST", "/v1/threads", { project: "acme", title: "Memory", resources: { memoryGiB: 12 } })).body as Thread;
  assert.equal(memory.setup?.how, "fresh");
  assert.ok(memory.setup?.how === "fresh" && memory.setup.building !== undefined, "it asks for the project's template, whose disk it can boot");
  assert.deepEqual(s.reads, [{ branch: "main" }]);
});

test("a template built before the project's disk size changed is not reused by a start of the new size", async (t) => {
  const s = await withImage(t);
  observeNode(s, node, { total: 64, committed: 0 });
  s.remoteReads(async () => ({ commit: "1".repeat(40), setupBlob: "b".repeat(40) }));
  await s.call("POST", "/v1/threads", { project: "acme", title: "Builds" });
  const [old] = s.registry.templates(project.id as ProjectId);
  assert.ok(old?.state === "building");
  s.registry.saveTemplate({ id: old.id, key: old.key, state: "ready", builtOn: node, builtAt: Date.now() - 60_000, commit: "1".repeat(40) });
  observeNode(s, node, { total: 64, committed: 0 }, { artifacts: [image.id, old.id] as NodeObservation["artifacts"] });
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Reuses" })).body.setup.how, "template", "the 10 GiB template serves a 10 GiB start");

  assert.equal((await s.call("PATCH", "/v1/projects/acme", { resources: { diskGiB: 40 } })).status, 200);
  const sized = (await s.call("POST", "/v1/threads", { project: "acme", title: "Sized", resources: { diskGiB: 40 } })).body as Thread;
  assert.equal(sized.setup?.how, "fresh", "the 10 GiB template's disk cannot be a 40 GiB pylon's");
  assert.ok(sized.setup?.how === "fresh" && sized.setup.building !== undefined && sized.setup.building !== old.id, "a 40 GiB template is built for the next thread");
  assert.deepEqual(s.registry.pylon(sized.pylonId)!.firstBoot, { kind: "fresh", preSetup: null });
});

test("a start's size overrides its project's field by field, its pylon boots that size, and thread detail reads it back", async (t) => {
  const s = await withImage(t);
  const bigger = await s.call("POST", "/v1/threads", { project: "acme", title: "Bigger", resources: { memoryGiB: 12 } });
  assert.equal(bigger.status, 201, JSON.stringify(bigger.body));
  assert.deepEqual(s.registry.pylon(bigger.body.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 12, diskGiB: 10 }, "the fields it leaves out are the project's");
  assert.deepEqual((await s.call("GET", `/v1/threads/${bigger.body.id}`)).body.pylon.resources, { cpus: 2, memoryGiB: 12, diskGiB: 10 });
  const sized = await s.call("POST", "/v1/threads", { project: "acme", title: "Sized", resources: { cpus: 4, memoryGiB: 8, diskGiB: 40 } });
  assert.deepEqual(s.registry.pylon(sized.body.pylonId)!.boot.resources, { cpus: 4, memoryGiB: 8, diskGiB: 40 });
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "Plain" });
  assert.deepEqual((await s.call("GET", `/v1/threads/${plain.body.id}`)).body.pylon.resources, project.resources);

  for (const resources of [{ cpus: 0 }, { memoryGiB: -8 }, { diskGiB: 1.5 }, { memoryGiB: "8" }, { gpus: 1 }, 8]) {
    assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Wrong", resources })).status, 400, JSON.stringify(resources));
  }
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: Thread) => r.title).toSorted(), ["Bigger", "Plain", "Sized"], "no refused start made a thread");
});

test("--node auto weighs a thread's own size, not its project's, and counts it once placed", async (t) => {
  const s = await withImage(t);
  observeNode(s, "small", { total: 16, committed: 8 });
  observeNode(s, "big", { total: 64, committed: 48 });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Big", node: "auto", resources: { memoryGiB: 12 } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.placement.node, "big");
  assert.deepEqual(started.body.placement.weighed.find((w: { node: string }) => w.node === "small"), { node: "small", refused: "has 8 of 16 GiB of memory committed, and the pylon needs 12" },
    "small has room for the project's 4 GiB but not the start's 12");
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Huge", node: "auto", resources: { memoryGiB: 20 } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /big has 60 of 64 GiB of memory committed, and the pylon needs 20/, "big counts Big's 12 GiB, which it has yet to report");

});

test("an overlapping start's reservation holds the start's own size", async (t) => {
  const s = await withImage(t);
  observeNode(s, "a", { total: 16, committed: 0 });
  observeNode(s, "b", { total: 16, committed: 2 });
  const { harness } = s.fake;
  const start = harness.startThread;
  const held = Promise.withResolvers<void>();
  let entered = 0;
  harness.startThread = async (thread) => { entered++; await held.promise; return start(thread); };
  const first = s.call("POST", "/v1/threads", { project: "acme", title: "One", node: "auto", resources: { memoryGiB: 12 } });
  while (entered < 1) await sleep(5);
  const second = s.call("POST", "/v1/threads", { project: "acme", title: "Two", node: "auto" });
  while (entered < 2) await sleep(5);
  held.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.body.placement.node, "a");
  assert.equal(two.body.placement.node, "b");
  assert.deepEqual(two.body.placement.weighed.find((w: { node: string }) => w.node === "a").left.memoryGiB, 0, "a counts the 12 GiB One reserved there, then Two's 4");
});

test("nodes report whether they are overcommitted, and their observed pylons as up, paused, archived, crashed and orphaned", async (t) => {
  const s = await withImage(t);
  const started = async (title: string) => (await s.call("POST", "/v1/threads", { project: "acme", title, node: "a" })).body as Thread;
  observeNode(s, "a", { total: 64, committed: 0 });
  const [up, paused, archived, failing, crashed, given] = [await started("Up"), await started("Paused"), await started("Archived"), await started("Failing"), await started("Crashed"), await started("Given up")];
  for (const thread of [archived, given]) assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 200);
  s.registry.savePylon({ ...s.registry.pylon(up.pylonId)!, boot: { ...s.registry.pylon(up.pylonId)!.boot, resources: { cpus: 4, memoryGiB: 8, diskGiB: 10 } } });
  const stopped = (t: Thread) => ({ pylonId: t.pylonId, phase: "stopped" as const, checkpoint: null, sessions: null });
  observeNode(s, "a", { total: 6, committed: 8 }, {
    pylons: [{ pylonId: up.pylonId, phase: "booting" }, stopped(paused), stopped(archived), { pylonId: "pylon-gone" as PylonId, phase: "booting" },
      { pylonId: failing.pylonId, phase: "broken", detail: "a service did not start", cause: "services", logTail: "" },
      { pylonId: crashed.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" },
      { pylonId: given.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" }],
  });
  observeNode(s, "old", { total: 6, committed: 8 });
  s.registry.apply({ record: "node", node: "old" as NodeName, state: "online", capacity: { memoryGiB: 6, committedMemoryGiB: 8, diskFreeGiB: 100 } as never });
  const nodes = (await s.call("GET", "/v1/nodes")).body as { name: string; overcommitted: boolean; pylons: unknown }[];
  const of = (name: string) => nodes.find((n) => n.name === name)!;
  assert.equal(of("a").overcommitted, true);
  assert.deepEqual(of("a").pylons, {
    up: { pylons: 2, cpus: 6, memoryGiB: 12 }, paused: { pylons: 1, cpus: 2, memoryGiB: 4 }, archived: { pylons: 2, cpus: 4, memoryGiB: 8 },
    crashed: { pylons: 1, cpus: 2, memoryGiB: 4 }, orphaned: ["pylon-gone"],
  }, "a VM whose service failed still holds its CPUs and memory, one whose controller exited holds only its disk, and with its thread archived it waits for an unarchive, not a retry");
  assert.equal(of("old").overcommitted, false, "a probe from before pylons were counted reports a committed memory that means nothing");
  assert.deepEqual([of(node).overcommitted, of(node).pylons], [false, null], "a node never observed has no pylons to report");
});

test("a scratch project has no repository, and each of its threads starts an empty one on its branch", async (t) => {
  const s = await setup(t);
  const scratch = { ...project, id: "sketch", repoUrl: null, allowedHosts: [], logins: [], secrets: [githubTokenGrant] };
  assert.deepEqual(await s.call("POST", "/v1/projects", scratch), { status: 201, body: scratch });
  assert.deepEqual((await s.call("GET", "/v1/projects")).body, [scratch]);
  assert.equal((await s.call("POST", "/v1/projects", { ...scratch, id: "empty-url", repoUrl: "" })).status, 400, "only null makes a scratch project");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);

  const started = await s.call("POST", "/v1/threads", { project: "sketch", title: "Sketch" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.setup, { how: "fresh", reason: "the project is scratch, so it has no template" });
  assert.deepEqual(s.reads, [], "a scratch project has no remote to read");
  const pylon = s.registry.pylon(started.body.pylonId)!;
  assert.deepEqual(pylon.boot.repo, { kind: "empty", branch: "main" });
  assert.deepEqual(pylon.boot.network, { allowedHosts: ["api.github.com", "github.com"], secrets: [githubTokenGrant] }, "the grant opens GitHub, and no repo host joins");
  assert.match(pylon.live.overlay[2]!.content, /new repository on branch main with no commits and no remote/);

  const trunk = await s.call("POST", "/v1/threads", { project: "sketch", title: "Trunk", branch: "trunk" });
  assert.deepEqual(s.registry.pylon(trunk.body.pylonId)!.boot.repo, { kind: "empty", branch: "trunk" });

  const pinned = await s.call("POST", "/v1/threads", { project: "sketch", title: "Pinned", commit: "abc123" });
  assert.equal(pinned.status, 400);
  assert.match(pinned.body.error, /sketch is a scratch project, so it has no commit to check out/);
  assert.equal(s.registry.threads("sketch" as Thread["project"]).length, 2, "no thread was created");
  assert.equal(s.calls.length, 2, "no conversation was started");
});

test("a pylon's allowlist reaches its project's HTTPS repo host and the HTTPS dotfiles host", async (t) => {
  const s = await withThread(t, {
    project: { ...project, repoUrl: "https://github.com/octocat/Spoon-Knife.git", allowedHosts: [], secrets: [], logins: [] },
    dotfiles: { repo: "https://gitlab.example.com/ramtin/dotfiles.git", ref: "main" },
  });
  assert.deepEqual(s.registry.pylon(s.thread.pylonId)!.boot.network.allowedHosts, ["github.com", "gitlab.example.com"]);
});

test("thread detail derives the actual state from the node's last observation", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const detail = async () => (await s.call("GET", `/v1/threads/${thread.id}`)).body as ThreadDetail;

  assert.deepEqual(await detail(), {
    thread,
    attention: null, seenAt: null, lastReplyAt: null,
    desired: "running",
    pylon: { grantsOutdated: false, id: thread.pylonId, node, actualState: "unknown", failed: null, observedAt: null, retryRefused: null, resources: project.resources },
    sessions: [], previews: [], ports: [], outputs: [], prWatch: { enabled: false, stopped: false, error: null }, pullRequests: [], review: null, questions: [], judgments: [], planning: false, attach: "herdr --session nexus", agent: { parkedTasks: 0 },
  });

  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const pylon = s.registry.pylon(thread.pylonId)!;
  const running = {
    pylonId: thread.pylonId, phase: "running" as const, liveHash: pylon.liveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: [running], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  const pause = { jobId: "job-1" as JobId, subject: thread.pylonId, kind: "pause" as const };
  s.registry.apply({ record: "job", status: { ...pause, state: "running", startedAt: "2027-01-01T00:00:59Z" } });
  s.registry.apply({ record: "sessions", pylonId: thread.pylonId, sessions: [{ id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle", title: "plan", message: null }] });
  s.registry.apply({ record: "output", pylonId: thread.pylonId, kind: "branch", ref: "nexus/fix" });
  s.registry.allocatePreviews(thread.pylonId, ["web"], { first: 8443, last: 8443 });
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "web", httpsPort: 8443, ready: true });

  const d = await detail();
  assert.equal(d.pylon.actualState, "pausing");
  assert.equal(d.pylon.observedAt, "2027-01-01T00:01:00Z");
  assert.deepEqual(d.sessions, [{ pylon: thread.pylonId, id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: null, status: "idle", title: "plan", message: null }]);
  assert.deepEqual(d.outputs, [{ thread: thread.id, kind: "branch", ref: "nexus/fix" }]);
  assert.deepEqual(d.previews, [{ pylon: thread.pylonId, service: "web", httpsPort: 8443, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:8443/" }]);

  s.registry.apply({ record: "job", status: { ...pause, state: "succeeded", finishedAt: "2027-01-01T00:01:30Z" } });
  assert.equal((await detail()).pylon.actualState, "running");
  s.registry.markOffline(node);
  assert.equal((await detail()).pylon.actualState, "unknown");
});

/** Reports the node online with the thread's pylon running these services and listening on these ports. */
function observeRunning(s: Awaited<ReturnType<typeof withThread>>, facts: { services?: ServiceFact[]; listening?: { port: number }[] | null }) {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const running = {
    pylonId: s.thread.pylonId, phase: "running" as const, liveHash: s.registry.pylon(s.thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: facts.services ?? [], listening: facts.listening === undefined ? [] : facts.listening, previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: [running], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
}

test("thread detail lists the pylon's listening ports with the service and preview of each", async (t) => {
  const s = await withThread(t);
  const ports = async () => ((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports;
  const web: ServiceFact = { name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true };
  const api: ServiceFact = { name: "api", state: "ready", port: 8080, declared: true, wantsPreview: false };
  observeRunning(s, { services: [web, api], listening: [{ port: 3000 }, { port: 5173 }, { port: 8080 }] });
  s.registry.allocatePreviews(s.thread.pylonId, ["web"], { first: 10200, last: 10299 });
  assert.deepEqual(await ports(), [
    { port: 3000, service: null, preview: null },
    { port: 5173, service: "web", preview: { pylon: s.thread.pylonId, service: "web", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" } },
    { port: 8080, service: "api", preview: null },
  ]);
  observeRunning(s, { listening: null });
  assert.equal(await ports(), null, "ports the node could not read are unknown, not none");
  s.registry.ingested({ ...s.registry.node(node)!.observation!, pylons: [{ pylonId: s.thread.pylonId, phase: "stopped", checkpoint: null, sessions: null }] }, []);
  assert.deepEqual(await ports(), [], "nothing listens in a stopped pylon");
});

test("a node whose stored observation is from a probe before routes, grants, counting and listening ports gets no thread, is not overcommitted, and its pylon's ports are unknown", async (t) => {
  const s = await withThread(t);
  const capacity = { memoryGiB: 6, committedMemoryGiB: 8, diskFreeGiB: 100 };
  s.registry.apply({ record: "node", node, state: "online", capacity: capacity as never });
  const running = {
    pylonId: s.thread.pylonId, phase: "running", liveHash: s.registry.pylon(s.thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id, checkpoint: null }, services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [image.id], jobs: [], pylons: [running] } as never, []);
  assert.equal(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, null, "a probe that read no ports reports them unknown");
  const nodes = (await s.call("GET", "/v1/nodes")).body as { name: string; overcommitted: boolean }[];
  assert.equal(nodes.find((n) => n.name === node)!.overcommitted, false, "the committed memory of a probe from before pylons were counted means nothing");
  const refused = await s.call("POST", "/v1/threads", { project: "acme", title: "Placed", node: "auto" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "no node can run this pylon: rj-firebat runs a probe too old to report what its pylons hold");
});

test("linking a port goes through the node's probe, gives it an https port at once, and counts as human activity", async (t) => {
  const s = await withThread(t);
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  const linked = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  const preview = { pylon: s.thread.pylonId, service: "port-3000", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual(linked, { status: 200, body: preview });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "link-port", port: 3000 }]]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node), "the loop publishes the new port at its next pass");
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 }), { status: 200, body: preview }, "linking again answers the same preview");
  observeRunning(s, { services: [], listening: [{ port: 3000 }] });
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, [{ port: 3000, service: "port-3000", preview }], "the port has its preview before the node lists its service");
  observeRunning(s, { services: [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], listening: [{ port: 3000 }] });
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).ports, [{ port: 3000, service: "port-3000", preview }]);

  // A port a declared service owns is previewed under that service.
  s.probeAnswers(async () => ({ kind: "link-port", service: "web" }));
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 5173 })).body.service, "web");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 70000 })).status, 400);
  const commands = s.commands.length;
  const reserved = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 22 });
  assert.equal(reserved.status, 400);
  assert.match(reserved.body.error, /is Nexus's own/);
  assert.equal(s.commands.length, commands, "a reserved port never reaches the probe");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000, title: "App" })).status, 400, "a preview has no title");
});

test("a preview that finds no free port answers 503, and any other allocation fault 500", async (t) => {
  const s = await withThread(t);
  const allocate = s.registry.allocatePreviews;
  s.registry.allocatePreviews = (pylon, services) => allocate(pylon, services, { first: 10200, last: 10199 });
  const full = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  assert.equal(full.status, 503);
  assert.match(full.body.error, /no https port is free for the preview of port-3000/);
  s.registry.allocatePreviews = () => { throw new Error("database is locked"); };
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 }), { status: 500, body: { error: "database is locked" } });
});

test("a node's probe that refuses the control plane answers 502", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat refused this caller"), { code: "forbidden" }); });
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 }), { status: 502, body: { error: "rj-firebat refused this caller" } });
});

test("linking a port of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  const paused = await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 503);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
  assert.deepEqual(s.registry.previews(s.thread.pylonId), []);
});

test("unpublishing a linked port goes through the node's probe, drops its preview at once, counts as human activity, and is safe to repeat", async (t) => {
  const s = await withThread(t);
  const detail = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  const linked = (await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).body;
  // The node's last read still lists the port's service, as it does until its next read.
  observeRunning(s, { services: [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], listening: [{ port: 3000 }] });
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  s.commands.length = 0;
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "unlink-port", port: 3000 }]]);
  assert.deepEqual((await detail()).previews, []);
  assert.deepEqual((await detail()).ports, [{ port: 3000, service: "port-3000", preview: null }], "the port is listed again, without a preview");
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node), "the loop publishes the previews without it at its next pass");
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {}), { status: 204, body: null }, "unpublishing again succeeds");
  assert.equal(s.commands.length, 2, "and asks the pylon again, which knows whether the port is linked");
  assert.deepEqual((await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 })).body, linked, "the port can be published again, on the port it freed");

  // The pylon refuses a port a service's preview owns, and its reason, which names the service, is the whole error.
  s.registry.allocatePreviews(s.thread.pylonId, ["web"], { first: 10200, last: 10299 });
  const reason = "Port 5173 is the preview of service web, not a linked port. Remove the preview from /home/user/workspace/repo/.nexus/services.yaml to unpublish it";
  s.probeAnswers(async () => ({ kind: "unlink-port", refused: reason }));
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/5173`, {}), { status: 422, body: { error: reason } });
  assert.deepEqual((await detail()).previews.map((p) => p.service), ["port-3000", "web"], "a refused unlink keeps every preview");

  s.commands.length = 0;
  for (const port of ["abc", "0", "70000", "22"]) assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/${port}`, {})).status, 400, port);
  assert.deepEqual(s.commands, [], "a bad or reserved port never reaches the probe");
});

test("unpublishing a port of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  await s.call("POST", `/v1/threads/${s.thread.id}/previews`, { port: 3000 });
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {});
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node), "the request wakes the pylon");
  assert.deepEqual(s.registry.previews(s.thread.pylonId).map((p) => p.service), ["port-3000"], "the preview stays until the pylon unlinks the port");
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 503);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/previews/3000`, {})).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
});

test("opening a session goes through the node's probe, defaults to Claude Code titled by its harness, and counts as human activity", async (t) => {
  const s = await withThread(t);
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {}), { status: 201, body: { herdrPane: "w1:p1", harness: "claude-code", title: "claude-code" } });
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, { harness: "pi", title: " plan " }), { status: 201, body: { herdrPane: "w1:p1", harness: "pi", title: "plan" } });
  assert.deepEqual(s.commands, [
    [s.thread.pylonId, { kind: "open-session", harness: "claude-code", title: "claude-code" }],
    [s.thread.pylonId, { kind: "open-session", harness: "pi", title: "plan" }],
  ]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node));

  s.commands.length = 0;
  for (const body of [{ harness: "codex" }, { title: "" }, { title: "x".repeat(81) }, { resume: "bd2c2d6b" }]) {
    assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(s.commands, [], "a bad request never reaches the probe");
});

const git = promisify(execFile);

/** A checkout on this machine whose first commit is refs/nexus/base, which the probe's pipes read in place of the pylon's. */
async function localCheckout(t: import("node:test").TestContext, s: { probePipes(next: (argv: readonly string[]) => Promise<ByteStream>): void }) {
  const repo = await mkdtemp(join(tmpdir(), "nexus-api-checkout-"));
  t.after(() => rm(repo, { recursive: true }));
  const run = (...args: string[]) => git("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "app.ts"), "export const a = 1;\n");
  await run("init", "-q");
  await run("add", "-A");
  await run("commit", "-q", "-m", "first");
  await run("update-ref", "refs/nexus/base", "HEAD");
  const base = (await run("rev-parse", "HEAD")).stdout.trim();
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {}));
  return { repo, run, base };
}

test("a thread's files and changes are read from its checkout through its node's probe, and reading counts as human activity", async (t) => {
  const s = await withThread(t);
  const { repo, base } = await localCheckout(t, s);
  await writeFile(join(repo, "src", "app.ts"), "export const a = 2;\n");
  await writeFile(join(repo, "shot.png"), Buffer.from([0x89, 0x50, 0, 255]));
  s.registry.recordActivity(s.thread.id, { human: 1 });
  s.woken.length = 0;
  const id = s.thread.id;

  const root = await s.call("GET", `/v1/threads/${id}/files`);
  assert.equal(root.status, 200);
  assert.deepEqual(root.body.entries.filter((e: { name: string }) => e.name !== ".git"), [{ name: "shot.png", kind: "file", size: 4 }, { name: "src", kind: "dir", size: null }]);
  assert.deepEqual((await s.call("GET", `/v1/threads/${id}/files?path=src`)).body, { path: "src", entries: [{ name: "app.ts", kind: "file", size: 20 }], truncated: false });

  const shot = await s.raw(`/v1/threads/${id}/files/content?path=shot.png`);
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, Buffer.from([0x89, 0x50, 0, 255]));
  assert.equal(shot.headers["content-type"], "image/png");
  assert.equal(shot.headers["x-content-type-options"], "nosniff");
  assert.equal(shot.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal((await s.raw(`/v1/threads/${id}/files/content?path=src%2Fapp.ts`)).body.toString(), "export const a = 2;\n");

  assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes`), {
    status: 200,
    body: {
      base: { kind: "start", commit: base },
      files: [
        { path: "shot.png", oldPath: null, status: "added", additions: null, deletions: null },
        { path: "src/app.ts", oldPath: null, status: "modified", additions: 1, deletions: 1 },
      ],
      truncated: false,
    },
  });
  const diff = await s.call("GET", `/v1/threads/${id}/diff?base=head&path=src%2Fapp.ts`);
  assert.equal(diff.status, 200);
  assert.equal(diff.body.base.kind, "head");
  assert.match(diff.body.diff, /^diff --git a\/src\/app.ts b\/src\/app.ts\n[^]*-export const a = 1;\n\+export const a = 2;\n$/);

  assert.ok(s.streams.every(([pylon, argv]) => pylon === s.thread.pylonId && argv[0] === "python3"));
  assert.ok(s.registry.thread(id)!.lastHumanActivityAt > 1);
  assert.ok(s.woken.includes(node));
});

const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR pixels")]);
const gifBytes = Buffer.from("GIF89a pixels");

test("a thread's checkout images are served while its pylon runs, sniffed, and the file at a base too", async (t) => {
  const s = await withThread(t);
  const { repo, run } = await localCheckout(t, s);
  observeRunning(s, {});
  await writeFile(join(repo, "shot.png"), pngBytes);
  await run("add", "shot.png");
  await run("commit", "-q", "-m", "shot");
  await writeFile(join(repo, "shot.png"), gifBytes);
  const active = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const image = (query: string) => s.raw(`/v1/threads/${s.thread.id}/image?${query}`);

  const now = await image("source=file&path=shot.png");
  assert.equal(now.status, 200);
  assert.deepEqual(now.body, gifBytes);
  assert.equal(now.headers["content-type"], "image/gif", "the bytes say what it is, not its name");
  assert.equal(now.headers["x-content-type-options"], "nosniff");
  assert.equal(now.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(now.headers["cache-control"], "no-cache");
  const before = await image("source=file&path=shot.png&base=head");
  assert.deepEqual([before.status, before.headers["content-type"]], [200, "image/png"]);
  assert.deepEqual(before.body, pngBytes);
  assert.equal((await image("source=file&path=shot.png&base=start")).status, 404, "the file was added after the start");

  await writeFile(join(repo, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  await writeFile(join(repo, "fake.png"), "not a png");
  for (const path of ["logo.svg", "fake.png", "src/app.ts"]) assert.equal((await image(`source=file&path=${encodeURIComponent(path)}`)).status, 415, path);
  await writeFile(join(repo, "huge.png"), Buffer.concat([pngBytes, Buffer.alloc(10 << 20)]));
  assert.equal((await image("source=file&path=huge.png")).status, 413);
  assert.equal((await image("source=file&path=..%2Fsecret.png")).status, 400);
  for (const query of ["source=file", "source=disk&path=shot.png", "source=file&path=shot.png&base=yesterday", "source=harness&entry=1&message=0&part=0&sha256=x"]) {
    assert.equal((await image(query)).status, 400, query);
  }
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, active, "an image's load is not the person's activity");
  assert.deepEqual(s.woken, []);
});

test("an image is refused with a 409 while the pylon does not run, without waking it, and a caller who may not read files may not read images", async (t) => {
  const s = await withThread(t);
  await localCheckout(t, s);
  const active = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const route = `/v1/threads/${s.thread.id}/image?source=file&path=src%2Fapp.ts`;
  const paused = await s.call("GET", route);
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running, and this request does not wake it/);
  assert.deepEqual(s.streams, [], "the probe is never asked");
  assert.deepEqual(s.woken, []);
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, active);

  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/files/content?path=src%2Fapp.ts`)).status, 403);
  assert.equal((await s.call("GET", route)).status, 403);
  s.callAs(laptop);
  assert.equal((await s.call("GET", "/v1/threads/th-nope/files/content?path=src%2Fapp.ts")).status, 404);
  assert.equal((await s.call("GET", "/v1/threads/th-nope/image?source=file&path=src%2Fapp.ts")).status, 404);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.woken.length = 0;
  assert.equal((await s.call("GET", route)).status, 409);
  assert.deepEqual(s.woken, []);
});

test("a harness conversation's image part is served by its hash, and a part that changed is gone", async (t) => {
  const s = await withThread(t);
  const data = pngBytes.toString("base64");
  const transcript = s.fake.transcript(s.thread.id);
  transcript.messages.push({ role: "toolResult", toolCallId: "c1", toolName: "screenshot", content: [{ type: "text", text: "taken" }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp: 0 });
  s.fake.commit(s.thread.id);
  const entry = transcript.messages.length;
  const sha256 = createHash("sha256").update(data).digest("hex");
  s.woken.length = 0;
  const shot = await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${entry}&message=0&part=1&sha256=${sha256}`);
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, pngBytes);
  assert.equal(shot.headers["content-type"], "image/png");
  assert.equal(shot.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.equal(shot.headers["x-content-type-options"], "nosniff");
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${entry}&message=0&part=1&sha256=${"0".repeat(64)}`)).status, 404);
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${entry}&message=0&part=0&sha256=${sha256}`)).status, 404, "a text part is no image");

  const big = Buffer.concat([pngBytes, Buffer.alloc(10 << 20)]).toString("base64");
  transcript.messages.push({ role: "user", content: [{ type: "image", data: big, mimeType: "image/png" }], timestamp: 0 });
  s.fake.commit(s.thread.id);
  const bigSha = createHash("sha256").update(big).digest("hex");
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${transcript.messages.length}&message=0&part=0&sha256=${bigSha}`)).status, 413);
  transcript.messages.push({ role: "user", content: [{ type: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" }], timestamp: 0 });
  s.fake.commit(s.thread.id);
  const svgSha = createHash("sha256").update(Buffer.from("<svg/>").toString("base64")).digest("hex");
  assert.equal((await s.raw(`/v1/threads/${s.thread.id}/image?source=harness&entry=${transcript.messages.length}&message=0&part=0&sha256=${svgSha}`)).status, 415);
  assert.deepEqual(s.woken, [], "a harness image needs no pylon");
});

test("a scratch thread's changes and diff are against the empty tree, before its first commit and after", async (t) => {
  const s = await withThread(t);
  const scratch = await mkdtemp(join(tmpdir(), "nexus-api-scratch-"));
  t.after(() => rm(scratch, { recursive: true }));
  const repo = join(scratch, "repo");
  await git("sh", ["-c", repoInitCommand({ kind: "empty", branch: "main" }, repo)]);
  const run = (...args: string[]) => git("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {}));
  const id = s.thread.id;
  const added = (path: string, additions: number) => ({ path, oldPath: null, status: "added", additions, deletions: 0 });
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "README.md"), "# sketch\n");
  await writeFile(join(repo, "src", "main.go"), "package main\n");

  for (const kind of ["start", "head"]) {
    assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes?base=${kind}`), {
      status: 200,
      body: { base: { kind, commit: null }, files: [added("README.md", 1), added("src/main.go", 1)], truncated: false },
    }, kind);
  }
  const diff = await s.call("GET", `/v1/threads/${id}/diff?path=README.md`);
  assert.equal(diff.status, 200);
  assert.deepEqual(diff.body.base, { kind: "start", commit: null });
  assert.match(diff.body.diff, /^diff --git a\/README.md b\/README.md\nnew file mode 100644\n[^]*--- \/dev\/null\n\+\+\+ b\/README.md\n@@ -0,0 \+1 @@\n\+# sketch\n$/);

  await run("add", "-A");
  await run("commit", "-q", "-m", "first");
  const head = (await run("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(repo, "README.md"), "# sketch\nmore\n");
  await writeFile(join(repo, "notes.txt"), "later\n");
  assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes`), {
    status: 200,
    body: { base: { kind: "start", commit: null }, files: [added("README.md", 2), added("notes.txt", 1), added("src/main.go", 1)], truncated: false },
  }, "the agent's commit is a change since the start too");
  assert.deepEqual(await s.call("GET", `/v1/threads/${id}/changes?base=head`), {
    status: 200,
    body: { base: { kind: "head", commit: head }, files: [{ path: "README.md", oldPath: null, status: "modified", additions: 1, deletions: 0 }, added("notes.txt", 1)], truncated: false },
  });
});

test("a checkout read the pylon refuses answers its status, and a bad request never reaches the probe", async (t) => {
  const s = await withThread(t);
  const { run } = await localCheckout(t, s);
  const id = s.thread.id;
  const refusal = async (path: string, status: number, message: RegExp) => {
    const reply = await s.call("GET", path);
    assert.equal(reply.status, status, path);
    assert.match(reply.body.error, message, path);
  };
  await refusal(`/v1/threads/${id}/files?path=nope`, 404, /nope does not exist/);
  await refusal(`/v1/threads/${id}/files/content?path=src`, 400, /src is not a file/);
  await refusal(`/v1/threads/${id}/files?path=..%2F..`, 400, /outside the checkout/);
  await run("update-ref", "-d", "refs/nexus/base");
  await refusal(`/v1/threads/${id}/changes`, 422, /no refs\/nexus\/base/);
  assert.equal((await s.call("GET", `/v1/threads/${id}/changes?base=head`)).status, 200);

  s.streams.length = 0;
  for (const path of [`/v1/threads/${id}/changes?base=main`, `/v1/threads/${id}/diff?base=tip`, `/v1/threads/${id}/files/content`, `/v1/threads/${id}/files/content?path=`, `/v1/threads/${id}/files?path=a%00b`, `/v1/threads/${id}/diff?${Array(100).fill(`path=${"p".repeat(154)}`).join("&")}`, `/v1/threads/${id}/files?path=${"%C3%A9".repeat(2000)}`]) {
    assert.equal((await s.call("GET", path)).status, 400, path);
  }
  assert.deepEqual(s.streams, [], "a bad request never reaches the probe");
});

test("reading the checkout of a pylon that is not running wakes it and is refused with 409, and an archived thread's probe is never asked", async (t) => {
  const s = await withThread(t);
  s.probePipes(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("GET", `/v1/threads/${s.thread.id}/changes`);
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node));
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.streams.length = 0;
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/files`)).status, 409);
  assert.deepEqual(s.streams, []);
});

test("a checkout read whose thread is deleted while it runs answers the delete, not the node's failure", async (t) => {
  const s = await withThread(t);
  s.probePipes(async () => {
    assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
    throw new Error(`rj-firebat: ${s.thread.pylonId} is not running`);
  });
  const read = await s.call("GET", `/v1/threads/${s.thread.id}/changes`);
  assert.equal(read.status, 409);
  assert.match(read.body.error, /is deleted/);
});

test("closing a session goes through the node's probe, and a pane that is not open, such as one from before a wake, is a 404", async (t) => {
  const s = await withThread(t);
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "close-session", herdrPane: "w1:p1" }]]);
  s.probeAnswers(async () => ({ kind: "close-session", outcome: "not-open" }));
  const stale = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.equal(stale.status, 404);
  assert.match(stale.body.error, /no session is open in pane w1:p1 .* A wake may have moved it/);
});

test("focusing a session runs Herdr's focus on its pane in the pylon as an argument, a pane that is not open is a 404, and anything but a pane ID is a 400", async (t) => {
  const s = await withThread(t);
  const focus = (pane: string) => s.call("POST", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent(pane)}/focus`, {});
  assert.deepEqual(await focus("w3:p1"), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "exec", argv: ["sh", "-c", focusScript, "focus", "w3:p1"], cwd: "/", timeoutMs: 15_000 }]]);
  s.probeAnswers(async () => ({ kind: "exec", exitCode: 1, output: "", truncated: false }));
  assert.deepEqual(await focus("w9:p1"), { status: 404, body: { error: `no pane w9:p1 is open in pylon ${s.thread.pylonId}` } });
  for (const pane of ["p1", "w1:p1;reboot", "$(id)", "w1:p1 w2:p1"]) {
    const refused = await focus(pane);
    assert.equal(refused.status, 400, pane);
    assert.match(refused.body.error, /^pane must be a Herdr pane ID such as w1:p1/);
  }
  assert.equal(s.commands.length, 2, "no refused pane reached the probe");
});

test("closing a listed session names it, and a pane that runs another session now is a 404 that leaves it open", async (t) => {
  const s = await withThread(t);
  s.registry.apply({ record: "sessions", pylonId: s.thread.pylonId, sessions: [
    { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review", status: "idle", message: null },
  ] });
  s.probeAnswers(async () => ({ kind: "close-session", outcome: "moved" }));
  const moved = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "close-session", herdrPane: "w1:p1", session: { harness: "claude-code", harnessSessionId: "s1", title: "review" } }]]);
  assert.equal(moved.status, 404);
  assert.match(moved.body.error, /pane w1:p1 of pylon \S+ runs another session now, so it was left open. A wake moved session w1:p1 to another pane/);
});

/** Records the thread's pylon stopped with these sessions, as the loop would from the node's observation. */
function observeStopped(s: Awaited<ReturnType<typeof withThread>>, sessions: readonly PausedSession[]) {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const stopped = { pylonId: s.thread.pylonId, phase: "stopped" as const, checkpoint: null, sessions };
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: [stopped], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] },
    ingest({ type: "pylon", pylon: stopped }, node, new Map([[s.thread.pylonId, "absent"]]), Date.now()));
}

const pausedReview: PausedSession = { id: "w1:p1", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: "s1", title: "review" };

test("an idle-paused or archived thread lists the sessions its wake brings back, as paused", async (t) => {
  const s = await withThread(t);
  s.registry.apply({ record: "sessions", pylonId: s.thread.pylonId, sessions: [{ ...pausedReview, herdrPane: "w1:p1", state: "running", status: "working", message: null }] });
  observeStopped(s, [pausedReview]);
  const sessions = async () => ((await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail).sessions;
  const paused = [{ pylon: s.thread.pylonId, ...pausedReview, state: "paused", status: "working", message: null }];
  assert.deepEqual(await sessions(), paused);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  assert.deepEqual(await sessions(), paused);
});

test("closing a paused session is refused with 409 without asking the probe or waking the pylon", async (t) => {
  const s = await withThread(t);
  observeStopped(s, [pausedReview]);
  // Timestamps only move forward, so this is the thread's start.
  const human = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const idle = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.equal(idle.status, 409);
  assert.match(idle.body.error, /session w1:p1 is paused with its pylon and resumes when its pylon wakes. Close it once it runs/);
  assert.deepEqual(s.woken, []);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.woken.length = 0;
  const archived = await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${encodeURIComponent("w1:p1")}`, {});
  assert.equal(archived.status, 409);
  assert.match(archived.body.error, /resumes when `nexus unarchive .*` wakes its pylon/);
  assert.deepEqual(s.commands, []);
  assert.deepEqual(s.woken, []);
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, human, "a refused close is not activity");
});

test("closing a failed session in no pane drops it from the pylon, by its ID", async (t) => {
  const s = await withThread(t);
  const id = "failed-0123456789ab";
  s.registry.apply({ record: "sessions", pylonId: s.thread.pylonId, sessions: [
    { id, state: "failed", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan", status: null, message: "pi exited 1" },
  ] });
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${id}`, {}), { status: 204, body: null });
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "drop-failed-session", id }]]);
  s.probeAnswers(async () => ({ kind: "drop-failed-session", dropped: false }));
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/${id}`, {})).status, 404);
});

test("a session of a pylon that is not running, or of an archived or deleted thread, is refused with 409", async (t) => {
  const s = await withThread(t);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.woken.length = 0;
  const paused = await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, { harness: "claude-code" });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.woken.includes(node), "the request wakes the pylon");
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/w1:p1`, {})).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  s.commands.length = 0;
  const archived = await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {});
  assert.equal(archived.status, 409);
  assert.match(archived.body.error, /is archived, so its pylon stays paused/);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}/sessions/w1:p1`, {})).status, 409);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/sessions`, {})).status, 409);
  assert.deepEqual(s.commands, [], "an archived or deleted thread's probe is never asked");
});

test("a failed pylon shows failed with its reason until its thread is deleted, and then shows the delete", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const detail = async () => (await s.call("GET", `/v1/threads/${thread.id}`)).body as ThreadDetail;
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const reason = "last job failed with setup-failed, which is not retryable: pylon-x: Setup exited 128\nfatal: unable to access";
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: reason });
  assert.deepEqual((await detail()).pylon, { grantsOutdated: false, id: thread.pylonId, node, actualState: "failed", failed: reason, observedAt: null, retryRefused: null, resources: project.resources });
  const [row] = (await s.call("GET", "/v1/threads")).body as ThreadRow[];
  assert.deepEqual([row!.desired, row!.pylon], [(await detail()).desired, { node, actualState: "failed", failed: reason }], "the list reports the pylon as its detail does");

  await s.call("DELETE", `/v1/threads/${thread.id}`);
  const del = { jobId: "job-del" as JobId, subject: thread.pylonId, kind: "delete" as const };
  s.registry.apply({ record: "job", status: { ...del, state: "running", startedAt: "2027-01-01T00:00:00Z" } });
  assert.equal((await detail()).pylon.actualState, "deleting");
  s.registry.apply({ record: "job", status: { ...del, state: "succeeded", finishedAt: "2027-01-01T00:00:05Z" } });
  s.registry.ingested({ node, observedAt: "2027-01-01T00:00:06Z", probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  assert.deepEqual((await detail()).pylon, { grantsOutdated: false, id: thread.pylonId, node, actualState: "absent", failed: reason, observedAt: "2027-01-01T00:00:06Z", retryRefused: null, resources: project.resources });
});

test("the thread list leaves deleted threads out when asked, as the dashboard asks and `threads --all` does not", async (t) => {
  const s = await withThread(t);
  const gone = (await s.call("POST", "/v1/threads", { project: "acme", title: "Old spike" })).body as Thread;
  assert.equal((await s.call("DELETE", `/v1/threads/${gone.id}`)).status, 200);
  const ids = async (path: string) => ((await s.call("GET", path)).body as ThreadRow[]).map((r) => r.id);
  assert.deepEqual(await ids("/v1/threads"), [s.thread.id, gone.id]);
  assert.deepEqual(await ids("/v1/threads?deleted=false"), [s.thread.id]);
  assert.deepEqual(await ids("/v1/threads?project=acme&deleted=false"), [s.thread.id]);
});

test("a follow from the latest event gets a reply's events and none from before it", async (t) => {
  const s = await withThread(t);
  s.registry.recordReply(s.thread.id, Date.now());
  const kinds = ["attention.changed", "thread.turn-ended", "session.turn-started", "session.turn-ended", "session.waiting", "session.ended"];
  const stream = s.events(`/v1/events?follow=true&since=latest&${kinds.map((k) => `kind=${k}`).join("&")}`);
  t.after(() => stream.close());
  await stream.response;
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/seen`, {})).status, 204);
  s.registry.recordReply(s.thread.id, Date.now());
  assert.deepEqual([(await stream.next()).payload, (await stream.next()).kind, (await stream.next()).payload], [{ attention: null }, "thread.turn-ended", { attention: "reply" }]);
  assert.deepEqual((await s.call("GET", "/v1/events?since=latest")).body, [], "nothing comes after the latest event");
});

test("retrying a failed pylon clears the planner's verdict and its attempts, marks the retry, counts as human activity and wakes its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const retry = (headers: Record<string, string> = {}) => s.call("POST", `/v1/threads/${thread.id}/pylon/retry`, undefined, headers);
  assert.equal((await retry()).status, 409, "a pylon that has not failed has nothing to retry");

  const failed = {
    ...s.registry.pylon(thread.pylonId)!,
    attempts: { count: 1, last: { at: 1, code: "setup-failed" as const, message: "fatal: could not read from remote repository" } },
    failed: "last job failed with setup-failed, which is not retryable: fatal: could not read from remote repository",
  };
  s.registry.savePylon(failed);
  assert.equal((await retry({ "content-type": "text/plain" })).status, 415);
  assert.equal((await retry({ host: "evil.example" })).status, 403);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await retry()).status, 403);
  s.callAs(laptop);
  assert.deepEqual(s.registry.pylon(thread.pylonId), failed, "a refused retry leaves the pylon failed");

  s.woken.length = 0;
  const before = Date.now();
  assert.equal((await retry()).status, 204, "a human may retry a failure the planner would not");
  assert.deepEqual(s.registry.pylon(thread.pylonId), { ...failed, attempts: { count: 0, last: null }, failed: null, retrying: true });
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before, "the pylon is wanted at once");
  assert.deepEqual(s.woken, [node]);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.failed, null);
  assert.equal((await retry()).status, 409, "a second retry finds nothing to clear");
});

test("a pylon whose disk holds a failed setup cannot be retried, and its detail says why", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const broken = (cause: "setup" | "saved-setup" | "services") => s.registry.ingested({
    node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [], jobs: [],
    pylons: [{ pylonId: thread.pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause, logTail: "" }], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
  }, []);
  broken("saved-setup");
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: "pylon is broken: Setup exited 128. Read controller logs" });
  const refusal = "Its disk holds the failed setup, and every boot of that disk fails the same way, so a retry cannot help. Start again from the project";
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.retryRefused, refusal);
  const res = await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`);
  assert.deepEqual(res, { status: 409, body: { error: `pylon ${thread.pylonId} cannot be retried. ${refusal}` } });
  assert.notEqual(s.registry.pylon(thread.pylonId)!.failed, null, "a refused retry leaves the verdict");

  broken("services");
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.retryRefused, null);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`)).status, 204, "a service that failed may start on the next boot");

  broken("setup");
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: "pylon is broken: Setup exited 128. Read controller logs" });
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.pylon.retryRefused, null);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`)).status, 204, "the pause removes a VM whose setup failed on this boot, so setup runs again");
});

test("an archived thread's failed pylon can be retried and stays archived, and a deleted thread's cannot", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const fail = () => s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed: "gave up after 5 failed attempts" });
  await s.call("POST", `/v1/threads/${thread.id}/archive`);
  fail();
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`)).status, 204);
  assert.equal(s.registry.pylon(thread.pylonId)!.failed, null);
  assert.equal(s.registry.thread(thread.id)!.status, "archived", "a retry settles the pylon rather than unarchiving it");

  fail();
  await s.call("DELETE", `/v1/threads/${thread.id}`);
  const res = await s.call("POST", `/v1/threads/${thread.id}/pylon/retry`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /is deleted/);
  assert.equal((await s.call("POST", "/v1/threads/th-missing/pylon/retry")).status, 404);
});

test("archive, delete, and activity update the thread and wake its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  s.woken.length = 0;
  const before = Date.now();

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/activity`, { kind: "human" })).status, 204);
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/activity`, { kind: "agent", turnRunning: true })).status, 400, "agent activity comes from the harness");

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).body.status, "archived");
  assert.equal(s.registry.thread(thread.id)!.status, "archived");
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).body.status, "deleted");
  assert.equal(s.registry.thread(thread.id)!.status, "deleted");
  assert.deepEqual(s.calls.at(-1), ["delete", { threadId: thread.id, pylonId: thread.pylonId }]);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 409);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}`)).body.agent, null);
  assert.deepEqual(s.woken, [node, node, node]);
});

test("a message goes to the thread's conversation and counts as human activity", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  s.woken.length = 0;
  s.calls.length = 0;
  const before = Date.now();

  const sent = await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "run the tests", requestId: "msg:1" });
  assert.deepEqual(sent, { status: 202, body: { submission: 7 } });
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before);
  assert.deepEqual(s.woken, [node]);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "now", requestId: "msg:2", mode: "steer" })).status, 202);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "", requestId: "msg:3" })).status, 400);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "x" })).status, 400);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/abort`)).status, 204);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/retry`)).status, 204);
  const view = await s.call("GET", `/v1/threads/${thread.id}/conversation`);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.entries.map((e: any) => e.model[0].content), ["run the tests", "now"]);
  assert.deepEqual(s.calls, [
    ["send", thread.id, "run the tests", "msg:1", "followUp"],
    ["send", thread.id, "now", "msg:2", "steer"],
    ["abort", thread.id],
    ["retry", thread.id],
    ["watch", thread.id],
    ["unwatch", thread.id],
  ]);
});

test("a thread's event stream sends the whole view, then each part a commit changed, and stops its watch when the client leaves", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  transcript.docs["pi.inbox"] = { items: [] };
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  const res = await stream.response;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.deepEqual(await stream.next(), { entries: [], docs: { "pi.inbox": { items: [] } } }, "the first event is the whole view");

  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [] }, generation: { message: { role: "assistant", content: [{ type: "text", text: "Hal" }] } } };
  fake.commit(thread.id);
  assert.deepEqual(await stream.next(), { docs: { "pi.live": transcript.docs["pi.live"] } }, "a commit to the live document sends only it, whole");
  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [] }, generation: { message: { role: "assistant", content: [{ type: "text", text: "Half" }] } } };
  fake.commit(thread.id);
  assert.equal((await stream.next()).docs["pi.live"].generation.message.content[0].text, "Half", "the partial is a snapshot, not a delta");

  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "and then?", requestId: "msg:1" })).status, 202);
  const appended = await stream.next();
  assert.deepEqual(Object.keys(appended), ["entries"]);
  assert.deepEqual(appended.entries.map((e: any) => e.model[0].content), ["and then?"]);
  delete transcript.docs["pi.live"];
  fake.commit(thread.id);
  assert.deepEqual(await stream.next(), { docs: { "pi.live": null } }, "a document that is gone is null");

  assert.equal(fake.watching(thread.id), 1);
  stream.close();
  await until("the stream's watch stopped when its client left", () => fake.watching(thread.id) === 0);
  assert.deepEqual(s.calls.filter(([call]) => call === "watch" || call === "unwatch"), [["watch", thread.id], ["unwatch", thread.id]]);
});

test("a client that reads slowly gets the latest view in fewer events, and never holds the harness up", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  const commits = 40;
  // Each commit a megabyte, so the paused client's socket fills after a few.
  for (let i = 1; i <= commits; i++) {
    transcript.docs["pi.live"] = { seq: i, output: "x".repeat(1 << 20) };
    fake.commit(thread.id);
    await new Promise((resolve) => setImmediate(resolve));
  }
  stream.resume();
  const seen: number[] = [];
  while (seen.at(-1) !== commits) seen.push((await stream.next()).docs["pi.live"].seq);
  assert.ok(seen.length < commits, `the backed-up events were merged: ${seen.length} events for ${commits} commits`);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "events stay in commit order");
  stream.close();
});

test("a thread's streams end when it is deleted, and a deleted thread, a stranger or one stream too many is refused", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.events(`/v1/threads/${thread.id}/events`).response).statusCode, 403);
  s.callAs(laptop);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/events`)).status, 405);

  const open = Array.from({ length: maxStreams }, () => s.events(`/v1/threads/${thread.id}/events`));
  for (const stream of open) await stream.next();
  const extra = await s.events(`/v1/threads/${thread.id}/events`).response;
  assert.equal(extra.statusCode, 503, "past the most streams the control plane serves");
  open.pop()!.close();
  await until("a closed stream frees its place", () => fake.watching(thread.id) === maxStreams - 1);
  const page = s.events(`/threads/${thread.id}/stream`);
  assert.ok((await page.next()).convo !== undefined, "the dashboard's stream counts against the same limit");
  open.push(page);

  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  await Promise.all(open.map((stream) => stream.ended));
  await until("every stream of the deleted thread stopped its watch", () => fake.watching(thread.id) === 0);
  assert.equal((await s.events(`/v1/threads/${thread.id}/events`).response).statusCode, 409);
  assert.equal((await s.events("/v1/threads/th-missing/events").response).statusCode, 404);
});

/** Backs up a paused client's socket with ten commits of a megabyte each. */
async function backUp(s: Awaited<ReturnType<typeof withThread>>) {
  const transcript = s.fake.transcript(s.thread.id);
  // One frame must exceed loopback's autotuned socket buffers even when intermediate commits coalesce.
  for (let i = 0; i < 3; i++) {
    transcript.docs["pi.live"] = { seq: i, output: "x".repeat(16 << 20) };
    s.fake.commit(s.thread.id);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a client that stops reading is dropped after the stall limit, with its watch and its place", async (t) => {
  const s = await withThread(t, { streamStallMs: 1000 });
  const { thread, fake } = s;
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  await backUp(s);
  assert.equal(fake.watching(thread.id), 1, "a slow client is not dropped at once");
  await until("the dropped stream stopped its watch", () => fake.watching(thread.id) === 0);
  stream.resume();
  assert.equal(await stream.ended, "dropped");
  const again = s.events(`/v1/threads/${thread.id}/events`);
  assert.ok((await again.next()).entries !== undefined, "a client that still listens connects again and gets the whole view");
  again.close();
});

test("deleting a thread whose client stopped reading frees the stream at once, writes nothing after the end, and drops the client", async (t) => {
  const s = await withThread(t, { streamStallMs: 1000 });
  const { thread, fake } = s;
  const transcript = fake.transcript(thread.id);
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await stream.next();
  stream.pause();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await backUp(s);
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  transcript.docs["pi.live"] = { seq: 10 };
  fake.commit(thread.id);
  assert.equal(fake.watching(thread.id), 0, "the delete stopped the watch at once, though the client has not read the end yet");
  t.mock.timers.tick(1000);
  stream.resume();
  assert.equal(await stream.ended, "dropped", "a client that never read up to the end was dropped after the stall limit");
  assert.equal((await s.call("GET", "/v1/projects")).status, 200, "the control plane is still up");
});

test("a stream whose thread is deleted while its watch opens stops that watch", async (t) => {
  const s = await withThread(t);
  const { thread, fake } = s;
  const release = fake.holdWatches();
  const stream = s.events(`/v1/threads/${thread.id}/events`);
  await until("the stream asked for its watch", () => s.calls.some(([call]) => call === "watch"));
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  release();
  await stream.ended;
  await until("the watch that opened after the delete was stopped", () => fake.watching(thread.id) === 0);
  assert.deepEqual(s.calls.filter(([call]) => call === "watch" || call === "unwatch"), [["watch", thread.id], ["unwatch", thread.id]]);
});

test("unarchiving makes an archived thread active, counts as human activity and wakes its node", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/unarchive`)).status, 409, "an active thread is not archived");
  await s.call("POST", `/v1/threads/${thread.id}/archive`);
  s.woken.length = 0;
  const before = Date.now();
  const res = await s.call("POST", `/v1/threads/${thread.id}/unarchive`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "active");
  assert.ok(res.body.lastHumanActivityAt >= before);
  assert.deepEqual(s.woken, [node]);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "x", requestId: "msg:1" })).status, 202);
});

test("an archived thread takes no messages, and a deleted one has no conversation", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  await s.call("POST", `/v1/threads/${thread.id}/archive`);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "x", requestId: "msg:1" })).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/retry`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/abort`)).status, 204);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}/conversation`)).status, 200);
  await s.call("DELETE", `/v1/threads/${thread.id}`);
  assert.equal((await s.call("GET", `/v1/threads/${thread.id}/conversation`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/abort`)).status, 409);
});

test("unknown threads, routes and methods get 404 and 405", async (t) => {
  const s = await setup(t);
  assert.equal((await s.call("GET", "/v1/threads/th-missing")).status, 404);
  assert.equal((await s.call("GET", "/v1/nothing")).status, 404);
  assert.equal((await s.call("PATCH", "/v1/projects")).status, 405);
  assert.equal((await s.call("POST", "/v1/projects", undefined)).status, 400);
  assert.equal((await s.call("POST", "/v1/projects", "{not json")).status, 400);
});

const fastAttach: AttachTiming = { pingMs: 60_000, waitMs: 5_000, pollMs: 20, hangUpMs: 5_000 };

/**
 * Asks for a terminal as the CLI does, with no Origin unless `headers` gives one. Resolves with the open socket and
 * what it receives, or with the HTTP refusal.
 */
function attachTo(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any } | ReturnType<typeof attached>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, perMessageDeflate: false });
    ws.on("unexpected-response", (_req, res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode!, body: JSON.parse(text) });
        ws.terminate();
      });
    });
    ws.on("error", () => undefined);
    ws.once("open", () => resolve(attached(ws)));
    ws.once("error", reject);
  });
}

function attached(ws: WebSocket) {
  const received: unknown[] = [];
  ws.on("message", (data, binary) => { received.push(binary ? Buffer.from(data as Buffer).toString() : JSON.parse(data.toString())); });
  return { ws, received, closed: once(ws, "close").then(([code]) => code as number) };
}

/** A pipe to the relay in the guest, which records its stdin. Ending its stdin hangs up, and Herdr's client exits 0. */
function fakePipe() {
  const output = new PassThrough();
  const end = Promise.withResolvers<StreamEnd>();
  const stdin: Buffer[] = [];
  const exit = (code: number) => {
    output.end();
    end.resolve({ kind: "exited", code });
  };
  const stream: ByteStream = {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    async write(chunk) { stdin.push(Buffer.from(chunk)); },
    async close() { setTimeout(() => exit(0), 10); },
    abort() {
      output.end();
      end.resolve({ kind: "lost" });
    },
    done: end.promise,
  };
  return { stream, stdin: () => Buffer.concat(stdin), print: (text: string) => output.write(text), exit };
}

const attachPathOf = (thread: string, query = "cols=100&rows=30") => `/v1/threads/${thread}/attach?${query}`;

test("the attach route refuses before the 101 with the API's JSON errors, and a page from any other origin is refused", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const path = attachPathOf(s.thread.id);
  s.probePipes(async () => { throw Object.assign(new Error("rj-firebat: not running"), { code: "not-running" }); });
  const refused = async (status: number, error: RegExp, attempt: Promise<Awaited<ReturnType<typeof attachTo>>>) => {
    const res = await attempt;
    assert.ok("status" in res, "refused before the 101");
    assert.equal(res.status, status);
    assert.match(res.body.error, error);
  };

  s.callAs("nSTRANGER" as TailnetNodeId);
  await refused(403, /caller is not a tailnet node/, attachTo(s.port, path));
  s.callAs(laptop);
  await refused(403, /does not answer to host evil\.example/, attachTo(s.port, path, { host: "evil.example" }));
  for (const origin of [`http://127.0.0.1:8443`, `https://127.0.0.1:${s.port}`, "null", "http://evil.example"]) {
    await refused(403, /does not answer pages from/, attachTo(s.port, path, { origin }));
  }
  await refused(400, /cols must be a whole number from 1 to 9999, got 0/, attachTo(s.port, attachPathOf(s.thread.id, "cols=0&rows=30")));
  await refused(400, /rows must be a whole number/, attachTo(s.port, attachPathOf(s.thread.id, "cols=80")));
  await refused(400, /term must be a terminal type/, attachTo(s.port, attachPathOf(s.thread.id, "cols=80&rows=24&term=x%20y")));
  for (const pane of ["", "p1", "w1:p1%3Breboot", "%24(id)"]) {
    await refused(400, /^pane must be a Herdr pane ID such as w1:p1, got /, attachTo(s.port, attachPathOf(s.thread.id, `cols=80&rows=24&pane=${pane}`)));
  }
  await refused(404, /^no thread th-missing$/, attachTo(s.port, attachPathOf("th-missing")));
  assert.equal(s.streams.length, 0, "no refusal reached the probe");

  for (const headers of [{}, { origin: `http://127.0.0.1:${s.port}` }]) {
    const a = await attachTo(s.port, path, headers);
    assert.ok("ws" in a, `admitted with ${JSON.stringify(headers)}`);
    a.ws.close();
    await a.closed;
  }

  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  await refused(409, new RegExp(`^thread ${s.thread.id} is archived, so its pylon stays paused$`), attachTo(s.port, path));
});

test("an attach wakes the pylon, waits for it, and carries keys, resizes and output until Herdr exits", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const pipe = fakePipe();
  let running = false;
  s.probePipes(async () => {
    if (!running) throw Object.assign(new Error("rj-firebat: not running"), { code: "not-running" });
    return pipe.stream;
  });
  const before = Date.now();
  const a = await attachTo(s.port, attachPathOf(s.thread.id, "cols=100&rows=30&term=xterm-ghostty"));
  assert.ok("ws" in a);
  await until("a waiting message", () => a.received.length === 1);
  assert.deepEqual(a.received, [{ type: "waiting", pylon: "unknown" }]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt >= before, "attaching is human activity");
  assert.ok(s.woken.includes(node), "and wakes the node");
  observeRunning(s, {});
  running = true;
  await until("the attached message", () => a.received.length === 2);
  assert.deepEqual(a.received[1], { type: "attached" });

  const [pylonId, argv] = s.streams.at(-1)!;
  assert.equal(pylonId, s.thread.pylonId);
  assert.deepEqual([argv[0], argv[1], argv[3], ...argv.slice(5)], ["python3", "-c", "guest-terminal.py", "100", "30", "xterm-ghostty", "sh", "-c", attachScript, "attach", ""]);
  const relayBytes = Number(argv[4]);
  await until("the relay's source", () => pipe.stdin().length >= relayBytes);
  assert.match(pipe.stdin().subarray(0, relayBytes).toString(), /^# A program on a pty in a pylon/);

  a.ws.send(Buffer.from("ls\r"));
  a.ws.send(encodeMessage({ type: "resize", size: terminalSize(140, 40) }));
  const frames = Buffer.from([0, 0, 0, 0, 3, ...Buffer.from("ls\r"), 1, 0, 0, 0, 4, 0, 140, 0, 40]);
  await until("the key and resize frames", () => pipe.stdin().length >= relayBytes + frames.length);
  assert.deepEqual(pipe.stdin().subarray(relayBytes), frames);

  pipe.print("herdr screen");
  await until("the output", () => a.received.length === 3);
  pipe.exit(0);
  assert.equal(await a.closed, 1000);
  assert.deepEqual(a.received.slice(2), ["herdr screen", { type: "exit", code: 0 }]);
});

test("a Claude worker's attach lands in the pane of its Claude session, one that names a pane lands there, and a Nexus agent thread's where Herdr was", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" });
  const claude = { ...s, thread: started.body as Thread };
  s.registry.setClaudeWorker(claude.thread.id, "/poteto-mode fix it", "started", undefined, claudeSession);
  const session = (herdrPane: string, harness: "shell" | "claude-code", harnessSessionId: string | null) => ({ id: herdrPane, state: "running" as const, herdrPane, harness, harnessSessionId, status: "idle" as const, title: "x", message: null });
  observeRunning(claude, {});
  s.registry.apply({ record: "sessions", pylonId: claude.thread.pylonId, sessions: [session("w1:p1", "shell", null), session("w2:p1", "claude-code", "another-session"), session("w3:p1", "claude-code", claudeSession)] });
  s.probePipes(async (argv) => argv[0] === "python3" ? fakePipe().stream : processStream("true", [], () => {}));
  const landsIn = async (thread: string, query?: string) => {
    const a = await attachTo(s.port, attachPathOf(thread, query));
    assert.ok("ws" in a);
    await until("attached", () => a.received.length === 1);
    a.ws.close();
    await a.closed;
    return s.streams.findLast(([, argv]) => argv[0] === "python3")![1].slice(8);
  };
  assert.deepEqual(await landsIn(claude.thread.id), ["sh", "-c", attachScript, "attach", "w3:p1"]);
  assert.deepEqual(await landsIn(claude.thread.id, "cols=100&rows=30&pane=w1:p1"), ["sh", "-c", attachScript, "attach", "w1:p1"], "an argument, never the script's text");
  observeRunning(s, {});
  assert.deepEqual(await landsIn(s.thread.id), ["sh", "-c", attachScript, "attach", ""]);
});

test("deleting a thread ends its attach as a conflict, and a closing API ends one with 1001", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  observeRunning(s, {});
  const pipes: ReturnType<typeof fakePipe>[] = [];
  s.probePipes(async () => {
    pipes.push(fakePipe());
    return pipes.at(-1)!.stream;
  });

  const deleted = await attachTo(s.port, attachPathOf(s.thread.id));
  assert.ok("ws" in deleted);
  await until("attached", () => deleted.received.length === 1);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal(await deleted.closed, 1000);
  assert.deepEqual(deleted.received.at(-1), { type: "error", kind: "conflict", message: `thread ${s.thread.id} is deleted` });

  const other = await withThread(t, { attachTiming: fastAttach });
  observeRunning(other, {});
  other.probePipes(async () => fakePipe().stream);
  const stopping = await attachTo(other.port, attachPathOf(other.thread.id));
  assert.ok("ws" in stopping);
  await until("attached", () => stopping.received.length === 1);
  await other.close();
  assert.equal(await stopping.closed, 1001);
  assert.equal((stopping.received.at(-1) as { kind: string }).kind, "unreachable");
});

test("a closing API gives up on a terminal whose node stopped answering after its wait, and opens none for an upgrade it was admitting", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach, closeWaitMs: 100 });
  observeRunning(s, {});
  let opened = 0;
  s.probePipes(async () => {
    opened++;
    // Its hang-up never ends, as a node that stopped answering would leave it.
    return { ...fakePipe().stream, async close() {} };
  });
  const stuck = await attachTo(s.port, attachPathOf(s.thread.id));
  assert.ok("ws" in stuck);
  await until("attached", () => stuck.received.length === 1);

  const whois = s.holdWhois();
  const admitting = attachTo(s.port, attachPathOf(s.thread.id));
  await whois.asked;
  const closing = s.close();
  whois.release();
  assert.equal(await Promise.race([closing.then(() => "closed"), sleep(60_000, "still closing", { ref: false })]), "closed");
  assert.equal(await stuck.closed, 1006, "the stuck terminal's socket is dropped");
  const late = await admitting;
  assert.ok("status" in late && late.status === 503, JSON.stringify("status" in late ? late : "attached"));
  assert.equal(opened, 1, "no terminal opened for the upgrade that was still at whois");
});

test("a closing API drops an upgrade whose whois never returns after its wait", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach, closeWaitMs: 100 });
  const whois = s.holdWhois();
  const stalled = attachTo(s.port, attachPathOf(s.thread.id)).then(() => "answered", () => "dropped");
  await whois.asked;
  const closing = await Promise.race([s.close().then(() => "closed"), sleep(60_000, "still closing", { ref: false })]);
  whois.release();
  assert.equal(closing, "closed");
  assert.equal(await stalled, "dropped", "the upgrade's socket was dropped, not answered");
});

test("a terminal takes a place among the streams", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const open = Array.from({ length: maxStreams }, () => s.events(`/v1/threads/${s.thread.id}/events`));
  for (const stream of open) await stream.next();
  const extra = await attachTo(s.port, attachPathOf(s.thread.id));
  assert.ok("status" in extra && extra.status === 503, JSON.stringify(extra));
  for (const stream of open) stream.close();
});

test("an upgrade the API serves no WebSocket for is handled as an ordinary request", async (t) => {
  const s = await withThread(t);
  const upgrade = { connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  assert.equal((await s.call("GET", "/v1/projects", undefined, upgrade)).status, 200);
  const other = await s.call("GET", attachPathOf(s.thread.id), undefined, { connection: "upgrade", upgrade: "h2c" });
  assert.deepEqual(other, { status: 404, body: { error: `no route /v1/threads/${s.thread.id}/attach`, code: "no-route" } });
});

test("attention ranks failure, unwatched parked tasks, unread reply, then work; seen never wakes", async (t) => {
  const s = await withThread(t);
  const id = s.thread.id;
  const base = `/v1/threads/${id}`;
  const attention = async () => {
    const row = ((await s.call("GET", "/v1/threads")).body as ThreadRow[])[0]!;
    const detail = (await s.call("GET", base)).body as ThreadDetail;
    assert.equal(row.attention, detail.attention);
    assert.equal(row.lastReplyAt, detail.lastReplyAt);
    assert.equal(row.seenAt, detail.seenAt);
    return row.attention;
  };
  assert.equal(await attention(), null);
  s.registry.recordActivity(id, { agentTurnRunning: true });
  assert.equal(await attention(), "working");
  s.registry.recordReply(id, 1000);
  assert.equal(await attention(), "reply");
  s.fake.park(id, 2);
  assert.equal(await attention(), "parked");
  assert.ok(!s.calls.some(([kind]) => kind === "watch"), "parked is known without a client watch");
  const pylon = s.registry.pylon(s.thread.pylonId)!;
  s.registry.savePylon({ ...pylon, failed: "gave up" });
  assert.equal(await attention(), "failed");
  s.registry.savePylon(pylon);
  s.fake.park(id, 0);
  s.registry.recordActivity(id, { agentTurnRunning: false });
  s.woken.length = 0;
  const human = s.registry.thread(id)!.lastHumanActivityAt;
  for (const status of ["active", "archived"] as const) {
    s.registry.setThreadStatus(id, status);
    assert.equal((await s.call("POST", `${base}/seen`)).status, 204);
    assert.equal(await attention(), null);
    assert.equal((await s.call("POST", `${base}/unseen`)).status, 204);
    assert.equal(s.registry.thread(id)!.seenAt, 999);
    assert.equal(await attention(), "reply");
    assert.equal(s.registry.thread(id)!.lastHumanActivityAt, human);
    assert.deepEqual(s.registry.pylon(s.thread.pylonId), pylon);
    assert.deepEqual(s.woken, []);
  }
});


test("the API reports the attention the event stream last reported, and a deleted thread's run is not parked", async (t) => {
  const s = await withThread(t);
  const id = s.thread.id;
  const reported = () => s.registry.events("0", { kinds: ["attention.changed"], thread: id }).at(-1)?.payload.attention ?? null;
  const shown = async () => ((await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail).attention;
  s.fake.park(id, 1);
  assert.deepEqual([await shown(), reported()], ["parked", "parked"]);
  assert.equal((await s.call("DELETE", `/v1/threads/${id}`)).status, 200);
  assert.deepEqual([await shown(), reported()], [null, null]);
});

test("attention takes the first matching state in every combination", () => {
  for (const failed of [false, true]) for (const parked of [false, true]) for (const decision of [false, true]) for (const limited of [false, true]) {
    for (const reply of [null, 10]) for (const seen of [null, 9, 10, 11]) for (const working of [false, true]) {
      const expected = failed ? "failed" : decision ? "decision" : parked ? "parked" : limited ? "limited" : reply !== null && (seen === null || reply > seen) ? "reply" : working ? "working" : null;
      assert.equal(attentionOf(failed, parked, reply, seen, working, false, decision, limited), expected);
    }
  }
});

test("seen is bounded by the rendered reply, not a newer reply discovered by attention polling", async (t) => {
  const s = await withThread(t);
  const id = s.thread.id;
  const base = `/v1/threads/${id}`;
  s.registry.recordReply(id, 1000);
  const renderedReplyAt = s.registry.thread(id)!.lastReplyAt;
  s.registry.recordReply(id, 2000);
  const human = s.registry.thread(id)!.lastHumanActivityAt;
  s.woken.length = 0;
  assert.equal((await s.call("POST", `${base}/seen`, { lastReplyAt: renderedReplyAt })).status, 204);
  let detail = (await s.call("GET", base)).body as ThreadDetail;
  assert.equal(detail.seenAt, 1000);
  assert.equal(detail.lastReplyAt, 2000);
  assert.equal(detail.attention, "reply");
  assert.equal((await s.call("POST", `${base}/seen`, { lastReplyAt: null })).status, 204);
  assert.equal(s.registry.thread(id)!.seenAt, 1000);
  await s.call("POST", `${base}/seen`, { lastReplyAt: 2000 });
  detail = (await s.call("GET", base)).body as ThreadDetail;
  assert.equal(detail.seenAt, 2000);
  assert.equal(detail.attention, null);
  await s.call("POST", `${base}/seen`, { lastReplyAt: 1000 });
  assert.equal(s.registry.thread(id)!.seenAt, 2000, "a stale page does not undo another client's seen mark");
  for (const lastReplyAt of [-1, 1.5, "2000"]) {
    assert.equal((await s.call("POST", `${base}/seen`, { lastReplyAt })).status, 400);
  }
  assert.equal(s.registry.thread(id)!.lastHumanActivityAt, human);
  assert.deepEqual(s.woken, []);
});

test("latest-turn API reads include commits and uncommitted work, and refuse missing or stale snapshots", async (t) => {
  const s = await withThread(t);
  const { repo, run } = await localCheckout(t, s);
  s.fake.harness.latestTurn = async () => "42";
  const route = `/v1/threads/${s.thread.id}`;
  assert.equal((await s.call("GET", `${route}/changes?base=turn`)).status, 422);
  await checkoutReader(async (argv) => processStream(argv[0]!, argv.slice(1), () => {}), repo).snapshot("42");
  await writeFile(join(repo, "src/app.ts"), "committed\n");
  await run("commit", "-qam", "work");
  await writeFile(join(repo, "new.txt"), "untracked\n");
  const changes = await s.call("GET", `${route}/changes?base=turn`);
  assert.equal(changes.status, 200);
  assert.equal(changes.body.base.kind, "turn");
  assert.deepEqual(changes.body.files.map((f: { path: string }) => f.path), ["new.txt", "src/app.ts"]);
  const diff = await s.call("GET", `${route}/diff?base=turn&path=new.txt`);
  assert.deepEqual(diff.body.base, changes.body.base);
  assert.match(diff.body.diff, /\+untracked/);
  s.fake.harness.latestTurn = async () => "43";
  assert.equal((await s.call("GET", `${route}/diff?base=turn`)).status, 422);
});

const deployCommit = "a".repeat(40);
const deployToken = "test-root-token";
const deployment: DeploymentOptions = {
  self: "nFIREBAT" as TailnetNodeId,
  deployers: new Set([laptop, "nFIREBAT" as TailnetNodeId]),
  keys: { nFIREBAT: tokenDigest(deployToken) },
  resolveMain: async () => deployCommit,
};
const reporterHeaders = { authorization: `Bearer ${deployToken}` };

test("deploy defaults off, main resolves, and release records the authenticated caller", async (t) => {
  const off = await setup(t);
  assert.equal((await off.call("PUT", "/v1/release", { commit: "main" })).status, 403);
  const on = await setup(t, { deployment });
  const r = await on.call("PUT", "/v1/release", { commit: "main" });
  assert.equal(r.status, 200);
  assert.equal(r.body.desired.commit, deployCommit);
  assert.equal(r.body.desired.requestedBy, laptop);
  assert.equal(r.body.nodes.length, 2);
  assert.equal((await on.call("PUT", "/v1/release", { commit: "--evil" })).status, 400);
});

test("the release view shows a deployer report 90 s old as pending, so a wait on that release is pending", async (t) => {
  const s = await setup(t, { deployment });
  assert.equal((await s.call("PUT", "/v1/release", { commit: "main" })).status, 200);
  s.callAs("nFIREBAT" as TailnetNodeId);
  for (const role of ["control", "probe"]) {
    const report = { role, commit: deployCommit, target: deployCommit, state: "healthy", reason: null };
    assert.equal((await s.call("POST", "/v1/deployer/report", report, reporterHeaders)).status, 200);
  }
  s.callAs(laptop);
  assert.equal(releaseOutcome((await s.call("GET", "/v1/release")).body, deployCommit), "healthy");
  for (const report of s.registry.releaseReports()) s.registry.reportRelease({ ...report, observedAt: Date.now() - 90_000 });
  const view = (await s.call("GET", "/v1/release")).body;
  assert.deepEqual(view.nodes.map((r: ReleaseReport) => [r.role, r.state, r.reason]), [["control", "pending", "deployer report is stale"], ["probe", "pending", "deployer report is stale"]]);
  assert.equal(releaseOutcome(view, deployCommit), "pending");
});

test("a deployer report may carry every report state", () => {
  for (const state of reportStates) assert.equal(reportSchema.parse({ role: "probe", commit: deployCommit, target: null, state, reason: null }).state, state);
});

test("only a deployer may build, roll out or roll back an image, never the control node itself", async (t) => {
  const routes = [["/v1/images/build", {}], ["/v1/images/rollout", { image: image.id }], ["/v1/images/rollback", {}]] as const;
  const off = await setup(t);
  for (const [path, body] of routes) assert.deepEqual(await off.call("POST", path, body), { status: 403, body: { error: "caller may not build, roll out or roll back an image: only deployers may, never infrastructure nodes or pylons" } });
  const on = await setup(t, { deployment });
  on.callAs("nFIREBAT" as TailnetNodeId);
  for (const [path, body] of routes) assert.equal((await on.call("POST", path, body)).status, 403, `the control node may not POST ${path}`);
  on.callAs(laptop);
  for (const [path, body] of routes) assert.deepEqual(await on.call("POST", path, body), { status: 409, body: { error: "image builds are not configured" } });
});

test("anyone allowed reads the usage backfill and its dry run, only a deployer starts or stops it, and without one its routes answer 409", async (t) => {
  const off = await setup(t, { deployment });
  for (const method of ["GET", "POST", "DELETE"]) assert.deepEqual(await off.call(method, "/v1/usage/backfill"), { status: 409, body: { error: "the usage backfill is not configured" } });
  const s = await setup(t, {
    deployment,
    usageBackfill: (registry) => usageBackfill({ registry, counter: { readWhole: () => assert.fail("nothing is read") }, wake: () => {}, intervalMs: 3_600_000, log: () => {} }),
  });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const thread = (await s.call("POST", "/v1/threads", { project: "acme", title: "Old work" })).body as Thread;
  assert.equal((await s.call("POST", `/v1/threads/${thread.id}/archive`)).status, 200);
  assert.deepEqual(await s.call("GET", "/v1/usage/backfill"), {
    status: 200, body: { backfill: { state: "never" }, plan: [{ thread: thread.id, project: "acme", node, title: "Old work", reason: null }] },
  });

  s.callAs("nFIREBAT" as TailnetNodeId);
  const refused = { status: 403, body: { error: "caller may not start or stop the usage backfill: only deployers may, never infrastructure nodes or pylons" } };
  assert.deepEqual(await s.call("POST", "/v1/usage/backfill"), refused);
  assert.deepEqual(await s.call("DELETE", "/v1/usage/backfill"), refused);
  assert.deepEqual((await s.call("GET", "/v1/usage/backfill")).body.backfill, { state: "never" });
  s.callAs(laptop);
  const started = await s.call("POST", "/v1/usage/backfill");
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.state, started.body.read, started.body.of, started.body.current], ["running", 0, 1, null]);
  assert.equal((await s.call("GET", "/v1/usage?since=all")).body.backfill.state, "running", "the usage report carries the backfill");
  const stopped = await s.call("DELETE", "/v1/usage/backfill");
  assert.deepEqual([stopped.status, stopped.body.state], [200, "stopped"]);
});

test("a deployer's image operations answer 200 once done and 202 while running, and the image routes show each image, its nodes and the operation", async (t) => {
  const recipe: ImageRecipe = { files: [{ path: "Dockerfile", mode: 0o644, content: "FROM debian\n" }], pins: image.pins };
  const built = { ...image, id: imageIdOf(recipe), builtAt: "2027-02-01T00:00:00Z" };
  const noJobs = () => assert.fail("no job is needed");
  const s = await setup(t, {
    deployment,
    images: (registry) => startImageRollout({ registry, probes: new Map([[node, { submit: noJobs, job: noJobs, manifest: async (id) => registry.image(id as ImageId) ?? null }]]), buildNode: node, recipe: async () => recipe, release: null, intervalMs: 600_000, log: () => {} }),
  });
  for (const manifest of [image, built]) assert.equal((await s.call("POST", "/v1/images", manifest)).status, 201);
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested({ node, observedAt: "2027-01-01T00:01:00Z", probeBootId: "b", events: [], capacity, artifacts: [image.id as ImageId], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  const entries = [{ ...built, release: null, nodes: [] }, { ...image, release: null, nodes: [node] }];
  assert.deepEqual((await s.call("GET", "/v1/images")).body, { current: null, previous: null, images: entries, operation: null }, "newest build first");

  const build = await s.call("POST", "/v1/images/build", {});
  assert.equal(build.status, 200, "the recipe's image is recorded already");
  assert.deepEqual([build.body.kind, build.body.image, build.body.state, build.body.requestedBy], ["build", built.id, "done", laptop]);
  const rollout = await s.call("POST", "/v1/images/rollout", { image: image.id });
  assert.equal(rollout.status, 202);
  assert.deepEqual([rollout.body.kind, rollout.body.image, rollout.body.state], ["rollout", image.id, "running"]);
  await s.images!.wake();
  assert.deepEqual((await s.call("GET", "/v1/images/current")).body, { current: entries[1], previous: null });
  const view = (await s.call("GET", "/v1/images")).body;
  assert.deepEqual([view.current, view.operation.kind, view.operation.state], [image.id, "rollout", "done"]);

  assert.equal((await s.call("POST", "/v1/images/rollout", { image: "img-ffffffffffff" })).status, 404);
  assert.equal((await s.call("POST", "/v1/images/rollout", { image: "../etc" })).status, 400);
  assert.equal((await s.call("POST", "/v1/images/rollback", {})).status, 409, "no image was current before this one");
  assert.equal((await s.call("PUT", "/v1/images/current", { image: built.id })).status, 405, "no route makes an image current without a rollout");
});

test("pylon traffic under its host identity cannot deploy even if that identity is allowed and listed as a deployer", async (t) => {
  const s = await setup(t, { deployment });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("PUT", "/v1/release", { commit: deployCommit }, { "x-forwarded-for": "nLAPTOP", ...reporterHeaders })).status, 403);
  assert.equal((await s.call("GET", "/v1/deployer/release")).status, 403);
  assert.equal((await s.call("GET", "/v1/%64eployer/release")).status, 403);
  assert.equal((await s.call("POST", "/v1/%64eployer/drain", { commit: deployCommit })).status, 403);
  assert.equal((await s.call("GET", "/v1/deployer/release", undefined, reporterHeaders)).status, 200);
  s.callAs(null);
  assert.equal((await s.call("PUT", "/v1/release", { commit: deployCommit }, reporterHeaders)).status, 403);
});

test("a body over a mebibyte is refused with 413 and reaches no route", async (t) => {
  const s = await setup(t);
  const refused = await s.call("POST", "/v1/projects", "x".repeat((1 << 20) + 1));
  assert.equal(refused.status, 413);
  assert.deepEqual(refused.body, { error: "request body over 1048576 bytes" });
  assert.deepEqual(s.registry.projects(), []);
});

test("a root-authenticated drain blocks every turn-entry route and can be released", async (t) => {
  const s = await setup(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  const drain = await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders);
  assert.equal(drain.status, 200);
  assert.equal(drain.body.idle, true);
  s.callAs(laptop);
  for (const path of ["/v1/threads", "/v1/threads/anything/messages", "/v1/threads/anything/retry", "/v1/threads/anything/start"]) {
    const refused = await s.call("POST", path, {});
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: "control plane is draining for deployment; retry after the release completes" });
  }
  assert.equal((await s.call("PUT", "/v1/release", { commit: "b".repeat(40) })).status, 409);
  s.callAs("nFIREBAT" as TailnetNodeId);
  const released = await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, release: true }, reporterHeaders);
  assert.deepEqual(released.body, { idle: false, expiresAt: null });
  assert.equal(s.registry.drain(), null);
});

test("drain reads committed live and queued work rather than a lagging activity flag", async (t) => {
  const s = await withThread(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  for (const docs of [{ "pi.live": { run: {} } }, { "pi.inbox": { items: [{ id: 1 }] } }]) {
    s.fake.transcript(s.thread.id).docs = docs as never;
    s.fake.commit(s.thread.id);
    const result = await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders);
    assert.equal(result.body.idle, false);
  }
  s.fake.transcript(s.thread.id).docs = {};
  s.fake.commit(s.thread.id);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
});

test("drain reads only harness conversations, so Claude worker and bare threads never reach the harness", async (t) => {
  const s = await withThread(t, { deployment });
  await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" });
  await s.startThread({ project: "acme", title: "Check", bare: true }, laptop);
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  s.calls.length = 0;
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
  assert.deepEqual(s.calls, [["watch", s.thread.id], ["unwatch", s.thread.id]]);
});

test("drain waits for a turn entering through the gate it was given, which the API shares with the harness", async (t) => {
  const gate = turnGate(() => false);
  const s = await setup(t, { deployment, gate });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  let end = () => {};
  const held = gate.run(() => new Promise<void>((resolve) => { end = resolve; }));
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, false);
  end();
  await held;
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
});

test("expired drain leases no longer block callers", async (t) => {
  const s = await withThread(t, { deployment });
  s.registry.setDrain({ commit: deployCommit, expiresAt: Date.now() - 1 });
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hello", requestId: "after-drain" })).status, 202);
});

test("drain cannot declare idle while a previously admitted message is still entering the harness", async (t) => {
  const s = await withThread(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  const entering = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const send = s.fake.harness.send;
  s.fake.harness.send = async (...args) => { entering.resolve(); await finish.promise; return send(...args); };
  const sending = s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hello", requestId: "entering-drain" });
  await entering.promise;
  s.callAs("nFIREBAT" as TailnetNodeId);
  try {
    assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, false);
  } finally { finish.resolve(); }
  assert.equal((await sending).status, 202);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
});

test("the final idle fence holds across lease expiry until rollback or success releases it", async (t) => {
  const s = await setup(t, { deployment });
  await s.call("PUT", "/v1/release", { commit: deployCommit });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, hold: true }, reporterHeaders)).body.idle, true);
  assert.equal(s.registry.drain()!.locked, true);
  s.registry.setDrain({ ...s.registry.drain()!, expiresAt: 0 });
  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/threads", {})).status, 409);
  s.callAs("nFIREBAT" as TailnetNodeId);
  await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, release: true }, reporterHeaders);
  assert.equal(s.registry.drain(), null);
});


test("direct TLS uses TCP whois, ignores forged headers, and renews without disturbing HTTP", async (t) => {
  const { testCertificate } = await import("../test-certificate.ts");
  const { request: tlsRequest } = await import("node:https");
  const { X509Certificate } = await import("node:crypto");
  const certDir = await mkdtemp(join(dir, "tls-"));
  const first = await testCertificate(certDir);
  const second = await testCertificate(certDir);
  assert.notEqual(new X509Certificate(first.cert).subject, new X509Certificate(second.cert).subject);
  let current = first;
  let fail = false;
  let reads = 0;
  const api = await setup(t, {
    https: { port: 0, renewalMs: 25, retryMs: 10, certificate: async () => {
      reads++;
      if (fail) throw new Error("renewal unavailable");
      return current;
    } },
    deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  });
  function tls(path = "/v1/threads", headers: Record<string, string> = {}, method = "GET") {
    return new Promise<{ status: number; fingerprint: string }>((resolve, reject) => {
      const req = tlsRequest({
        hostname: "127.0.0.1", port: api.httpsPort, path, method, agent: false,
        ca: [first.cert, second.cert], servername: "dashboard.example.ts.net",
        headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
      }, (res) => {
        const fingerprint = (res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256;
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, fingerprint }));
      });
      req.on("error", reject).end();
    });
  }
  await until("HTTPS started", () => api.httpsPort !== undefined);
  assert.equal((await tls()).status, 200);
  assert.equal((await tls()).fingerprint, new X509Certificate(first.cert).fingerprint256);
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
  api.callAs(null);
  const forged = { "x-forwarded-for": "100.64.0.10", "x-forwarded-host": "127.0.0.1", "tailscale-user-login": "owner@example.com" };
  assert.equal((await tls("/v1/threads", forged)).status, 403);
  assert.equal((await api.call("GET", "/v1/threads", undefined, forged)).status, 403);
  api.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await tls("/v1/release", forged, "PUT")).status, 403);
  api.callAs(laptop);
  assert.equal((await tls("/v1/threads", { ...forged, host: "evil.example" })).status, 403);
  const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  assert.equal((await tls(attachPathOf("missing"), { ...upgrade, origin: "https://127.0.0.1" })).status, 404);
  assert.equal((await tls(attachPathOf("missing"), { ...upgrade, origin: "http://127.0.0.1" })).status, 403);
  assert.equal((await tls(attachPathOf("missing"), { ...upgrade, origin: "https://127.0.0.1:10200" })).status, 403);
  fail = true;
  const before = reads;
  await until("the renewal read the certificate", () => reads !== before);
  assert.equal((await tls()).fingerprint, new X509Certificate(first.cert).fingerprint256);
  assert.equal((await api.call("GET", "/v1/health")).body.https.status, "degraded");
  fail = false;
  current = second;
  for (const deadline = Date.now() + 60_000; (await tls()).fingerprint !== new X509Certificate(second.cert).fingerprint256;) {
    assert.ok(Date.now() < deadline, "certificate renewed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
});

test("health reports the version of the API contract, which the CLI reads", async (t) => {
  const api = await setup(t);
  assert.equal((await api.call("GET", "/v1/health")).body.version, version);
});

test("HTTP starts while certificate issuance is pending, survives failure, and HTTPS starts on retry", async (t) => {
  const { testCertificate } = await import("../test-certificate.ts");
  const { request: tlsRequest } = await import("node:https");
  const certificate = await testCertificate(await mkdtemp(join(dir, "startup-tls-")));
  const first = Promise.withResolvers<typeof certificate>();
  const retry = Promise.withResolvers<typeof certificate>();
  let attempts = 0;
  const api = await setup(t, { https: { port: 0, retryMs: 10, certificate: () => ++attempts === 1 ? first.promise : retry.promise } });
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
  assert.equal(api.httpsPort, undefined);
  assert.deepEqual((await api.call("GET", "/v1/health")).body.https, { status: "waiting", error: null, nextAttemptAt: null });
  first.reject(new Error("tailscaled certificate: HTTP 403"));
  await until("issuance retried", () => attempts >= 2);
  const failed = await api.call("GET", "/v1/health");
  assert.equal(failed.status, 200);
  assert.equal(failed.body.https.status, "waiting");
  assert.equal(failed.body.https.error, "tailscaled certificate: HTTP 403");
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
  retry.resolve(certificate);
  await until("HTTPS started after retry", () => api.httpsPort !== undefined);
  const ready = (await api.call("GET", "/v1/health")).body.https;
  assert.equal(ready.status, "ready");
  assert.equal(ready.error, null);
  assert.ok(ready.nextAttemptAt > Date.now());
  assert.equal(await new Promise<number>((resolve, reject) => {
    tlsRequest({ hostname: "127.0.0.1", port: api.httpsPort, path: "/v1/threads", ca: certificate.cert, servername: "dashboard.example.ts.net" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    }).on("error", reject).end();
  }), 200);
  assert.equal((await api.call("GET", "/v1/threads")).status, 200);
});

test("closing HTTP while issuance is pending prevents a late HTTPS listener", async (t) => {
  const { testCertificate } = await import("../test-certificate.ts");
  const certificate = await testCertificate(await mkdtemp(join(dir, "late-tls-")));
  const pending = Promise.withResolvers<typeof certificate>();
  const api = await setup(t, { https: { port: 0, certificate: () => pending.promise } });
  await api.close();
  pending.resolve(certificate);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(api.httpsPort, undefined);
});

test("project edits validate before saving, flag older grants, and leave checkpoint boots unchanged", async (t) => {
  const s = await withThread(t);
  const before = s.registry.pylon(s.thread.pylonId)!.boot;
  const secrets = [...project.secrets, { name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }];
  const edited = await s.call("PATCH", "/v1/projects/acme", { secrets, logins: ["claude"] });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.secrets, secrets);
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}`)).body.pylon.grantsOutdated, true);
  await s.call("POST", `/v1/threads/${s.thread.id}/archive`);
  await s.call("POST", `/v1/threads/${s.thread.id}/unarchive`);
  assert.deepEqual(s.registry.pylon(s.thread.pylonId)!.boot, before);
  const next = await s.call("POST", "/v1/threads", { project: "acme", title: "New grants" });
  assert.deepEqual(s.registry.pylon(next.body.pylonId)!.boot.network.secrets, secrets);
  for (const patch of [{ id: "other" }, { repoUrl: "https://example.com/new" }, { defaultNode: "missing" }, { resources: { cpus: 0, memoryGiB: 4, diskGiB: 10 } }, { secrets: [{ name: "TOKEN", hosts: [] }] }, { secrets: [{ name: "TOKEN", hosts: ["*.example.com"] }] }]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", patch)).status, 400);
    assert.deepEqual(s.registry.project(project.id as ProjectId), edited.body);
  }
  assert.equal((await s.call("PATCH", "/v1/projects/missing", {})).status, 404);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { secrets: [] })).status, 403);
});

test("a thread started with HTTPS dotfiles shows its grants current until its project's hosts change", async (t) => {
  const s = await withThread(t, { dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" } });
  assert.ok(s.registry.pylon(s.thread.pylonId)!.boot.network.allowedHosts.includes("github.com"), "the dotfiles host is in the boot's allowlist");
  const outdated = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body.pylon.grantsOutdated;
  assert.equal(await outdated(), false);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { allowedHosts: [...project.allowedHosts, "another.example.com"] })).status, 200);
  assert.equal(await outdated(), true);
});

test("pylon boot inherits the person's identity and a project can override or clear it", async (t) => {
  const gitIdentity = { name: "Example Person", email: "person@example.com" };
  const s = await withThread(t, { gitIdentity });
  assert.deepEqual(s.registry.pylon(s.thread.pylonId)!.boot.gitIdentity, gitIdentity);
  const override = { name: "Work Person", email: "work@example.com" };
  for (const identity of [override, null]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", { gitIdentity: identity })).status, 200);
    const next = await s.call("POST", "/v1/threads", { project: "acme", title: "Identity" });
    const pylon = s.registry.pylon(next.body.pylonId)!;
    assert.deepEqual(pylon.boot.gitIdentity, identity ?? gitIdentity);
    assert.ok(pylon.live.overlay[2]!.content.includes((identity ?? gitIdentity).email));
  }
});

test("partial resource patches merge atomically without resetting another edit", async (t) => {
  const s = await withThread(t);
  const edits = await Promise.all([
    s.call("PATCH", "/v1/projects/acme", { resources: { cpus: 4 } }),
    s.call("PATCH", "/v1/projects/acme", { resources: { memoryGiB: 8 } }),
  ]);
  for (const result of edits) assert.equal(result.status, 200);
  assert.deepEqual(s.registry.project(project.id as ProjectId)!.resources, { ...project.resources, cpus: 4, memoryGiB: 8 });
  const before = s.registry.project(project.id as ProjectId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { resources: { cpus: 16 }, defaultNode: "missing" })).status, 400);
  assert.deepEqual(s.registry.project(project.id as ProjectId), before, "a refused edit rolls back every field");
});

test("grant comparison ignores order and duplicates but detects changed access", async (t) => {
  const original = {
    ...project,
    allowedHosts: ["registry.npmjs.org", "example.com"],
    logins: ["claude", "chatgpt"],
    secrets: [
      { name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] },
      { name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com"] },
    ],
  };
  const s = await withThread(t, { project: original });
  const outdated = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body.pylon.grantsOutdated;
  assert.equal(await outdated(), false);
  const pylon = s.registry.pylon(s.thread.pylonId)!;
  s.registry.savePylon({ ...pylon, boot: { ...pylon.boot, network: { ...pylon.boot.network, allowedHosts: [...pylon.boot.network.allowedHosts].reverse() } } });
  const reordered = {
    allowedHosts: [...original.allowedHosts].reverse(),
    logins: [...original.logins].reverse(),
    secrets: [...original.secrets].reverse().map((grant) => ({ ...grant, hosts: [...grant.hosts].reverse() })),
  };
  assert.equal((await s.call("PATCH", "/v1/projects/acme", reordered)).status, 200);
  assert.equal(await outdated(), false);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", {
    allowedHosts: [...reordered.allowedHosts, ...reordered.allowedHosts],
    logins: [...reordered.logins, ...reordered.logins],
    secrets: reordered.secrets.map((grant) => ({ ...grant, hosts: [...grant.hosts, ...grant.hosts] })),
  })).status, 200);
  assert.equal(await outdated(), false);
  for (const changed of [
    { secrets: [original.secrets[0]] },
    { secrets: [{ ...original.secrets[0], hosts: ["github.com"] }, original.secrets[1]] },
    { allowedHosts: ["another.example.com"] },
    { logins: ["claude"] },
  ]) {
    assert.equal((await s.call("PATCH", "/v1/projects/acme", { ...reordered, ...changed })).status, 200);
    assert.equal(await outdated(), true);
  }
});

test("project add and edit refuse a grant of the ChatGPT token, which comes with the chatgpt login", async (t) => {
  const s = await withThread(t);
  const before = s.registry.project(project.id as ProjectId);
  const secrets = [{ name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] }];
  const added = await s.call("POST", "/v1/projects", { ...project, id: "granted", secrets });
  assert.equal(added.status, 400);
  assert.match(added.body.error, /NEXUS_CHATGPT_TOKEN comes with the chatgpt login: add the login instead/);
  assert.equal(s.registry.project("granted" as ProjectId), undefined);
  const edited = await s.call("PATCH", "/v1/projects/acme", { secrets });
  assert.equal(edited.status, 400);
  assert.deepEqual(s.registry.project(project.id as ProjectId), before);
});

test("project add and edit refuse duplicate secret names instead of merging their grants", async (t) => {
  const s = await withThread(t);
  const before = s.registry.project(project.id as ProjectId);
  for (const hosts of [["b.example"], ["a.example"]]) {
    const secrets = [{ name: "TOKEN", hosts: ["a.example"] }, { name: "TOKEN", hosts }];
    const added = await s.call("POST", "/v1/projects", { ...project, id: "duplicate", secrets });
    assert.equal(added.status, 400);
    assert.match(added.body.error, /duplicate secret names: list all of a secret's hosts in one grant/);
    assert.equal(s.registry.project("duplicate" as ProjectId), undefined);
    const edited = await s.call("PATCH", "/v1/projects/acme", { secrets, resources: { cpus: 16 } });
    assert.equal(edited.status, 400);
    assert.match(edited.body.error, /duplicate secret names: list all of a secret's hosts in one grant/);
    assert.deepEqual(s.registry.project(project.id as ProjectId), before);
  }
  const secrets = [{ name: "TOKEN", hosts: ["a.example", "b.example"] }];
  const added = await s.call("POST", "/v1/projects", { ...project, id: "combined", secrets });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.secrets, secrets);
  const edited = await s.call("PATCH", "/v1/projects/acme", { secrets });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.secrets, secrets);
});

test("the health, release, deployer and event routes answer each caller and method as listed", async (t) => {
  const report = { role: "probe", commit: deployCommit, target: deployCommit, state: "healthy", reason: null };
  const off = await setup(t);
  const otherToken = "other-node-token";
  const on = await setup(t, { deployment: { ...deployment, keys: { ...deployment.keys, nOTHER: tokenDigest(otherToken) } } });
  on.registry.upsertNode({ name: "rj-other" as NodeName, tailnetHost: "rj-other.tail.ts.net", tailnetNodeId: "nOTHER" as TailnetNodeId });
  const notDeployer = await setup(t, { deployment: { ...deployment, deployers: new Set(["nFIREBAT" as TailnetNodeId]) } });
  const callers: [string, Awaited<ReturnType<typeof setup>>, string, Record<string, string>][] = [
    ["a deployer", on, laptop, {}],
    ["an allowed caller who is not a deployer", notDeployer, laptop, {}],
    ["an allowed caller while deploys are off", off, laptop, {}],
    ["the control node", on, "nFIREBAT", {}],
    ["the control node with its deployer key", on, "nFIREBAT", reporterHeaders],
    ["the control node with another key", on, "nFIREBAT", { authorization: "Bearer not-the-key" }],
    ["an allowed laptop with the control node's key", on, laptop, reporterHeaders],
    ["another node with its deployer key", on, "nOTHER", { authorization: `Bearer ${otherToken}` }],
    ["a stranger", on, "nSTRANGER", {}],
    ["a stranger with the control node's key", on, "nSTRANGER", reporterHeaders],
  ];
  const requests: [string, string, unknown?][] = [
    ["GET", "/v1/health?past=admission"],
    ["POST", "/v1/health", {}],
    ["GET", "/v1/release"],
    ["PUT", "/v1/release", { commit: "main" }],
    ["PUT", "/v1/release", { commit: "--evil" }],
    ["POST", "/v1/release", { commit: "main" }],
    ["GET", "/v1/deployer/release"],
    ["POST", "/v1/deployer/release", {}],
    ["POST", "/v1/deployer/report", report],
    ["POST", "/v1/deployer/report", { ...report, role: "control" }],
    ["POST", "/v1/deployer/report", { ...report, state: "fine" }],
    ["GET", "/v1/deployer/report"],
    ["POST", "/v1/deployer/drain", { commit: "b".repeat(40) }],
    ["POST", "/v1/deployer/drain", { commit: deployCommit, release: true }],
    ["GET", "/v1/deployer/drain"],
    ["POST", "/v1/deployer/nothing", {}],
    ["GET", "/v1/deployer/nothing"],
    ["GET", "/v1/events?kind=release.changed"],
    ["GET", "/v1/events?since=-1"],
    ["GET", "/v1/events?kind=unknown"],
    ["DELETE", "/v1/events"],
  ];
  const answers: Record<string, string[]> = {};
  for (const [who, s, id, headers] of callers) {
    s.callAs(id as TailnetNodeId);
    answers[who] = [];
    for (const [method, path, body] of requests) {
      const reply = await s.call(method, path, body, headers);
      answers[who].push(`${method} ${path} ${reply.status}${reply.status < 300 ? "" : ` ${reply.body.error}`}`);
    }
  }
  const deployer = [
    "GET /v1/health?past=admission 200",
    "POST /v1/health 405 POST is not allowed on /v1/health",
    "GET /v1/release 200",
    "PUT /v1/release 200",
    "PUT /v1/release 400 ✖ Invalid string: must match pattern /^[0-9a-f]{40}$/\n  → at commit",
    "POST /v1/release 405 POST is not allowed on /v1/release",
    "GET /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=release.changed 200",
    "GET /v1/events?since=-1 400 invalid event cursor",
    "GET /v1/events?kind=unknown 400 unknown event kind",
    "DELETE /v1/events 405 DELETE is not allowed on /v1/events",
  ];
  const allowed = [
    "GET /v1/health?past=admission 200",
    "POST /v1/health 405 POST is not allowed on /v1/health",
    "GET /v1/release 200",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "POST /v1/release 405 POST is not allowed on /v1/release",
    "GET /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=release.changed 200",
    "GET /v1/events?since=-1 400 invalid event cursor",
    "GET /v1/events?kind=unknown 400 unknown event kind",
    "DELETE /v1/events 405 DELETE is not allowed on /v1/events",
  ];
  const controlKey = [
    "GET /v1/health?past=admission 200",
    "POST /v1/health 405 POST is not allowed on /v1/health",
    "GET /v1/release 200",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "PUT /v1/release 403 caller may not deploy; infrastructure nodes and pylons cannot deploy",
    "POST /v1/release 405 POST is not allowed on /v1/release",
    "GET /v1/deployer/release 200",
    "POST /v1/deployer/release 405 POST is not allowed on /v1/deployer/release",
    "POST /v1/deployer/report 200",
    "POST /v1/deployer/report 200",
    "POST /v1/deployer/report 400 ✖ Invalid option: expected one of \"pending\"|\"waiting-for-control\"|\"waiting-for-idle\"|\"installing\"|\"healthy\"|\"rolled-back\"|\"failed\"\n  → at state",
    "GET /v1/deployer/report 405 GET is not allowed on /v1/deployer/report",
    "POST /v1/deployer/drain 409 release was superseded",
    "POST /v1/deployer/drain 200",
    "GET /v1/deployer/drain 405 GET is not allowed on /v1/deployer/drain",
    "POST /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/events?kind=release.changed 200",
    "GET /v1/events?since=-1 400 invalid event cursor",
    "GET /v1/events?kind=unknown 400 unknown event kind",
    "DELETE /v1/events 405 DELETE is not allowed on /v1/events",
  ];
  const otherKey = [
    "GET /v1/health?past=admission 403 caller is not a tailnet node this control plane allows",
    "POST /v1/health 403 caller is not a tailnet node this control plane allows",
    "GET /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/release 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/release 200",
    "POST /v1/deployer/release 405 POST is not allowed on /v1/deployer/release",
    "POST /v1/deployer/report 200",
    "POST /v1/deployer/report 403 only the control node reports control health",
    "POST /v1/deployer/report 400 ✖ Invalid option: expected one of \"pending\"|\"waiting-for-control\"|\"waiting-for-idle\"|\"installing\"|\"healthy\"|\"rolled-back\"|\"failed\"\n  → at state",
    "GET /v1/deployer/report 405 GET is not allowed on /v1/deployer/report",
    "POST /v1/deployer/drain 403 only the control node drains",
    "POST /v1/deployer/drain 403 only the control node drains",
    "GET /v1/deployer/drain 405 GET is not allowed on /v1/deployer/drain",
    "POST /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/deployer/nothing 404 no deployer route /v1/deployer/nothing",
    "GET /v1/events?kind=release.changed 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?since=-1 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=unknown 403 caller is not a tailnet node this control plane allows",
    "DELETE /v1/events 403 caller is not a tailnet node this control plane allows",
  ];
  const stranger = [
    "GET /v1/health?past=admission 403 caller is not a tailnet node this control plane allows",
    "POST /v1/health 403 caller is not a tailnet node this control plane allows",
    "GET /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "PUT /v1/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/release 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/release 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/report 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/drain 403 caller is not a tailnet node this control plane allows",
    "POST /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/deployer/nothing 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=release.changed 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?since=-1 403 caller is not a tailnet node this control plane allows",
    "GET /v1/events?kind=unknown 403 caller is not a tailnet node this control plane allows",
    "DELETE /v1/events 403 caller is not a tailnet node this control plane allows",
  ];
  assert.deepEqual(answers, {
    "a deployer": deployer,
    "an allowed caller who is not a deployer": allowed,
    "an allowed caller while deploys are off": allowed,
    "the control node": allowed,
    "the control node with its deployer key": controlKey,
    "the control node with another key": allowed,
    "an allowed laptop with the control node's key": deployer,
    "another node with its deployer key": otherKey,
    "a stranger": stranger,
    "a stranger with the control node's key": stranger,
  });
});

test("an event follower gets each event as an id and its data, then the watermark as a ping, every second, and a plain read gets them as JSON", async (t) => {
  const s = await setup(t);
  const first = s.registry.appendEvent("release.changed", null, { state: "pending" });
  const unrelated = s.registry.appendEvent("thread.failed", null, {});
  const plain = await s.raw("/v1/events?kind=release.changed");
  assert.equal(plain.status, 200);
  assert.deepEqual([plain.headers["content-type"], plain.headers["cache-control"]], ["application/json", "no-store"]);
  assert.deepEqual(JSON.parse(plain.body.toString()), [first]);

  const chunks: string[] = [];
  const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    request({ host: "127.0.0.1", port: s.port, path: "/v1/events?follow=true&kind=release.changed", headers: { host: `127.0.0.1:${s.port}` } }, resolve).on("error", reject).end();
  });
  t.after(() => res.destroy());
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => chunks.push(chunk));
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.headers["content-type"], res.headers["cache-control"]], ["text/event-stream", "no-store"]);
  const frame = (event: { id: string }) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
  const ping = (id: string) => `id: ${id}\n: ping\n\n`;
  await until("the first batch arrived", () => chunks.join("").length >= (frame(first) + ping(unrelated.id)).length);
  assert.equal(chunks.join(""), frame(first) + ping(unrelated.id), "the watermark passes the unrelated event the filter left out");
  await until("a second passed", () => chunks.join("").length > (frame(first) + ping(unrelated.id)).length);
  const second = s.registry.appendEvent("release.changed", null, { state: "installing" });
  const expected = frame(first) + ping(unrelated.id) + ping(unrelated.id) + frame(second) + ping(second.id);
  await until("the next event arrived", () => chunks.join("").length >= expected.length);
  assert.equal(chunks.join("").slice(0, expected.length), expected);
});

test("an event follower open across a deploy drain gets every event in order, and the drain neither ends nor refuses it", async (t) => {
  const s = await setup(t, { deployment });
  const stream = s.events("/v1/events?follow=true");
  t.after(() => stream.close());
  assert.equal((await s.call("PUT", "/v1/release", { commit: deployCommit })).status, 200);
  s.callAs("nFIREBAT" as TailnetNodeId);
  const report = (state: string) => s.call("POST", "/v1/deployer/report", { role: "control", commit: null, target: deployCommit, state, reason: null }, reporterHeaders);
  assert.equal((await report("waiting-for-idle")).status, 200);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit }, reporterHeaders)).body.idle, true);
  assert.equal((await report("installing")).status, 200);
  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/threads", {})).status, 409, "the drain holds");
  const during = s.events("/v1/events?follow=true&kind=release.changed");
  t.after(() => during.close());
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("POST", "/v1/deployer/drain", { commit: deployCommit, release: true }, reporterHeaders)).status, 200);
  assert.equal((await report("healthy")).status, 200);
  const states = async (reader: typeof stream, n: number) => {
    const seen: unknown[] = [];
    while (seen.length < n) seen.push((await reader.next()).payload.state ?? null);
    return seen;
  };
  assert.deepEqual(await states(stream, 4), [null, "waiting-for-idle", "installing", "healthy"], "the release asked for, then each report, in order");
  assert.deepEqual(await states(during, 4), [null, "waiting-for-idle", "installing", "healthy"], "a follower opened during the drain is served from the start");
  assert.equal(await Promise.race([stream.ended, new Promise((resolve) => setTimeout(resolve, 1_500, "open"))]), "open", "the follower stays open past the next ping");
});

test("a slow event follower gets every event once and in order, and one that stops reading is dropped after the stall limit with its place", async (t) => {
  const s = await setup(t, { streamStallMs: 1000 });
  const slow = s.events("/v1/events?follow=true&kind=release.changed");
  t.after(() => slow.close());
  const firstId = s.registry.appendEvent("release.changed", null, { n: 0 }).id;
  assert.equal((await slow.next()).id, firstId);
  slow.pause();
  // A megabyte each, so the paused client's socket fills in a few events and the follower stops partway through a batch.
  const ids = [firstId];
  for (let n = 1; n <= 12; n++) ids.push(s.registry.appendEvent("release.changed", null, { n, pad: "x".repeat(1 << 20) }).id);
  await sleep(1_500);
  slow.resume();
  const seen = [firstId];
  while (seen.length < ids.length) seen.push((await slow.next()).id);
  assert.deepEqual(seen, ids, "each event once, in order");

  const stalled = s.events("/v1/events?follow=true");
  await stalled.response;
  stalled.pause();
  const others = Array.from({ length: maxStreams - 2 }, () => s.events("/v1/events?follow=true&kind=release.changed"));
  t.after(() => { for (const other of others) other.close(); });
  await Promise.all(others.map((other) => other.response));
  assert.equal((await s.events("/v1/events?follow=true&kind=release.changed").response).statusCode, 503, "every place is taken");
  for (let n = 0; n < 24; n++) s.registry.appendEvent("thread.failed", null, { n, pad: "x".repeat(1 << 20) });
  let freed = s.events("/v1/events?follow=true&kind=release.changed");
  while ((await freed.response).statusCode === 503) {
    await sleep(100);
    freed = s.events("/v1/events?follow=true&kind=release.changed");
  }
  t.after(() => freed.close());
  stalled.resume();
  assert.equal(await stalled.ended, "dropped", "the follower that stopped reading was dropped, which gave its place to the next");
});

test("event followers share the streams' places with thread streams, past which each is refused with its own error, and a thread's delete leaves them open", async (t) => {
  const s = await withThread(t);
  const { thread } = s;
  const followers = Array.from({ length: maxStreams - 1 }, () => s.events("/v1/events?follow=true"));
  t.after(() => { for (const follower of followers) follower.close(); });
  await Promise.all(followers.map((follower) => follower.response));
  const page = s.events(`/v1/threads/${thread.id}/events`);
  await page.next();
  const follow = await s.call("GET", "/v1/events?follow=true");
  assert.deepEqual(follow, { status: 503, body: { error: "too many streams" } });
  const threadStream = await s.call("GET", `/v1/threads/${thread.id}/events`);
  assert.deepEqual(threadStream, { status: 503, body: { error: `${maxStreams} streams are open, the most this control plane serves at once` } });
  assert.deepEqual(await s.call("GET", "/v1/events?since=-1&follow=true"), { status: 400, body: { error: "invalid event cursor" } }, "a bad cursor is refused before the place is counted");
  assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  assert.equal(await page.ended, "end");
  const after = s.registry.appendEvent("release.changed", null, {});
  for (const follower of followers) assert.equal((await follower.next()).id, after.id, "every follower is still open after the delete");
  assert.equal((await s.events("/v1/events?follow=true").response).statusCode, 200, "the deleted thread's stream gave its place back, and the followers kept theirs");
});

test("an event cursor older than what the log retains is refused with 409", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 10_002; i++) s.registry.appendEvent("release.changed", null, {});
  for (const path of ["/v1/events?since=1", "/v1/events?since=1&follow=true"]) {
    assert.deepEqual(await s.call("GET", path), { status: 409, body: { error: "event cursor expired; retained events cannot fill the gap" } });
  }
});

test("an event read that fails for any other reason answers 500, not the expired cursor's 409", async (t) => {
  const s = await setup(t);
  s.registry.eventBatch = () => { throw new Error("database disk image is malformed"); };
  assert.deepEqual(await s.call("GET", "/v1/events?since=0"), { status: 500, body: { error: "database disk image is malformed" } });
});

test("event followers replay a disconnect gap with since and filter without losing order", async (t) => {
  const s = await setup(t);
  const first = s.registry.appendEvent("release.changed", null, { state: "pending" });
  const stream = s.events("/v1/events?follow=true&kind=release.changed");
  assert.equal((await stream.next()).id, first.id);
  stream.close();
  const second = s.registry.appendEvent("release.changed", null, { state: "installing" });
  s.registry.appendEvent("thread.failed", null, {});
  const third = s.registry.appendEvent("release.changed", null, { state: "healthy" });
  const resumed = s.events(`/v1/events?follow=true&kind=release.changed&since=${first.id}`);
  t.after(() => resumed.close());
  assert.deepEqual([await resumed.next(), await resumed.next()].map((e) => e.id), [second.id, third.id]);
  const fourth = s.registry.appendEvent("release.changed", null, { state: "pending" });
  assert.equal((await resumed.next()).id, fourth.id);
  assert.equal((await s.call("GET", "/v1/events?since=-1")).status, 400);
  assert.equal((await s.call("GET", "/v1/events?kind=unknown")).status, 400);
});

test("a Claude worker start stores its first prompt without starting a harness conversation", async (t) => {
  const s = await withThread(t);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix the bug" });
  assert.equal(started.status, 201);
  assert.equal(started.body.conversationId, null);
  assert.deepEqual(s.registry.claudeWorker(started.body.id), { model: "claude-opus-5-5", prompt: "/poteto-mode fix the bug", state: "pending", session: null });
  assert.equal((await s.call("GET", `/v1/threads/${started.body.id}`)).body.claudeWorker.state, "pending");
  const brief = "fix the bug:\n\t- keep \"quotes\", `ticks` and $HOME\n\nthen test";
  const multiLine = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: brief });
  assert.equal(s.registry.claudeWorker(multiLine.body.id)!.prompt, `/poteto-mode ${brief}`);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "a\0b" })).status, 400);
});

test("a quiet filtered stream scans past unrelated events and survives retention rollover", async (t) => {
  const { follow } = await import("../cli/transport.ts");
  const s = await setup(t);
  const stop = new AbortController();
  t.after(() => stop.abort());
  let cursor = "0";
  const endpoint = { url: new URL(`http://127.0.0.1:${s.port}`), socks: null };
  const reading = follow(endpoint, "/v1/events?follow=true&kind=session.turn-ended", () => assert.fail("no matching events yet"), stop.signal, (id) => { cursor = id; });
  for (let batch = 0; batch < 3; batch++) {
    let last = "0";
    for (let i = 0; i < 5000; i++) {
      last = s.registry.appendEvent("release.changed", null, {}).id;
      if (i % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await until("the stream sent its scanned watermark", () => cursor === last);
  }
  stop.abort();
  await reading;
  const matching = s.registry.appendEvent("session.turn-ended", null, {});
  const resumed = s.events(`/v1/events?follow=true&kind=session.turn-ended&since=${cursor}`);
  t.after(() => resumed.close());
  assert.equal((await resumed.next()).id, matching.id);
});

/**
 * A Claude worker thread whose launch opened the fixture's session, with its pylon running. The probe runs each pipe
 * here, against a folder in place of the pylon's ~/.claude/projects, where `transcript` is the session's file.
 */
async function withClaude(t: import("node:test").TestContext) {
  const s = await withThread(t);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const thread = started.body as Thread;
  s.registry.setClaudeWorker(thread.id, "/poteto-mode fix it", "started", undefined, claudeSession);
  const projects = await mkdtemp(join(tmpdir(), "nexus-claude-projects-"));
  t.after(() => rm(projects, { recursive: true }));
  await mkdir(join(projects, "-home-user-workspace-repo"));
  // The asks the pylon's hook reports waiting, which a test sets.
  const pylon = { asks: [] as unknown[] };
  s.probePipes(async (argv) => argv[0] === claudeHook
    ? processStream("sh", ["-c", 'printf "%s\n" "$0"', JSON.stringify(pylon.asks)], () => {})
    : processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {}));
  const c = { ...s, thread };
  observeRunning(c, {});
  return { ...c, pylon, transcript: join(projects, "-home-user-workspace-repo", `${claudeSession}.jsonl`) };
}

test("a Claude worker's pasted image is served from its transcript while the pylon runs, by the place its entry names", async (t) => {
  const s = await withClaude(t);
  const record = JSON.stringify({
    type: "user", timestamp: "2026-10-28T10:00:00.000Z", origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "What is wrong here?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: pngBytes.toString("base64") } }] },
  });
  await writeFile(s.transcript, `${fixture[0]}${record}\n`);
  const view = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  const prompt = view.entries.find((e) => e.kind === "prompt" && e.text === "What is wrong here?") as Extract<ClaudeConversation["entries"][number], { kind: "prompt" }>;
  const [place] = prompt.images!;
  const query = (p: typeof place) => `/v1/threads/${s.thread.id}/image?source=transcript&offset=${p!.offset}&bytes=${p!.bytes}&sha256=${p!.sha256}&index=${p!.index}`;
  const active = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const shot = await s.raw(query(place));
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, pngBytes);
  assert.equal(shot.headers["content-type"], "image/png");
  assert.equal(shot.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.equal(shot.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal((await s.raw(query({ ...place!, index: 1 }))).status, 404);
  assert.equal((await s.raw(query({ ...place!, bytes: 5 << 20 }))).status, 400, "no record is longer than one read");
  s.registry.markOffline(node);
  const paused = await s.call("GET", query(place));
  assert.equal(paused.status, 409);
  assert.deepEqual(s.woken, []);
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, active);
});

test("a Claude worker thread's latest turn is the one its newest turn-started names, and a turn without a snapshot is refused", async (t) => {
  const s = await withClaude(t);
  const { repo } = await localCheckout(t, s);
  const route = `/v1/threads/${s.thread.id}/changes?base=turn`;
  const helper = fileURLToPath(new URL("../checkout-files.py", import.meta.url));
  let sequence = 0;
  const started = (session: string, at: number) => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session, at } });
  const turn = async (session: string, at: number) => {
    assert.ok(await snapshotTurn(repo, claudeTurn(session, at), 30_000, helper));
    started(session, at);
  };
  const changed = async () => (await s.call("GET", route)).body.files.map((f: { path: string }) => f.path);
  assert.equal((await s.call("GET", route)).status, 422, "no turn has started");
  const at = Date.now();
  await turn(claudeSession, at);
  await writeFile(join(repo, "first.txt"), "first\n");
  assert.deepEqual(await changed(), ["first.txt"]);
  await turn(claudeSession, at + 1);
  await writeFile(join(repo, "second.txt"), "second\n");
  assert.deepEqual(await changed(), ["second.txt"]);
  started("another-session", at);
  assert.deepEqual(await changed(), ["second.txt"], "an older turn reported late does not replace the newest");
  started(claudeSession, at + 2);
  const stale = await s.call("GET", route);
  assert.equal(stale.status, 422, "a turn whose hook took no snapshot, as on an older image, never shows the previous one");
  assert.match(stale.body.error, /no latest-turn snapshot/);
});

const sent = (outcome: "sent" | "queued", resumed = false): CommandResult => ({ kind: "send-claude", outcome, herdrPane: "w1:p1", resumed });

test("a Claude worker thread's message is typed into its session exactly, in either mode, and never reaches the harness", async (t) => {
  const s = await withClaude(t);
  s.probeAnswers(async (command) => command.kind === "send-claude" ? sent("sent") : assert.fail(`unexpected ${command.kind}`));
  s.calls.length = 0;
  s.woken.length = 0;
  const before = Date.now();
  const send = (body: unknown) => s.call("POST", `/v1/threads/${s.thread.id}/messages`, body);
  const text = `Fix the "cart" total:\n  run \`npm test\` with $HOME and $(whoami) as typed\n\nthen say 'done' !`;

  assert.deepEqual(await send({ text, requestId: "msg:1" }), { status: 202, body: { claude: { session: claudeSession, outcome: "sent", resumed: false } } });
  assert.equal((await send({ text: "now", requestId: "msg:2", mode: "steer" })).status, 202);
  assert.equal((await send({ text: "later", requestId: "msg:3", mode: "followUp" })).status, 202);
  assert.equal((await send({ text: " one\r\ntwo\rthree\r\n", requestId: "msg:4" })).status, 202);
  const typed = (text: string, requestId: string) => [s.thread.pylonId, { kind: "send-claude", session: claudeSession, text, requestId, model: "claude-opus-5-5" }];
  assert.deepEqual(s.commands, [typed(text, "msg:1"), typed("now", "msg:2"), typed("later", "msg:3"), typed("one\ntwo\nthree", "msg:4")], "the text exactly, line ends made newlines, in both modes");
  assert.deepEqual(s.calls.filter(([call]) => call === "send"), [], "the harness is sent none of them");
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt >= before, "a message is human activity");
  assert.ok(s.woken.includes(node));

  s.commands.length = 0;
  const tab = await send({ text: "a\tb", requestId: "msg:5" });
  assert.equal(tab.status, 400);
  assert.match(tab.body.error, /tab/);
  assert.equal((await send({ text: " \n ", requestId: "msg:6" })).status, 400);
  assert.equal((await send({ text: "x" })).status, 400);
  assert.deepEqual(s.commands, [], "a message Claude cannot take as typed never reaches the probe");
});

test("a Claude worker's message is typed once per request ID, a send that typed nothing can be sent again, and one that may have typed some cannot", async (t) => {
  const s = await withClaude(t);
  let answer = async (): Promise<CommandResult> => sent("queued", true);
  s.probeAnswers(() => answer());
  const send = (requestId: string) => s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "run it", requestId });
  const queued = { status: 202, body: { claude: { session: claudeSession, outcome: "queued", resumed: true } } };
  assert.deepEqual(await send("msg:1"), queued);
  assert.deepEqual(await send("msg:1"), queued, "a resend answers what the send did");
  assert.equal(s.commands.length, 1, "and types nothing");

  answer = async () => { throw { code: "not-running", message: "the pylon is paused" }; };
  const before = Date.now();
  const paused = await send("msg:2");
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt >= before, "the send is human activity, which wakes the pylon");
  answer = async () => sent("blocked" as never);
  const blocked = await send("msg:2");
  assert.equal(blocked.status, 409, "the paused send typed nothing, so its request ID is tried again");
  assert.match(blocked.body.error, /Claude waits at a prompt in its terminal, so nothing was typed. Attach/);
  answer = async () => sent("starting" as never);
  assert.equal((await send("msg:2")).status, 409);
  answer = async () => sent("moved" as never);
  const moved = await send("msg:2");
  assert.equal(moved.status, 409);
  assert.match(moved.body.error, new RegExp(`stopped running Claude session ${claudeSession} before the message was typed, so nothing was typed. Send again`));
  answer = async () => sent("sent");
  assert.equal((await send("msg:2")).status, 202);
  assert.equal(s.commands.length, 6);

  answer = async () => { throw new Error("typing into Claude's pane w1:p1 failed, so part of the message may sit unsent in its prompt"); };
  assert.equal((await send("msg:3")).status, 500);
  answer = async () => ({ kind: "send-claude-outcome", send: "failed" });
  const again = await send("msg:3");
  assert.equal(again.status, 422);
  assert.match(again.body.error, /Check the conversation before sending it again under a new request ID/);
  assert.deepEqual(s.commands.slice(6).map(([, command]) => command.kind), ["send-claude", "send-claude-outcome"], "a send that may have typed part of the message is asked after, not typed again");
});

test("a Claude worker's message whose probe wait ran out is typed once, and a resend under its request ID answers what became of it", async (t) => {
  const s = await withClaude(t);
  const send = (requestId: string) => s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "run it", requestId });
  let answer = async (_command: PylonCommand): Promise<CommandResult> => { throw Object.assign(new Error(`${node}: no answer within 90000 ms`), { code: "unreachable" }); };
  s.probeAnswers((command) => answer(command));
  const slow = await send("msg:1");
  assert.equal(slow.status, 503);
  assert.match(slow.body.error, /no answer within 90000 ms. The message may still reach Claude, as one queued in the pylon behind an earlier send does, and reaches it at most once. Send it again under request ID msg:1 to learn what became of it/);

  answer = async (command) => command.kind === "send-claude-outcome" ? { kind: "send-claude-outcome", send: { outcome: "queued", herdrPane: "w1:p1", resumed: false } } : assert.fail(`${command.kind} would type it again`);
  const queued = { status: 202, body: { claude: { session: claudeSession, outcome: "queued", resumed: false } } };
  assert.deepEqual(await send("msg:1"), queued, "the resend answers how Claude took the first");
  assert.deepEqual(await send("msg:1"), queued);
  assert.deepEqual(s.commands.map(([, command]) => command), [
    { kind: "send-claude", session: claudeSession, text: "run it", requestId: "msg:1", model: "claude-opus-5-5" },
    { kind: "send-claude-outcome", requestId: "msg:1" },
  ], "the probe was asked about it once, and the message typed once");

  answer = async (command) => { if (command.kind === "send-claude") throw Object.assign(new Error(`${node}: no answer within 90000 ms`), { code: "unreachable" }); return { kind: "send-claude-outcome", send: { outcome: "blocked", herdrPane: "w1:p1", resumed: false } }; };
  assert.equal((await send("msg:2")).status, 503);
  assert.equal((await send("msg:2")).status, 409, "the first send typed nothing after all");
  answer = async () => sent("sent");
  assert.equal((await send("msg:2")).status, 202, "so its request ID is typed when sent again");

  for (const [requestId, earlier] of [["msg:3", async () => ({ kind: "send-claude-outcome", send: "unknown" }) as CommandResult], ["msg:4", async () => { throw new Error(`${node}: POST /v1/pylons/x/commands: HTTP 400: unknown command kind "send-claude-outcome"`); }]] as const) {
    answer = async () => { throw Object.assign(new Error(`${node}: no answer within 90000 ms`), { code: "unreachable" }); };
    assert.equal((await send(requestId)).status, 503);
    answer = earlier;
    assert.equal((await send(requestId)).status, 422, `${requestId}: a probe that cannot say what became of it, restarted or older, leaves it uncertain`);
  }
});

test("a resend while its first send is still asked waits for it, so a late answer that typed nothing cannot clear a newer send's fence", async (t) => {
  const s = await withClaude(t);
  const answers: PromiseWithResolvers<CommandResult>[] = [];
  s.probeAnswers(() => { answers.push(Promise.withResolvers()); return answers.at(-1)!.promise; });
  const send = () => s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "run it", requestId: "msg:1" });
  const asked = async (n: number) => { while (s.commands.length < n) await sleep(5); };
  const first = send();
  await asked(1);
  const resend = send();
  await sleep(100);
  assert.equal(s.commands.length, 1, "the resend does not ask the probe while the first send waits on it");
  answers[0]!.resolve(sent("blocked" as never));
  assert.equal((await first).status, 409, "the first send typed nothing");
  await asked(2);
  const again = send();
  await sleep(100);
  answers[1]!.resolve(sent("queued"));
  const queued = { status: 202, body: { claude: { session: claudeSession, outcome: "queued", resumed: false } } };
  assert.deepEqual(await resend, queued, "the resend typed the message itself, as the first typed nothing");
  assert.deepEqual(await again, queued, "and a resend while it was typing answers what it did");
  assert.deepEqual(await send(), queued);
  assert.deepEqual(s.commands.map(([, command]) => command.kind), ["send-claude", "send-claude"], "the message was typed by one send only");
});

test("a Claude worker thread takes no messages while archived, deleted or before its session starts, and asks no probe", async (t) => {
  const s = await withClaude(t);
  s.probeAnswers(async () => assert.fail("no command reaches the probe"));
  const fresh = (await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "later" })).body as Thread;
  const early = await s.call("POST", `/v1/threads/${fresh.id}/messages`, { text: "hi", requestId: "msg:1" });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /has not started a session yet/);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`, {})).status, 200);
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hi", requestId: "msg:2" }), { status: 409, body: { error: `thread ${s.thread.id} is archived` } });
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`, {})).status, 200);
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hi", requestId: "msg:3" }), { status: 409, body: { error: `thread ${s.thread.id} is deleted` } });
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/abort`)).status, 409);
  assert.deepEqual(s.calls.filter(([call]) => call === "send" || call === "abort"), []);
});

test("a Claude worker thread's abort presses Esc in its session's pane through the probe, and says why when nothing was pressed", async (t) => {
  const s = await withClaude(t);
  let outcome: InterruptClaudeOutcome = "interrupted";
  s.probeAnswers(async (command) => command.kind === "interrupt-claude" ? { kind: "interrupt-claude", outcome } : assert.fail(`unexpected ${command.kind}`));
  const abort = () => s.call("POST", `/v1/threads/${s.thread.id}/abort`);
  assert.equal((await abort()).status, 204);
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "interrupt-claude", session: claudeSession }]]);
  assert.deepEqual(s.calls.filter(([call]) => call === "abort"), [], "the harness aborts nothing");

  const refusals: [InterruptClaudeOutcome, RegExp][] = [
    ["blocked", new RegExp(`waits at a prompt in its terminal, which Esc would cancel, so nothing was pressed.*nexus attach ${s.thread.id}`)],
    ["idle", /not working, so there is no turn to interrupt/],
    ["unknown", /cannot tell yet/],
    ["not-running", new RegExp(`no pane runs Claude session ${claudeSession}`)],
  ];
  for ([outcome] of refusals) {
    const refused = await abort();
    assert.equal(refused.status, 409, outcome);
    assert.match(refused.body.error, refusals.find(([o]) => o === outcome)![1]);
  }

  s.commands.length = 0;
  s.woken.length = 0;
  observePaused(s);
  const paused = await abort();
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /does not wake it/);
  assert.deepEqual([s.commands, s.woken], [[], []], "a paused pylon runs no turn, so it is not woken to be interrupted");

  const fresh = (await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "later" })).body as Thread;
  const early = await s.call("POST", `/v1/threads/${fresh.id}/abort`);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /has not started a session yet, so it has no turn to interrupt/);
});

/** Records the thread's pylon stopped, as the loop would from its node's observation. */
function observePaused(s: Awaited<ReturnType<typeof withClaude>>) {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  const stopped = { pylonId: s.thread.pylonId, phase: "stopped" as const, checkpoint: null, sessions: [] };
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons: [stopped], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
}

test("a Claude worker stopped on its usage limit lists as limited, with the stop in its row and its conversation", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, `${fixture[0]}${usageLimitRecord}`);
  const stop = { stoppedAt: Date.parse("2026-10-26T05:34:18.605Z"), resetsAt: 1792996200000 };
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation).usageLimit, stop);
  const row = ((await s.call("GET", "/v1/threads")).body as ThreadRow[]).find((r) => r.id === s.thread.id)!;
  assert.equal(row.attention, "limited");
  assert.deepEqual(row.usageLimit, stop);
});

test("a Claude worker thread's conversation is its transcript, read from the running pylon after each session event and kept for when it is paused", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const reply = await s.call("GET", `/v1/threads/${s.thread.id}/conversation`);
  assert.equal(reply.status, 200);
  const first = reply.body as ClaudeConversation;
  assert.deepEqual({ ...first, entries: [], readAt: null }, { kind: "claude", session: claudeSession, entries: [], dropped: 0, readAt: null, working: false, usageLimit: null });
  assert.ok(first.readAt !== null && first.readAt >= Date.now() - 10_000);
  const prompt = first.entries[0]!;
  assert.ok(prompt.kind === "prompt" && prompt.from === "person" && prompt.text.startsWith("Do these steps one at a time"), JSON.stringify(prompt));
  assert.deepEqual(first.entries.flatMap((e) => e.kind === "tool" ? [e.name] : []), ["Write", "Bash", "Bash", "Agent"]);
  assert.deepEqual(first.entries.flatMap((e) => e.kind === "result" ? [e.isError] : []), [false, false, true, false], "each call's result, the failed `false` among them");

  const reads = s.streams.length;
  await appendFile(s.transcript, fixture.slice(30, 43).join(""));
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  await until("a session event is followed by a read, with no one watching", () => s.registry.claudeTranscript(s.thread.id)!.readAt > first.readAt!);
  assert.equal(s.streams.length, reads + 1);

  observePaused(s);
  const paused = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  assert.equal(s.streams.length, reads + 1, "a paused pylon is not read");
  assert.ok(paused.entries.length > first.entries.length);
  assert.deepEqual(paused.entries.slice(0, first.entries.length), first.entries, "a read only appends");
  assert.ok(paused.entries.some((e) => e.kind === "task" && e.status === "completed" && e.summary.includes("Count lines in hello.py")), "the subagent's finish");
  assert.ok(paused.entries.some((e) => e.kind === "turn"));
  assert.deepEqual(s.commands, [], "reading is never a command");
});

test("a Claude worker thread's page stream shows new entries during a turn, read when its session events say so rather than on a timer", async (t) => {
  // The reads follow intervals, which the test steps through, so a slow suite cannot outrun them or fit an extra one in.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  const frame = async (pattern: RegExp, what: string) => {
    for (;;) {
      const next = await stream.next();
      assert.ok(next.convo !== undefined || next.grow !== undefined || next.shows !== undefined, what);
      if (next.convo !== undefined && pattern.test(next.convo)) return next.convo as string;
    }
  };
  assert.match(await frame(/Do these steps one at a time/, "the read a watch starts with"), /Claude Code · claude-opus-5-5/);
  const idle = s.streams.length;
  t.mock.timers.tick(10_000);
  assert.equal(s.streams.length, idle, "an idle thread is not read on a timer");

  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind, session: claudeSession } });
  await appendFile(s.transcript, fixture.slice(22, 24).join(""));
  report("session.turn-started");
  t.mock.timers.tick(1_000);
  await frame(/<span class="t-name">Write<\/span>/, "the turn's start is followed by a read");
  await appendFile(s.transcript, fixture[24]!);
  t.mock.timers.tick(2_000);
  assert.match(await frame(/<span class="t-mark run"/, "a turn that runs is read again"), /python3 \/home\/user\/workspace\/repo\/hello.py/);
  await appendFile(s.transcript, fixture.slice(25, 28).join(""));
  report("session.turn-ended");
  t.mock.timers.tick(1_000);
  assert.doesNotMatch(await frame(/Exit code 1/, "the turn's end is followed by a read"), /t-mark run/);
  const ended = s.streams.length;
  t.mock.timers.tick(10_000);
  assert.equal(s.streams.length, ended, "the reads stop with the turn");
});

/** The page's conversation region: its opening tag's watermark and named view, and whether it holds a rendering. */
async function convoRegion(s: Awaited<ReturnType<typeof withClaude>>, query = "") {
  const html = (await s.raw(`/threads/${s.thread.id}${query}`)).body.toString();
  const tag = /<div class="convo" id="convo" data-rendered-reply-at="(\d*)"(?: data-shows="([^"]+)")? data-live[^>]*>/.exec(html)!;
  return { replyAt: tag[1], named: tag[2], inside: html.slice(tag.index + tag[0].length).split('<section class="file-view"')[0]!.replace(/<\/div><\/div>\s*$/, "") };
}

test("a poll of a Claude worker's streaming page names the view its stream shows rather than render it, and names a reply's view only once a frame showed the reply", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  let shows: string | undefined;
  const frame = async (pattern: RegExp) => {
    for (;;) {
      const next = await stream.next();
      shows = next.shows ?? shows;
      if (next.convo !== undefined && pattern.test(next.convo)) return;
    }
  };
  await frame(/Do these steps one at a time/);
  assert.deepEqual(await convoRegion(s, "?streaming=1"), { replyAt: "", named: shows, inside: "" }, "the poll names the view the stream's last frame shows and renders none");
  const unstreamed = await convoRegion(s);
  assert.equal(unstreamed.named, undefined);
  assert.match(unstreamed.inside, /Do these steps one at a time/, "a poll from a page that does not stream renders the conversation");

  await appendFile(s.transcript, fixture.slice(30, 43).join(""));
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  const replyAt = String(s.registry.thread(s.thread.id)!.lastReplyAt);
  t.mock.timers.tick(1_000);
  await until("the read after the turn's end stores the reply", () => s.registry.claudeEntries(s.thread.id).some((e) => e.kind === "reply" && e.text.startsWith("The subagent reported 1 line")));
  const read = await convoRegion(s, "?streaming=1");
  assert.equal(read.replyAt, replyAt);
  assert.notEqual(read.named, shows, "the page has not shown the reply yet, so the poll names another view than it shows");
  await frame(/The subagent reported 1 line/);
  assert.equal(shows, read.named, "the frame that shows the reply is of the view the poll named");
});

test("a Claude worker's page names no reply watermark until the transcript holds a read that started after the reply", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const projects = dirname(dirname(s.transcript));
  let held: Promise<void> = Promise.resolve();
  s.probePipes(async (argv) => {
    await held;
    return processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {});
  });
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  let shows: string | undefined;
  const frame = async (until: (next: any) => boolean) => {
    for (;;) {
      const next = await stream.next();
      shows = next.shows ?? shows;
      if (until(next)) return;
    }
  };
  await frame((next) => /Do these steps one at a time/.test(next.convo ?? ""));
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind, session: claudeSession } });
  report("session.turn-started");
  t.mock.timers.tick(1_000);
  const idle = shows;
  await frame(() => shows !== idle);
  // A refresh waits for the turn's read, so none runs when the next is held.
  await s.call("GET", `/v1/threads/${s.thread.id}/conversation`);

  const read = Promise.withResolvers<void>();
  held = read.promise;
  await appendFile(s.transcript, fixture.slice(30, 43).join(""));
  report("session.turn-ended");
  const working = shows;
  t.mock.timers.tick(1_000);
  await frame(() => shows !== working);
  const ended = await convoRegion(s, "?streaming=1");
  assert.equal(ended.named, shows, "the stream shows the turn's end, and the poll names that view");
  assert.equal(ended.replyAt, "", "but the read that brings the reply has not been stored, so no watermark");
  read.resolve();
  await frame((next) => /The subagent reported 1 line/.test(next.convo ?? ""));
  assert.deepEqual(await convoRegion(s, "?streaming=1"), { replyAt: String(s.registry.thread(s.thread.id)!.lastReplyAt), named: shows, inside: "" });
});

test("a Claude worker's page names no reply watermark while the reads after the reply have not reached the transcript's end", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const projects = dirname(dirname(s.transcript));
  const second = Promise.withResolvers<void>();
  let reads = 0;
  let held = Infinity;
  s.probePipes(async (argv) => {
    if (++reads === held) await second.promise;
    return processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {});
  });
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  const frame = async (pattern: RegExp) => {
    for (let next = await stream.next(); !pattern.test(next.convo ?? ""); next = await stream.next());
  };
  await frame(/Do these steps one at a time/);
  await s.call("GET", `/v1/threads/${s.thread.id}/conversation`);

  const reply = JSON.parse(fixture[40]!);
  // Two records of more than half of what one read takes, so the reply lies past the first read.
  const long = (i: number) => `${JSON.stringify({ ...reply, uuid: `long-${i}`, message: { ...reply.message, id: `msg-long-${i}`, content: [{ type: "text", text: `Long ${i} ${"x".repeat(maxRecordBytes * 0.6)}` }] } })}\n`;
  await appendFile(s.transcript, long(0) + long(1) + fixture.slice(30, 43).join(""));
  held = reads + 2;
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  t.mock.timers.tick(1_000);
  await frame(/Long 0 x/);
  assert.equal((await convoRegion(s, "?streaming=1")).replyAt, "", "the first read stopped short of the reply, so no watermark");
  second.resolve();
  await frame(/The subagent reported 1 line/);
  assert.equal((await convoRegion(s, "?streaming=1")).replyAt, String(s.registry.thread(s.thread.id)!.lastReplyAt));
});

test("a Claude worker's page stream sends nothing while its conversation is unchanged, its pings included, though an age in it changed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-27T12:00:00Z") });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  for (let next = await stream.next(); !/Do these steps one at a time/.test(next.convo ?? ""); next = await stream.next());
  for (let pings = 0; pings < 4; pings++) t.mock.timers.tick(15_000);
  assert.match((await convoRegion(s)).inside, /started <time [^>]*data-ago>1 min ago<\/time>/, "a minute on, a render says so");

  await appendFile(s.transcript, fixture.slice(22, 24).join(""));
  // No turn runs, so the event's read is the only change the stream can show.
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  t.mock.timers.tick(1_000);
  assert.match((await stream.next()).convo, /<span class="t-name">Write<\/span>/, "the first frame after the pings is the read's, not one for the age");
});

test("two page streams of one Claude worker render each new view once between them", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const streams = [s.events(`/threads/${s.thread.id}/stream`), s.events(`/threads/${s.thread.id}/stream`)];
  t.after(() => { for (const stream of streams) stream.close(); });
  const frame = async (stream: (typeof streams)[number], pattern: RegExp) => {
    for (;;) {
      const next = await stream.next();
      if (next.convo !== undefined && pattern.test(next.convo)) return next;
    }
  };
  for (const stream of streams) await frame(stream, /Do these steps one at a time/);
  // Each render reads who sent the prompts it shows, and nothing else here does.
  const senders = s.registry.claudeMessageSenders;
  let renders = 0;
  s.registry.claudeMessageSenders = (...args) => { renders++; return senders(...args); };
  t.after(() => { s.registry.claudeMessageSenders = senders; });
  await appendFile(s.transcript, fixture.slice(22, 24).join(""));
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  const [a, b] = await Promise.all(streams.map((stream) => frame(stream, /<span class="t-name">Write<\/span>/)));
  assert.deepEqual(a, b);
  assert.equal(renders, 1, "the second stream's frame reuses the first's render");
});

test("a Claude worker's transcript streams to the CLI as its entries whole, then each read's new entries and the turn's start and end", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const whole = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  const stream = s.events(`/v1/threads/${s.thread.id}/claude/events`);
  t.after(() => stream.close());
  assert.deepEqual(await stream.next(), { reset: true, session: claudeSession, entries: whole.entries, dropped: 0, working: false });

  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind, session: claudeSession } });
  report("session.turn-started");
  assert.deepEqual(await stream.next(), { reset: false, session: claudeSession, entries: [], dropped: 0, working: true }, "the turn's start");
  await appendFile(s.transcript, fixture.slice(22, 25).join(""));
  const appended: unknown[] = [];
  for (let frame = await stream.next(); ; frame = await stream.next()) {
    assert.deepEqual([frame.reset, frame.working], [false, true]);
    appended.push(...frame.entries);
    if (appended.length > 0) break;
  }
  report("session.turn-ended");
  for (let frame = await stream.next(); frame.working; frame = await stream.next()) appended.push(...frame.entries);
  const after = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  assert.deepEqual([...whole.entries, ...appended], after.entries, "the frames add up to the transcript, each entry once");

  await writeFile(s.transcript, fixture.slice(0, 3).join(""));
  report("session.turn-ended");
  const replaced = await stream.next();
  assert.equal(replaced.reset, true, "a replaced transcript starts over");
  assert.deepEqual(replaced.entries, ((await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation).entries);

  const harness = await s.call("GET", `/v1/threads/${s.thread.id}/events`);
  assert.equal(harness.status, 409, "a Claude worker has no harness conversation to stream");
  const other = await s.call("GET", `/v1/threads/${(await s.call("POST", "/v1/threads", { project: "acme", title: "Agent" })).body.id}/claude/events`);
  assert.deepEqual(other.status, 409);
  assert.match(other.body.error, /has no Claude worker/);
});

test("a review needs the GitHub token's loop, and landing, at its start or later, needs a deployer", async (t) => {
  const off = await withThread(t);
  const refused = await off.call("POST", `/v1/threads/${off.thread.id}/review`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /github.tokenFile/);
  const asked: unknown[] = [];
  const reviews = {
    async start(builder: string, request: unknown) { asked.push(["start", builder, request]); return { id: "rv-1" }; },
    land(builder: string, by: string, head?: string) { asked.push(["land", builder, by, head]); return { id: "rv-1" }; },
  } as never as ReviewLoop;
  const s = await withThread(t, { reviews, deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop, "nFIREBAT" as TailnetNodeId]), keys: {} } });
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { rounds: 6 })).status, 400, "a review runs at most 5 rounds");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { pr: 7, rounds: 5 })).status, 201);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { land: true })).status, 201);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`, { head: "a".repeat(40) })).status, 200, "the dashboard names the commit it confirmed");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`, { head: "main" })).status, 400);
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, { land: true })).status, 403, "the control node itself never lands, even listed as a deployer");
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/land`)).status, 403);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, {})).status, 403, "the control node never starts a review either, since a thread never drives another");
  s.callAs(phone);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/review`, {})).status, 201, "a review that stops at approval needs no deploy right");
  assert.deepEqual(asked, [
    ["start", s.thread.id, { pr: 7, rounds: 5, land: null }],
    ["start", s.thread.id, { pr: undefined, rounds: undefined, land: laptop }],
    ["land", s.thread.id, laptop, undefined],
    ["land", s.thread.id, laptop, "a".repeat(40)],
    ["start", s.thread.id, { pr: undefined, rounds: undefined, land: null }],
  ]);
});

test("only a project edit turns on reviews of its own, landing needs a deployer, and the project records who turned it on", async (t) => {
  const s = await setup(t, { deployment });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", autoReview: { land: true, enabledBy: laptop } })).status, 400, "a new project cannot name who turned it on");
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: false } }), { status: 403, body: { error: "caller may not edit a project: only a person may, never the control plane, infrastructure nodes or pylons" } });
  s.callAs(phone);
  assert.deepEqual(await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true } }), { status: 403, body: { error: "caller may not land a pull request: landing deploys, and only deployers may, never infrastructure nodes or pylons" } });
  const reviewing = await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: false } });
  assert.deepEqual(reviewing.body.autoReview, { land: false, enabledBy: phone }, "reviewing alone lands nothing, so it needs no deployer");
  s.callAs(laptop);
  assert.deepEqual((await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true } })).body.autoReview, { land: true, enabledBy: laptop });
  assert.deepEqual((await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "trunk" })).body.autoReview, { land: true, enabledBy: laptop }, "another edit keeps it");
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true, enabledBy: "nPHONE" } })).status, 400);
  const off = await s.call("PATCH", "/v1/projects/acme", { autoReview: null });
  assert.equal(off.body.autoReview, undefined);
  assert.equal((await s.call("GET", "/v1/projects")).body.find((p: { id: string }) => p.id === "acme").autoReview, undefined);
});

test("a deployer's land names the holds it waives at the commit it confirmed, and the review loop decides whether they may be waived", async (t) => {
  const held = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const head = "a".repeat(40);
  const landed: unknown[][] = [];
  const reviews = { land(...args: unknown[]) { landed.push(args); return { id: "rv-1" }; } } as never as ReviewLoop;
  const s = await withThread(t, { reviews, deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} } });
  const land = (body: unknown) => s.call("POST", `/v1/threads/${s.thread.id}/land`, body);

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await land({ head, waive: [held] })).status, 403, "only a deployer waives");
  assert.deepEqual(landed, [], "a refused waiver never reaches the review loop");
  s.callAs(laptop);
  assert.equal((await land({ waive: [held] })).status, 400, "a waiver names the commit it confirmed");
  assert.equal((await land({ head, waive: [] })).status, 400, "a waiver names at least one hold");
  assert.equal((await land({ head, waive: [held] })).status, 200);
  assert.equal((await land({ head })).status, 200);
  assert.deepEqual(landed, [[s.thread.id, laptop, head, [held]], [s.thread.id, laptop, head, undefined]]);
});

test("an item is added to a project the pipeline runs for, becomes a queued thread behind the items it is after, and only a person adds, approves or cancels one", async (t) => {
  const s = await setup(t, { pipeline: true, deployment });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/projects", { ...project, id: "other", pipeline: { autoStart: true } })).status, 400, "only an edit turns the pipeline on");
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const off = await s.call("POST", "/v1/items", { project: "acme", title: "A", message: "Build A." });
  assert.deepEqual(off, { status: 409, body: { error: "the pipeline does not run for project acme. nexus project edit acme --pipeline start turns it on" } });

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: true } })).status, 403, "the control plane cannot turn approvals off");
  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "X", requestId: "pipeline:it-000000000000" })).status, 400, "an item's request ID is the pipeline's own");
  const approving = await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: false } });
  assert.deepEqual(approving.body.pipeline, { autoStart: false });
  const a = await s.call("POST", "/v1/items", { project: "acme", title: "A", message: "Build A." });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const item = a.body as PipelineItem;
  assert.deepEqual(item, {
    id: item.id, project: "acme", title: "A", addedBy: laptop, addedAt: item.addedAt, after: [], worker: "harness", model: null, brief: "Build A.", thread: null,
    phase: { kind: "held", why: `project acme waits for the person to approve each item: nexus item approve ${item.id}` }, approved: null,
  });
  assert.match(item.id, /^it-[0-9a-f]{12}$/);
  const b = (await s.call("POST", "/v1/items", { project: "acme", title: "B", claude: "Build B", after: [item.id] })).body as PipelineItem;
  assert.deepEqual(b.phase, { kind: "planned", why: "waits for A to be queued" });
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "C", message: "Go.", after: ["it-000000000000"] })).status, 404);
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "C", message: "Go.", after: [] })).status, 201, "an empty after is nothing ahead");
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "C", message: "Go.", requestId: "x" })).status, 400, "an item takes no request ID");

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await s.call("POST", `/v1/items/${item.id}/approve`, {}), { status: 403, body: { error: "caller may not approve an item: only a person may, never the control plane, infrastructure nodes or pylons" } });
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "D", message: "Go." })).status, 403, "the control plane, and so a harness thread, adds no item");
  assert.equal((await s.call("POST", `/v1/items/${b.id}/cancel`, {})).status, 403);
  s.callAs(laptop);
  const approved = await s.call("POST", `/v1/items/${item.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual((approved.body as PipelineItem).approved?.by, laptop);
  const thread = (approved.body as PipelineItem).thread!;
  assert.match(thread, /^th-/, "the approval queues it at once");
  assert.equal(s.registry.queuedThread(thread)?.startedBy, laptop);
  assert.equal((await s.call("POST", `/v1/items/${item.id}/cancel`, {})).status, 409, "a queued item is cancelled by archiving its thread");
  assert.equal((await s.call("POST", `/v1/items/${b.id}/approve`, {})).status, 200);
  const shown = (await s.call("GET", `/v1/items/${b.id}`)).body as PipelineItem;
  assert.notEqual(shown.thread, null);
  assert.deepEqual(s.registry.queuedThread(shown.thread!)?.after, [thread], "the second item's thread waits for the first's");
  assert.equal((await s.call("GET", "/v1/items")).body.length, 3);
  assert.deepEqual((await s.call("GET", "/v1/items?project=other")).body, []);
  assert.equal((await s.call("GET", "/v1/items/it-000000000000")).status, 404);

  const offAgain = await s.call("PATCH", "/v1/projects/acme", { pipeline: null });
  assert.equal(offAgain.body.pipeline, null, "an off pipeline is kept as null, so the migration never turns it on again");
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { defaultBranch: "trunk" })).body.pipeline, null, "another edit keeps it");
});

async function withQueue(t: import("node:test").TestContext) {
  const s = await setup(t, { queue: true });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const first = await s.call("POST", "/v1/threads", { project: "acme", title: "First" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  return { ...s, first: first.body as Thread };
}

test("only a person starts a thread, starts a queued one now or messages one, never the control node, an infrastructure node or a pylon", async (t) => {
  const s = await withQueue(t);
  const testbench = "nTESTBENCH" as TailnetNodeId;
  s.registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: testbench });
  const queued = (await s.call("POST", "/v1/threads", { project: "acme", title: "Then", after: [s.first.id] })).body as QueuedThread;
  // A pylon's request leaves through its node, so whois names that node.
  const pylonNode = s.registry.nodes().find((n) => n.name === s.registry.pylon(s.first.pylonId)!.node)!.tailnetNodeId;
  const routes = [
    ["start a thread", "/v1/threads", { project: "acme", title: "Another" }, 201],
    ["start a queued thread", `/v1/threads/${queued.id}/start`, undefined, 201],
    ["message a thread", `/v1/threads/${s.first.id}/messages`, { text: "Go.", requestId: "msg:1" }, 202],
  ] as const;
  for (const [who, caller] of [["the control node", "nFIREBAT" as TailnetNodeId], ["an infrastructure node", testbench], ["a pylon", pylonNode]] as const) {
    s.callAs(caller);
    for (const [action, path, body] of routes) {
      const error = `caller may not ${action}: only a person may, never the control plane, infrastructure nodes or pylons`;
      assert.deepEqual(await s.call("POST", path, body), { status: 403, body: { error } }, `${who} may not ${action}`);
    }
  }
  assert.equal(s.calls.length, 1, "no refused request started or messaged a thread");
  assert.equal(s.registry.queuedThread(queued.id)?.status, "queued");

  s.callAs(phone);
  for (const [action, path, body, status] of routes) {
    const answer = await s.call("POST", path, body);
    assert.equal(answer.status, status, `a person who is not a deployer may ${action}: ${JSON.stringify(answer.body)}`);
  }
  assert.deepEqual(s.calls.map((c) => c[0]), ["start", "start", "start", "send"]);
});

test("only a person acts on a thread, its pylon or a project, never the control node, an infrastructure node or a pylon", async (t) => {
  const reviewed: unknown[][] = [];
  const reviews = {
    async start(...args: unknown[]) { reviewed.push(["start", ...args]); return { id: "rv-1" }; },
    cancel(...args: unknown[]) { reviewed.push(["cancel", ...args]); return { id: "rv-1" }; },
  } as never as ReviewLoop;
  const s = await withThread(t, { reviews });
  const testbench = "nTESTBENCH" as TailnetNodeId;
  s.registry.upsertNode({ name: "infra-testbench" as NodeName, tailnetHost: "infra-testbench.tail.ts.net", tailnetNodeId: testbench });
  const pylonNode = s.registry.nodes().find((n) => n.name === s.registry.pylon(s.thread.pylonId)!.node)!.tailnetNodeId;
  const id = s.thread.id;
  const routes = [
    ["abort a thread's turn", "POST", `/v1/threads/${id}/abort`, undefined, 204],
    ["retry a thread's turn", "POST", `/v1/threads/${id}/retry`, undefined, 204],
    ["retry a thread's pylon", "POST", `/v1/threads/${id}/pylon/retry`, undefined, 204],
    ["open a session in a thread's pylon", "POST", `/v1/threads/${id}/sessions`, { harness: "shell" }, 201],
    ["close a session in a thread's pylon", "DELETE", `/v1/threads/${id}/sessions/${encodeURIComponent("w1:p1")}`, {}, 204],
    ["focus a session in a thread's pylon", "POST", `/v1/threads/${id}/sessions/${encodeURIComponent("w1:p1")}/focus`, {}, 204],
    ["publish a preview", "POST", `/v1/threads/${id}/previews`, { port: 3000 }, 200],
    ["unpublish a preview", "DELETE", `/v1/threads/${id}/previews/3000`, {}, 204],
    ["start a review", "POST", `/v1/threads/${id}/review`, {}, 201],
    ["cancel a review", "POST", `/v1/threads/${id}/review/cancel`, undefined, 200],
    ["edit a project", "PATCH", "/v1/projects/acme", { defaultBranch: "trunk" }, 200],
    ["archive a thread", "POST", `/v1/threads/${id}/archive`, undefined, 200],
    ["unarchive a thread", "POST", `/v1/threads/${id}/unarchive`, undefined, 200],
    ["delete a thread", "DELETE", `/v1/threads/${id}`, {}, 200],
  ] as const;
  const harnessCalls = s.calls.length;
  for (const [who, caller] of [["the control node", "nFIREBAT" as TailnetNodeId], ["an infrastructure node", testbench], ["a pylon", pylonNode]] as const) {
    s.callAs(caller);
    for (const [action, method, path, body] of routes) {
      const error = `caller may not ${action}: only a person may, never the control plane, infrastructure nodes or pylons`;
      assert.deepEqual(await s.call(method, path, body), { status: 403, body: { error } }, `${who} may not ${action}`);
    }
    const attached = await attachTo(s.port, attachPathOf(id));
    assert.ok("status" in attached, `${who} is refused before the 101`);
    assert.deepEqual([attached.status, attached.body.error], [403, "caller may not attach to a thread's pylon: only a person may, never the control plane, infrastructure nodes or pylons"]);
  }
  assert.deepEqual([s.calls.length, s.commands, s.streams, reviewed], [harnessCalls, [], [], []], "no refused request reached the harness, the probe or the review loop");
  assert.equal(s.registry.thread(id)!.status, "active");
  assert.equal(s.registry.project("acme" as ProjectId)!.defaultBranch, project.defaultBranch);

  s.callAs(phone);
  s.registry.savePylon({ ...s.registry.pylon(s.thread.pylonId)!, failed: "last job failed with setup-failed" });
  for (const [action, method, path, body, status] of routes) {
    const answer = await s.call(method, path, body);
    assert.equal(answer.status, status, `a person who is not a deployer may ${action}: ${JSON.stringify(answer.body)}`);
  }
  assert.deepEqual(reviewed.map((r) => r[0]), ["start", "cancel"]);
});

test("a start after other threads is queued with no row or pylon, until start-queued starts it as any start", async (t) => {
  const s = await withQueue(t);
  const answer = await s.call("POST", "/v1/threads", { project: "acme", title: "Then", after: [s.first.id], message: "Fix the next bug." });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const queued = answer.body as QueuedThread;
  assert.deepEqual(queued, {
    id: queued.id, title: "Then", project: "acme", startedBy: laptop, createdAt: queued.createdAt, status: "queued", after: [s.first.id],
    waits: [{ thread: s.first.id, state: "waiting", why: "has no pull request yet" }], blocked: false, node, worker: "harness", model: null,
    prompt: "Fix the next bug.", branch: null, commit: null, resources: project.resources, startNow: null, lastError: null,
  });
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [s.first.id], "the thread list leaves queued threads out");
  assert.deepEqual(await s.call("GET", "/v1/queued"), { status: 200, body: [queued] });
  assert.deepEqual((await s.call("GET", "/v1/queued?project=other")).body, []);
  assert.deepEqual(await s.call("GET", `/v1/queued/${queued.id}`), { status: 200, body: queued });
  assert.equal((await s.call("GET", `/v1/queued/${s.first.id}`)).status, 404, "a started thread is not queued");
  const refused = await s.call("GET", `/v1/threads/${queued.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /is queued, so it has no pylon or conversation yet/);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/messages`, { text: "hi", requestId: "msg:1" })).status, 409);
  assert.equal(s.registry.pylon(`pylon-${queued.id}` as PylonId), undefined);
  assert.equal(s.calls.length, 1, "only the first thread has a conversation");

  const archived = await s.call("POST", `/v1/threads/${queued.id}/archive`);
  assert.deepEqual(archived, { status: 200, body: { ...queued, status: "archived" } });
  assert.match((await s.call("GET", `/v1/threads/${queued.id}`)).body.error, /was cancelled while queued/);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/archive`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/start`)).status, 409, "a cancelled thread starts only once unarchived");
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/unarchive`)).body.status, "queued");

  const started = await s.call("POST", `/v1/threads/${queued.id}/start`);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal((started.body as Thread).id, queued.id);
  assert.equal((started.body as Thread).startedBy, laptop);
  assert.deepEqual(s.calls.slice(1), [
    ["start", { threadId: queued.id, pylonId: `pylon-${queued.id}` }],
    ["send", queued.id, "Fix the next bug.", `queued:${queued.id}`, "followUp"],
  ]);
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [s.first.id, queued.id]);
  assert.deepEqual((await s.call("GET", "/v1/queued")).body, []);
  assert.equal((await s.call("GET", `/v1/queued/${queued.id}`)).status, 404);
  assert.equal((await s.call("GET", `/v1/threads/${queued.id}`)).status, 200);
  assert.match((await s.call("POST", `/v1/threads/${queued.id}/start`)).body.error, /has started/);
  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/archive`)).body.status, "archived", "a started thread archives as a thread");

  const other = (await s.call("POST", "/v1/threads", { project: "acme", title: "Later", after: [queued.id], claude: "Fix it" })).body as QueuedThread;
  assert.equal(other.worker, "claude");
  assert.deepEqual(other.waits, [{ thread: queued.id, state: "blocked", why: "is archived and its pull request did not merge" }]);
  assert.equal(other.blocked, true);
  assert.deepEqual(await s.call("DELETE", `/v1/threads/${other.id}`), { status: 200, body: { ...other, status: "deleted" } });
  assert.equal((await s.call("DELETE", `/v1/threads/${other.id}`)).status, 409);
  assert.equal((await s.call("POST", "/v1/threads/th-000000000000/start")).status, 404);
});

test("a queued start is checked as a start is before it is recorded, and needs the GitHub token", async (t) => {
  const s = await withQueue(t);
  const refused = async (body: unknown, status: number, error: RegExp) => {
    const answer = await s.call("POST", "/v1/threads", body);
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.match(answer.body.error, error);
  };
  await refused({ project: "acme", title: "x", after: [] }, 400, /after/);
  await refused({ project: "acme", title: "x", after: Array.from({ length: 33 }, (_, i) => `th-${i}`) }, 400, /after/);
  await refused({ project: "acme", title: "x", after: ["th-nope"] }, 404, /no thread th-nope/);
  await refused({ project: "nope", title: "x", after: [s.first.id] }, 404, /no project nope/);
  await refused({ project: "acme", title: "x", node: "nowhere", after: [s.first.id] }, 400, /no node nowhere/);
  await refused({ project: "acme", title: "x", claude: "Fix it", message: "hi", after: [s.first.id] }, 400, /message is for a Nexus agent thread/);
  assert.deepEqual((await s.call("GET", "/v1/queued")).body, []);

  const plain = await withImage(t);
  const answer = await plain.call("POST", "/v1/threads", { project: "acme", title: "x", after: ["th-any"] });
  assert.equal(answer.status, 409);
  assert.match(answer.body.error, /queued threads need the control plane's GitHub token \(github.tokenFile\)/);
  assert.deepEqual((await plain.call("GET", "/v1/queued")).body, []);
});

test("a start repeated under its request ID answers the same thread and delivers its first message once", async (t) => {
  const s = await withImage(t);
  const body = { project: "acme", title: "Brief", message: "Fix the checkout bug.", requestId: "start:1" };
  const first = await s.call("POST", "/v1/threads", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = (first.body as Thread).id;
  const again = await s.call("POST", "/v1/threads", body);
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal((again.body as Thread).id, id);
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [id], "one thread");
  const brief = ["send", id, "Fix the checkout bug.", `brief:${id}`, "followUp"];
  assert.deepEqual(s.calls, [["start", { threadId: id, pylonId: `pylon-${id}` }], brief, brief], "the repeat sends the brief again under the same request ID");
  assert.deepEqual(s.fake.transcript(id).messages.map((m) => m.content), ["Fix the checkout bug."], "one first message");

  const other = await s.call("POST", "/v1/threads", { ...body, title: "Another" });
  assert.equal(other.status, 409);
  assert.match(other.body.error, new RegExp(`request ID start:1 started thread ${id} with another body`));
  assert.equal((await s.call("POST", "/v1/threads", { ...body, message: "Something else." })).status, 409, "the first message is part of the body");
  assert.equal((await s.call("GET", "/v1/threads")).body.length, 1);

  assert.equal((await s.call("POST", `/v1/threads/${id}/archive`)).status, 200);
  const archived = await s.call("POST", "/v1/threads", body);
  assert.equal((archived.body as Thread).status, "archived", "a repeat answers the thread as it is now");
  assert.equal(s.calls.filter((c) => c[0] === "send").length, 2, "an archived thread is not sent its brief again");
});

test("starts repeated at once under one request ID start one thread, and one with another body is refused", async (t) => {
  const s = await withImage(t);
  const body = { project: "acme", title: "Twice", requestId: "start:same" };
  const reading = Promise.withResolvers<void>();
  const read = Promise.withResolvers<never>();
  s.remoteReads(() => { reading.resolve(); return read.promise; });
  const first = s.call("POST", "/v1/threads", body);
  await reading.promise;
  const second = s.call("POST", "/v1/threads", body);
  const other = await s.call("POST", "/v1/threads", { ...body, title: "Other" });
  read.reject(new Error("no remote"));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((b.body as Thread).id, (a.body as Thread).id);
  assert.equal(other.status, 409);
  assert.match(other.body.error, /request ID start:same is starting a thread with another body/);
  assert.deepEqual((await s.call("GET", "/v1/threads")).body.map((r: ThreadRow) => r.id), [(a.body as Thread).id]);
  assert.equal(s.calls.filter((c) => c[0] === "start").length, 1);
});

test("a start that failed under a request ID made nothing, so the ID starts a corrected body", async (t) => {
  const s = await withImage(t);
  assert.equal((await s.call("POST", "/v1/threads", { project: "nope", title: "x", requestId: "start:typo" })).status, 404);
  const fixed = await s.call("POST", "/v1/threads", { project: "acme", title: "x", requestId: "start:typo" });
  assert.equal(fixed.status, 201, JSON.stringify(fixed.body));
  const claude = await s.call("POST", "/v1/threads", { project: "acme", title: "x", claude: "Fix it", message: "hi", requestId: "start:claude" });
  assert.equal(claude.status, 400);
  assert.match(claude.body.error, /message is for a Nexus agent thread/);
  assert.equal(s.registry.startRequest("start:claude"), undefined);
  const plain = await s.call("POST", "/v1/threads", { project: "acme", title: "No ID", message: "Look around." });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(s.calls.at(-1), ["send", (plain.body as Thread).id, "Look around.", `brief:${(plain.body as Thread).id}`, "followUp"], "a start without a request ID sends its first message too");
});

test("a start whose first message failed keeps its request ID, and a repeat sends the brief to the same thread once", async (t) => {
  const s = await withImage(t);
  const send = s.fake.harness.send;
  t.after(() => { s.fake.harness.send = send; });
  const cases = [
    { requestId: "start:refused", fail: () => Promise.reject(new Error("the harness is unreachable")) },
    { requestId: "start:unacknowledged", fail: async (...args: Parameters<typeof send>) => { await send(...args); throw new Error("the acknowledgement was lost"); } },
  ];
  for (const { requestId, fail } of cases) {
    const body = { project: "acme", title: requestId, message: `Brief for ${requestId}`, requestId };
    s.fake.harness.send = fail;
    const failed = await s.call("POST", "/v1/threads", body);
    s.fake.harness.send = send;
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    const id = s.registry.startRequest(requestId)?.thread;
    assert.ok(id !== undefined, `${requestId}: the thread committed, so its request ID is kept`);
    assert.equal(failed.body.error, `started ${id}, but its first message was not sent: ${requestId === "start:refused" ? "the harness is unreachable" : "the acknowledgement was lost"}. Start it again under request ID ${requestId} to send it`);
    assert.equal((await s.call("POST", "/v1/threads", { ...body, message: "Another brief" })).status, 409, `${requestId}: another body is refused`);
    const retried = await s.call("POST", "/v1/threads", body);
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    assert.equal((retried.body as Thread).id, id);
    assert.deepEqual(s.fake.transcript(id).messages.map((m) => m.content), [`Brief for ${requestId}`], `${requestId}: the brief arrived once`);
  }
  assert.equal((await s.call("GET", "/v1/threads")).body.length, 2, "one thread per request ID");
});

test("a queued start repeated under its request ID answers the same queued thread, then the thread it became", async (t) => {
  const s = await withQueue(t);
  const body = { project: "acme", title: "Then", after: [s.first.id], message: "Fix the next bug.", requestId: "start:queued" };
  const first = await s.call("POST", "/v1/threads", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const queued = first.body as QueuedThread;
  assert.deepEqual(await s.call("POST", "/v1/threads", body), { status: 201, body: queued });
  assert.deepEqual((await s.call("GET", "/v1/queued")).body, [queued], "one queued thread");
  assert.equal((await s.call("POST", "/v1/threads", { ...body, after: undefined })).status, 409, "an immediate start under the queued start's ID is another body");

  assert.equal((await s.call("POST", `/v1/threads/${queued.id}/start`)).status, 201);
  const started = await s.call("POST", "/v1/threads", body);
  assert.equal(started.status, 201);
  assert.equal((started.body as Thread).id, queued.id);
  assert.equal((started.body as Thread).pylonId, `pylon-${queued.id}`, "a repeat after the start answers the thread");
  assert.deepEqual(s.fake.transcript(queued.id).messages.map((m) => m.content), ["Fix the next bug."]);
});

test("thread detail lists the judgments of the thread's failed pylon, oldest failure first, with what each decided and did", async (t) => {
  const s = await withThread(t);
  const judgment = (failure: number, phase: Judgment["phase"]): Judgment => ({
    failure, thread: s.thread.id, node, failed: "pylon is broken: the controller exited", startedAt: 5, request: failure === 900 ? null : { brief: "Is it the node?", token: "t" },
    conversation: null, reply: failure === 900 ? null : "No block.", phase,
  });
  s.registry.saveJudgment(judgment(900, { kind: "acting", verdict: { answer: "person", why: "Nexus already retried this thread's pylon 2 times on its own", by: "control plane" } }), null);
  s.registry.saveJudgment(judgment(812, { kind: "done", verdict: { answer: "retry-elsewhere", why: "The node is out of disk.", by: "judgment" }, outcome: { kind: "moved", from: node, to: "rj-other" as NodeName, on: "verdict" } }), null);
  const { judgments } = (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  assert.deepEqual(judgments, [
    { failure: 812, node, failed: "pylon is broken: the controller exited", startedAt: 5, phase: "done", verdict: { answer: "retry-elsewhere", why: "The node is out of disk.", by: "judgment" },
      outcome: `moved the pylon from ${node} to rj-other and retried it`, question: null, brief: "Is it the node?", reply: "No block." },
    { failure: 900, node, failed: "pylon is broken: the controller exited", startedAt: 5, phase: "acting", verdict: { answer: "person", why: "Nexus already retried this thread's pylon 2 times on its own", by: "control plane" },
      outcome: null, question: null, brief: null, reply: null },
  ]);
});

test("a planning thread's proposals become cards only a person answers, an accepted one becomes the person's item and queued thread, and the next message tells the thread", async (t) => {
  const s = await setup(t, { pipeline: true, deployment });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { pipeline: { autoStart: true } })).status, 200);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Plan", planning: true, claude: "Plan it" })).status, 400, "a Claude worker cannot plan");
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Plan", planning: true, after: ["th-000000000000"] })).status, 400, "a planning thread starts now");
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "Plan", message: "Go.", planning: true })).status, 400, "an item is no planning thread");
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Plan the wave", planning: true, message: "Plan the orchestration wave." });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = (started.body as Thread).id;
  assert.equal(((await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail).planning, true);
  const first = s.fake.transcript(id).messages[0]!.content as string;
  assert.ok(first.startsWith(planningPrefix) && first.endsWith("Plan the orchestration wave."), "the guide goes before the person's first message");
  const token = /"token": "([^"]+)"/.exec(first)![1]!;

  s.fake.transcript(id).messages.push({ role: "assistant", content: [{ type: "text", text: `Two items.\n\`\`\`nexus-plan\n${JSON.stringify({ token, items: [
    { key: "a", title: "A: archive what landed", brief: "Archive the builder once its review lands." },
    { key: "b", title: "B: nudge a stalled builder", brief: "Nudge a builder that stopped short.", after: ["a"] },
  ] })}\n\`\`\`` }] } as never);
  s.fake.commit(id);
  s.registry.recordReply(id, Date.now());
  await s.plans!.poll();
  const detail = async () => (await s.call("GET", `/v1/threads/${id}`)).body as ThreadDetail;
  const [a, b] = (await detail()).questions;
  assert.deepEqual([a!.proposal?.title, b!.proposal?.title], ["A: archive what landed", "B: nudge a stalled builder"]);
  assert.ok(a!.text.includes("Archive the builder once its review lands."), "the card shows the brief in full");
  assert.equal((await detail()).attention, "decision");
  assert.deepEqual([s.registry.items().length, s.registry.queuedThreads().length], [0, 0], "nothing the thread wrote adds or starts work, though the project's items start on their own");

  const answer = (q: Question, option: string) => s.call("POST", `/v1/questions/${q.id}/answer`, { option });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await answer(a!, "accept"), { status: 403, body: { error: "caller may not answer this question: only a person's device may, never infrastructure nodes or pylons" } });
  s.callAs(phone);
  assert.deepEqual(await answer(b!, "accept"), { status: 409, body: { error: `"B: nudge a stalled builder" waits on "A: archive what landed", which is not answered yet. Accept that one first` } });
  assert.equal(s.registry.question(b!.id)!.answer, null, "a refused accept leaves the card open");
  assert.equal((await answer(a!, "accept")).status, 200);
  assert.equal((await answer(b!, "reject")).status, 200);
  const items = (await s.call("GET", "/v1/items")).body as PipelineItem[];
  assert.deepEqual(items.map((i) => [i.title, i.addedBy, i.brief]), [["A: archive what landed", phone, "Archive the builder once its review lands."]], "only the accepted proposal is an item, the person's");
  assert.equal(s.registry.queuedThread(items[0]!.thread!)?.startedBy, phone, "and is queued as the person's at once");
  assert.notEqual((await detail()).attention, "decision");

  s.callAs(laptop);
  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "B is too early.", requestId: "msg:1" })).status, 202);
  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "B is too early.", requestId: "msg:1" })).status, 202);
  assert.equal((await s.call("POST", `/v1/threads/${id}/messages`, { text: "Go on.", requestId: "msg:2" })).status, 202);
  assert.deepEqual(s.fake.transcript(id).messages.slice(2).map((m) => m.content), [
    `${planningPrefix}\nThe person answered your proposals:\n- accepted "A: archive what landed" (key a), now pipeline item ${items[0]!.id}\n- rejected "B: nudge a stalled builder" (key b)\nThe person's message follows.\n\nB is too early.`,
    "Go on.",
  ], "the next message tells what the person answered, once");
});

test("a person answers a question, a deployer question needs a deployer, and no node or pylon answers one", async (t) => {
  const s = await withThread(t, { deployment });
  const ask = (id: string, answerer: Question["answerer"]) => s.registry.askQuestion({
    id, thread: s.thread.id, text: "Rebuild the pylon image?\nIt changes the base layer.", options: ["Rebuild", "Not now"], reserved: "image-rebuild", answerer, askedAt: 1,
  });
  ask("qn-person", "person");
  ask("qn-deployer", "deployer");
  const answer = (id: string, option: string) => s.call("POST", `/v1/questions/${id}/answer`, { option });
  const detail = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  assert.equal((await detail()).attention, "decision");
  assert.deepEqual((await detail()).questions.map((q) => q.id), ["qn-deployer", "qn-person"], "by when they were asked, then by ID");

  s.callAs("nFIREBAT" as TailnetNodeId);
  for (const id of ["qn-person", "qn-deployer"]) {
    assert.deepEqual(await answer(id, "Rebuild"), { status: 403, body: { error: "caller may not answer this question: only a person's device may, never infrastructure nodes or pylons" } });
  }
  s.callAs(phone);
  assert.deepEqual(await answer("qn-deployer", "Rebuild"), { status: 403, body: { error: "caller may not answer this question: its answer may deploy, so only deployers may" } });
  assert.deepEqual(await answer("qn-unknown", "Rebuild"), { status: 404, body: { error: "no question qn-unknown" } });
  assert.deepEqual(await answer("qn-person", "Maybe"), { status: 400, body: { error: `"Maybe" is not an option of question qn-person, which are "Rebuild", "Not now"` } });
  assert.equal((await s.call("POST", "/v1/questions/qn-person/answer", { option: "Rebuild", by: laptop })).status, 400, "the answerer is the caller, never the body");

  const answered = await answer("qn-person", "Not now");
  assert.equal(answered.status, 200);
  const first = answered.body as Question;
  assert.deepEqual(first.answer && { option: first.answer.option, by: first.answer.by }, { option: "Not now", by: phone });
  assert.equal((await detail()).attention, "decision", "the deployer question is still open");
  s.callAs(laptop);
  assert.deepEqual(await answer("qn-person", "Not now"), { status: 200, body: first }, "a retried answer gets the first one's record");
  assert.deepEqual(await answer("qn-person", "Rebuild"), { status: 409, body: { error: `question qn-person was answered "Not now" by ${phone}` } });
  assert.equal((await answer("qn-deployer", "Rebuild")).status, 200);
  const after = await detail();
  assert.notEqual(after.attention, "decision");
  assert.deepEqual(after.questions.map((q) => [q.id, q.answer?.option, q.answer?.by]), [["qn-deployer", "Rebuild", laptop], ["qn-person", "Not now", phone]]);
});

test("without deployment options the control node is unknown, so no one answers a question or starts or messages a thread", async (t) => {
  const s = await setup(t, { deployment: null });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const thread = await s.startThread({ project: "acme", title: "Fix checkout" }, laptop);
  for (const answerer of ["person", "deployer"] as const) {
    s.registry.askQuestion({ id: `qn-${answerer}`, thread: thread.id, text: "Go?", options: ["Yes", "No"], reserved: null, answerer, askedAt: 1 });
  }
  for (const caller of [laptop, "nFIREBAT" as TailnetNodeId]) {
    s.callAs(caller);
    for (const id of ["qn-person", "qn-deployer"]) assert.equal((await s.call("POST", `/v1/questions/${id}/answer`, { option: "Yes" })).status, 403, `${caller} answered ${id}`);
    assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Another" })).status, 403, `${caller} started a thread`);
    assert.equal((await s.call("POST", `/v1/threads/${thread.id}/messages`, { text: "Go." })).status, 403, `${caller} messaged a thread`);
  }
});

const drink = { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot", preview: "a cup of tea" }, { label: "Coffee", description: "Strong" }] };
const extras = { question: "What goes in it?", header: "Extras", multiSelect: true, options: [{ label: "Milk", description: "" }, { label: "Sugar", description: "" }] };

/**
 * A Claude worker thread in a running turn whose pylon's hook reports an AskUserQuestion dialog waiting, which a read
 * of its conversation found, though Claude has written no transcript yet.
 */
async function claudeAsking(t: import("node:test").TestContext) {
  const s = await withClaude(t);
  const at = Date.now();
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: at, event: { kind: "session.turn-started", session: claudeSession, at } });
  s.pylon.asks = [{ session: claudeSession, toolUseId: "toolu_1", at: at + 1, input: { questions: [drink, extras] } }];
  const read = () => s.call("GET", `/v1/threads/${s.thread.id}/conversation`);
  assert.equal((await read()).status, 200);
  const delivered = () => s.commands.filter(([, c]) => c.kind === "exec");
  const answer = (body: unknown) => s.call("POST", "/v1/questions/ask-toolu_1/answer", body);
  const detail = async () => (await s.call("GET", `/v1/threads/${s.thread.id}`)).body as ThreadDetail;
  const exec = (exitCode: number | null, output: string) => s.probeAnswers(async (c) => c.kind === "exec" ? { kind: "exec", exitCode, output, truncated: false } : assert.fail(`unexpected ${c.kind}`));
  return { ...s, read, delivered, answer, detail, exec };
}

test("a person answers a Claude worker's AskUserQuestion with a choice per question, which the hook in its pylon hands to Claude before it is recorded", async (t) => {
  const s = await claudeAsking(t);
  const [asked] = (await s.detail()).questions;
  assert.deepEqual(asked && { id: asked.id, text: asked.text, options: asked.options, ask: asked.ask, answer: asked.answer }, {
    id: "ask-toolu_1", text: "Drink: Which drink?\nExtras: What goes in it?", options: [], ask: { session: claudeSession, toolUseId: "toolu_1", questions: [drink, extras] }, answer: null,
  });
  assert.equal((await s.detail()).attention, "decision");
  const choices = [{ picked: ["Tea"], notes: "no rush" }, { picked: ["Milk"], own: "Oat cream" }];

  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.deepEqual(await s.answer({ choices }), { status: 403, body: { error: "caller may not answer this question: only a person's device may, never infrastructure nodes or pylons" } });
  s.callAs(laptop);
  assert.deepEqual(await s.answer({ option: "Tea" }), { status: 400, body: { error: `question ask-toolu_1 is a Claude worker's AskUserQuestion, answered with {"choices": [...]}, a choice for each question it asks` } });
  for (const bad of [{ choices: choices.slice(1) }, { choices: [{ picked: ["Juice"] }, choices[1]] }, { choices: [{ picked: ["Tea"], own: "Water" }, choices[1]] }, { choices, option: "Tea" }]) {
    assert.equal((await s.answer(bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(s.delivered(), [], "nothing refused reaches the pylon");

  s.exec(0, "delivered\n");
  const answered = await s.answer({ choices: [{ picked: ["Tea"], notes: " no rush " }, { picked: ["Milk"], own: "Oat cream" }] });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const first = answered.body as Question;
  assert.deepEqual(first.answer && { ...first.answer, at: 0 }, { option: "Drink: Tea; Extras: Milk, Oat cream", by: laptop, at: 0, choices });
  assert.deepEqual(s.delivered().map(([pylon, c]) => [pylon, c.kind === "exec" && { ...c, argv: c.argv.slice(0, 2) }]), [[s.thread.pylonId, { kind: "exec", argv: ["/usr/local/bin/nexus-claude-hook", "answer"], cwd: "/", timeoutMs: 15_000 }]]);
  const [, command] = s.delivered()[0]!;
  assert.deepEqual(JSON.parse(command.kind === "exec" ? command.argv[2]! : ""), {
    session: claudeSession, questions: ["Which drink?", "What goes in it?"], toolUseId: "toolu_1",
    answers: { "Which drink?": "Tea", "What goes in it?": "Milk, Oat cream" }, annotations: { "Which drink?": { notes: "no rush" } },
  });
  assert.notEqual((await s.detail()).attention, "decision");

  s.callAs(phone);
  assert.deepEqual(await s.answer({ choices }), { status: 200, body: first }, "a retried answer gets the first one's record");
  assert.deepEqual(await s.answer({ choices: [{ picked: ["Coffee"] }, { picked: ["Sugar"] }] }), { status: 409, body: { error: `question ask-toolu_1 was answered "Drink: Tea; Extras: Milk, Oat cream" by ${laptop}` } });
  assert.equal(s.delivered().length, 1, "an answered ask is not handed to Claude again");
  s.registry.askQuestion({ id: "qn-plain", thread: s.thread.id, text: "Go?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: 1 });
  assert.deepEqual(await s.call("POST", "/v1/questions/qn-plain/answer", { choices }), { status: 400, body: { error: `question qn-plain is answered with {"option": "<one of its options>"}` } });
});

test("an answer to an AskUserQuestion nobody waits for any more withdraws it, and one a pylon's image cannot hand to Claude says to answer in its terminal", async (t) => {
  const s = await claudeAsking(t);
  const choices = [{ picked: ["Tea"] }, { picked: ["Milk"] }];
  const open = async () => (await s.detail()).questions.map((q) => [q.id, q.answer]);
  const old = `pylon ${s.thread.pylonId} runs an image from before AskUserQuestion could be answered from the dashboard, so answer it in the pylon's terminal (\`nexus attach ${s.thread.id}\`)`;
  s.exec(127, "sh: 1: /usr/local/bin/nexus-claude-hook: not found\n");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: old } });
  s.exec(0, "");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: old } }, "a hook from before asks exits 0 for a kind it does not know");
  s.exec(21, "");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: "another answer to question ask-toolu_1 reached Claude first" } });
  s.exec(null, "");
  assert.equal((await s.answer({ choices })).status, 502);
  assert.deepEqual(await open(), [["ask-toolu_1", null]], "an answer Claude did not get is not recorded");

  // Each answer above started a read, whose report from before the hook stopped would ask the question again.
  await s.read();
  s.pylon.asks = [];
  s.exec(20, "");
  assert.deepEqual(await s.answer({ choices }), { status: 409, body: { error: "Claude no longer waits for this answer: it was answered in the terminal, its turn ended, or its pylon paused since. Send it to Claude as a message instead" } });
  assert.deepEqual(await open(), []);
  assert.notEqual((await s.detail()).attention, "decision");
  await s.read();
  assert.deepEqual(await open(), [], "the pylon's next report agrees");
});

test("a harness, a Claude worker and a bare thread each answer every agent route as their kind does", async (t) => {
  const s = await withThread(t);
  const claude = (await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" })).body as Thread;
  const bare = await s.startThread({ project: "acme", title: "Check", bare: true }, laptop);
  const threads = { harness: s.thread, claude, bare };
  /** Each route's status, with its error or what its body is. A stream that opens is closed at once. */
  const answer = async (method: string, path: string, body?: unknown) => {
    if (path.endsWith("events") || path.endsWith("/stream")) {
      const stream = s.events(path);
      const { statusCode } = await stream.response;
      stream.close();
      if (statusCode === 200) return "200 stream";
    }
    const res = await s.call(method, path, body);
    return `${res.status} ${res.body === null ? "" : res.body.error ?? (res.body.kind === "claude" ? "claude view" : Array.isArray(res.body.entries) ? "harness view" : JSON.stringify(res.body))}`;
  };
  const routes = async (t: Thread, requestId: string) => ({
    detail: await (async () => {
      const d = (await s.call("GET", `/v1/threads/${t.id}`)).body as ThreadDetail;
      return { claudeWorker: d.claudeWorker ?? null, agent: d.agent };
    })(),
    conversation: await answer("GET", `/v1/threads/${t.id}/conversation`),
    events: await answer("GET", `/v1/threads/${t.id}/events`),
    claudeEvents: await answer("GET", `/v1/threads/${t.id}/claude/events`),
    page: await answer("GET", `/threads/${t.id}/stream`),
    message: await answer("POST", `/v1/threads/${t.id}/messages`, { text: "hi", requestId }),
    abort: await answer("POST", `/v1/threads/${t.id}/abort`),
    retry: await answer("POST", `/v1/threads/${t.id}/retry`),
  });
  const noConversation = (t: Thread) => `409 thread ${t.id} has no conversation`;
  const noWorker = (t: Thread) => `409 thread ${t.id} has no Claude worker`;
  const deleted = (t: Thread) => `409 thread ${t.id} is deleted`;
  const archived = (t: Thread) => `409 thread ${t.id} is archived`;
  assert.deepEqual(await routes(threads.harness, "msg:h"), {
    detail: { claudeWorker: null, agent: { parkedTasks: 0 } }, conversation: "200 harness view", events: "200 stream", claudeEvents: noWorker(threads.harness),
    page: "200 stream", message: '202 {"submission":7}', abort: "204 ", retry: "204 ",
  });
  assert.deepEqual(await routes(threads.claude, "msg:c"), {
    detail: { claudeWorker: { model: "claude-opus-5-5", state: "pending" }, agent: null }, conversation: "200 claude view", events: noConversation(threads.claude), claudeEvents: "200 stream",
    page: "200 stream", message: `409 the Claude worker of ${threads.claude.id} has not started a session yet, so it takes no messages. Send it once it has started`,
    abort: `409 the Claude worker of ${threads.claude.id} has not started a session yet, so it has no turn to interrupt`, retry: noConversation(threads.claude),
  });
  assert.deepEqual(await routes(threads.bare, "msg:b"), {
    detail: { claudeWorker: null, agent: null }, conversation: noConversation(threads.bare), events: noConversation(threads.bare), claudeEvents: noWorker(threads.bare),
    page: noConversation(threads.bare), message: noConversation(threads.bare), abort: noConversation(threads.bare), retry: noConversation(threads.bare),
  });

  for (const t of Object.values(threads)) assert.equal((await s.call("POST", `/v1/threads/${t.id}/archive`)).status, 200);
  assert.deepEqual(await Promise.all(Object.values(threads).map((t) => answer("POST", `/v1/threads/${t.id}/messages`, { text: "hi", requestId: "msg:archived" }))), Object.values(threads).map(archived));
  assert.deepEqual(await Promise.all(Object.values(threads).map((t) => answer("POST", `/v1/threads/${t.id}/retry`))), Object.values(threads).map(archived));
  for (const t of Object.values(threads)) assert.equal((await s.call("POST", `/v1/threads/${t.id}/unarchive`)).status, 200);

  s.calls.length = 0;
  for (const t of Object.values(threads)) assert.equal((await s.call("DELETE", `/v1/threads/${t.id}`)).status, 200);
  assert.deepEqual(s.calls, [["delete", { threadId: threads.harness.id, pylonId: threads.harness.pylonId }]], "only the harness thread's conversation is deleted");
  for (const t of Object.values(threads)) {
    assert.deepEqual(await routes(t, "msg:deleted"), {
      detail: { claudeWorker: t === claude ? { model: "claude-opus-5-5", state: "pending" } : null, agent: null }, conversation: deleted(t), events: deleted(t), claudeEvents: deleted(t),
      page: deleted(t), message: deleted(t), abort: deleted(t), retry: deleted(t),
    }, t.title);
  }
});

const health: NodeHealth = {
  node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
  memory: { totalGiB: 62.8, availableGiB: 40.2, swapTotalGiB: 8, swapFreeGiB: 8 }, disk: { path: "/var/lib/nexus", totalGiB: 457, freeGiB: 180.3 },
  temperatures: null, pylons: [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, processes: 2, cpuPercent: 12.5, residentGiB: 6.2 }],
};

test("only a deployer reads a node's health, which the node's probe answers, and no route under it changes the node", async (t) => {
  const s = await setup(t, { deployment });
  let reads = 0;
  s.nodeHealth(async () => { reads++; return health; });
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 200, body: health });
  s.callAs(phone);
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 403, body: { error: "caller may not read a node's health: only deployers may, never infrastructure nodes or pylons" } });
  s.callAs("nFIREBAT" as TailnetNodeId);
  assert.equal((await s.call("GET", `/v1/nodes/${node}/health`)).status, 403, "the control node is never a deployer, though listed");
  s.callAs(laptop);
  assert.deepEqual(await s.call("GET", "/v1/nodes/nowhere/health"), { status: 404, body: { error: "no node nowhere" } });
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await s.call(method, `/v1/nodes/${node}/health`, {})).status, 405, `${method} is no route`);
  s.nodeHealth(async () => { throw Object.assign(new Error(`${node}: connect ECONNREFUSED`), { code: "unreachable" }); });
  assert.deepEqual(await s.call("GET", `/v1/nodes/${node}/health`), { status: 503, body: { error: `${node}: connect ECONNREFUSED` } });
  assert.equal(reads, 1, "a refused caller reaches no probe");
  const off = await setup(t);
  assert.equal((await off.call("GET", `/v1/nodes/${node}/health`)).status, 403, "with no deployers configured, nobody reads it");
});
