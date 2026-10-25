import { once } from "node:events";
import type { NexusEvent } from "../events.ts";
import { releaseOutcome, type ReleaseView } from "../deploy/model.ts";
/**
 * The Mac's nexus CLI: the control plane's API as commands, for a human at a shell and for the Claude Code and pi
 * integrations, which shell out to it. docs/cli.md is the contract: the commands, their JSON, the exit codes and
 * the watch stream. --json prints the API's reply as it is, except where docs/cli.md says otherwise.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { z } from "zod";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, InboxState, LiveState } from "@earendil-works/pi-durable";
import type { ListeningPort, NodeSummary, OpenedSession, ThreadDetail, ThreadRow, ViewFrame } from "../control/api.ts";
import type { Preview, Thread } from "../control/registry.ts";
import type { Changes, Diff, Listing } from "../checkout-files.ts";
import type { Project, SecretGrant } from "../project.ts";
import type { ActualState } from "../reconcile.ts";
import type { WebSocket } from "ws";
import { attachTerminal, processTty } from "./attach.ts";
import { call, CliError, exitCodes, follow, upgrade, type Endpoint, type HostPort } from "./transport.ts";

const version = "0.16.1";
const defaults = { url: "http://rj-firebat.tailc817d3.ts.net:7470", socks: "localhost:1055" };
const configFile = () => join(homedir(), ".config", "nexus", "cli.json");

const usage = `nexus ${version}, the Nexus control plane from this Mac

  nexus events [--follow] [--since ID] [--thread T] [--project P] [--kind K]...
  nexus threads [--project P] [--all]          threads, without deleted ones unless --all
  nexus show <thread>                          a thread with its pylon, sessions, previews and outputs
  nexus ports <thread>                         the TCP ports the pylon listens on, and each one's preview
  nexus preview <thread> <port> [--wait]       publish a port as a preview, and print its URL
  nexus unpreview <thread> <port>              stop publishing a port that preview published
  nexus files <thread> [path]                  a directory of the pylon's checkout
  nexus changes <thread> [--uncommitted | --turn]       the files changed since boot, HEAD, or the latest turn
  nexus diff <thread> [path...] [--uncommitted | --turn]
  nexus conversation <thread>                  the agent's transcript
  nexus session open <thread> [--harness claude-code|pi|shell] [--title T]
  nexus session close <thread> <pane|id>       a session in no pane by its ID, which \`nexus show\` gives
  nexus attach <thread>                        this terminal on the pylon's Herdr sessions, through the control plane
  nexus start --project P [--title T] [--message M | --claude PROMPT [--model ID]] [--node N] [--branch B] [--commit C]
  nexus send <thread> <text...> [--steer] [--request-id ID]
  nexus watch <thread> [--interval MS]
  nexus seen <thread> [--unread]
  nexus abort|retry|retry-pylon|wake <thread>
  nexus archive|unarchive|delete <thread>
  nexus projects
  nexus project edit <id> [--node N] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]
    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...
    [--clear-hosts] [--clear-logins] [--clear-secrets] [--git-name NAME --git-email EMAIL | --clear-git-identity]
  nexus project add <id> (<repo-url> | --scratch) --node N [--branch B] [--cpus n] [--memory GiB] [--disk GiB]
                    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...
  nexus deploy <commit|main> [--wait]
  nexus release
  nexus nodes
  nexus --version

Every command takes --json, --url URL and --socks HOST:PORT|none. The URL and proxy come from those flags,
then NEXUS_URL and NEXUS_SOCKS, then ${configFile()}, then ${defaults.url} through ${defaults.socks}.
`;

type Values = Record<string, string | boolean | string[] | undefined>;
/** `idleMs` is how long the reply may take, 30 s by default. */
type Api = (method: string, path: string, body?: unknown, idleMs?: number) => Promise<unknown>;
/** Follows one of the API's event streams until it ends or `signal` aborts it. */
type Follow = (path: string, onEvent: (data: unknown) => void | Promise<void>, signal: AbortSignal, onCursor?: (id: string) => void) => Promise<void>;
/** What a command prints: its JSON for --json, its text otherwise. */
interface Result { json: unknown; text: string }
/** What attach needs beyond the API. */
interface Local {
  /** A WebSocket to the API, over the same connection as every call. */
  connect(path: string): Promise<WebSocket>;
  /** The settings for attach over ssh that are set, which attach names once, because they do nothing now. */
  retired: readonly string[];
}
interface Command {
  args: readonly [min: number, max: number];
  options?: ParseArgsOptionsConfig;
  /** Nothing when the command printed its own output, as watch does. */
  run(api: Api, args: readonly string[], values: Values, follow: Follow, local: Local): Promise<Result | void>;
}

const str = (v: Values, key: string) => v[key] as string | undefined;
/** A flag given any number of times. */
const strs = (v: Values, key: string) => (v[key] as string[] | undefined) ?? [];
const thread = (id: string) => `/v1/threads/${encodeURIComponent(id)}`;

const hostname = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/**
 * `NAME:HOST[,HOST...]`, such as GH_TOKEN:api.github.com,github.com. A value pasted by mistake, as in NAME=value,
 * fails the name or host check, so it never reaches the API, and the error does not repeat it.
 */
function secretGrantOf(flag: string): SecretGrant {
  const m = /^([A-Z_][A-Z0-9_]*):(.+)$/.exec(flag);
  const hosts = m === null ? [] : m[2]!.split(",");
  if (m === null || !hosts.every((host) => hostname.test(host))) {
    throw new CliError("invalid", "--secret takes NAME:HOST[,HOST...], an upper-case name and lower-case hostnames, such as GH_TOKEN:api.github.com,github.com. The value stays in each node's secret file");
  }
  return { name: m[1]!, hosts };
}

