/**
 * A Claude Code session's transcript, as a client shows it. Claude Code 2.1.308 writes each session as JSON lines
 * under ~/.claude/projects/<the cwd, each character that is not a letter or digit made `-`>/<session id>.jsonl, and a
 * resume appends to the same file. The control plane reads it from the pylon over a raw pipe, from an offset, and
 * parses each record here, at the boundary, into a small model that only grows: a later record never changes an
 * earlier entry, so a tool call and its result are two entries that a renderer pairs by the call's ID.
 *
 * A record is untrusted guest output. Records Claude Code writes for its own bookkeeping, such as API request
 * copies, context attachments and the session metadata it writes again each time it saves the session, are known
 * and left out. Every other record shape the parser does not know stays visible as a `record` entry, so a new
 * Claude Code version shows something rather than nothing.
 */
import { createHash } from "node:crypto";
import type { OpenPipe } from "./checkout-files.ts";
import type { ByteStream, StreamEnd } from "./protocol.ts";

/**
 * Who a prompt came from: the person, a slash command, or something else, such as a plugin. A finished background
 * task is a `task` entry and a `!` shell command a `tool` entry, not prompts.
 */
export type PromptSource = "person" | "command" | "other";

export type ClaudeEntry =
  | { kind: "prompt"; at: number; text: string; from: PromptSource }
  | { kind: "reply"; at: number; text: string }
  /** `input` is the call's arguments, each string cut to its limit. */
  | { kind: "tool"; at: number; id: string; name: string; input: Record<string, unknown> }
  | { kind: "result"; at: number; toolUseId: string; output: string; isError: boolean }
  /**
   * A background subagent or shell finished, as Claude's `<task-notification>` says. `toolUseId` is the call that
   * started it. `result` is a subagent's final answer, which a shell's notification does not carry.
   */
  | { kind: "task"; at: number; toolUseId: string | null; status: string; summary: string; result: string | null }
  /** A prompt typed while Claude was busy joins its queue, and leaves it when Claude takes it. `text` is null when the record names none. */
  | { kind: "queue"; at: number; op: string; text: string | null }
  /** Such as an interrupted turn, a model error or a compaction. `usageLimit` marks the error a usage limit stopped the turn with, and when the limit resets, if Claude Code said. */
  | { kind: "notice"; at: number; tone: "info" | "error"; text: string; usageLimit?: UsageLimit }
  | { kind: "turn"; at: number; durationMs: number }
  /**
   * Claude opened a pull request. Claude Code writes the record again each time it saves the session's metadata, so
   * one pull request gives many entries, which a client shows once. `url` is an https URL.
   */
  | { kind: "pull-request"; at: number; number: number; url: string; repository: string }
  /** A record the parser does not know, kept visible. `summary` is a short, cut rendering of it. */
  | { kind: "record"; at: number | null; type: string; summary: string };

/** `resetsAt` is in Unix milliseconds, null when Claude Code did not say. */
export interface UsageLimit { resetsAt: number | null }

/** The usage limit the newest entry that is not bookkeeping stopped on, or null. Bookkeeping is a turn's duration, a queue operation, a pull request and an unknown record. */
export function usageLimitStop(entries: readonly ClaudeEntry[]): { stoppedAt: number; resetsAt: number | null } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (bookkeeping.has(entry.kind)) continue;
    return entry.kind === "notice" && entry.usageLimit !== undefined ? { stoppedAt: entry.at, resetsAt: entry.usageLimit.resetsAt } : null;
  }
  return null;
}
const bookkeeping = new Set<ClaudeEntry["kind"]>(["turn", "queue", "pull-request", "record"]);

/** "stopped on its usage limit until 06:30 UTC", or "…, which reset at 06:30 UTC" once the reset passed. A reset more than a day away also names its date, as in "Oct 29, 05:30 UTC". */
export function usageLimitText(limit: { resetsAt: number | null }, now: number): string {
  if (limit.resetsAt === null) return "stopped on its usage limit";
  const at = new Date(limit.resetsAt);
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
  const when = Math.abs(limit.resetsAt - now) > 86_400_000 ? `${at.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${time}` : time;
  return limit.resetsAt > now ? `stopped on its usage limit until ${when}` : `stopped on its usage limit, which reset at ${when}`;
}

