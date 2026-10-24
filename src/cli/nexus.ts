/**
 * The Mac's nexus CLI: the control plane's API as commands, for a human at a shell and for the Claude Code and pi
 * integrations, which shell out to it. docs/cli.md is the contract: the commands, their JSON, the exit codes and
 * the watch stream. --json prints the API's reply as it is, except where docs/cli.md says otherwise.
 */
import { spawn } from "node:child_process";
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
import { call, CliError, exitCodes, follow, type Endpoint, type HostPort } from "./transport.ts";

const version = "0.7.0";
const defaults = { url: "http://rj-firebat.tailc817d3.ts.net:7470", socks: "localhost:1055" };
const configFile = () => join(homedir(), ".config", "nexus", "cli.json");

const usage = `nexus ${version}, the Nexus control plane from this Mac

  nexus threads [--project P] [--all]          threads, without deleted ones unless --all
  nexus show <thread>                          a thread with its pylon, sessions, previews and outputs
  nexus ports <thread>                         the TCP ports the pylon listens on, and each one's preview
  nexus preview <thread> <port> [--wait]       publish a port as a preview, and print its URL
  nexus unpreview <thread> <port>              stop publishing a port that preview published
  nexus files <thread> [path]                  a directory of the pylon's checkout
  nexus changes <thread> [--uncommitted]       the files changed since the pylon booted, or since HEAD
  nexus diff <thread> [path...] [--uncommitted]
  nexus conversation <thread>                  the agent's transcript
  nexus session open <thread> [--harness claude-code|pi|shell] [--title T]
  nexus session close <thread> <pane|id>       a session in no pane by its ID, which \`nexus show\` gives
  nexus attach <thread>                        a terminal on the pylon's Herdr sessions, over ssh to its node
  nexus start --project P [--title T] [--message M] [--node N] [--branch B] [--commit C]
  nexus send <thread> <text...> [--steer] [--request-id ID]
  nexus watch <thread> [--interval MS]
  nexus abort|retry|retry-pylon|wake <thread>
  nexus archive|unarchive|delete <thread>
  nexus projects
  nexus project add <id> (<repo-url> | --scratch) --node N [--branch B] [--cpus n] [--memory GiB] [--disk GiB]
                    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...
  nexus nodes
  nexus --version

Every command takes --json, --url URL and --socks HOST:PORT|none. The URL and proxy come from those flags,
then NEXUS_URL and NEXUS_SOCKS, then ${configFile()}, then ${defaults.url} through ${defaults.socks}.
attach runs ssh to the node, or to the config's "ssh" destination for it, through the same proxy, or else
NEXUS_ATTACH, or the config's "attach", with sh.
`;

