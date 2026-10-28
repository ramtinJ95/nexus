// Drives the real API, dashboard and Claude transcript reader through two simulated minutes of a watched Claude turn,
// counts the work the transcript's read and render path does, and records what the page's client sees.
// Run from the root of a checkout: node docs/verification/transcript-render-once/measure.ts <out-dir>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { mock } from "node:test";

const out = process.argv[2]!;
let threadId = "";
const inspector = new Session();
inspector.connect();
await inspector.post("Profiler.enable");
await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

const counts = {
  /** Transcript entries the registry read and parsed for a conversation's view, by whose request. */
  entriesParsed: { stream: 0, poll: 0 },
  /** Entries a thread's usage-limit check reads, the newest 16 each time, which this path does not change. */
  usageLimitEntries: 0,
  /** Calls of dashboard.ts's convo(), each a render of the whole conversation, and blockView(), each one block's HTML. */
  convoRenders: { stream: 0, poll: 0 },
  blocksRendered: { stream: 0, poll: 0 },
  frames: 0,
  ageOnlyFrames: 0,
  /** Frames that only name the view the region shows, which the branch sends when a turn starts or ends. */
  namingFrames: 0,
  pings: 0,
  streamBytes: 0,
  polls: 0,
  pollBytes: 0,
  transcriptReads: 0,
};
let phase: "setup" | "stream" | "poll" = "setup";
const all = StatementSync.prototype.all;
StatementSync.prototype.all = function (this: StatementSync, ...args: never[]) {
  const rows = all.apply(this, args);
  if (phase === "setup" || !this.sourceSQL.startsWith("SELECT entry FROM claude_entries")) return rows;
  if (this.sourceSQL.endsWith("LIMIT 16")) counts.usageLimitEntries += rows.length;
  else counts.entriesParsed[phase] += rows.length;
  return rows;
} as typeof all;

/** Adds the calls of convo() and blockView() since the last take to `phase`, and starts counting afresh. */
async function takeRenders(into: "stream" | "poll" | null) {
  const { result } = await inspector.post("Profiler.takePreciseCoverage");
  if (into === null) return;
  for (const script of result) {
    if (!script.url.endsWith("/src/control/dashboard.ts")) continue;
    for (const f of script.functions) {
      if (f.functionName === "convo") counts.convoRenders[into] += f.ranges[0]!.count;
      if (f.functionName === "blockView") counts.blocksRendered[into] += f.ranges[0]!.count;
    }
  }
}

const start = Date.parse("2026-10-27T12:00:00Z");
mock.timers.enable({ apis: ["setInterval", "Date"], now: start });