/** What `GET /v1/threads/<id>/conversation` answers for a Claude worker thread. */
export interface ClaudeConversation {
  kind: "claude";
  /** The worker's Claude Code session, null until its launch names one. */
  session: string | null;
  /** The newest entries, at most maxEntries. */
  entries: readonly ClaudeEntry[];
  /** How many older entries were dropped to keep within maxEntries. */
  dropped: number;
  /** When the transcript was last read from the pylon, or null if never. A paused pylon shows what that read saw. */
  readAt: number | null;
  /** Whether a turn of the worker's session runs, from its session events. */
  working: boolean;
}

/**
 * Where a reader is in the file. `skipping` means a record longer than maxRecordBytes is being passed over. `before`
 * is the SHA-256 of the up to beforeBytes just before `offset`, which a file replaced by another does not match.
 */
export interface TranscriptCursor { offset: number; skipping: boolean; before: string }

/** Claude's records end alike, with its cwd, session, version and branch, so the check spans whole records. */
const beforeBytes = 4 << 10;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const transcriptStart: TranscriptCursor = { offset: 0, skipping: false, before: sha256(new Uint8Array()) };

export const maxEntries = 3000;
/** The most one read takes from the file. A record longer than this is skipped, and a `record` entry says so. */
export const maxRecordBytes = 512 << 10;
/** Cuts for each entry's text, so a transcript of many megabytes keeps to a bounded model. */
export const textLimits = { prompt: 32 << 10, reply: 64 << 10, input: 4 << 10, output: 8 << 10, summary: 500 } as const;

/** Where Claude Code keeps every project's transcripts in a pylon. */
export const claudeProjects = "/home/user/.claude/projects";
/** Far longer than reading maxRecordBytes of a local file takes, even on a busy pylon. */
export const transcriptDeadlineMs = 20_000;
/** The header line, the bytes before the cursor and one read's bytes. A reply longer than this is not the script's. */
const maxReplyBytes = 64 + beforeBytes + maxRecordBytes;

/** One read's result. `reset` means the file was replaced, so `entries` start from its beginning and replace any read before. */
export interface TranscriptRead { entries: ClaudeEntry[]; cursor: TranscriptCursor; more: boolean; reset: boolean }

/**
 * Prints the transcript's size, the offset this read starts at and how many bytes before it follow, then those bytes
 * and at most $3 bytes from the offset. A file smaller than the cursor's offset, or whose $5 bytes before it do not
 * hash to $4, was replaced, so the read starts over at 0. Exits 3 when no project holds the session's transcript.
 */
const readScript = `for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] || continue; size=$(($(wc -c < "$f"))); start=$2; n=$((start < $5 ? start : $5))
{ [ "$size" -lt "$start" ] || [ "$(tail -c +$((start - n + 1)) "$f" | head -c $n | sha256sum)" != "$4  -" ]; } && start=0 n=0
echo "$size $start $n"; tail -c +$((start - n + 1)) "$f" | head -c $((n + $3)); exit 0; done; exit 3`;

/**
 * Reads the session's transcript from `cursor` over one raw pipe and parses the complete lines it gets. Null when the
 * session has no transcript yet (Claude writes none before its first prompt). `more` is true when the file holds
 * bytes past what this read took, so the caller reads again.
 */
