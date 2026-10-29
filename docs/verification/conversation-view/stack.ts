// A local Nexus control plane for the conversation view captures: the real registry, API and dashboard on
// 127.0.0.1:7470, seeded with two Claude worker threads and two harness threads. Each Claude worker's transcript is a
// recorded Claude Code session, read by the checkout's own transcript parser. Each harness conversation is a recorded
// session too, its calls renamed to pi's tools and its results timed as pi-durable times them, and one of them has a
// command still running. The model harness is the test fake and the node's observation is written here, so nothing
// reaches a pylon or the live control plane.
//
//   node docs/verification/conversation-view/stack.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import { parseRecord, transcriptStart, type ClaudeEntry } from "../../../src/claude-transcript.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const here = import.meta.dirname;
const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-convo-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const startThread = threadStarter({
  registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  mirror: { setupInputs: () => Promise.reject(new Error("the capture reads no remote")) },
});
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  deployment: { self: "nNODE" as TailnetNodeId, deployers: new Set(), keys: {} },
  harness: fake.harness, startThread, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});
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
await call("POST", "/v1/projects", {
  id: "nexus", repoUrl: "git@example.com:nexus.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
await call("POST", "/v1/images", image);
registry.setCurrentImage(image.id as ImageId);

const transcript = (file: string): ClaudeEntry[] => readFileSync(file, "utf8").split("\n").filter((line) => line !== "").flatMap(parseRecord);
const start = (title: string, claude?: string): Promise<Thread> => call("POST", "/v1/threads", { project: "nexus", title, ...(claude === undefined ? {} : { claude }) });

async function claudeThread(title: string, file: string, session: string) {
  const entries = transcript(file);
  const prompt = entries.find((e) => e.kind === "prompt")!.text;
  const thread = await start(title, prompt);
  registry.setClaudeWorker(thread.id, prompt, "started", undefined, session);
  registry.appendClaudeRead(thread.id, { session, from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now() });
  return thread;
}

/** A Claude Code call as pi's coding tools would have made it. */
function piCall(name: string, input: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
    switch (name) {
    case "Bash": return { name: "bash", arguments: { command: input.command } };
    case "Read": return { name: "read", arguments: { path: input.file_path } };
    case "Write": return { name: "write", arguments: { path: input.file_path, content: input.content } };
    case "Edit": return { name: "edit", arguments: { path: input.file_path, edits: [{ oldText: input.old_string, newText: input.new_string }] } };
    case "Grep": return { name: "grep", arguments: { pattern: input.pattern, ...(input.path === undefined ? {} : { path: input.path }) } };
    case "Glob": return { name: "find", arguments: { pattern: input.pattern } };
    default: return { name: name.toLowerCase(), arguments: input };
  }
}

const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
  role: "assistant", content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", api: "x", provider: "openai", model: "gpt-6-astra", timestamp,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

/** A recorded session as a harness conversation: each reply and the calls after it one answer, each result timed. */
function harnessMessages(entries: readonly ClaudeEntry[]): Message[] {
  const messages: Message[] = [];
  const started = new Map<string, { at: number; name: string }>();
  let answer: AssistantMessage | null = null;
  for (const entry of entries) {
    if (entry.kind === "prompt") {
      answer = null;
      messages.push({ role: "user", content: entry.text, timestamp: entry.at });
    } else if (entry.kind === "reply" || entry.kind === "tool") {
      if (answer === null || (entry.kind === "reply" && answer.content.length > 0)) messages.push(answer = assistant([], entry.at));
      if (entry.kind === "reply") answer.content.push({ type: "text", text: entry.text });
      else {
        const { name, arguments: args } = piCall(entry.name, entry.input);
        answer.content.push({ type: "toolCall", id: entry.id, name, arguments: args as ToolCall["arguments"] });
        started.set(entry.id, { at: entry.at, name });
      }
      answer.stopReason = answer.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
    } else if (entry.kind === "result") {
      const tool = started.get(entry.toolUseId);
      if (tool === undefined) continue;
      answer = null;
      messages.push({ role: "toolResult", toolCallId: entry.toolUseId, toolName: tool.name, content: [{ type: "text", text: entry.output }], isError: entry.isError, timestamp: entry.at, durationMs: entry.at - tool.at } as Message);
    }
  }
  return messages;
}

const worker = await claudeThread("agoText says never for 0", join(here, "fixtures/claude-worker.jsonl"), "76779e06-7bb3-45d9-86fe-9bb6769a3557");
const fixture = await claudeThread("Claude fixture: steps, a subagent, steers", join(here, "../../../src/fixtures/claude-transcript.jsonl"), "fixture");

const source = transcript(join(here, "fixtures/harness-source.jsonl"));
const folds = await start("How a fold of tool calls reads");
fake.transcript(folds.id).messages.push(...harnessMessages(source));
fake.commit(folds.id);

const running = await start("Run the dashboard client tests");
const testRun = source.find((e): e is Extract<ClaudeEntry, { kind: "result" }> => e.kind === "result" && e.output.includes("✖"))!;
fake.transcript(running.id).messages.push(
  { role: "user", content: "Run the fold tests with phrasesShown at 2 and tell me what breaks.", timestamp: Date.now() - 64_000 },
  assistant([{ type: "text", text: "Setting phrasesShown to 2 and running the fold tests." }, { type: "toolCall", id: "r1", name: "edit", arguments: { path: "src/control/dashboard.ts", edits: [{ oldText: "const phrasesShown = 3;", newText: "const phrasesShown = 2;" }] } }], Date.now() - 60_000),
  { role: "toolResult", toolCallId: "r1", toolName: "edit", content: [{ type: "text", text: "Successfully replaced 1 block in src/control/dashboard.ts." }], isError: false, timestamp: Date.now() - 59_000, durationMs: 12 } as Message,
  assistant([{ type: "toolCall", id: "r2", name: "bash", arguments: { command: "node --test --test-name-pattern=fold src/control/dashboard.test.ts" } }], Date.now() - 58_000),
);
fake.transcript(running.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] }, tools: [{ callId: "r2", name: "bash", status: "running", output: testRun.output.split("\n").slice(0, 14).join("\n") }] };
fake.commit(running.id);
registry.recordActivity(running.id, { agent: Date.now() - 64_000, agentTurnRunning: true });

const observe = () => {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = [worker, fixture, folds, running].map((t): PylonObservation => ({
    pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], pylons, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] } as never, []);
};
observe();
setInterval(observe, 1000);

console.log(JSON.stringify({ worker: worker.id, fixture: fixture.id, folds: folds.id, running: running.id }));