const { startApi } = await import("../../../src/control/api.ts");
const { threadStarter } = await import("../../../src/control/threads.ts");
const { fakeHarness } = await import("../../../src/control/fake-harness.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { processStream } = await import("../../../src/process-stream.ts");
const { claudeProjects } = await import("../../../src/claude-transcript.ts");
type ThreadId = import("../../../src/control/registry.ts").ThreadId;
type Thread = import("../../../src/control/registry.ts").Thread;
type NodeName = import("../../../src/protocol.ts").NodeName;
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;
type PylonId = import("../../../src/protocol.ts").PylonId;

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const session = "11111111-2222-4333-8444-555555555501";
const dir = await mkdtemp(join(tmpdir(), "nexus-transcript-render-"));
const projects = join(dir, "projects");
await mkdir(join(projects, "-home-user-workspace-repo"), { recursive: true });
const transcript = join(projects, "-home-user-workspace-repo", `${session}.jsonl`);

const registry = openRegistry(join(dir, "registry.db"));
/** Holds the transcript reads that start while it is set. */
let held: PromiseWithResolvers<void> | null = null;
registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({
  registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" },
  mirror: { setupInputs: () => Promise.reject(new Error("no remote is read")) },
});
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  harness: fake.harness, startThread, wake: () => {}, previewPorts: { first: 10200, last: 10299 },
  probes: new Map([[node, {
    command: () => Promise.reject(new Error("no command is sent")),
    stream: (_: PylonId, argv: readonly string[]) => {
      counts.transcriptReads++;
      return (held?.promise ?? Promise.resolve()).then(() => processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {}));
    },
  }]]),
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: api.port, method, path, headers: { host: `127.0.0.1:${api.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

assert.equal((await call("POST", "/v1/projects", {
  id: "acme", repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
})).status, 201);
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
assert.equal((await call("POST", "/v1/images", image)).status, 201);
registry.setCurrentImage(image.id as import("../../../src/images.ts").ImageId);
const started = await call("POST", "/v1/threads", { project: "acme", title: "Long Claude turn", claude: "work through the steps" });
assert.equal(started.status, 201, started.text);
const thread = JSON.parse(started.text) as Thread;
const id = thread.id as ThreadId;
threadId = id;
registry.setClaudeWorker(id, "/poteto-mode work through the steps", "started", undefined, session);
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
registry.apply({ record: "node", node, state: "online", capacity });
registry.ingested({
  node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [],
  pylons: [{
    pylonId: thread.pylonId, phase: "running", liveHash: registry.pylon(thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }],
}, []);

// The fixture's opening: a prompt, then tool calls and their results. Each later step is one assistant reply.
const fixture = (await readFile(new URL("../../../src/fixtures/claude-transcript.jsonl", import.meta.url), "utf8")).split("\n").filter((l) => l !== "");
const replyRecord = JSON.parse(fixture[40]!);
let step = 0;
const steps = (n: number) => Array.from({ length: n }, () => {
  step++;
  const r = structuredClone(replyRecord);
  r.uuid = `00000000-0000-4000-8000-${String(step).padStart(12, "0")}`;
  r.message.id = `msg_step${step}`;
  r.message.content = [{ type: "text", text: `Step ${step}: ran \`npm test\` in **packages/${step}**.\n\n- ${step} files changed\n- the build passed\n\n\`\`\`sh\nnpm test -- --filter ${step}\n\`\`\`` }];
  return `${JSON.stringify(r)}\n`;
}).join("");
await writeFile(transcript, fixture.slice(0, 30).map((l) => `${l}\n`).join("") + steps(600));

let sequence = 0;
const report = (kind: "session.turn-started" | "session.turn-ended") =>
  registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function readsDone(at: number) {
  for (let i = 0; i < 2000 && (registry.claudeTranscript(id)?.readAt ?? 0) < at; i++) await settle();
  assert.ok((registry.claudeTranscript(id)?.readAt ?? 0) >= at, "the transcript was read");
  await settle();
}

/** The client of the page's stream, as client.js keeps it: the region it shows and the view it names. */
const client = { convo: null as string | null, shows: null as string | null };
const shownContents: string[] = [];
// The thread's ID is random and assets carry their hash, so neither may differ between the two runs. An age is the
// client's to tick, so it is compared by its instant.
const ageless = (html: string) => html.replaceAll(threadId, "th-ID").replace(/\?v=[\w-]+/g, "?v=")
  .replace(/<time datetime="([^"]+)" title="[^"]+"[^>]*>[^<]*<\/time>/g, '<time datetime="$1">');
const stream = await new Promise<IncomingMessage>((resolve) => {
  request({ host: "127.0.0.1", port: api.port, path: `/threads/${id}/stream`, headers: { host: `127.0.0.1:${api.port}`, accept: "text/event-stream" } }, resolve).end();
});
stream.setEncoding("utf8");
let buffered = "";
stream.on("data", (chunk: string) => {
  if (phase !== "setup") counts.streamBytes += Buffer.byteLength(chunk);
  buffered += chunk;
  const blocks = buffered.split("\n\n");
  buffered = blocks.pop()!;
  for (const block of blocks) {
    if (block.startsWith(": ping")) {
      if (phase !== "setup") counts.pings++;
      continue;
    }
    const frame = JSON.parse(block.slice("data: ".length));
    if (phase !== "setup") counts.frames++;
    if (frame.convo !== undefined) {
      if (phase !== "setup" && client.convo !== null && ageless(client.convo) === ageless(frame.convo)) counts.ageOnlyFrames++;
      client.convo = frame.convo;
      if (shownContents.at(-1) !== ageless(frame.convo)) shownContents.push(ageless(frame.convo));
    }
    if (phase !== "setup" && frame.convo === undefined && frame.grow === undefined) counts.namingFrames++;
    if (frame.shows !== undefined) client.shows = frame.shows;
  }
});