function int(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new CliError("invalid", `${flag} takes a whole number, got ${value}`);
  return n;
}

function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

/** Pads every column but the last. */
function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => i === r.length - 1 ? cell : cell.padEnd(widths[i]!)).join("  ")).join("\n");
}

/** Why the preview cannot answer, such as its service failed, or null. A control plane older than `Preview.failed` sends none, which is no failure. */
const failureOf = (p: Preview): string | null => p.failed ?? null;
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}...`;
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
const entryText = (entry: EntryRecord) => (entry.model ?? []).map(messageText).filter((text) => text !== "").join("\n");

/** What watch and the CLI's renderings read of a conversation. */
type View = Pick<ConversationView, "entries" | "docs">;

const queuedTexts = (view: View) => ((view.docs["pi.inbox"] as InboxState | undefined)?.items ?? [])
  .flatMap((item) => item.mode === "write" ? [] : [contentText(item.content as string | (TextContent | ImageContent)[])]);
const busy = (view: View) => (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;

function conversationText(view: ConversationView): string {
  const parts = [
    ...view.entries.map(entryText).filter((text) => text !== ""),
    ...queuedTexts(view).map((text) => `(queued) > ${text}`),
    ...busy(view) ? ["(the agent is working)"] : [],
  ];
  return parts.length === 0 ? "No messages yet." : parts.join("\n\n");
}

function detailText({ thread: t, pylon: p, agent, sessions, previews, ports, outputs, prWatch, pullRequests, claudeWorker, attention }: ThreadDetail): string {
  const observed = p.observedAt === null ? "" : `, observed ${ago(Date.parse(p.observedAt))}`;
  return [
    `${t.id}  ${t.title}`,
    `project: ${t.project}`,
    ...(claudeWorker === undefined ? [] : [`Claude worker: ${claudeWorker.state}, model ${claudeWorker.model ?? "unknown"}`, ...(claudeWorker.message === undefined ? [] : [`failed: ${claudeWorker.message}`])]),
    `attention: ${attention ?? "none"}`,
    `status: ${t.status}${t.agentTurnRunning ? ", agent working" : ""}`,
    `pylon: ${p.id} on ${p.node}, ${p.actualState}${observed}`,
    ...(p.grantsOutdated ? ["grants: older than project; start a new thread to apply current grants (archive/unarchive keeps these grants)"] : []),
    ...p.failed === null ? [] : [`failed: ${p.failed}`],
    ...p.retryRefused === null ? [] : [`retry refused: ${p.retryRefused}`],
    ...(agent?.parkedTasks ?? 0) === 0 ? [] : [`parked tasks: ${agent!.parkedTasks}. \`nexus retry ${t.id}\` runs them again`],
    // A session in no pane is closed by its ID. A control plane older than `Session.state` sends none, and every session it lists runs.
    ...sessions.map((s) => `session: ${s.harness}${s.title === null ? "" : ` ${JSON.stringify(s.title)}`} ${s.herdrPane === null ? `as ${s.id}` : `in pane ${s.herdrPane}`}, ${s.state === "paused" ? `paused (resumes on ${t.status === "archived" ? "unarchive" : "wake"})`
      : s.state === "failed" ? `failed: ${s.message}` : s.status}`),
    ...previews.map((v) => `preview: ${v.service} at ${v.url}${failureOf(v) !== null ? `, not ready: ${failureOf(v)}` : v.ready ? "" : ", not ready"}`),
    ...(ports ?? []).map((l) => `port: ${l.port}${l.service === null ? "" : `, service ${l.service}`}${l.preview === null ? "" : `, previewed at ${l.preview.url}`}`),
    ...(prWatch?.enabled ? [prWatch.stopped ? "PR watch: stopped (10 comment-only wakes)" : "PR watch: on", ...(prWatch.error ? [prWatch.error] : [])] : ["PR watch: off (no control-plane GitHub token configured)"]),
    ...(pullRequests ?? []).map((pr) => `PR #${pr.number}: ${pr.title} — ${pr.state}, checks ${pr.checks}, review ${pr.review} ${pr.url}`),
    ...outputs.map((o) => `output: ${o.kind} ${o.ref}`),
  ].join("\n");
}

function portsText(ports: ThreadDetail["ports"], id: string): string {
  if (ports === null) return "The pylon's listening ports could not be read.";
  if (ports.length === 0) return "No listening ports.";
  return [
    table(ports.map((l) => [String(l.port), l.service ?? "-", l.preview === null ? "-" : `${l.preview.url}${failureOf(l.preview) !== null ? ` (not ready: ${failureOf(l.preview)})` : l.preview.ready ? "" : " (not served yet)"}`])),
    ...ports.some((l) => l.preview === null) ? [`\`nexus preview ${id} <port>\` publishes a port.`] : [],
  ].join("\n");
}

function portArg(given: string): number {
  const port = Number(given);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("invalid", `the port must be a whole number from 1 to 65535, got ${given}`);
  return port;
}

/** A diff of a large tree can take the pylon a while. */
const checkoutReadMs = 120_000;
const baseQuery = (v: Values) => {
  if (v.uncommitted === true && v.turn === true) throw new CliError("invalid", "--turn and --uncommitted cannot be used together");
  return v.turn === true ? "base=turn" : v.uncommitted === true ? "base=head" : "base=start";
};

