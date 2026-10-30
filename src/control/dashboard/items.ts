/** Reads a conversation, pi's or a Claude worker's transcript, into the items the thread page shows. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, InboxState, LiveState } from "@earendil-works/pi-durable";
import { isImage } from "../../image-types.ts";
import { checkoutDir } from "../../sessions.ts";
import type { ThreadId } from "../registry.ts";
import type { ClaudeConversation, ClaudeEntry, PromptSource, TranscriptImage } from "../../claude-transcript.ts";
import type { Sender } from "../../agent-protocol.ts";
import type { PromptSenders } from "../inbox.ts";
import { queuedOf, type AgentView } from "../conversation-view.ts";
import { askedIn, askQuestionId, type AskedQuestion, type Question } from "../questions.ts";
import { clock } from "./elapsed.ts";
import type { Tone } from "./view.ts";

/**
 * One row of the conversation. A tool call carries its result, which the transcript holds in a later entry, and the
 * finish of a background task it started. A queued message carries what happens to it, such as that it sends after
 * the run. A note is a quiet line, such as how long a turn took. A finished call says how long it took when its agent
 * recorded it.
 */
export type Item =
  | { kind: "user"; text: string; queued: string | null; at: number; from: PromptFrom; images?: readonly Shot[] }
  | { kind: "agent"; text: string; streaming: boolean; images?: readonly Shot[] }
  | { kind: "tool"; call: { id: string; name: string; arguments: Readonly<Record<string, unknown>> }; result: ToolResult; ms: number | null; task?: Pick<Extract<ClaudeEntry, { kind: "task" }>, "status" | "summary" | "result">; images?: readonly Shot[] }
  /** A Claude worker's AskUserQuestion call, with its question while one was asked for it. */
  | { kind: "ask"; id: string; questions: readonly AskedQuestion[]; result: ToolResult; question: Question | null }
  | { kind: "notice"; text: string; tone: Tone }
  | { kind: "note"; text: string }
  | { kind: "link"; text: string; url: string };
type ToolResult = { state: "done"; output: string; isError: boolean } | { state: "running"; output: string } | { state: "none" };
export type ToolItem = Extract<Item, { kind: "tool" }>;
export type AskItem = Extract<Item, { kind: "ask" }>;
export type UserItem = Extract<Item, { kind: "user" }>;

/** Who a message came from. Nexus's PR watch, review loop, usage-limit watch and nudge write into a conversation as a user. */
type PromptFrom = PromptSource | Sender;
/** How a bubble names who a message came from. A person's is said only to a screen reader, as the bubble's side shows it. */
export const promptLabel: Record<PromptFrom, string> = {
  person: "You", "pr-watch": "Nexus PR watch", review: "Nexus review", "usage-limit": "Nexus usage limit", nudge: "Nexus nudge", command: "Slash command", other: "Claude Code",
};
/** A harness entry's kind for each sender's messages. */
const nexusKinds: Readonly<Record<string, Sender>> = { "nexus.pr-watch": "pr-watch", "nexus.review": "review", "nexus.usage-limit": "usage-limit", "nexus.nudge": "nudge" } satisfies Record<`nexus.${Sender}`, Sender>;

/** A message's text, with what each image part becomes in it. A committed message's images show as images. */
const messageText = (content: UserMessage["content"], image: (part: ImageContent) => string) => typeof content === "string" ? content
  : content.map((part: TextContent | ImageContent) => part.type === "text" ? part.text : image(part)).join("");

/** An image a row shows, linked to its full size. `caption` is a checkout file's path. */
export interface Shot { src: string; label: string; caption: string | null }
const imageRoute = (thread: ThreadId, query: Record<string, string | number>) =>
  `/v1/threads/${thread}/image?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`;
const inlineShots = (images: readonly { src: string }[]): Shot[] => images.map(({ src }, i) => ({ src, label: `Image ${i + 1}`, caption: null }));
const transcriptShots = (thread: ThreadId, images: readonly TranscriptImage[] = []): Shot[] => inlineShots(images.map((image) => ({ src: imageRoute(thread, { source: "transcript", ...image }) })));
const fileShots = (thread: ThreadId, paths: readonly string[]): Shot[] => paths.map((path) => ({ src: imageRoute(thread, { source: "file", path }), label: path, caption: path }));
/** A part's hash, once per part, since a page renders the same committed parts again and again. */
const partHashes = new WeakMap<ImageContent, string>();
export const partHash = (part: ImageContent) => partHashes.get(part) ?? partHashes.set(part, createHash("sha256").update(part.data).digest("hex")).get(part)!;
/** The image parts of a harness message, each named by its entry's ID, the message's place in the entry, its own place and its hash. */
function harnessShots(thread: ThreadId, entry: number, message: number, content: UserMessage["content"]): Shot[] {
  if (typeof content === "string") return [];
  return inlineShots(content.flatMap((part: TextContent | ImageContent, i) => part.type !== "image" ? []
    : [{ src: imageRoute(thread, { source: "harness", entry, message, part: i, sha256: partHash(part) }) }]));
}