interface Poll { at: number; certifies: string | null; unseen: boolean; renderedConvo: boolean; page: string }
/** Each turn's reply watermark, and a text of the reply it stands for. */
const replies = new Map<string, string>();
const polls: Poll[] = [];
let lastPage = "";
/** A poll as client.js makes it while its stream is open, and the reply watermark the client takes from it, if any. */
async function poll() {
  await takeRenders("stream");
  phase = "poll";
  const page = await call("GET", `/threads/${id}?streaming=1`);
  assert.equal(page.status, 200);
  await takeRenders("poll");
  phase = "stream";
  counts.polls++;
  counts.pollBytes += Buffer.byteLength(page.text);
  const tag = /<div class="convo" id="convo" data-rendered-reply-at="(\d*)"(?: data-shows="([^"]+)")? data-live[^>]*>/.exec(page.text)!;
  const inside = page.text.slice(tag.index + tag[0].length).split('<section class="file-view"')[0]!.replace(/<\/div><\/div>\s*$/, "");
  const certified = tag[2] !== undefined ? tag[2] === client.shows : inside === client.convo;
  // The page but the conversation, which the stream supplies.
  const rest = ageless(page.text.slice(0, tag.index) + page.text.slice(tag.index + tag[0].length + inside.length));
  polls.push({ at: (Date.now() - start) / 1000, certifies: certified ? tag[1]! : null, unseen: certified && tag[1] !== "" && !client.convo!.includes(replies.get(tag[1]!)!), renderedConvo: inside.trim() !== "", page: createHash("sha256").update(rest).digest("hex").slice(0, 16) });
  lastPage = rest;
}

report("session.turn-started");
mock.timers.tick(1_000);
await readsDone(start + 1_000);
for (let i = 0; i < 200 && !client.convo?.includes("Step 600:"); i++) await settle();
assert.ok(client.convo?.includes("Step 600:"), "the stream showed the whole transcript");
await takeRenders(null);
phase = "stream";

const endTurn = (reply: string) => {
  report("session.turn-ended");
  replies.set(String(registry.thread(id)!.lastReplyAt), reply);
};
const seconds = 120;
for (let s = 2; s <= seconds; s++) {
  if (s % 10 === 0) await appendFile(transcript, steps(2));
  if (s === seconds - 1) {
    // A turn's end reaches the registry before the read that brings its reply, and a poll comes between them.
    held = Promise.withResolvers();
    await appendFile(transcript, `${fixture[40]}\n`);
    endTurn("The subagent reported 1 line");
  }
  if (s === seconds) endTurn(`Step ${step}:`);
  mock.timers.tick(1_000);
  if (s === seconds - 1) {
    await settle();
    await poll();
    held!.resolve();
    held = null;
    await readsDone(start + s * 1_000);
    report("session.turn-started");
  } else if (s % 2 === 1 || s === seconds) await readsDone(start + s * 1_000);
  else await settle();
  if (s % 5 === 0) await poll();
}
await takeRenders("stream");
phase = "setup";

const final = ageless(client.convo!);
stream.destroy();
await api.close();
registry.close();
mock.timers.reset();
await rm(dir, { recursive: true });

await writeFile(join(out, "counts.json"), `${JSON.stringify(counts, null, 2)}\n`);
await writeFile(join(out, "observed.json"), `${JSON.stringify({ shownContents: shownContents.length, polls, final }, null, 2)}\n`);
await writeFile(join(out, "shown.html"), shownContents.join("\n\n<!-- next -->\n\n"));
await writeFile(join(out, "page.html"), lastPage);
process.exit(0);