type Values = Record<string, string | boolean | string[] | undefined>;
/** `idleMs` is how long the reply may take, 30 s by default. */
type Api = (method: string, path: string, body?: unknown, idleMs?: number) => Promise<unknown>;
/** Follows one of the API's event streams until it ends or `signal` aborts it. */
type Follow = (path: string, onEvent: (data: unknown) => void, signal: AbortSignal) => Promise<void>;
/** What a command prints: its JSON for --json, its text otherwise. */
interface Result { json: unknown; text: string }
/** What a command that runs a program on this Mac, as attach does, needs beyond the API. */
interface Local {
  socks: HostPort | null;
  /** The attach command that replaces ssh's, run with sh. */
  attach: string | null;
  /** ssh's destination for each node named here, such as `user@host` or an ssh config alias, instead of its tailnetHost. */
  ssh: Readonly<Record<string, string>>;
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

/** Why the preview's service failed, or null. A control plane older than `Preview.failed` sends none, which is no failure. */
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

function detailText({ thread: t, pylon: p, agent, sessions, previews, ports, outputs }: ThreadDetail): string {
  const observed = p.observedAt === null ? "" : `, observed ${ago(Date.parse(p.observedAt))}`;
  return [
    `${t.id}  ${t.title}`,
    `project: ${t.project}`,
    `status: ${t.status}${t.agentTurnRunning ? ", agent working" : ""}`,
    `pylon: ${p.id} on ${p.node}, ${p.actualState}${observed}`,
    ...p.failed === null ? [] : [`failed: ${p.failed}`],
    ...p.retryRefused === null ? [] : [`retry refused: ${p.retryRefused}`],
    ...(agent?.parkedTasks ?? 0) === 0 ? [] : [`parked tasks: ${agent!.parkedTasks}. \`nexus retry ${t.id}\` runs them again`],
    // A session in no pane is closed by its ID. A control plane older than `Session.state` sends none, and every session it lists runs.
    ...sessions.map((s) => `session: ${s.harness}${s.title === null ? "" : ` ${JSON.stringify(s.title)}`} ${s.herdrPane === null ? `as ${s.id}` : `in pane ${s.herdrPane}`}, ${s.state === "paused" ? `paused (resumes on ${t.status === "archived" ? "unarchive" : "wake"})`
      : s.state === "failed" ? `failed: ${s.message}` : s.status}`),
    ...previews.map((v) => `preview: ${v.service} at ${v.url}${failureOf(v) !== null ? `, not ready: ${failureOf(v)}` : v.ready ? "" : ", not ready"}`),
    ...(ports ?? []).map((l) => `port: ${l.port}${l.service === null ? "" : `, service ${l.service}`}${l.preview === null ? "" : `, previewed at ${l.preview.url}`}`),
    ...outputs.map((o) => `output: ${o.kind} ${o.ref}`),
  ].join("\n");
}

function portsText(ports: ThreadDetail["ports"], id: string): string {
  if (ports === null) return "The pylon's listening ports could not be read.";
  if (ports.length === 0) return "No listening ports. A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1.";
  return [
    table(ports.map((l) => [String(l.port), l.service ?? "-", l.preview === null ? "-" : `${l.preview.url}${failureOf(l.preview) !== null ? " (its service failed)" : l.preview.ready ? "" : " (not served yet)"}`])),
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
const baseQuery = (v: Values) => v.uncommitted === true ? "base=head" : "base=start";

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
  const since = kind === "start"
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
      throw new CliError("failed", `port ${port} of ${id} was not served within ${waitMs / 1000} s. \`nexus ports ${id}\` shows whether it listens and whether its preview is published`);
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

/**
 * Wakes the pylon and waits until it runs, then runs ssh to its node with a terminal, or the configured attach
 * command, and returns once the person detaches. Recording activity first counts the attach as human presence
 * until the node's next read, which counts the attached terminal itself.
 */
async function attach(api: Api, id: string, local: Local): Promise<void> {
  const deadline = Date.now() + waitMs;
  let d = await api("GET", thread(id)) as ThreadDetail;
  // An archived thread's pylon pauses even while a terminal is attached.
  if (d.thread.status === "archived") throw new CliError("conflict", `thread ${id} is archived, so its pylon stays paused. \`nexus unarchive ${id}\` wakes it`);
  if (d.thread.status === "deleted") throw new CliError("conflict", `thread ${id} is deleted`);
  await api("POST", `${thread(id)}/activity`, { kind: "human" });
  while (d.pylon.actualState !== "running") {
    if (d.pylon.actualState === "failed") throw new CliError("failed", `the pylon of ${id} failed: ${d.pylon.failed ?? "no reason given"}`);
    if (Date.now() >= deadline) throw new CliError("failed", `the pylon of ${id} did not run within ${waitMs / 1000} s. It is ${d.pylon.actualState}`);
    await sleep(waitPollMs);
    d = await api("GET", thread(id)) as ThreadDetail;
  }
  const { id: pylon, node } = d.pylon;
  const host = (await api("GET", "/v1/nodes") as NodeSummary[]).find((n) => n.name === node)?.tailnetHost;
  if (host === undefined) throw new CliError("failed", `the control plane lists no node ${node}`);
  const destination = local.ssh[node] ?? host;
  const [command, args] = local.attach !== null ? ["sh", ["-c", local.attach]]
    : ["ssh", ["-t", ...local.socks === null ? [] : ["-o", `ProxyCommand=nc -X 5 -x ${local.socks.host}:${local.socks.port} %h %p`], destination, "nexus-attach", pylon]];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, NEXUS_THREAD: id, NEXUS_PYLON: pylon, NEXUS_NODE: node, NEXUS_NODE_HOST: host } });
    child.once("error", (err) => reject(new CliError("failed", `${command} could not start: ${err.message}`)));
    child.once("exit", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) {
    const how = local.attach === null
      ? `ssh to ${destination} exited ${code}. To reach the node as another user or through an ssh alias, set "ssh": {"${node}": "<user@host or alias>"} in ${configFile()}, or set NEXUS_ATTACH, as docs/cli.md describes`
      : `the attach command from NEXUS_ATTACH or the config exited ${code}`;
    throw new CliError("failed", `attaching to ${id} on ${node} failed: ${how}`);
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

const commands: Readonly<Record<string, Command>> = {
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
    options: { uncommitted: { type: "boolean" } },
    async run(api, [id], v) {
      const c = await whenRunning(api, id!, () => api("GET", `${thread(id!)}/changes?${baseQuery(v)}`, undefined, checkoutReadMs), "no changes were read") as Changes;
      return { json: c, text: changesText(c) };
    },
  },
  diff: {
    args: [1, Infinity],
    options: { uncommitted: { type: "boolean" } },
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
    async run(api, [id], _, __, local) {
      await attach(api, id!, local);
    },
  },
  start: {
    args: [0, 0],
    options: { project: { type: "string" }, title: { type: "string" }, message: { type: "string" }, node: { type: "string" }, branch: { type: "string" }, commit: { type: "string" } },
    async run(api, _, v) {
      const project = str(v, "project");
      const message = str(v, "message");
      const title = str(v, "title") ?? (message === undefined ? undefined : titleOf(message));
      if (project === undefined) throw new CliError("invalid", "start needs --project");
      if (title === undefined) throw new CliError("invalid", "start needs --title or --message");
      const optional = Object.fromEntries((["node", "branch", "commit"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
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
  "project add": {
    args: [1, 2],
    options: {
      node: { type: "string" }, branch: { type: "string" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" },
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      scratch: { type: "boolean" },
    },
    async run(api, [id, url], v) {
      // A project cannot be changed or removed, so a forgotten URL must not quietly make a scratch project.
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

const configSchema = z.strictObject({
  url: z.string().optional(), socks: z.string().optional(), attach: z.string().optional(),
  // A destination is one ssh argument, never an option.
  ssh: z.record(z.string(), z.string().regex(/^[^-\s]\S*$/, "must be an ssh destination such as user@host or an alias")).optional(),
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
async function settings(v: Values): Promise<{ endpoint: Endpoint } & Omit<Local, "socks">> {
  const config = await readConfig(configFile());
  const env = (name: string) => process.env[name] || undefined;
  const attach = env("NEXUS_ATTACH") ?? config.attach ?? null;
  const url = str(v, "url") ?? env("NEXUS_URL") ?? config.url ?? defaults.url;
  const socks = str(v, "socks") ?? env("NEXUS_SOCKS") ?? config.socks ?? defaults.socks;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("invalid", `the control plane URL ${url} is not a URL`);
  }
  if (parsed.protocol !== "http:") throw new CliError("invalid", `the control plane URL ${url} must be http://, which is what the API serves on the tailnet`);
  return { endpoint: { url: parsed, socks: socks === "none" ? null : hostPort(socks) }, attach, ssh: config.ssh ?? {} };
}

function hostPort(value: string): HostPort {
  const m = /^(.+):(\d+)$/.exec(value);
  if (m === null || Number(m[2]) > 65535) throw new CliError("invalid", `the SOCKS proxy ${value} must be HOST:PORT or none`);
  return { host: m[1]!, port: Number(m[2]) };
}

const globalOptions: ParseArgsOptionsConfig = { json: { type: "boolean" }, url: { type: "string" }, socks: { type: "string" } };

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
  const [min, max] = command.args;
  if (positionals.length < min || positionals.length > max) {
    throw new CliError("invalid", `${name} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, got ${positionals.length}`);
  }
  const { endpoint: target, attach, ssh } = await settings(values);
  const result = await command.run((method, path, body, idleMs) => call(target, method, path, body, idleMs), positionals, values,
    (path, onEvent, signal) => follow(target, path, onEvent, signal), { socks: target.socks, attach, ssh });
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