export async function readTranscript(open: OpenPipe, session: string, cursor: TranscriptCursor, projects = claudeProjects, deadlineMs = transcriptDeadlineMs): Promise<TranscriptRead | null> {
  if (!/^[A-Za-z0-9-]{1,200}$/.test(session)) throw new Error(`${JSON.stringify(session.slice(0, 200))} is not a Claude Code session ID`);
  const { end, out } = await drained(await open(["sh", "-c", readScript, session, projects, String(cursor.offset), String(maxRecordBytes), cursor.before, String(beforeBytes)]), deadlineMs);
  if (end.kind === "lost") throw new Error("the pipe to the pylon was lost before the transcript was read");
  if (end.code === 3) return null;
  if (end.code !== 0) throw new Error(`reading the Claude Code transcript exited ${end.code}`);
  const newline = out.indexOf(0x0a);
  const header = newline < 0 ? null : /^(\d{1,15}) (\d{1,15}) (\d{1,15})$/.exec(out.subarray(0, newline).toString("latin1"));
  const size = Number(header?.[1]);
  const start = Number(header?.[2]);
  const preceding = out.subarray(newline + 1, newline + 1 + Number(header?.[3]));
  const body = out.subarray(newline + 1 + preceding.length);
  if (header === null || preceding.length !== Math.min(start, beforeBytes) || body.length > maxRecordBytes || (start !== cursor.offset && start !== 0)) {
    throw new Error("the transcript reader's reply is malformed");
  }
  const reset = start !== cursor.offset;
  const next = consumed(body, { offset: start, skipping: !reset && cursor.skipping });
  const before = sha256(Buffer.concat([preceding, body.subarray(0, next.cursor.offset - start)]).subarray(-beforeBytes));
  return { entries: next.entries, cursor: { ...next.cursor, before }, more: size > start + body.length, reset };
}