/** What ends a path in prose: space, quotes, brackets and punctuation, but no period, which a sentence's end strips. */
const pathBreaks = /[\s`'"()<>[\]{}:,;|*!?]+/;
/**
 * The checkout's image files that prose names: bare, in backticks or as a markdown image, relative to the checkout
 * once normalised, at most 6 and each once. A path outside the checkout, as under /tmp, or a URL, is no file the
 * checkout serves.
 */
export function imagePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const word of text.split(pathBreaks)) {
    const token = word.replace(/\.$/, "");
    if (!isImage(token)) continue;
    const path = checkoutPath(token);
    if (path !== null) paths.add(path);
    if (paths.size === 6) break;
  }
  return [...paths];
}
function checkoutPath(path: string): string | null {
  if (path.startsWith("~") || (path.startsWith("/") && !path.startsWith(`${checkoutDir}/`))) return null;
  const relative = posix.normalize(path.startsWith("/") ? path.slice(checkoutDir.length + 1) : path);
  return relative === ".." || relative.startsWith("../") || relative.startsWith("/") ? null : relative;
}
/** The argument naming the file a write tool writes, for pi and for Claude Code. */
const writtenFile: Readonly<Record<string, string>> = { write: "path", Write: "file_path" };
const writtenImages = (name: string, args: Readonly<Record<string, unknown>>): string[] => {
  const path = Object.hasOwn(writtenFile, name) ? args[writtenFile[name]!] : undefined;
  return typeof path === "string" && isImage(path) ? [checkoutPath(path)].filter((p) => p !== null) : [];
};

/**
 * The transcript's messages, then what pi-durable shows of the current run: tool output as it streams, the
 * partial answer and a model request waiting to be retried, then the messages queued behind the run.
 */
function conversationItems(view: ConversationView, thread: ThreadId): Item[] {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const answer = (message: AssistantMessage, streaming: boolean) => {
    for (const part of message.content) {
      if (part.type === "text" && part.text !== "") items.push({ kind: "agent", text: part.text, streaming, ...(streaming ? {} : { images: fileShots(thread, imagePaths(part.text)) }) });
      // A streaming call's arguments are not whole yet. Its committed answer shows it.
      if (part.type === "toolCall" && !streaming) {
        const tool: ToolItem = { kind: "tool", call: part, result: { state: "none" }, ms: null, images: fileShots(thread, writtenImages(part.name, part.arguments)) };
        tools.set(part.id, tool);
        items.push(tool);
      }
    }
    if (message.stopReason === "error") items.push({ kind: "notice", text: `The model failed: ${message.errorMessage ?? "no reason given"}`, tone: "bad" });
    if (message.stopReason === "aborted") items.push({ kind: "notice", text: "Aborted.", tone: "muted" });
  };

  for (const { entry, message, place } of view.entries.flatMap((entry) => (entry.model ?? []).map((message, place) => ({ entry, message, place })))) {
    if (message.role === "user") {
      const text = messageText(message.content, () => "");
      items.push({
        kind: "user", text, queued: null, at: message.timestamp, from: nexusKinds[entry.kind] ?? "person",
        images: [...harnessShots(thread, entry.id, place, message.content), ...fileShots(thread, imagePaths(text))],
      });
    }
    if (message.role === "assistant") answer(message, false);
    if (message.role === "toolResult") {
      const result: ToolResult = { state: "done", output: messageText(message.content, () => ""), isError: message.isError };
      const ms = typeof message.durationMs === "number" ? message.durationMs : null;
      const images = harnessShots(thread, entry.id, place, message.content);
      const tool = tools.get(message.toolCallId);
      if (tool === undefined) items.push({ kind: "tool", call: { id: message.toolCallId, name: message.toolName, arguments: {} }, result, ms, images });
      else {
        tool.result = result;
        tool.ms = ms;
        tool.images = [...tool.images ?? [], ...images];
      }
    }
  }
  for (const slot of live?.tools ?? []) {
    const tool = tools.get(slot.callId);
    if (tool !== undefined && tool.result.state === "none" && slot.status === "running") tool.result = { state: "running", output: slot.output ?? "" };
  }
  const generation = live?.generation;
  if (generation?.message !== undefined) answer(generation.message as AssistantMessage, true);
  if (generation?.retry !== undefined) items.push({ kind: "notice", text: `The model request failed and will be retried: ${generation.retry.error}`, tone: "busy" });
  for (const queued of inbox?.items ?? []) {
    if (queued.mode !== "write") items.push({ kind: "user", text: messageText(queued.content as UserMessage["content"], (part) => `[${part.mimeType} image]`), queued: queued.mode === "steer" ? "joins after this tool round" : "sends after this run", at: 0, from: "person" });
  }
  return items;
}

export const itemsOf = (view: AgentView, questions: () => readonly Question[], thread: ThreadId, senders: () => PromptSenders): Item[] => view.kind === "claude" ? claudeItems(view.view, questions(), thread, senders()) : conversationItems(view.view, thread);

/**
 * A Claude worker's transcript as the rows a harness conversation shows. Each result goes on its call, and a
 * background task's finish on the call that started it. A call of the current turn without a result runs while
 * Claude works. An AskUserQuestion call is its own row, with the thread's question for it. A message Claude Code
 * queued and has not taken shows queued at the end. A pull request shows once.
 */
function claudeItems({ entries, working }: ClaudeConversation, questions: readonly Question[], thread: ThreadId, senderOf: PromptSenders): Item[] {
  const from = (text: string | null | undefined): PromptFrom => (text == null ? null : senderOf(text)) ?? "person";
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const calledAt = new Map<string, number>();
  const asks = new Map<string, AskItem>();
  const pullRequests = new Set<string>();
  let turn: ToolItem[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "prompt": items.push({ kind: "user", text: entry.text, queued: null, at: entry.at, from: entry.from === "person" ? from(entry.text) : entry.from, images: [...transcriptShots(thread, entry.images), ...fileShots(thread, imagePaths(entry.text))] }); break;
      case "reply": items.push({ kind: "agent", text: entry.text, streaming: false, images: fileShots(thread, imagePaths(entry.text)) }); break;
      case "tool": {
        const asked = askedIn(entry);
        if (asked !== null) {
          const ask: AskItem = { kind: "ask", id: entry.id, questions: asked, result: { state: "none" }, question: questions.find((q) => q.id === askQuestionId(entry.id)) ?? null };
          asks.set(entry.id, ask);
          items.push(ask);
          break;
        }
        const tool: ToolItem = { kind: "tool", call: { id: entry.id, name: entry.name, arguments: entry.input }, result: { state: "none" }, ms: null, images: fileShots(thread, writtenImages(entry.name, entry.input)) };
        tools.set(entry.id, tool);
        calledAt.set(entry.id, entry.at);
        turn.push(tool);
        items.push(tool);
        break;
      }
      case "result": {
        const result: ToolResult = { state: "done", output: entry.output, isError: entry.isError };
        const images = transcriptShots(thread, entry.images);
        const tool = tools.get(entry.toolUseId) ?? asks.get(entry.toolUseId);
        if (tool === undefined) items.push({ kind: "tool", call: { id: entry.toolUseId, name: "tool", arguments: {} }, result, ms: null, images });
        else {
          tool.result = result;
          if (tool.kind === "tool") tool.images = [...tool.images ?? [], ...images];
        }
        const at = calledAt.get(entry.toolUseId);
        if (tool?.kind === "tool" && at !== undefined && entry.at >= at) tool.ms = entry.at - at;
        break;
      }
      case "task": {
        const tool = entry.toolUseId === null ? undefined : tools.get(entry.toolUseId);
        if (tool === undefined) items.push({ kind: "notice", text: `A background task ${entry.status}: ${entry.summary}`, tone: "muted" });
        else tool.task = entry;
        break;
      }
      case "queue": break;
      case "notice": items.push({ kind: "notice", text: entry.text, tone: entry.tone === "error" ? "bad" : "muted" }); break;
      case "turn":
        turn = [];
        items.push({ kind: "note", text: `Worked for ${clock(entry.durationMs)}.` });
        break;
      case "pull-request":
        if (!pullRequests.has(entry.url)) items.push({ kind: "link", text: `Opened pull request #${entry.number}`, url: entry.url });
        pullRequests.add(entry.url);
        break;
      case "record": items.push({ kind: "notice", text: `Claude Code wrote a ${entry.type} record: ${entry.summary}`, tone: "muted" }); break;
    }
  }
  if (working) for (const tool of turn) if (tool.result.state === "none") tool.result = { state: "running", output: "" };
  for (const q of queuedOf(entries)) items.push({ kind: "user", text: q.text ?? "A message the transcript does not show", queued: "Claude takes it at its next step", at: q.at, from: from(q.text) });
  return items;
}

/** The model of the newest committed answer, which is the one the next message goes to. */
export function modelOf(view: ConversationView): string | null {
  const answers = view.entries.flatMap((entry) => entry.model ?? []).filter((m) => m.role === "assistant");
  return answers.at(-1)?.model ?? null;
}
