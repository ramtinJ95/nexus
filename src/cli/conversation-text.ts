/** A harness conversation and a Claude worker's transcript as text. */
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, InboxState, LiveState } from "@earendil-works/pi-durable";
import { usageLimitText, type ClaudeConversation, type ClaudeEntry, type PromptSource } from "../claude-transcript.ts";
import { queuedOf } from "../control/conversation-view.ts";
import { clip } from "./kit.ts";

const contentText = (content: string | readonly (TextContent | ImageContent)[]) => typeof content === "string" ? content
  : content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("");

function messageText(message: Message): string {
  switch (message.role) {
    case "system": return "";
    case "user": return contentText(message.content).split("\n").map((line) => `> ${line}`).join("\n");
    case "toolResult": return `[${message.isError ? "tool error" : "result"}] ${message.toolName}: ${clip(contentText(message.content), 400)}`;
    case "assistant": return [
      ...message.content.flatMap((part) => part.type === "text" && part.text !== "" ? [part.text]
        : part.type === "toolCall" ? [`[tool] ${part.name} ${clip(JSON.stringify(part.arguments), 200)}`] : []),
      ...message.stopReason === "error" ? [`[error] The model failed: ${message.errorMessage ?? "no reason given"}`] : [],
      ...message.stopReason === "aborted" ? ["[aborted]"] : [],
    ].join("\n");
  }
}

/** Empty for an entry that holds no model message, such as the head marker. */
export const entryText = (entry: EntryRecord) => (entry.model ?? []).map(messageText).filter((text) => text !== "").join("\n");

/** What watch and the CLI's renderings read of a conversation. */
export type View = Pick<ConversationView, "entries" | "docs">;

export const queuedTexts = (view: View) => ((view.docs["pi.inbox"] as InboxState | undefined)?.items ?? [])
  .flatMap((item) => item.mode === "write" ? [] : [contentText(item.content as string | (TextContent | ImageContent)[])]);
export const busy = (view: View) => (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;

export function conversationText(view: ConversationView): string {
  const parts = [
    ...view.entries.map(entryText).filter((text) => text !== ""),
    ...queuedTexts(view).map((text) => `(queued) > ${text}`),
    ...busy(view) ? ["(the agent is working)"] : [],
  ];
  return parts.length === 0 ? "No messages yet." : parts.join("\n\n");
}

/** How a prompt's first line names who it came from. A person's is not named. */
const promptLabel: Record<PromptSource, string> = { person: "", command: "[slash command] ", other: "[Claude Code] " };

/**
 * One transcript entry as a line or more, empty for one that prints nothing alone: a result, which its call shows,
 * a queue operation, and a pull request `shown` already holds, which this adds to it. A call says how it ended
 * when `how` is given.
 */
export function claudeEntryText(e: ClaudeEntry, shown: Set<string>, how?: string): string {
  switch (e.kind) {
    case "prompt": return `> ${promptLabel[e.from]}${[...e.text === "" ? [] : [e.text], ...(e.images ?? []).map(() => "[image]")].join("\n").split("\n").join("\n> ")}`;
    case "reply": return e.text;
    case "tool": return `[tool] ${e.name} ${clip(JSON.stringify(e.input), 200)}${how === undefined ? "" : ` (${how})`}`;
    case "task": return `[task] ${e.status}: ${e.summary}`;
    case "notice": return `[${e.tone === "error" ? "error" : "notice"}] ${e.text}`;
    case "turn": return `[turn] ${Math.round(e.durationMs / 1000)}s`;
    case "pull-request": {
      if (shown.has(e.url)) return "";
      shown.add(e.url);
      return `[pull request] Opened pull request #${e.number}: ${e.url}`;
    }
    case "record": return `[record] ${e.type}: ${e.summary}`;
    case "result": case "queue": return "";
  }
}

/**
 * A Claude worker's transcript: each prompt, reply, notice and task, and each tool call on one line with how it
 * ended, then the messages Claude Code queued and whether Claude works.
 */
export function claudeText(c: ClaudeConversation): string {
  const results = new Map(c.entries.flatMap((e) => e.kind === "result" ? [[e.toolUseId, e] as const] : []));
  const lastTurn = c.entries.findLastIndex((e) => e.kind === "turn");
  const shown = new Set<string>();
  const lines = c.entries.map((e, i) => {
    if (e.kind !== "tool") return claudeEntryText(e, shown);
    const result = results.get(e.id);
    return claudeEntryText(e, shown, result !== undefined ? (result.isError ? "failed" : "ok") : c.working && i > lastTurn ? "running" : "no result");
  }).filter((text) => text !== "");
  const parts = [
    ...c.dropped === 0 ? [] : [`(${c.dropped} older entries are not kept)`],
    ...lines,
    ...queuedOf(c.entries).map((q) => `(queued) > ${q.text ?? ""}`),
    ...c.working ? ["(Claude is working)"] : [],
    ...c.usageLimit === null ? [] : [`(Claude ${usageLimitText(c.usageLimit, Date.now())}. Send it "continue" after the reset to resume)`],
  ];
  if (parts.length > 0) return parts.join("\n\n");
  return c.readAt === null ? "Claude's transcript has not been read yet. It is read while the pylon runs." : "Claude has not written a transcript yet.";
}
