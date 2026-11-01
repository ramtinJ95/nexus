/** What the demo's threads say: harness conversations as pi-ai messages, and Claude worker transcripts as entries. */
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import type { ClaudeEntry } from "../../claude-transcript.ts";

const minute = 60_000;

/** Builds a conversation forward in time from `start`, a few seconds to minutes between steps. */
export function harnessTalk(start: number, model = "gpt-6-astra") {
  let at = start;
  const messages: Message[] = [];
  const step = (ms: number) => (at += ms);
  const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage => ({
    role: "assistant", content, stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), api: "openai-responses", provider: "openai", model, timestamp: step(40_000),
    usage: { input: 18_400, output: 1_250, cacheRead: 52_000, cacheWrite: 0, totalTokens: 71_650, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  let calls = 0;
  const t = {
    messages,
    get at() { return at; },
    person(text: string, gap = 2 * minute) { messages.push({ role: "user", content: text, timestamp: step(gap) }); return t; },
    say(text: string) { messages.push(assistant([{ type: "text", text }])); return t; },
    think(thinking: string, text: string) { messages.push(assistant([{ type: "thinking", thinking }, { type: "text", text }])); return t; },
    /** One tool call and its result. */
    tool(name: string, args: ToolCall["arguments"], output: string, isError = false) {
      const id = `call_${++calls}`;
      messages.push(assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse"));
      messages.push({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: output }], isError, timestamp: step(6_000) });
      return t;
    },
    bash(command: string, output: string, isError = false) { return t.tool("bash", { command }, output, isError); },
    read(path: string, output: string) { return t.tool("read", { path }, output); },
    edit(path: string, oldText: string, newText: string) { return t.tool("edit", { path, oldText, newText }, `Successfully replaced text in ${path}.`); },
    fail(errorMessage: string) { messages.push(assistant([], "error", errorMessage)); return t; },
  };
  return t;
}

/** Builds a Claude worker's transcript forward in time from `start`. */
export function claudeTalk(start: number) {
  let at = start;
  const entries: ClaudeEntry[] = [];
  let calls = 0;
  const step = (ms: number) => (at += ms);
  const t = {
    entries,
    get at() { return at; },
    prompt(text: string, from: "person" | "nexus" = "person") { entries.push({ kind: "prompt", at: step(2 * minute), text, from } as ClaudeEntry); return t; },
    reply(text: string) { entries.push({ kind: "reply", at: step(30_000), text }); return t; },
    tool(name: string, input: Record<string, unknown>, output: string, isError = false) {
      const id = `toolu_${String(++calls).padStart(4, "0")}`;
      entries.push({ kind: "tool", at: step(20_000), id, name, input });
      entries.push({ kind: "result", at: step(5_000), toolUseId: id, output, isError });
      return t;
    },
    /** A call with no result yet, as one still running or an AskUserQuestion that waits. */
    open(name: string, input: Record<string, unknown>, id = `toolu_${String(++calls).padStart(4, "0")}`) {
      entries.push({ kind: "tool", at: step(20_000), id, name, input });
      return id;
    },
    turn(durationMs: number) { entries.push({ kind: "turn", at: step(1_000), durationMs }); return t; },
    notice(tone: "info" | "error", text: string, resetsAt?: number) {
      entries.push({ kind: "notice", at: step(1_000), tone, text, ...(resetsAt === undefined ? {} : { usageLimit: { resetsAt } }) });
      return t;
    },
    pr(number: number, repository: string) { entries.push({ kind: "pull-request", at: step(1_000), number, url: `https://github.com/${repository}/pull/${number}`, repository }); return t; },
    task(summary: string, result: string) { entries.push({ kind: "task", at: step(60_000), toolUseId: null, status: "completed", summary, result }); return t; },
  };
  return t;
}

export const diffSnippet = `\`\`\`diff
--- a/src/control/node-metrics.ts
+++ b/src/control/node-metrics.ts
@@ -81,7 +81,9 @@ const minute = 60_000;
 const hour = 60 * minute;
 const day = 24 * hour;
-const tiers = [{ name: "raw", bucketMs: 0, keepMs: 6 * hour }];
+const tiers = [
+  { name: "raw", bucketMs: 0, keepMs: 6 * hour },
+  { name: "5m", bucketMs: 5 * minute, keepMs: 31 * day },
+];
\`\`\``;

export const typescriptSnippet = `\`\`\`ts
export function backoff(attempt: number, base = 500, cap = 30_000): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}
\`\`\``;

export const testOutput = `> nexus@0.0.0 test
> node --test 'src/**/*.test.ts'

✔ probe client reconnects after a reset (412ms)
✔ probe client gives up after the deadline (1.2s)
✔ backoff stays under its cap (3ms)
ℹ tests 1342
ℹ suites 0
ℹ pass 1342
ℹ fail 0
ℹ duration_ms 84213`;

export const failingTests = `✖ cart totals round half-even on discounted lines (6ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  19.99 !== 20

      at TestContext.<anonymous> (src/cart/totals.test.ts:88:10)
ℹ tests 311
ℹ pass 310
ℹ fail 1`;

/** Two dozen rounds of a thread that has been at it for a day, to show a long conversation. */
export function longConversation(start: number) {
  const t = harnessTalk(start)
    .person("Node pages should graph each node's health: load, memory, disk and temperatures, with 31 days of history kept on the control plane. Start with the store, then the graphs.")
    .think("The probe already serves a health snapshot. I need sampling on the control plane, a tiered store, and a page that draws it.", "I'll read how health is fetched today, then propose a store before writing any code.")
    .bash("rg -n \"health\\(\\)\" src/control | head -20", "src/control/api.ts:171:  async function nodeHealth(caller, name) {\nsrc/control/api/node-routes.ts:51:    [\"GET\", /^\\/v1\\/nodes\\/([^/]+)\\/health$/ ...\nsrc/control/node-metrics.ts:196:export function recordingHealth(probe, record, log) {")
    .read("src/protocol/client.ts", "export interface NodeHealth {\n  node: NodeName;\n  readAt: string;\n  cpus: number;\n  load: { one: number; five: number; fifteen: number } | null;\n  memory: { totalGiB: number; availableGiB: number; swapTotalGiB: number; swapFreeGiB: number } | null;\n  ...")
    .say(`Here's the plan.

## Store

| Tier | Bucket | Kept |
| --- | --- | --- |
| raw | each read | 6 hours |
| 5m | 5 minutes | 31 days |

Each sample is a flat map of **series keys** to numbers, so a new sensor needs no migration.

## Graphs

- One uPlot chart per group: load, memory, disk, temperatures
- Pylon CPU as a stacked area, labelled by thread
- A range picker: 6h, 24h, 7d, 31d

Shall I go ahead with the store first?`)
    .person("Yes. Keep the store boring: one table, JSON values.")
    .edit("src/control/node-metrics-store.ts", "export function nodeMetricsStore(db: Db) {", "export function nodeMetricsStore(db: Db) {\n  const insert = db.sql(\"INSERT INTO node_samples (node, tier, at, values) VALUES (?, ?, ?, ?)\");")
    .bash("npm run typecheck", "> tsc --noEmit\n")
    .say(`The store is in. The bucket math, for the record:\n\n${diffSnippet}\n\nNext I'll write the sampling pass.`);
  for (let i = 1; i <= 9; i++) {
    t.person(i % 3 === 0 ? `Round ${i}: the ${["load", "memory", "disk"][i % 3]} graph jumps when a pylon pauses. Can you smooth that?` : `Looks right. What about gaps when a node is offline for ${i * 5} minutes?`, 20 * minute)
      .bash(`node --test src/control/node-metrics.test.ts --test-name-pattern "gap ${i}"`, `✔ a gap of ${i * 5} minutes draws as a break, not a line (${3 + i}ms)\nℹ pass 1\nℹ fail 0`)
      .say(i % 2 === 0
        ? `Done. A gap longer than two buckets now draws as a break in the line, so an offline node doesn't look idle.\n\n> The graph should never invent a reading the node didn't give.`
        : `Fixed in \`graph-data.ts\`. I bucket by the tier's width and leave \`null\` where no sample landed, which uPlot draws as a gap:\n\n\`\`\`ts\nconst points = buckets.map((b) => b.samples.length === 0 ? null : mean(b.samples));\n\`\`\``);
  }
  t.person("Ship it behind the existing node page. Then open the PR.", 30 * minute)
    .bash("npm test 2>&1 | tail -6", testOutput)
    .bash("git push -u origin feat/node-graphs && gh pr create --fill", "https://github.com/ramtinJ95/nexus/pull/402")
    .say(`Opened **#402**, *graph each node's health on its page*.

1. \`node-metrics-store.ts\` keeps raw samples 6 hours and 5-minute buckets 31 days
2. \`health-sampling.ts\` reads every node each minute
3. \`node-graphs.js\` draws the charts with uPlot, lazily loaded

Tests pass (1342). The review loop has it now.`)
    .person("Now add a temperature alert at 85°C, same page.", 40 * minute)
    .think("A temperature check belongs with the doctor's checks, not on the graph page alone.", "Reading the doctor's checks first.")
    .read("src/control/doctor-model.ts", "export type NodeCheckName = \"online\" | \"release\" | \"disk\" | \"pylons\";");
  return t;
}
