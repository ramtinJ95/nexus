/** The API wired as the control plane wires it, over a fake harness and probe, for the API, dashboard and CLI suites. */
import type { DeploymentOptions } from "./releases.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { claudeProjects } from "../claude-transcript.ts";
import { claudeHook } from "../../images/pylon/nexus-contract.ts";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { startApi, type ApiOptions } from "./api.ts";
import { threadStarter } from "./threads.ts";
import { pipeline } from "./pipeline.ts";
import { planning } from "./planning.ts";
import { threadQueue } from "./queue.ts";
import { turnGate } from "./drain.ts";
import type { AttachTiming } from "./attach.ts";
import type { ReviewLoop } from "./review.ts";
import { agentReader } from "./agent-conversation.ts";
import { readEvents } from "./event-reader.ts";
import { fakeHarness } from "./fake-harness.ts";
import { openRegistry, type JoinedNode, type Registry, type Thread, type ThreadId } from "./registry.ts";
import type { ImageRollout } from "./image-rollout.ts";
import type { UsageBackfillJob } from "./usage-backfill.ts";
import type { ImageId } from "../images.ts";
import type { ProjectMirror } from "./templates.ts";
import { processStream } from "../process-stream.ts";
import { checkoutDir } from "../sessions.ts";
import { tokenDigest } from "../deploy/model.ts";
import { call as callJson, runningPylon, tempDir, testCapacity, testImage, testObservation } from "../test-kit.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { NodeObservation, ServiceFact } from "../protocol/observations.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import type { ByteStream } from "../protocol/streams.ts";
import type { NodeHealth } from "../protocol/client.ts";

export const node = "rj-firebat" as NodeName;
export const laptop = "nLAPTOP" as TailnetNodeId;
/** An allowed person's device that is not a deployer. */
export const phone = "nPHONE" as TailnetNodeId;
export const project = {
  id: "acme", repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: ["registry.npmjs.org"],
  secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }], logins: ["chatgpt"], preSetup: null,
};
export const image = testImage();

export const dotfiles = { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" };

export const dir = await tempDir("nexus-api-");

export const claudeSession = "11111111-2222-4333-8444-555555555501";
/** The lines of a real Claude Code 2.1.308 transcript, each with its newline. */
export const fixture = (await readFile(new URL("../fixtures/claude-transcript.jsonl", import.meta.url), "utf8")).split("\n").filter((line) => line !== "").map((line) => `${line}\n`);

/** Every API option but the services the kit builds, which a test asks for by flag or factory. */
export type TestApiOptions = Omit<Partial<ApiOptions>, "deployment" | "images" | "usageBackfill" | "queue" | "pipeline" | "planning"> & {
  /** null leaves deployments off. */
  deployment?: DeploymentOptions | null;
  images?(registry: Registry): ImageRollout;
  usageBackfill?(registry: Registry): UsageBackfillJob;
  queue?: boolean;
  pipeline?: boolean;
  /** Defaults to `pipeline`. */
  planning?: boolean;
  dotfiles?: typeof dotfiles;
  gitIdentity?: { name: string; email: string };
};

export async function testApi(t: import("node:test").TestContext, options: TestApiOptions = {}) {
  const { deployment, images: imagesOf, usageBackfill: backfillOf, queue: queued, pipeline: piped, planning: planned = piped, dotfiles: dots, gitIdentity, ...apiOptions } = options;
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  const images = imagesOf?.(registry);
  const backfill = backfillOf?.(registry);
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  let caller: TailnetNodeId | null = laptop;
  let requests = 0;
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
  const startThread = threadStarter({ registry, harness, mirror, dotfiles: dots ?? dotfiles, gitIdentity, wake });
  const queue = queued === true || piped === true ? threadQueue({ registry, startThread, gate: turnGate(() => false), send: (id, text, requestId) => harness.send(id, text, requestId, "followUp") }) : null;
  const items = piped === true ? pipeline({ registry, queue: queue! }) : null;
  const plans = planned === true ? planning({ registry, pipeline: items, replies: agentReader(registry, harness).replies }) : null;
  /** The options of an API on `port`, so a restart serves the same registry and services. */
  const optionsAt = (port: number): ApiOptions => ({
    registry, host: "127.0.0.1", port,
    // Every loopback caller is whoever the test says. Tests never ask tailscaled.
    whois: async () => {
      requests++;
      asked();
      await admitted;
      return caller;
    },
    // infra-testbench is allowed as a node in control.json's callers would be, so a test can show the API still tells it from a person.
    allowed: new Set([laptop, phone, "nFIREBAT" as TailnetNodeId, "nTESTBENCH" as TailnetNodeId]),
    joins: { configured: new Set(["nFIREBAT", "nBENCH"] as TailnetNodeId[]), whois: async () => caller === null ? null : { id: caller, host: hosts.get(caller) ?? "unnamed.tail.ts.net" }, joined: (n) => { joined.push(n); } },
    // The control plane runs on rj-firebat and deploys nothing unless a test says so.
    ...(deployment === null ? {} : { deployment: deployment ?? { self: "nFIREBAT" as TailnetNodeId, deployers: new Set(), keys: {} } }),
    ...(queue === null ? {} : { queue }),
    ...(items === null ? {} : { pipeline: items }),
    ...(plans === null ? {} : { planning: plans }),
    ...(images === undefined ? {} : { images }),
    ...(backfill === undefined ? {} : { usageBackfill: backfill }),
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
    ...apiOptions,
  });
  let api = await startApi(optionsAt(0));
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
    registry, images, queue, plans, call, raw, woken, joined, hosts, calls, commands, streams, reads, fake, startThread,
    get api() { return api; }, get port() { return api.port; }, get httpsPort() { return api.httpsPort; }, close: () => api.close(),
    /** How many requests the API has admitted. */
    requests: () => requests,
    callAs(id: TailnetNodeId | null) { caller = id; },
    nodeHealth(next: typeof health) { health = next; },
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
    /** Stops the control plane, which drops every connection, and returns a function that starts it again on its port. */
    async stop() {
      const { port } = api;
      await api.close();
      return async () => { api = await startApi(optionsAt(port)); };
    },
  };
}