/** The pipe's whole output. A pipe that passes the deadline or prints past the cap is dropped. */
async function drained(stream: ByteStream, deadlineMs: number): Promise<{ end: StreamEnd; out: Buffer }> {
  const reply = (async () => {
    await stream.close();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxReplyBytes) throw new Error(`the transcript reader printed over ${maxReplyBytes} bytes`);
      chunks.push(chunk);
    }
    return { end: await stream.done, out: Buffer.concat(chunks) };
  })();
  // A reply that loses the race fails unwatched.
  reply.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the pylon did not read the transcript within ${deadlineMs / 1000} s`)), deadlineMs);
  });
  try {
    return await Promise.race([reply, late]);
  } catch (err) {
    stream.abort();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The entries of the complete lines in `body`, which starts at `cursor`, and the cursor just past them. A trailing
 * partial line waits for the next read. A full read with no newline is the middle of a record too long to read, so
 * the cursor skips it, and the newline that ends it gives one `record` entry in its place.
 */
function consumed(body: Buffer, cursor: Omit<TranscriptCursor, "before">): { entries: ClaudeEntry[]; cursor: Omit<TranscriptCursor, "before"> } {
  const last = body.lastIndexOf(0x0a);
  if (last < 0) {
    const skipping = cursor.skipping || body.length === maxRecordBytes;
    return { entries: [], cursor: skipping ? { offset: cursor.offset + body.length, skipping } : cursor };
  }
  const lines = body.subarray(0, last).toString("utf8").split("\n");
  const entries: ClaudeEntry[] = [];
  if (cursor.skipping) {
    lines.shift();
    entries.push({ kind: "record", at: null, type: "oversized", summary: `a record of more than ${maxRecordBytes} bytes was skipped` });
  }
  let at = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const read = entriesOf(line, at);
    entries.push(...read.entries);
    at = read.at ?? at;
  }
  return { entries, cursor: { offset: cursor.offset + last + 1, skipping: false } };
}

/** Every entry one transcript line gives, in order. A line that is not a JSON object gives one `record` entry. */
export function parseRecord(line: string): ClaudeEntry[] {
  return entriesOf(line, 0).entries;
}

/**
 * `at` is the record's timestamp, or `lastAt` for a record without one. Any record that breaks the shape its type
 * promises gives a `record` entry, so no input makes this throw.
 */
function entriesOf(line: string, lastAt: number): { entries: ClaudeEntry[]; at: number | null } {
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    r = undefined;
  }
  if (!isFields(r)) return { entries: [{ kind: "record", at: null, type: "invalid", summary: cut(line, textLimits.summary) }], at: null };
  const own = typeof r.timestamp === "string" && Number.isFinite(Date.parse(r.timestamp)) ? Date.parse(r.timestamp) : null;
  const at = own ?? lastAt;
  const type = typeof r.type === "string" ? r.type : "untyped";
  try {
    return { entries: (records.get(type) ?? shown(type))(r, at), at: own };
  } catch {
    return { entries: [record(type, r, at)], at: own };
  }
}

type Fields = Readonly<Record<string, unknown>>;
type Parse = (r: Fields, at: number) => ClaudeEntry[];
/** Parses a string-content form, keyed in `forms` by its leading tag. */
type Form = (text: string, r: Fields, at: number) => ClaudeEntry[];
/** Parses an assistant content block. `tone` is set for a message Claude Code made itself, which is a notice rather than a reply. */
type Block = (block: Fields, at: number, tone: "info" | "error" | null) => ClaudeEntry[];

const table = <T>(rows: Record<string, T>): ReadonlyMap<string, T> => new Map(Object.entries(rows));
const none = (): ClaudeEntry[] => [];
const hidden = (...types: string[]): Record<string, typeof none> => Object.fromEntries(types.map((t) => [t, none]));
const shown = (type: string): Parse => (r, at) => [record(type, r, at)];

const records = table<Parse>({
  ...hidden("api-request", "api-request-blob", "api-request-shape", "mode", "permission-mode", "atis-latch", "last-prompt", "file-history-snapshot", "file-history-delta", "ai-title", "cost-state",
    "custom-title", "tag", "relocated", "agent-name", "agent-color", "agent-setting", "isolation-latch", "dev-mods", "memory-mode", "worktree-state",
    "frame-link", "history-suppression", "bridge-session"),
  user: userRecord,
  assistant: assistantRecord,
  system: (r, at) => {
    const subtype = str(r.subtype, "subtype");
    return (systems.get(subtype) ?? shown(`system/${subtype}`))(r, at);
  },
  attachment: (r, at) => {
    const type = str(fields(r.attachment, "attachment").type, "attachment.type");
    return (attachments.get(type) ?? shown(`attachment/${type}`))(r, at);
  },
  "pr-link": (r, at) => {
    if (typeof r.prNumber !== "number" || !Number.isSafeInteger(r.prNumber) || r.prNumber < 1) throw new Error("prNumber is not a pull request's number");
    const url = str(r.prUrl, "prUrl");
    // The URL becomes a link, so nothing but a whole https URL may pass.
    if (!URL.canParse(url) || new URL(url).protocol !== "https:" || url.length > textLimits.summary) throw new Error("prUrl is not an https URL");
    return [{ kind: "pull-request", at, number: r.prNumber, url, repository: cut(str(r.prRepository, "prRepository"), textLimits.summary) }];
  },
  "queue-operation": (r, at) => [{ kind: "queue", at, op: cut(str(r.operation, "operation"), textLimits.summary), text: r.content === undefined ? null : cut(str(r.content, "content"), textLimits.prompt) }],
});

const systems = table<Parse>({
  ...hidden("stop_hook_summary"),
  turn_duration: (r, at) => {
    if (typeof r.durationMs !== "number" || !(r.durationMs >= 0)) throw new Error("durationMs is not a duration");
    return [{ kind: "turn", at, durationMs: r.durationMs }];
  },
  compact_boundary: (_r, at) => [notice(at, "info", "Claude compacted the conversation")],
  local_command: (r, at) => {
    const text = str(r.content, "content");
    const form = forms.get(leadingTag(text));
    return form === undefined ? [record("system/local_command", r, at)] : form(text, r, at);
  },
  api_error: (r, at) => {
    let message: unknown = r.content;
    for (let e: unknown = r.error; typeof message !== "string" && isFields(e); e = e.error) message = e.message;
    return [notice(at, "error", typeof message === "string" && message.trim() !== "" ? `Claude's API request failed: ${message}` : "Claude's API request failed")];
  },
});

const attachments = table<Parse>({
  ...hidden("environment", "model", "deferred_tools_delta", "agent_listing_delta", "mcp_instructions_delta", "skill_listing", "auto_mode", "command_permissions", "instructions", "session_context", "date", "prompt_snapshot", "total_tokens_reminder", "deferred_tools_record", "silent_turn_reminder", "remote_session_change"),
  // A prompt or a task's notification that Claude took from its queue in the middle of a turn.
  queued_command: (r, at) => {
    const queued = fields(r.attachment, "attachment");
    const text = typeof queued.prompt === "string" ? queued.prompt : partsText(queued.prompt);
    if (queued.commandMode === "task-notification") return [task(text, at)];
    if (queued.commandMode === "prompt") return [prompt(at, text, isFields(queued.origin) && queued.origin.kind === "human" ? "person" : "other")];
    return [record("attachment/queued_command", r, at)];
  },
});

