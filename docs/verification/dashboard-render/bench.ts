/**
 * Times `liveFrames` on a long synthetic conversation: 100 turns, each a prompt, a reply with a Bash call, its result
 * and a closing reply, 400 messages in all, while an answer streams. Each frame is a new view of the same entries with
 * a longer partial answer, as pi-durable sends while a run streams. Prints the first frame's time and the median and
 * 90th percentile of the next 300, for a harness view and for a Claude worker's transcript of the same turns.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ClaudeConversation, ClaudeEntry } from "../../../src/claude-transcript.ts";
import type { Thread } from "../../../src/control/registry.ts";
import { liveFrames } from "../../../src/control/dashboard.ts";

const turns = 100;
const frames = 300;
const prose = (turn: number) => `Turn ${turn}: I read **src/app.ts** and \`npm test\` fails in *two* places.\n\n- the parser drops a \`null\`\n- the [docs](https://example.com/${turn}) say otherwise\n\n\`\`\`ts\nconst x = parse(input);\n\`\`\`\n\nI fix both and run the suite again.`;
const thread = { id: "th-bench", createdAt: 0, status: "active" } as Thread;

function harness(): (partial: string) => ConversationView {
  const messages = Array.from({ length: turns }, (_, i) => [
    { role: "user", content: `Please look at issue ${i}. ${prose(i)}`, timestamp: i },
    { role: "assistant", content: [{ type: "text", text: prose(i) }, { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `npm test -- ${i}` } }], model: "gpt-bench", stopReason: "toolUse", timestamp: i },
    { role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: `ok ${i}\n`.repeat(20) }], isError: false, timestamp: i },
    { role: "assistant", content: [{ type: "text", text: prose(i + 1000) }], model: "gpt-bench", stopReason: "stop", timestamp: i },
  ]).flat();
  const entries = messages.map((message, i) => ({ id: i + 1, conversationId: 1, kind: `pi.${message.role}`, model: [message] }));
  return (partial) => ({
    conversation: { id: 1 }, entries,
    docs: { "pi.live": { run: { taskId: 1, inputs: [1] }, tools: [], generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: partial }], stopReason: "pending" } } } },
  }) as never as ConversationView;
}

function claude(): (partial: string) => ClaudeConversation {
  const entries: ClaudeEntry[] = Array.from({ length: turns }, (_, i): ClaudeEntry[] => [
    { kind: "prompt", at: i, text: `Please look at issue ${i}. ${prose(i)}`, from: "person" },
    { kind: "reply", at: i, text: prose(i) },
    { kind: "tool", at: i, id: `c${i}`, name: "Bash", input: { command: `npm test -- ${i}` } },
    { kind: "result", at: i, toolUseId: `c${i}`, output: `ok ${i}\n`.repeat(20), isError: false },
    { kind: "reply", at: i, text: prose(i + 1000) },
  ]).flat();
  // A Claude worker's transcript has no partial answer, so its frames add a reply each.
  return (partial) => ({ kind: "claude", session: "s1", entries: [...entries, { kind: "reply", at: turns, text: partial }], dropped: 0, readAt: 1, working: true, usageLimit: null });
}

function time(view: (partial: string) => ConversationView | ClaudeConversation): { first: number; median: number; p90: number } {
  const next = liveFrames(thread, "claude-opus-5-5");
  const words = Array.from({ length: frames + 1 }, (_, i) => `word${i}`);
  const at = performance.now();
  next(view(words[0]!));
  const first = performance.now() - at;
  const ms = words.slice(1).map((_, i) => {
    const start = performance.now();
    next(view(words.slice(0, i + 2).join(" ")));
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return { first, median: ms[Math.floor(ms.length / 2)]!, p90: ms[Math.floor(ms.length * 0.9)]! };
}

for (const [name, view] of [["harness", harness()], ["claude", claude()]] as const) {
  const { first, median, p90 } = time(view);
  console.log(`${name}: first frame ${first.toFixed(1)} ms, then median ${median.toFixed(2)} ms, p90 ${p90.toFixed(2)} ms per frame`);
}