function listingText(l: Listing): string {
  const where = l.path === "" ? "the checkout" : l.path;
  if (l.entries.length === 0) return `${where} is empty.`;
  return [
    // A directory has no size, so its padding is trimmed.
    table(l.entries.map((e) => [e.kind === "dir" ? `${e.name}/` : e.kind === "symlink" ? `${e.name}@` : e.name, e.size === null ? "" : String(e.size)])).replace(/ +$/gm, ""),
    ...l.truncated ? [`Only the first ${l.entries.length} entries of ${where} are listed.`] : [],
  ].join("\n");
}

function changesText(c: Changes): string {
  const { kind, commit } = c.base;
  const since = kind === "turn" ? `the latest turn began, ${commit?.slice(0, 12)}` : kind === "start"
    ? commit === null ? "the pylon booted an empty repository" : `the commit the pylon booted at, ${commit.slice(0, 12)}`
    : commit === null ? "HEAD, which names no commit yet" : `HEAD, ${commit.slice(0, 12)}`;
  if (c.files.length === 0) return `No changes since ${since}.`;
  return [
    `Changes since ${since}:`,
    table(c.files.map((f) => [f.status, f.additions === null ? "binary" : `+${f.additions} -${f.deletions}`, f.oldPath === null ? f.path : `${f.path} (from ${f.oldPath})`])),
    ...c.truncated ? [`Only the first ${c.files.length} files are listed.`] : [],
  ].join("\n");
}

const waitMs = 120_000;
/** Longer than the probe takes to answer a command, at most 90 s. */
const sessionOpenMs = 120_000;
const waitPollMs = 1_000;

/** Polls the thread until its node reports the port listening and its preview published and warmed. */
async function served(api: Api, id: string, port: number): Promise<Preview> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const d = await api("GET", thread(id)) as ThreadDetail;
    const preview = d.ports?.find((l) => l.port === port)?.preview;
    if (preview?.ready === true) return preview;
    if (Date.now() >= deadline) {
      const why = preview && failureOf(preview) !== null ? `, because ${failureOf(preview)}` : "";
      throw new CliError("failed", `port ${port} of ${id} was not served within ${waitMs / 1000} s${why}. \`nexus ports ${id}\` shows whether it listens and whether its preview is published`);
    }
    await sleep(waitPollMs);
  }
}

/**
 * Sends a request that needs the pylon running, such as an unlink or a session open. Each try is human activity, so
 * the first wakes a paused pylon, and a 409 is tried again once a second until the pylon runs, unless the thread is
 * archived or deleted. `undone` says what the failure after the wait leaves undone.
 */
async function whenRunning<T>(api: Api, id: string, send: () => Promise<T>, undone: string): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof CliError) || err.kind !== "conflict") throw err;
      const { status } = (await api("GET", thread(id)) as ThreadDetail).thread;
      if (status === "archived" || status === "deleted") throw err;
      if (Date.now() >= deadline) throw new CliError("failed", `the pylon of ${id} did not run within ${waitMs / 1000} s, so ${undone}. ${err.message}`);
    }
    await sleep(waitPollMs);
  }
}

const threadRow = (t: ThreadRow) => [t.id, t.status, t.agentTurnRunning ? "working" : "-", `pylon ${t.pylon.actualState}`, t.project, ago(t.createdAt), t.title];

/** The first line of a message, as the title of the thread it starts. */
const titleOf = (message: string) => clip(message.split("\n").find((line) => line.trim() !== "")?.trim() ?? message, 80);

async function send(api: Api, id: string, text: string, steer: boolean, requestId: string): Promise<{ submission: number }> {
  return await api("POST", `${thread(id)}/messages`, { text, requestId, mode: steer ? "steer" : "followUp" }) as { submission: number };
}

/** A thread action whose route answers 204. Its JSON is null. */
const action = (path: string, done: string, body?: unknown): Command => ({
  args: [1, 1],
  async run(api, [id]) {
    await api("POST", `${thread(id!)}/${path}`, body);
    return { json: null, text: `${done} ${id}.` };
  },
});

/** A thread action whose route answers the thread. */
const statusChange = (method: string, path: string, done: string): Command => ({
  args: [1, 1],
  async run(api, [id]) {
    const t = await api(method, `${thread(id!)}${path}`) as Thread;
    return { json: t, text: `${done} ${t.id}.` };
  },
});

/** What watch reports of a thread, as one event whenever any of it changes. */
export interface WatchState {
  type: "state";
  thread: string;
  status: Thread["status"];
  /** Parked when a task hit the restart limit and holds the run until `nexus retry`. */
  run: "idle" | "working" | "parked";
  parkedTasks: number;
  /** Messages waiting for the current run to finish. */
  queued: number;
  pylon: ActualState;
  failed: string | null;
  /** ThreadDetail's ports. */
  ports: ThreadDetail["ports"];
}
/** What watch reports of the run in flight, as one event whenever any of it changes. */
export interface WatchLive {
  type: "live";
  thread: string;
  /** The text of each message waiting for the current run to finish. */
  queued: string[];
  /** The output so far of each tool call still running, by the toolCall's id in the entries. */
  tools: { callId: string; output: string }[];
  /** The answer streaming now, its text parts joined. */
  partial: string | null;
  /** The error of a model request waiting to be retried. */
  retry: string | null;
}
/** An entry with the CLI's plain rendering of its messages. */
export interface RenderedEntry { entry: EntryRecord; text: string }
export type WatchEvent =
  | { type: "reset"; thread: string; entries: RenderedEntry[] }
  | { type: "entry"; thread: string } & RenderedEntry
  | WatchState
  | WatchLive
  | { type: "error"; thread: string; kind: "unreachable" | "failed"; message: string };