/**
 * What Claude Code writes as a user message's string content, besides a prompt: a slash command, a `!` shell
 * command and its output, a local command's output, and a task's notification. A `!` command is a tool call and
 * its result, paired by the prompt ID the two records share. Claude records no exit status for it.
 */
const forms = table<Form>({
  "command-name": command,
  "command-message": command,
  "bash-input": (text, r, at) => [{ kind: "tool", at, id: shellId(r), name: "shell", input: { command: cut(inner(text, "bash-input") ?? "", textLimits.input) } }],
  "bash-stdout": (text, r, at) => {
    const output = [inner(text, "bash-stdout"), inner(text, "bash-stderr")].filter((s) => s !== null && s !== "").join("\n");
    return [{ kind: "result", at, toolUseId: shellId(r), output: cut(plain(output), textLimits.output), isError: false }];
  },
  "local-command-stdout": (text, _r, at) => said(at, "info", inner(text, "local-command-stdout")),
  "local-command-stderr": (text, _r, at) => said(at, "error", inner(text, "local-command-stderr")),
  "task-notification": (text, _r, at) => [task(text, at)],
});

const personForms = table<Form>({ "command-name": personCommand, "command-message": personCommand });

const blocks = table<Block>({
  text: (block, at, tone) => {
    const text = str(block.text, "text");
    if (text.trim() === "") return [];
    return [tone === null ? { kind: "reply", at, text: cut(text, textLimits.reply) } : notice(at, tone, text)];
  },
  thinking: none,
  redacted_thinking: none,
  tool_use: (block, at) => [{ kind: "tool", at, id: cut(str(block.id, "id"), textLimits.summary), name: cut(str(block.name, "name"), textLimits.summary), input: cutStrings(fields(block.input, "input")) as Record<string, unknown> }],
});

const interruptions = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

function userRecord(r: Fields, at: number): ClaudeEntry[] {
  if (r.isMeta === true) return [];
  // The summary Claude Code writes for itself after a compaction, which is long and not the person's.
  if (r.isCompactSummary === true) return [notice(at, "info", "Claude continues from a summary of the earlier conversation")];
  const content = fields(r.message, "message").content;
  // The person's own words are a prompt whatever they hold, so typing a tag such as <bash-input> forges nothing. A slash
  // command the person typed, such as the worker's first `/poteto-mode` prompt, is recorded in its command form.
  const from = isFields(r.origin) && r.origin.kind === "human" ? "person" : "other";
  if (typeof content === "string") {
    const tag = leadingTag(content);
    const form = from === "person" ? personForms.get(tag) : forms.get(tag);
    return form === undefined ? [prompt(at, content, from)] : form(content, r, at);
  }
  // Claude's metadata for a subagent it started in the background, which tells Claude not to show it.
  const background = isFields(r.toolUseResult) && r.toolUseResult.status === "async_launched";
  const entries: ClaudeEntry[] = [];
  const words: string[] = [];
  for (const item of list(content, "message.content")) {
    const part = fields(item, "a content item");
    const type = str(part.type, "a content item's type");
    if (type === "tool_result") {
      const output = background ? "Started in the background" : cut(typeof part.content === "string" ? part.content : partsText(part.content ?? []), textLimits.output);
      entries.push({ kind: "result", at, toolUseId: cut(str(part.tool_use_id, "tool_use_id"), textLimits.summary), output, isError: part.is_error === true });
    } else if (type === "text" && interruptions.has(str(part.text, "text"))) entries.push(notice(at, "info", "Interrupted"));
    else if (type === "text" || type === "image") words.push(type === "text" ? str(part.text, "text") : "[image]");
    else entries.push(record(`user/${type}`, part, at));
  }
  if (words.length > 0) entries.push(prompt(at, words.join("\n"), from));
  return entries;
}

