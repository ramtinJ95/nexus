// A local Nexus control plane for the dashboard polish captures: the real registry, API and dashboard on
// 127.0.0.1:7470, seeded with threads in each attention state, a harness conversation and a Claude worker transcript
// with runs of tool calls. The model harness is the test fake and the node's observation is written here, so nothing
// reaches a pylon or the live control plane. The registry's clock is set back while a turn starts, so the captures
// show turns that have run for a while.
//
//   node docs/verification/dashboard-polish/stack.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { transcriptStart, type ClaudeEntry } from "../../../src/claude-transcript.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
let back = 0;
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-polish-")), "registry.db"), () => Date.now() - back);
const startedAgo = <T>(ms: number, act: () => T): T => {
  back = ms;
  try { return act(); } finally { back = 0; }
};
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  harness: fake.harness, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
for (const id of ["nexus", "spoon"]) {
  await call("POST", "/v1/projects", {
    id, repoUrl: `git@example.com:${id}.git`, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
}
await call("POST", "/v1/images", image);
await call("PUT", "/v1/images/current", { image: image.id });

const start = (project: string, title: string, claude?: string): Promise<Thread> => call("POST", "/v1/threads", { project, title, ...(claude === undefined ? {} : { claude }) });
const assistant = (content: AssistantMessage["content"]): Message => ({
  role: "assistant", content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", api: "x", provider: "x", model: "claude-opus-5-5", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const tool = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, toolName: string, text: string): Message => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 });

const loop = await start("nexus", "Refactor the reconcile loop");
const flaky = await start("nexus", "Fix the flaky stream test", "Find why src/control/stream.check.ts fails one run in ten and fix it");
const docs = await start("nexus", "Write the CLI usage docs");
const failed = await start("spoon", "Upgrade to Node 26");
const asks = await start("spoon", "Rename the fork button", "Rename the fork button to Copy");
const quiet = await start("spoon", "Spike: preview over HTTPS");
const old = await start("spoon", "Old experiment");

fake.transcript(loop.id).messages.push(
  { role: "user", content: "Split the reconcile loop's tick into a planner and an applier, and keep the tests green.", timestamp: Date.now() - 63_000 },
  assistant([{ type: "text", text: "I'll look at the loop and its tests first." }, tool("b1", "bash", { command: "rg -n 'function tick' src/control" }), tool("b2", "bash", { command: "wc -l src/control/loop.ts" })]),
  result("b1", "bash", "src/control/loop.ts:88:export async function tick("), result("b2", "bash", "280 src/control/loop.ts"),
  assistant([tool("r1", "read", { path: "src/control/loop.ts" }), tool("e1", "edit", { path: "src/control/loop.ts", edits: [{ oldText: "export async function tick(", newText: "export async function plan(" }] }),
    tool("w1", "write", { path: "src/control/apply.ts", content: "export async function apply() {}\n" }), tool("e2", "edit", { path: "src/control/loop.ts", edits: [{ oldText: "plan(", newText: "planTick(" }] }),
    tool("b3", "bash", { command: "npm run typecheck" })]),
  result("r1", "read", "…"), result("e1", "edit", "ok"), result("w1", "write", "ok"), result("e2", "edit", "ok"), result("b3", "bash", "tsc --noEmit"),
  assistant([{ type: "text", text: "The tick is split. Running the loop's tests now." }, tool("b4", "bash", { command: "node --test src/control/loop.test.ts" })]),
);
fake.transcript(loop.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] }, tools: [{ callId: "b4", status: "running", output: "▶ the loop ticks\n" }] };
fake.commit(loop.id);
startedAgo(63_000, () => registry.recordActivity(loop.id, { agent: Date.now() - 63_000, agentTurnRunning: true }));

const entries: ClaudeEntry[] = [
  { kind: "prompt", at: Date.now() - 95_000, text: "/poteto-mode Find why src/control/stream.check.ts fails one run in ten and fix it", from: "person" },
  { kind: "reply", at: 1, text: "Reproducing it first." },
  { kind: "tool", at: 2, id: "c1", name: "Bash", input: { command: "for i in $(seq 20); do node src/control/stream.check.ts || echo FAIL; done" } },
  { kind: "result", at: 3, toolUseId: "c1", output: "FAIL\nFAIL", isError: false },
  { kind: "tool", at: 4, id: "c2", name: "Read", input: { file_path: "/repo/src/control/stream.check.ts" } },
  { kind: "result", at: 5, toolUseId: "c2", output: "…", isError: false },
  { kind: "tool", at: 6, id: "c3", name: "Grep", input: { pattern: "setTimeout", path: "src/control" } },
  { kind: "result", at: 7, toolUseId: "c3", output: "src/control/stream.check.ts:41", isError: false },
  { kind: "tool", at: 8, id: "c4", name: "Edit", input: { file_path: "/repo/src/control/stream.check.ts", old_string: "setTimeout(done, 50)", new_string: "await frame" } },
  { kind: "result", at: 9, toolUseId: "c4", output: "ok", isError: false },
  { kind: "tool", at: 10, id: "c5", name: "MultiEdit", input: { file_path: "/repo/src/control/stream.check.ts", edits: [{ old_string: "let done", new_string: "let frame" }] } },
  { kind: "result", at: 11, toolUseId: "c5", output: "ok", isError: false },
  { kind: "tool", at: 12, id: "c6", name: "Write", input: { file_path: "/repo/src/control/stream.test.ts", content: "test('frames arrive in order', () => {});\n" } },
  { kind: "result", at: 13, toolUseId: "c6", output: "ok", isError: false },
  { kind: "tool", at: 14, id: "c7", name: "Bash", input: { command: "node --test src/control/stream.test.ts" } },
  { kind: "result", at: 15, toolUseId: "c7", output: "ok 1", isError: false },
  { kind: "tool", at: 16, id: "c8", name: "TodoWrite", input: { todos: [] } },
  { kind: "result", at: 17, toolUseId: "c8", output: "ok", isError: false },
  { kind: "tool", at: 18, id: "c9", name: "WebFetch", input: { url: "https://nodejs.org/api/test.html" } },
  { kind: "result", at: 19, toolUseId: "c9", output: "…", isError: false },
  { kind: "reply", at: 20, text: "The check raced a 50 ms timer against the stream's first frame. Running it twenty times again." },
  { kind: "tool", at: 21, id: "c10", name: "Bash", input: { command: "for i in $(seq 20); do node src/control/stream.check.ts || echo FAIL; done" } },
];
registry.setClaudeWorker(flaky.id, "/poteto-mode Find why src/control/stream.check.ts fails one run in ten and fix it", "started", undefined, "s1");
registry.appendClaudeRead(flaky.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now() });
let sequence = 0;
const report = (thread: Thread, kind: "session.turn-started" | "session.waiting", session: string) =>
  registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session } });
startedAgo(95_000, () => report(flaky, "session.turn-started", "s1"));

registry.setClaudeWorker(asks.id, "/poteto-mode Rename the fork button to Copy", "started", undefined, "s2");
report(asks, "session.waiting", "s2");
registry.recordReply(docs.id, Date.now() - 120_000);
registry.recordReply(quiet.id, Date.now() - 600_000);
registry.markSeen(quiet.id, false);
registry.savePylon({ ...registry.pylon(failed.pylonId)!, failed: "setup failed: npm ci exited with code 1" });
await call("POST", `/v1/threads/${old.id}/archive`);

const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } });
  const pylons = [loop, flaky, docs, asks, quiet].map((t): PylonObservation => ({
    pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons, previewRoutes: [] }, []);
};
observe();
setInterval(observe, 1000);

const ids: Record<string, ThreadId> = { loop: loop.id, flaky: flaky.id, docs: docs.id, failed: failed.id, asks: asks.id, quiet: quiet.id, old: old.id };
console.log(JSON.stringify(ids));