function stateOf(d: ThreadDetail, view: View | null): WatchState {
  const parkedTasks = d.agent?.parkedTasks ?? 0;
  return {
    type: "state", thread: d.thread.id, status: d.thread.status,
    run: parkedTasks > 0 ? "parked" : view !== null && busy(view) ? "working" : "idle",
    parkedTasks, queued: view === null ? 0 : queuedTexts(view).length, pylon: d.pylon.actualState, failed: d.pylon.failed, ports: d.ports,
  };
}

function liveOf(id: string, view: View | null): WatchLive {
  const live = view?.docs["pi.live"] as LiveState | undefined;
  const generation = live?.generation;
  const partial = generation?.message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
  return {
    type: "live", thread: id, queued: view === null ? [] : queuedTexts(view),
    tools: (live?.tools ?? []).flatMap((slot) => slot.status === "running" ? [{ callId: slot.callId, output: slot.output ?? "" }] : []),
    partial: partial === "" ? null : partial, retry: generation?.retry?.error ?? null,
  };
}

function stateText(s: WatchState): string {
  const run = s.run === "working" ? ", agent working" : s.run === "parked" ? `, ${s.parkedTasks} parked tasks hold the run` : "";
  const ports = (s.ports ?? []).map((l: ListeningPort) => l.preview?.ready === true ? `${l.port} at ${l.preview.url}` : String(l.port));
  return `-- ${s.status}, pylon ${s.pylon}${s.failed === null ? "" : ` (${s.failed})`}${run}${s.queued === 0 ? "" : `, ${s.queued} queued`}${ports.length === 0 ? "" : `, listening on ${ports.join(", ")}`}`;
}

/**
 * Follows the thread's conversation as the API streams it, and polls the thread. The conversation is pi-durable's
 * active context, not the full history: a new head marker, a compaction or a delete can reorder or drop entries.
 * So the first print shows the context whole, a later one that only appends prints each new entry, and any other
 * change prints it whole again. Then the thread's state and the run in flight, when they changed. Every print
 * comes from the latest of both sources, so an answer's entry is printed before the live event that drops its
 * partial. An unreachable or failing control plane is reported once and retried through, so a live pane survives
 * a restart of the control plane. Ends after the state that says the thread is deleted, or once the process that
 * started it is gone.
 */