function assistantRecord(r: Fields, at: number): ClaudeEntry[] {
  const message = fields(r.message, "message");
  const tone = r.isApiErrorMessage === true ? "error" : message.model === "<synthetic>" ? "info" : null;
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : list(message.content, "message.content");
  const entries = content.flatMap((item) => {
    const block = fields(item, "a content block");
    const type = str(block.type, "a content block's type");
    const parse = blocks.get(type);
    return parse === undefined ? [record(`assistant/${type}`, block, at)] : parse(block, at, tone);
  });
  if (r.isApiErrorMessage !== true || r.apiError !== "usage_limit_reached") return entries;
  const usageLimit = { resetsAt: resetsAt(r.apiErrorParams) };
  return entries.map((entry) => entry.kind === "notice" && entry.tone === "error" ? { ...entry, usageLimit } : entry);
}

/** `apiErrorParams.rate_limit_info.resetsAt`, which is in Unix seconds, in milliseconds, or null for anything else. */
function resetsAt(params: unknown): number | null {
  const info = isFields(params) ? params.rate_limit_info : undefined;
  const seconds = isFields(info) ? info.resetsAt : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function command(text: string, _r: Fields, at: number): ClaudeEntry[] {
  const name = inner(text, "command-name");
  if (name === null) throw new Error("a command names none");
  const args = inner(text, "command-args")?.trim() ?? "";
  return [prompt(at, args === "" ? name.trim() : `${name.trim()} ${args}`, "command")];
}

/** The person's slash command, as they typed it: a prompt from the person, not from Claude Code. */
function personCommand(text: string, r: Fields, at: number): ClaudeEntry[] {
  return command(text, r, at).map((entry) => entry.kind === "prompt" ? { ...entry, from: "person" } : entry);
}

function task(text: string, at: number): ClaudeEntry {
  const id = inner(text, "tool-use-id");
  const result = inner(text, "result");
  return {
    kind: "task", at,
    toolUseId: id === null ? null : cut(id, textLimits.summary),
    status: cut(inner(text, "status") ?? "unknown", textLimits.summary),
    summary: cut(inner(text, "summary") ?? "", textLimits.summary),
    result: result === null ? null : cut(result, textLimits.output),
  };
}

const shellId = (r: Fields): string => `shell:${cut(str(r.promptId, "promptId"), textLimits.summary)}`;
const prompt = (at: number, text: string, from: PromptSource): ClaudeEntry => ({ kind: "prompt", at, text: cut(text, textLimits.prompt), from });
const notice = (at: number, tone: "info" | "error", text: string): ClaudeEntry => ({ kind: "notice", at, tone, text: cut(text, textLimits.output) });
/** A local command's output as a notice, or nothing when it printed nothing. */
const said = (at: number, tone: "info" | "error", text: string | null): ClaudeEntry[] => text === null || plain(text).trim() === "" ? [] : [notice(at, tone, plain(text).trim())];

function record(type: string, value: unknown, at: number): ClaudeEntry {
  let summary: string;
  try {
    summary = JSON.stringify(value);
  } catch {
    summary = "a record nested too deeply to show";
  }
  return { kind: "record", at, type: cut(type, textLimits.summary), summary: cut(summary, textLimits.summary) };
}

/** The text of a list of content parts, each image as "[image]" and each other part as its type. */
function partsText(parts: unknown): string {
  return list(parts, "content").map((item) => {
    const part = fields(item, "a content part");
    if (part.type === "text") return str(part.text, "text");
    return `[${typeof part.type === "string" ? part.type : "unknown"}]`;
  }).join("\n");
}

/** The text inside `<name>…</name>`, or to the end of `text` where the closing tag is missing, as in a record that was cut. */
function inner(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)(?:</${name}>|$)`).exec(text);
  return match === null ? null : match[1]!;
}

const leadingTag = (text: string): string => /^\s*<([a-z_-]+)>/.exec(text)?.[1] ?? "";
const plain = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

/** `text` at most `limit` characters long, with "…" marking a cut. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last < 0xdc00) end--;
  return `${text.slice(0, end)}…`;
}

function cutStrings(value: unknown): unknown {
  if (typeof value === "string") return cut(value, textLimits.input);
  if (Array.isArray(value)) return value.map(cutStrings);
  if (isFields(value)) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, cutStrings(v)]));
  return value;
}

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
function fields(value: unknown, what: string): Fields {
  if (!isFields(value)) throw new Error(`${what} is not an object`);
  return value;
}
function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} is not a string`);
  return value;
}
function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value;
}