export async function withThread(t: import("node:test").TestContext, options: { gitIdentity?: { name: string; email: string }; deployment?: DeploymentOptions; reviews?: ReviewLoop; project?: typeof project; dotfiles?: typeof dotfiles; streamStallMs?: number; attachTiming?: AttachTiming; closeWaitMs?: number } = {}) {
  const s = await testApi(t, options);
  assert.equal((await s.call("POST", "/v1/projects", options.project ?? project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Fix checkout" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  return { ...s, thread: started.body as Thread };
}

/** Puts a node online with this capacity and grants, holding the current image unless told otherwise. */
export function observeNode(s: Awaited<ReturnType<typeof testApi>>, name: string, memory: { total: number; committed: number }, over: Partial<NodeObservation> = {}) {
  const at = name as NodeName;
  s.registry.upsertNode({ name: at, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: `n${name.toUpperCase()}` as TailnetNodeId });
  const capacity = testCapacity({ committedCpus: 4, memoryGiB: memory.total, committedMemoryGiB: memory.committed, diskFreeGiB: 200, committedDiskGiB: 60 });
  s.registry.apply({ record: "node", node: at, state: "online", capacity });
  s.registry.ingested(testObservation(at, {
    observedAt: "2027-01-01T00:01:00Z", capacity, artifacts: [image.id], grants: { secrets: ["STRIPE_KEY", "NEXUS_CHATGPT_TOKEN"], gitSsh: true }, ...over,
  }), []);
}

export async function withImage(t: import("node:test").TestContext) {
  const s = await testApi(t);
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  return s;
}

/** Reports the node online with the thread's pylon running these services and listening on these ports. */
export function observeRunning(s: Awaited<ReturnType<typeof withThread>>, facts: { services?: ServiceFact[]; listening?: { port: number }[] | null }) {
  s.registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  const running = runningPylon(s.thread.pylonId, {
    liveHash: s.registry.pylon(s.thread.pylonId)!.liveHash, bootedFrom: { image: image.id, checkpoint: null },
    services: facts.services ?? [], listening: facts.listening === undefined ? [] : facts.listening,
  });
  s.registry.ingested(testObservation(node, { pylons: [running] }), []);
}

export const git = promisify(execFile);

/** A checkout on this machine whose first commit is refs/nexus/base, which the probe's pipes read in place of the pylon's. */
export async function localCheckout(t: import("node:test").TestContext, s: { probePipes(next: (argv: readonly string[]) => Promise<ByteStream>): void }) {
  const repo = await tempDir("nexus-api-checkout-", t);
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

export const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR pixels")]);

/**
 * Asks for a terminal as the CLI does, with no Origin unless `headers` gives one. Resolves with the open socket and
 * what it receives, or with the HTTP refusal.
 */
export function attachTo(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any } | ReturnType<typeof attached>> {
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

export function attached(ws: WebSocket) {
  const received: unknown[] = [];
  ws.on("message", (data, binary) => { received.push(binary ? Buffer.from(data as Buffer).toString() : JSON.parse(data.toString())); });
  return { ws, received, closed: once(ws, "close").then(([code]) => code as number) };
}

export const attachPathOf = (thread: string, query = "cols=100&rows=30") => `/v1/threads/${thread}/attach?${query}`;

export const deployCommit = "a".repeat(40);
export const deployToken = "test-root-token";
export const deployment: DeploymentOptions = {
  self: "nFIREBAT" as TailnetNodeId,
  deployers: new Set([laptop, "nFIREBAT" as TailnetNodeId]),
  keys: { nFIREBAT: tokenDigest(deployToken) },
  resolveMain: async () => deployCommit,
};
export const reporterHeaders = { authorization: `Bearer ${deployToken}` };

/**
 * A Claude worker thread whose launch opened the fixture's session, with its pylon running. The probe runs each pipe
 * here, against a folder in place of the pylon's ~/.claude/projects, where `transcript` is the session's file.
 */
export async function withClaude(t: import("node:test").TestContext) {
  const s = await withThread(t);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const thread = started.body as Thread;
  s.registry.setClaudeWorker(thread.id, "/poteto-mode fix it", "started", undefined, claudeSession);
  const projects = await tempDir("nexus-claude-projects-", t);
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

export const sent = (outcome: "sent" | "queued", resumed = false): CommandResult => ({ kind: "send-claude", outcome, herdrPane: "w1:p1", resumed });

export async function withQueue(t: import("node:test").TestContext) {
  const s = await testApi(t, { queue: true });
  assert.equal((await s.call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const first = await s.call("POST", "/v1/threads", { project: "acme", title: "First" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  return { ...s, first: first.body as Thread };
}