async function watch(api: Api, follow: Follow, id: string, intervalMs: number, json: boolean): Promise<void> {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => process.exit(0));
  // A consumer that closes the pipe is done reading.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
    process.exit(0);
  });
  // A consumer killed outright never closes the pipe, and an idle thread prints nothing that would find it closed.
  const parent = process.ppid;
  const emit = (event: WatchEvent, text: string) => {
    if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
    else if (text !== "") process.stdout.write(`${text}\n`);
  };
  const rendered = (entry: EntryRecord): RenderedEntry => ({ entry, text: entryText(entry) });
  const joined = (entries: readonly RenderedEntry[]) => entries.map((e) => e.text).filter((text) => text !== "").join("\n");
  /** The IDs of the active context as last printed, or null before the first print. */
  let printed: number[] | null = null;
  let shown: string | null = null;
  let liveShown: string | null = null;
  /** The thread as last polled, and its conversation as last streamed. */
  let detail: ThreadDetail | null = null;
  let streamed: View | null = null;
  /** What each source failed with last, while it fails. After an outage the state is printed again. */
  const failing = new Map<"poll" | "stream", string>();
  let recovered = false;
  const failed = (source: "poll" | "stream", err: unknown) => {
    if (!(err instanceof CliError) || (err.kind !== "unreachable" && err.kind !== "failed")) throw err;
    if (![...failing.values()].includes(err.message)) emit({ type: "error", thread: id, kind: err.kind, message: err.message }, `-- ${err.message}. Retrying`);
    failing.set(source, err.message);
  };
  const succeeded = (source: "poll" | "stream") => {
    if (failing.delete(source) && failing.size === 0) recovered = true;
  };

  function print() {
    const d = detail;
    // A thread with a conversation waits for its first frame.
    if (d === null || (d.agent !== null && streamed === null)) return;
    const view = d.agent === null ? null : streamed;
    // Without a conversation, the entries last printed stand. The first print shows an empty context.
    const entries: readonly EntryRecord[] | null = view?.entries ?? (printed === null ? [] : null);
    if (entries !== null) {
      const before = printed;
      const appended = before !== null && entries.length >= before.length && before.every((entryId, i) => entries[i]!.id === entryId);
      if (appended) {
        for (const entry of entries.slice(before.length)) {
          const e = rendered(entry);
          emit({ type: "entry", thread: id, ...e }, e.text);
        }
      } else {
        const all = entries.map(rendered);
        emit({ type: "reset", thread: id, entries: all }, before === null ? joined(all) : `-- The conversation was rewritten. It now reads:\n${joined(all)}`);
      }
      printed = entries.map((e) => e.id);
    }
    const state = stateOf(d, view);
    const key = JSON.stringify(state);
    // After an outage the state is printed again, which tells the consumer the control plane is back.
    if (key !== shown || recovered) emit(state, stateText(state));
    shown = key;
    recovered = false;
    // The text stream already says what the state does of the run, so only JSON carries it.
    const live = liveOf(id, view);
    const liveKey = JSON.stringify(live);
    if (liveKey !== liveShown) emit(live, "");
    liveShown = liveKey;
  }

  const stop = new AbortController();
  /**
   * Each connection's first frame is the whole view, and each later one replaces what changed. A dropped stream
   * is opened again after 100 ms, doubling up to the poll interval, and from 100 ms again once a frame arrives.
   * A thread without a conversation, or a deleted one, refuses the stream, and never streams again.
   */
  async function stream() {
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      let first = true;
      try {
        await follow(`${thread(id)}/events`, (data) => {
          const frame = data as ViewFrame;
          const docs = { ...first ? {} : streamed!.docs, ...frame.docs };
          for (const [kind, doc] of Object.entries(docs)) if (doc === null) delete docs[kind];
          streamed = { entries: frame.entries ?? streamed!.entries, docs: docs as View["docs"] };
          first = false;
          attempt = 0;
          succeeded("stream");
          print();
        }, stop.signal);
      } catch (err) {
        if (err instanceof CliError && err.kind === "conflict") return;
        failed("stream", err);
      }
      await sleep(Math.min(100 * 2 ** attempt, intervalMs), undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  async function poll() {
    while (!stop.signal.aborted) {
      try {
        detail = await api("GET", thread(id)) as ThreadDetail;
        succeeded("poll");
        print();
        if (detail.thread.status === "deleted") return;
      } catch (err) {
        failed("poll", err);
      }
      await sleep(intervalMs, undefined, { signal: stop.signal }).catch(() => {});
      if (process.ppid !== parent) return;
    }
  }
  // Only the poll ends the watch. The stream stops early for a thread without a conversation, which leaves the
  // watch running, or with a failure such as a refusal, which ends it.
  const streaming = stream();
  try {
    await Promise.race([poll(), streaming.then(() => new Promise<never>(() => {}))]);
  } finally {
    stop.abort();
  }
}

function releaseText(view: ReleaseView): string {
  return [`Desired: ${view.desired === null ? "none" : `${view.desired.commit} by ${view.desired.requestedBy} at ${new Date(view.desired.requestedAt).toISOString()}`}`,
    ...view.nodes.map((r) => `${r.node} ${r.role}: ${r.commit ?? "unknown"} ${r.state}${r.reason === null ? "" : `: ${r.reason}`}`)].join("\n");
}

const commands: Readonly<Record<string, Command>> = {
  events: {
    args: [0, 0],
    options: { follow: { type: "boolean" }, since: { type: "string" }, thread: { type: "string" }, project: { type: "string" }, kind: { type: "string", multiple: true } },
    async run(api, _, v, follow) {
      const query = new URLSearchParams();
      for (const key of ["since", "thread", "project"]) if (str(v, key) !== undefined) query.set(key, str(v, key)!);
      for (const kind of strs(v, "kind")) query.append("kind", kind);
      const print = async (event: NexusEvent, signal?: AbortSignal) => {
        const line = v.json ? JSON.stringify(event) : `${event.id} ${new Date(event.time).toISOString()} ${event.thread ?? "-"} ${event.kind} ${JSON.stringify(event.payload)}`;
        if (!process.stdout.write(line + "\n")) await once(process.stdout, "drain", { signal });
        query.set("since", event.id);
      };
      if (v.follow !== true) {
        for (const event of await api("GET", `/v1/events?${query}`) as NexusEvent[]) await print(event);
        return;
      }
      query.set("follow", "true");
      const stop = new AbortController();
      const end = () => { stop.abort(); process.exit(0); };
      const parent = process.ppid;
      const orphan = setInterval(() => { if (process.ppid !== parent) end(); }, 1000);
      const outputError = (err: NodeJS.ErrnoException) => { if (err.code === "EPIPE") end(); else throw err; };
      process.stdout.on("error", outputError);
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      for (const signal of signals) process.once(signal, end);
      try {
        while (!stop.signal.aborted) {
          try { await follow(`/v1/events?${query}`, (data) => print(data as NexusEvent, stop.signal), stop.signal, (id) => query.set("since", id)); }
          catch (err) {
            if (err instanceof CliError && err.kind !== "unreachable" && err.kind !== "failed") throw err;
            if (!stop.signal.aborted) console.error(`nexus: ${(err as Error).message}; reconnecting`);
          }
          await sleep(1000, undefined, { signal: stop.signal }).catch(() => undefined);
        }
      } finally {
        clearInterval(orphan);
        process.stdout.removeListener("error", outputError);
        for (const signal of signals) process.removeListener(signal, end);
      }
    },
  },
  release: {
    args: [0, 0],
    async run(api) {
      const view = await api("GET", "/v1/release") as ReleaseView;
      return { json: view, text: releaseText(view) };
    },
  },
  deploy: {
    args: [1, 1], options: { wait: { type: "boolean" } },
    async run(api, [commit], values) {
      if (commit !== "main" && !/^[0-9a-f]{40}$/.test(commit!)) throw new CliError("invalid", "deploy takes main or a full lower-case commit hash");
      let view = await api("PUT", "/v1/release", { commit }) as ReleaseView;
      const target = view.desired!.commit;
      const deadline = Date.now() + 30 * 60_000;
      while (values.wait === true) {
        const outcome = releaseOutcome(view, target);
        if (outcome === "healthy") break;
        if (outcome === "failed") throw new CliError("failed", releaseText(view));
        if (outcome === "superseded") throw new CliError("conflict", `deployment superseded\n${releaseText(view)}`);
        if (Date.now() >= deadline) throw new CliError("failed", `deployment wait timed out\n${releaseText(view)}`);
        await sleep(1_000);
        try { view = await api("GET", "/v1/release") as ReleaseView; }
        catch (error) { if (!(error instanceof CliError) || error.kind !== "unreachable") throw error; }
      }
      return { json: view, text: releaseText(view) };
    },
  },
  threads: {
    args: [0, 0],
    options: { project: { type: "string" }, all: { type: "boolean" } },
    async run(api, _, v) {
      const project = str(v, "project");
      const threads = await api("GET", `/v1/threads${project === undefined ? "" : `?project=${encodeURIComponent(project)}`}`) as ThreadRow[];
      const shown = v.all === true ? threads : threads.filter((t) => t.status !== "deleted");
      return { json: shown, text: shown.length === 0 ? "No threads." : table(shown.map(threadRow)) };
    },
  },
  show: {
    args: [1, 1],
    async run(api, [id]) {
      const d = await api("GET", thread(id!)) as ThreadDetail;
      return { json: d, text: detailText(d) };
    },
  },
  ports: {
    args: [1, 1],
    async run(api, [id]) {
      const d = await api("GET", thread(id!)) as ThreadDetail;
      return { json: d.ports, text: portsText(d.ports, id!) };
    },
  },
  preview: {
    args: [2, 2],
    options: { wait: { type: "boolean" } },
    async run(api, [id, given], v) {
      const port = portArg(given!);
      const linked = await api("POST", `${thread(id!)}/previews`, { port }) as Preview;
      const preview = v.wait === true ? await served(api, id!, port) : linked;
      return { json: preview, text: failureOf(preview) !== null ? `${preview.url} (not ready: ${failureOf(preview)})` : preview.ready ? preview.url : `${preview.url} (not served yet. \`--wait\` waits until it is)` };
    },
  },
  unpreview: {
    args: [2, 2],
    async run(api, [id, given]) {
      const port = portArg(given!);
      await whenRunning(api, id!, () => api("DELETE", `${thread(id!)}/previews/${port}`, {}), `port ${port} is still published`);
      return { json: null, text: `Unpublished port ${port} of ${id}.` };
    },
  },
  files: {
    args: [1, 2],
    async run(api, [id, path = ""]) {
      const l = await whenRunning(api, id!, () => api("GET", `${thread(id!)}/files?path=${encodeURIComponent(path)}`, undefined, checkoutReadMs), "nothing was listed") as Listing;
      return { json: l, text: listingText(l) };
    },
  },
  changes: {
    args: [1, 1],
    options: { uncommitted: { type: "boolean" }, turn: { type: "boolean" } },
    async run(api, [id], v) {
      const c = await whenRunning(api, id!, () => api("GET", `${thread(id!)}/changes?${baseQuery(v)}`, undefined, checkoutReadMs), "no changes were read") as Changes;
      return { json: c, text: changesText(c) };
    },
  },
  diff: {
    args: [1, Infinity],
    options: { uncommitted: { type: "boolean" }, turn: { type: "boolean" } },
    async run(api, [id, ...paths], v) {
      const query = [baseQuery(v), ...paths.map((p) => `path=${encodeURIComponent(p)}`)].join("&");
      const d = await whenRunning(api, id!, () => api("GET", `${thread(id!)}/diff?${query}`, undefined, checkoutReadMs), "no diff was read") as Diff;
      const text = d.diff === "" ? "No changes." : d.diff.replace(/\n$/, "");
      return { json: d, text: d.truncated ? `${text}\n[The diff stops here, at its 4 MiB limit. Name paths to see the rest.]` : text };
    },
  },
  conversation: {
    args: [1, 1],
    async run(api, [id]) {
      const view = await api("GET", `${thread(id!)}/conversation`) as ConversationView;
      return { json: view, text: conversationText(view) };
    },
  },
  "session open": {
    args: [1, 1],
    options: { harness: { type: "string" }, title: { type: "string" } },
    async run(api, [id], v) {
      const body = Object.fromEntries((["harness", "title"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
      // The API answers once the agent is ready or waits for its human, which can take a minute.
      const opened = await whenRunning(api, id!, () => api("POST", `${thread(id!)}/sessions`, body, sessionOpenMs), "no session was opened") as OpenedSession;
      return { json: opened, text: `Opened ${opened.harness} session ${JSON.stringify(opened.title)} in pane ${opened.herdrPane} of ${id}. \`nexus attach ${id}\` attaches to it.` };
    },
  },
  // Not tried again on a 409: a paused session comes back with its pylon's wake, and a pane asked for before the wake
  // may name another session after it.
  "session close": {
    args: [2, 2],
    async run(api, [id, session]) {
      await api("DELETE", `${thread(id!)}/sessions/${encodeURIComponent(session!)}`, {});
      return { json: null, text: `Closed session ${session} of ${id}.` };
    },
  },
  attach: {
    args: [1, 1],
    async run(_api, [id], _values, _follow, local) {
      const { retired } = local;
      if (retired.length > 0) process.stderr.write(`nexus: attach ignores ${retired.join(" and ")} now that it goes through the control plane. Remove ${retired.length === 1 ? "it" : "them"}\n`);
      await attachTerminal(local.connect, id!, processTty());
    },
  },
  start: {
    args: [0, 0],
    options: { model: { type: "string" }, claude: { type: "string" }, project: { type: "string" }, title: { type: "string" }, message: { type: "string" }, node: { type: "string" }, branch: { type: "string" }, commit: { type: "string" } },
    async run(api, _, v) {
      const project = str(v, "project");
      const message = str(v, "message");
      const claude = str(v, "claude");
      if (v.model !== undefined && claude === undefined) throw new CliError("invalid", "--model requires --claude");
      if (message !== undefined && claude !== undefined) throw new CliError("invalid", "--claude and --message are mutually exclusive");
      const title = str(v, "title") ?? (message === undefined && claude === undefined ? undefined : titleOf(message ?? claude!));
      if (project === undefined) throw new CliError("invalid", "start needs --project");
      if (title === undefined) throw new CliError("invalid", "start needs --title, --message or --claude");
      const optional = Object.fromEntries((["node", "branch", "commit", "claude", "model"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
      const t = await api("POST", "/v1/threads", { project, title, ...optional }) as Thread;
      if (message !== undefined) {
        await send(api, t.id, message, false, `msg:${randomUUID()}`).catch((err: unknown) => {
          throw err instanceof CliError ? new CliError(err.kind, `started ${t.id}, but its first message was not sent: ${err.message}`, err.status) : err;
        });
      }
      return { json: t, text: `Started ${t.id} on ${t.project}: ${t.title}${message === undefined ? "" : "\nSent the first message."}` };
    },
  },
  send: {
    args: [2, Infinity],
    options: { steer: { type: "boolean" }, "request-id": { type: "string" } },
    async run(api, [id, ...words], v) {
      const steer = v.steer === true;
      // The API treats a resend with the same request ID as the same message, so a caller that retries passes one.
      const reply = await send(api, id!, words.join(" "), steer, str(v, "request-id") ?? `msg:${randomUUID()}`);
      return { json: reply, text: steer ? `Sent to ${id}, to join the current run after its tool round.` : `Sent to ${id}.` };
    },
  },
  watch: {
    args: [1, 1],
    options: { interval: { type: "string" } },
    async run(api, [id], v, follow) {
      const interval = int(str(v, "interval"), "--interval", 2000);
      if (interval === 0) throw new CliError("invalid", "--interval must be above 0");
      await watch(api, follow, id!, interval, v.json === true);
    },
  },
  seen: {
    args: [1, 1],
    options: { unread: { type: "boolean" } },
    async run(api, [id], v) {
      await api("POST", `${thread(id!)}/${v.unread ? "unseen" : "seen"}`, {});
      return { json: null, text: `Marked ${id} ${v.unread ? "unread" : "seen"}.` };
    },
  },
  abort: action("abort", "Aborted the run of"),
  retry: action("retry", "Retried the parked tasks of"),
  "retry-pylon": action("pylon/retry", "Retried the pylon of"),
  wake: action("activity", "Recorded activity on", { kind: "human" }),
  archive: statusChange("POST", "/archive", "Archived"),
  unarchive: statusChange("POST", "/unarchive", "Unarchived"),
  delete: statusChange("DELETE", "", "Deleted"),
  projects: {
    args: [0, 0],
    async run(api) {
      const projects = await api("GET", "/v1/projects") as Project[];
      return { json: projects, text: projects.length === 0 ? "No projects." : table(projects.map((p) => [p.id, `node ${p.defaultNode}`, `branch ${p.defaultBranch}`, p.repoUrl ?? "scratch"])) };
    },
  },
  "project edit": {
    args: [1, 1],
    options: {
      node: { type: "string" }, branch: { type: "string" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" },
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      "clear-hosts": { type: "boolean" }, "clear-logins": { type: "boolean" }, "clear-secrets": { type: "boolean" },
      "git-name": { type: "string" }, "git-email": { type: "string" }, "clear-git-identity": { type: "boolean" },
    },
    async run(api, [id], v) {
      const patch: Record<string, unknown> = {};
      for (const [flag, field] of [["node", "defaultNode"], ["branch", "defaultBranch"]] as const) {
        if (v[flag] !== undefined) patch[field] = str(v, flag);
      }
      const resources: Partial<Project["resources"]> = {};
      for (const [flag, field] of [["cpus", "cpus"], ["memory", "memoryGiB"], ["disk", "diskGiB"]] as const) {
        if (v[flag] !== undefined) resources[field] = int(str(v, flag), `--${flag}`, 0);
      }
      if (Object.keys(resources).length > 0) patch.resources = resources;
      for (const [flag, clear, field] of [["allow-host", "clear-hosts", "allowedHosts"], ["login", "clear-logins", "logins"], ["secret", "clear-secrets", "secrets"]] as const) {
        if (v[clear] && v[flag] !== undefined) throw new CliError("invalid", `--${clear} conflicts with --${flag}`);
        if (v[clear] || v[flag] !== undefined) patch[field] = flag === "secret" ? strs(v, flag).map(secretGrantOf) : strs(v, flag);
      }
      const name = str(v, "git-name"), email = str(v, "git-email");
      if ((name === undefined) !== (email === undefined) || (v["clear-git-identity"] && name !== undefined)) throw new CliError("invalid", "use --git-name with --git-email, or --clear-git-identity");
      if (v["clear-git-identity"]) patch.gitIdentity = null;
      else if (name !== undefined) patch.gitIdentity = { name, email };
      const p = await api("PATCH", `/v1/projects/${encodeURIComponent(id!)}`, patch) as Project;
      return { json: p, text: `Updated project ${p.id}. Existing threads keep their boot settings and grants; start a new thread to apply them.` };
    },
  },
  "project add": {
    args: [1, 2],
    options: {
      node: { type: "string" }, branch: { type: "string" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" },
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      scratch: { type: "boolean" },
    },
    async run(api, [id, url], v) {
      // A forgotten URL must not quietly make a scratch project.
      if ((url === undefined) === (v.scratch !== true)) throw new CliError("invalid", "project add takes a <repo-url> or --scratch, and not both");
      const repoUrl = url ?? null;
      const resources = { cpus: int(str(v, "cpus"), "--cpus", 2), memoryGiB: int(str(v, "memory"), "--memory", 4), diskGiB: int(str(v, "disk"), "--disk", 10) };
      const secrets = strs(v, "secret").map(secretGrantOf);
      const node = str(v, "node");
      if (node === undefined) throw new CliError("invalid", "project add needs --node. Run nexus nodes to list them");
      const p = await api("POST", "/v1/projects", {
        id, repoUrl, defaultBranch: str(v, "branch") ?? "main", defaultNode: node, resources,
        allowedHosts: strs(v, "allow-host"), secrets, logins: strs(v, "login"), preSetup: null,
      }) as Project;
      return { json: p, text: p.repoUrl === null ? `Added scratch project ${p.id} on ${p.defaultNode}` : `Added project ${p.id} (${p.repoUrl}) on ${p.defaultNode}` };
    },
  },
  nodes: {
    args: [0, 0],
    async run(api) {
      const nodes = await api("GET", "/v1/nodes") as NodeSummary[];
      return {
        json: nodes,
        text: nodes.length === 0 ? "No nodes." : table(nodes.map((n) => [
          n.name, n.state, n.observedAt === null ? "never observed" : `observed ${ago(Date.parse(n.observedAt))}`,
          n.capacity === null ? "" : `${n.capacity.committedMemoryGiB}/${n.capacity.memoryGiB} GiB committed, ${n.capacity.diskFreeGiB} GiB disk free`,
        ])),
      };
    },
  },
};

/**
 * Keys that CLIs before 0.9.0 read for attach over ssh. They still parse, so a config that has them keeps working,
 * and attach names the ones that are set.
 */
const retiredKeys = ["ssh", "attach"] as const;
const configSchema = z.strictObject({
  url: z.string().optional(), socks: z.string().optional(),
  ...Object.fromEntries(retiredKeys.map((key) => [key, z.unknown().optional()])) as Record<(typeof retiredKeys)[number], z.ZodOptional<z.ZodUnknown>>,
});

async function readConfig(file: string): Promise<z.infer<typeof configSchema>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError("invalid", `cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError("invalid", `${file} is not JSON: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) throw new CliError("invalid", `${file} is not a CLI config: ${z.prettifyError(result.error)}`);
  return result.data;
}

/** Each setting from its flag, then the environment, then the config file, then the default. */
async function settings(v: Values): Promise<{ endpoint: Endpoint; retired: string[] }> {
  const config = await readConfig(configFile());
  const env = (name: string) => process.env[name] || undefined;
  const retired = [
    ...retiredKeys.filter((key) => config[key] !== undefined).map((key) => `"${key}" in ${configFile()}`),
    ...env("NEXUS_ATTACH") === undefined ? [] : ["NEXUS_ATTACH"],
  ];
  const url = str(v, "url") ?? env("NEXUS_URL") ?? config.url ?? defaults.url;
  const socks = str(v, "socks") ?? env("NEXUS_SOCKS") ?? config.socks ?? defaults.socks;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("invalid", `the control plane URL ${url} is not a URL`);
  }
  if (parsed.protocol !== "http:") throw new CliError("invalid", `the control plane URL ${url} must be http://, which is what the API serves on the tailnet`);
  return { endpoint: { url: parsed, socks: socks === "none" ? null : hostPort(socks) }, retired };
}

function hostPort(value: string): HostPort {
  const m = /^(.+):(\d+)$/.exec(value);
  if (m === null || Number(m[2]) > 65535) throw new CliError("invalid", `the SOCKS proxy ${value} must be HOST:PORT or none`);
  return { host: m[1]!, port: Number(m[2]) };
}

const globalOptions: ParseArgsOptionsConfig = {
  json: { type: "boolean" }, url: { type: "string" }, socks: { type: "string" }, help: { type: "boolean", short: "h" },
};

/** The entries of `usage` that name the command: `abort|retry <thread>` names abort and retry, `project edit <id>` names project edit. */
function usageOf(name: string): string {
  const entries = usage.match(/^  nexus .*(?:\n {4}.*)*/gm) ?? [];
  return `${entries.filter((entry) => {
    const [, first, second] = entry.trim().split(/\s+/);
    return first!.split("|").includes(name) || `${first} ${second}` === name;
  }).join("\n")}\n`;
}

async function run(argv: readonly string[]): Promise<void> {
  // `project add` and `session open` and `close` are the commands of two words.
  const twoWords = Object.hasOwn(commands, `${argv[0]} ${argv[1]}`);
  const name = twoWords ? `${argv[0]} ${argv[1]}` : argv[0];
  const rest = argv.slice(twoWords ? 2 : 1);
  const command = Object.hasOwn(commands, name!) ? commands[name!]! : undefined;
  if (command === undefined) throw new CliError("invalid", argv.length === 0 ? "no command given" : `unknown command ${name}`);
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...rest], options: { ...command.options, ...globalOptions }, allowPositionals: true, strict: true }) as typeof parsed;
  } catch (err) {
    throw new CliError("invalid", (err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(usageOf(name!));
    return;
  }
  const [min, max] = command.args;
  if (positionals.length < min || positionals.length > max) {
    throw new CliError("invalid", `${name} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, got ${positionals.length}`);
  }
  const { endpoint: target, retired } = await settings(values);
  const result = await command.run((method, path, body, idleMs) => call(target, method, path, body, idleMs), positionals, values,
    (path, onEvent, signal, onCursor) => follow(target, path, onEvent, signal, onCursor), { connect: (path) => upgrade(target, path), retired });
  if (result !== undefined) process.stdout.write(`${values.json === true ? JSON.stringify(result.json, null, 2) : result.text}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "version") {
    process.stdout.write(`nexus ${version}\n`);
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(usage);
    return 0;
  }
  try {
    await run(argv);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const json = argv.includes("--json");
    process.stderr.write(json ? `${JSON.stringify({ error: err.message, kind: err.kind, status: err.status })}\n`
      : argv.length === 0 ? usage : `nexus: ${err.message}${err.kind === "invalid" && err.status === null ? ". Run nexus --help for usage" : ""}\n`);
    return exitCodes[err.kind];
  }
}

process.exitCode = await main(process.argv.slice(2));
