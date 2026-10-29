// A local Nexus control plane for the dashboard's theme captures: the stack of docs/verification/dashboard-scrolling,
// unchanged but for its paths. The real registry, API and dashboard on 127.0.0.1:7470, seeded with what a busy
// deployment holds: 52 threads in four projects, a long harness conversation with tool calls, a Claude worker's long
// transcript, three questions waiting on one thread, a review under way and an approved one, a checkout with a diff
// across 40 files, a dozen pipeline items and a node's health. Stand-ins replace only what this pylon cannot host:
// whois answers the laptop, a deployer; the model is the test harness; the probe runs the real checkout helper
// against a fixture repository and reports made-up health. Nothing reaches a pylon or the live control plane.
//
// Port 7489 takes what the driver changes while it watches a page, each as one POST with a JSON body:
//  - /verify/append {thread, n}: n more replies join the harness conversation.
//  - /verify/stream {thread, words}: a reply streams one word every 40 ms, then is committed.
//  - /verify/turn {thread, running}: the thread's turn starts or ends, so the run bar shows or goes.
//  - /verify/ask {thread}: one more question waits on the thread.
//
//   EVIDENCE=<dir> node docs/verification/dashboard-themes/stack.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import type { Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { transcriptStart, type ClaudeEntry } from "../../../src/claude-transcript.ts";
import { processStream } from "../../../src/process-stream.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-themes-evidence-"));
mkdirSync(evidence, { recursive: true });
const log = (line: string) => appendFileSync(join(evidence, "stack.log"), `${new Date().toISOString()} ${line}\n`);
const scratch = mkdtempSync(join(tmpdir(), "nexus-themes-"));

const repo = join(scratch, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
const write = (path: string, text: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n";
mkdirSync(repo);
git("init", "-q", "-b", "main");
write("src/control/loop.ts", lines(1200, (i) => `export const step${i} = (state: number) => state + ${i};`));
for (let f = 0; f < 38; f++) write(`src/${["control", "probe", "cli", "harness"][f % 4]}/part-${f}.ts`, lines(30, (i) => `export const value${i} = ${f * i};`));
write("docs/notes.md", "# Notes\n");
git("add", "-A");
git("commit", "-q", "-m", "base");
git("update-ref", "refs/nexus/base", "HEAD");
write("src/control/loop.ts", lines(1200, (i) => i % 3 === 0 ? `export const step${i} = (state: number, by = ${i}) => state + by; // the planner calls this once per tick, and the applier never does, so the two halves stay apart` : `export const step${i} = (state: number) => state + ${i};`));
for (let f = 0; f < 38; f++) write(`src/${["control", "probe", "cli", "harness"][f % 4]}/part-${f}.ts`, lines(30, (i) => `export const value${i} = ${f * i + (i % 5 === 0 ? 1 : 0)};`));
write("docs/notes.md", "# Notes\n\nThe loop is split into a planner and an applier.\n");

const node = "verify-node" as NodeName;
const laptop = "nVERIFYLAPTOP" as TailnetNodeId;
let back = 0;
const registry = openRegistry(join(scratch, "registry.db"), () => Date.now() - back);
const startedAgo = <T>(ms: number, act: () => T): T => {
  back = ms;
  try { return act(); } finally { back = 0; }
};
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
registry.upsertNode({ name: "node-b" as NodeName, tailnetHost: "node-b.tail.ts.net", tailnetNodeId: "nNODEB" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({ registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const health = () => ({
  node, readAt: new Date().toISOString(), cpus: 16, load: { one: 2.41, five: 1.97, fifteen: 1.5 },
  memory: { totalGiB: 64, availableGiB: 41.2, swapTotalGiB: 8, swapFreeGiB: 7.5 }, disk: { path: "/var/lib/nexus", totalGiB: 1800, freeGiB: 1210.4 },
  temperatures: [{ sensor: "k10temp Tctl", celsius: 61.2 }, { sensor: "nvme Composite", celsius: 44.9 }],
  pylons: registry.pylonsOn(node).map((p, i) => ({ pylonId: p.pylonId, processes: 40 + i, cpuPercent: (i * 37) % 210, residentGiB: 0.4 + (i % 7) * 0.3 })),
});
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470,
  deployment: { self: "nNODE" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  harness: fake.harness, startThread, wake: () => {}, previewPorts: { first: 10200, last: 10299 },
  probes: new Map([[node, {
    command: async () => { throw new Error("the verify stack runs no guest commands"); },
    // The checkout helper reads its script from stdin and the checkout from its first argument, which is the fixture
    // here. The Claude worker's transcript is the seeded one, so its reads fail and the page shows the last.
    stream: async (_pylonId: unknown, argv: string[]) => {
      if (argv[0] !== "python3" || argv[1] !== "-") throw new Error("the verify stack reads only the checkout");
      return processStream(argv[0], [argv[1], repo, ...argv.slice(3)], (text) => process.stderr.write(text));
    },
    health: async () => health(),
  }]]),
} as unknown as Parameters<typeof startApi>[0]);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};

const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
for (const id of ["nexus", "spoon", "docs-site", "infra"]) {
  await call("POST", "/v1/projects", {
    id, repoUrl: `https://github.com/example/${id}.git`, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
}
registry.saveImage(image as never, null);
registry.setCurrentImage(image.id as never);
for (const [id, autoStart] of [["nexus", true], ["spoon", false]] as const) registry.editProject(id as never, (p) => ({ ...p, pipeline: { autoStart } }));

const start = (project: string, title: string, claude?: string): Promise<Thread> => call("POST", "/v1/threads", { project, title, ...(claude === undefined ? {} : { claude }) });
const assistant = (content: AssistantMessage["content"]): Message => ({
  role: "assistant", content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", api: "x", provider: "x", model: "gpt-6-astra", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const tool = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, toolName: string, text: string): Message => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 });

const long = await start("nexus", "Split the reconcile loop into a planner and an applier");
const live = await start("nexus", "Stream the conversation while the turn runs");
const claude = await start("nexus", "Fix the flaky stream test", "Find why src/control/stream.check.ts fails one run in ten and fix it");
const asks = await start("spoon", "Rotate the merge token and rebuild the image");
const reviewed = await start("nexus", "Cache the thread list");
const reviewer = await start("nexus", "Review of #42: Cache the thread list");
const landable = await start("nexus", "Name the caller in every refusal");
const landReviewer = await start("nexus", "Review of #45: Name the caller in every refusal");
const filler: Thread[] = [];
const verbs = ["Fix", "Add", "Document", "Refactor", "Remove", "Rename", "Speed up", "Test"];
const nouns = ["the probe's health route", "the archive flow", "preview gateway retries", "the CLI's --json output", "template builds", "the event stream", "node placement", "the usage page", "pylon wake-ups on visit", "the start dialog's node picker", "the attention toast", "secret grants"];
for (let i = 0; i < 44; i++) {
  const project = ["nexus", "spoon", "docs-site", "infra"][i % 4]!;
  const title = i === 7 ? "Make the sidebar's very long thread titles end with an ellipsis instead of pushing the time out of the row" : `${verbs[i % verbs.length]} ${nouns[i % nouns.length]}${i >= nouns.length ? ` (${Math.floor(i / nouns.length) + 1})` : ""}`;
  filler.push(await start(project, title));
}
for (const t of filler.slice(30, 36)) await call("POST", `/v1/threads/${t.id}/archive`);
for (const t of filler.slice(36, 40)) await call("DELETE", `/v1/threads/${t.id}`);
for (const [i, t] of filler.slice(0, 30).entries()) registry.recordReply(t.id, Date.now() - (i + 1) * 3_600_000);

const code = lines(14, (i) => `  const planned${i} = plan(state, { tick: ${i}, budget: remaining - ${i} }); // a deliberately long line that a narrow screen must scroll sideways rather than overflow`);
const transcript = fake.transcript(long.id).messages;
for (let turn = 0; turn < 40; turn++) {
  transcript.push(
    { role: "user", content: turn === 0 ? "Split the reconcile loop's tick into a planner and an applier, and keep the tests green." : `Round ${turn}: carry on, and tell me what changed in src/control/loop.ts this time.`, timestamp: Date.now() - (40 - turn) * 600_000 },
    assistant([{ type: "text", text: `Round ${turn}. I read the loop again and changed the planner's step ${turn}.\n\n- The planner now returns a list of actions.\n- The applier runs each action once, and records it.\n\n\`\`\`ts\n${code}\`\`\`` }, tool(`b${turn}`, "bash", { command: `node --test src/control/loop.test.ts --test-name-pattern="round ${turn}"` }), tool(`r${turn}`, "read", { path: "src/control/loop.ts" })]),
    result(`b${turn}`, "bash", lines(60, (i) => `ok ${i + 1} - the loop round ${turn} case ${i}`)), result(`r${turn}`, "read", "…"),
    assistant([{ type: "text", text: `The tests pass for round ${turn}. https://github.com/example/nexus/blob/main/src/control/a-very-long-path/that/does/not/break/anywhere/loop-planner-applier-round-${turn}.ts` }]),
  );
}
fake.commit(long.id);
registry.recordReply(long.id, Date.now() - 60_000);

const liveMessages = fake.transcript(live.id).messages;
for (let turn = 0; turn < 12; turn++) {
  liveMessages.push(
    { role: "user", content: `Message ${turn}: stream the reply.`, timestamp: Date.now() - (12 - turn) * 60_000 },
    assistant([{ type: "text", text: `Reply ${turn}, in a few paragraphs.\n\n${"The conversation grows at its end while the turn runs. ".repeat(6)}\n\n${"A reader who scrolled up to read an earlier reply keeps their place. ".repeat(5)}` }]),
  );
}
fake.commit(live.id);

const entries: ClaudeEntry[] = [{ kind: "prompt", at: Date.now() - 3_600_000, text: "/poteto-mode Find why src/control/stream.check.ts fails one run in ten and fix it", from: "person" }];
for (let i = 0; i < 70; i++) {
  entries.push(
    { kind: "reply", at: entries.length, text: `Step ${i}: ${i % 2 === 0 ? "reproducing it again with a tighter loop." : "reading the check's timer against the stream's first frame."}` },
    { kind: "tool", at: entries.length + 1, id: `c${i}`, name: i % 3 === 0 ? "Bash" : i % 3 === 1 ? "Read" : "Edit", input: i % 3 === 0 ? { command: "for i in $(seq 20); do node src/control/stream.check.ts || echo FAIL; done" } : i % 3 === 1 ? { file_path: "/repo/src/control/stream.check.ts" } : { file_path: "/repo/src/control/stream.check.ts", old_string: "setTimeout(done, 50)", new_string: "await frame" } },
    { kind: "result", at: entries.length + 2, toolUseId: `c${i}`, output: i % 3 === 0 ? lines(20, (j) => j % 7 === 0 ? "FAIL" : "ok") : "ok", isError: false },
  );
}
registry.setClaudeWorker(claude.id, "/poteto-mode Find why src/control/stream.check.ts fails one run in ten and fix it", "started", undefined, "s1");
registry.appendClaudeRead(claude.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now() });

let questions = 0;
const ask = (thread: ThreadId) => {
  questions += 1;
  registry.askQuestion({
    id: `qn-verify-${questions}`, thread, reserved: null, answerer: "person", askedAt: Date.now() - questions * 30_000,
    text: `Question ${questions}: the builder's pull request changes images/pylon/Dockerfile and rotates the merge token on rj-firebat. ${"It needs a person to say which way to go before it can carry on. ".repeat(2)}Which should it do?`,
    options: ["Rebuild and roll out", "Leave the image as it is", "Rotate the token only"],
  });
};
for (let i = 0; i < 3; i++) ask(asks.id);

const notCheckedLive = ["the merge itself, which needs GitHub"];
const round = (head: string): Review["rounds"][number] => ({ head, verdict: { token: "t", verdict: "request-changes", findings: [{ id: "N1", priority: "P2", where: "src/control/api.ts:120", summary: "The cache is never invalidated when a thread is archived" }, { id: "N2", priority: "P3", where: null, summary: "Name the constant" }], reserved: [], notCheckedLive }, check: null, answers: null } as never);
const review = (builder: Thread, reviewerThread: Thread, number: number, phase: Review["phase"], rounds: number): Review => ({
  id: `rv-${number}0000000`.slice(0, 11), builder: builder.id, reviewer: reviewerThread.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000,
  pr: { repo: "example/nexus", number, url: `https://github.com/example/nexus/pull/${number}`, title: builder.title, branch: `feature-${number}` },
  models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: null, auto: false, merged: null, waiver: null,
  rounds: Array.from({ length: rounds }, (_, i) => round(String(i + 1).repeat(40))), phase,
} as Review);
registry.saveReview(review(reviewed, reviewer, 42, { kind: "reviewing" }, 2));
registry.saveReview(review(landable, landReviewer, 45, { kind: "approved" }, 3));

const item = (n: number, project: string, title: string, extra: Record<string, unknown> = {}) => registry.saveItem({
  id: `it-${String(n).padStart(12, "0")}`, project, title, request: { project, title }, message: `Build ${title}.`, after: [], addedBy: laptop, addedAt: Date.now() - n * 60_000,
  approved: null, cancelled: null, lastError: null, ...extra,
} as never);
for (let n = 1; n <= 12; n++) item(n, n % 3 === 0 ? "spoon" : "nexus", n === 4 ? "Wake-ups from the event stream, so a paused pylon's agent hears about a merged predecessor without a person sending it a message" : `Pipeline item ${n}: ${nouns[n % nouns.length]}`, n > 1 && n % 2 === 0 ? { after: [`it-${String(n - 1).padStart(12, "0")}`] } : {});

startedAgo(95_000, () => registry.recordActivity(claude.id, { agent: Date.now() - 95_000, agentTurnRunning: true }));
let sequence = 0;
registry.reportSession(node, { sequence: ++sequence, pylon: claude.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "s1" } });

const running = [long, live, claude, asks, reviewed, reviewer, landable, landReviewer, ...filler.slice(0, 30)];
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = running.map((t): PylonObservation => ({
    pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons, previewRoutes: [] } as never, []);
};
observe();
setInterval(observe, 1000);

let appended = 0;
const control: Record<string, (body: { thread: ThreadId; n?: number; words?: number; running?: boolean }) => Promise<void> | void> = {
  append({ thread, n = 1 }) {
    for (let i = 0; i < n; i++) fake.transcript(thread).messages.push(assistant([{ type: "text", text: `Appended reply ${++appended}.\n\n${"It adds a few lines at the conversation's end. ".repeat(4)}` }]));
    fake.commit(thread);
    registry.recordReply(thread, Date.now());
  },
  async stream({ thread, words = 60 }) {
    const t = fake.transcript(thread);
    let text = "";
    for (let i = 0; i < words; i++) {
      text += `${i % 12 === 11 ? "\n\n" : ""}word${i} `;
      t.docs["pi.live"] = { run: { taskId: 1, inputs: [1] }, generation: { message: assistant([{ type: "text", text }]) } } as never;
      fake.commit(thread);
      await new Promise((r) => setTimeout(r, 40));
    }
    t.docs["pi.live"] = {} as never;
    t.messages.push(assistant([{ type: "text", text }]));
    fake.commit(thread);
  },
  turn({ thread, running: on = true }) { registry.recordActivity(thread, { agent: Date.now(), agentTurnRunning: on }); },
  ask({ thread }) { ask(thread); },
};
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    const act = control[req.url?.replace(/^\/verify\//, "") ?? ""];
    if (req.method !== "POST" || act === undefined) return void res.writeHead(404).end();
    log(`${req.url} ${body}`);
    await act(JSON.parse(body));
    res.writeHead(204).end();
  });
}).listen(7489, "127.0.0.1");

const ids = { long: long.id, live: live.id, claude: claude.id, asks: asks.id, reviewed: reviewed.id, landable: landable.id, archived: filler[30]!.id, deleted: filler[36]!.id, node };
log(`seeded ${registry.threads().length} threads`);
console.log(JSON.stringify(ids));
