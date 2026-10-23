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
import type { ListeningPort, NodeSummary, ThreadDetail, ThreadRow } from "../control/api.ts";
import type { Preview, Thread } from "../control/registry.ts";
import type { Project } from "../project.ts";
import type { ActualState } from "../reconcile.ts";
import { call, CliError, exitCodes, type Endpoint, type HostPort } from "./transport.ts";

const version = "0.2.0";
const defaults = { url: "http://rj-firebat.tailc817d3.ts.net:7470", socks: "localhost:1055" };
const configFile = () => join(homedir(), ".config", "nexus", "cli.json");

const usage = `nexus ${version}, the Nexus control plane from this Mac

  nexus threads [--project P] [--all]          threads, without deleted ones unless --all
  nexus show <thread>                          a thread with its pylon, sessions, previews and outputs
  nexus ports <thread>                         the TCP ports the pylon listens on, and each one's preview
  nexus preview <thread> <port> [--wait]       publish a port as a preview, and print its URL
  nexus conversation <thread>                  the agent's transcript
  nexus start --project P [--title T] [--message M] [--node N] [--branch B] [--commit C]
  nexus send <thread> <text...> [--steer] [--request-id ID]
  nexus watch <thread> [--interval MS]
  nexus abort|retry|retry-pylon|wake <thread>
  nexus archive|unarchive|delete <thread>
  nexus projects
  nexus nodes
  nexus --version

Every command takes --json, --url URL and --socks HOST:PORT|none. The URL and proxy come from those flags,
then NEXUS_URL and NEXUS_SOCKS, then ${configFile()}, then ${defaults.url} through ${defaults.socks}.
`;

type Values = Record<string, string | boolean | undefined>;
type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;
/** What a command prints: its JSON for --json, its text otherwise. */
interface Result { json: unknown; text: string }
interface Command {
  args: readonly [min: number, max: number];
  options?: ParseArgsOptionsConfig;
  /** Nothing when the command printed its own output, as watch does. */
  run(api: Api, args: readonly string[], values: Values): Promise<Result | void>;
}

const str = (v: Values, key: string) => v[key] as string | undefined;
const thread = (id: string) => `/v1/threads/${encodeURIComponent(id)}`;

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

const queuedTexts = (view: ConversationView) => ((view.docs["pi.inbox"] as InboxState | undefined)?.items ?? [])
  .flatMap((item) => item.mode === "write" ? [] : [contentText(item.content as string | (TextContent | ImageContent)[])]);
const busy = (view: ConversationView) => (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;

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
    ...sessions.map((s) => `session: ${s.harness} in pane ${s.herdrPane}, ${s.status}`),
    ...previews.map((v) => `preview: ${v.service} at ${v.url}${v.ready ? "" : ", not ready"}`),
    ...(ports ?? []).map((l) => `port: ${l.port}${l.service === null ? "" : `, service ${l.service}`}${l.preview === null ? "" : `, previewed at ${l.preview.url}`}`),
    ...outputs.map((o) => `output: ${o.kind} ${o.ref}`),
  ].join("\n");
}

function portsText(ports: ThreadDetail["ports"], id: string): string {
  if (ports === null) return "The pylon's listening ports could not be read.";
  if (ports.length === 0) return "No listening ports. A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1.";
  return [
    table(ports.map((l) => [String(l.port), l.service ?? "-", l.preview === null ? "-" : `${l.preview.url}${l.preview.ready ? "" : " (not served yet)"}`])),
    ...ports.some((l) => l.preview === null) ? [`\`nexus preview ${id} <port>\` publishes a port.`] : [],
  ].join("\n");
}

const waitMs = 120_000;
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

function stateOf(d: ThreadDetail, view: ConversationView | null): WatchState {
  const parkedTasks = d.agent?.parkedTasks ?? 0;
  return {
    type: "state", thread: d.thread.id, status: d.thread.status,
    run: parkedTasks > 0 ? "parked" : view !== null && busy(view) ? "working" : "idle",
    parkedTasks, queued: view === null ? 0 : queuedTexts(view).length, pylon: d.pylon.actualState, failed: d.pylon.failed, ports: d.ports,
  };
}

function liveOf(id: string, view: ConversationView | null): WatchLive {
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
 * Polls the thread and its conversation. The conversation route serves pi-durable's active context, not the full
 * history: a new head marker, a compaction or a delete can reorder or drop entries. So the first poll prints the
 * context whole, a later one that only appends prints each new entry, and any other change prints it whole again.
 * Then the thread's state when it changed. An unreachable or failing control plane is reported once and polled
 * through, so a live pane survives a restart of the control plane. Ends after the state that says the thread is
 * deleted, or once the process that started it is gone.
 */
async function watch(api: Api, id: string, intervalMs: number, json: boolean): Promise<void> {
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
  let failing: string | null = null;
  for (;;) {
    try {
      const d = await api("GET", thread(id)) as ThreadDetail;
      // A thread deleted between the two reads has no conversation. The next poll sees the delete.
      const view = d.agent === null ? null : await (api("GET", `${thread(id)}/conversation`) as Promise<ConversationView>)
        .catch((err: unknown) => { if (err instanceof CliError && err.kind === "conflict") return null; throw err; });
      // Without a conversation, the entries last printed stand. The first poll prints an empty context.
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
      if (key !== shown || failing !== null) emit(state, stateText(state));
      shown = key;
      // The text stream already says what the state does of the run, so only JSON carries it.
      const live = liveOf(id, view);
      const liveKey = JSON.stringify(live);
      if (liveKey !== liveShown) emit(live, "");
      liveShown = liveKey;
      failing = null;
      if (d.thread.status === "deleted") return;
    } catch (err) {
      if (!(err instanceof CliError) || (err.kind !== "unreachable" && err.kind !== "failed")) throw err;
      if (failing !== err.message) emit({ type: "error", thread: id, kind: err.kind, message: err.message }, `-- ${err.message}. Retrying`);
      failing = err.message;
    }
    await sleep(intervalMs);
    if (process.ppid !== parent) return;
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
      const port = Number(given);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("invalid", `the port must be a whole number from 1 to 65535, got ${given}`);
      const linked = await api("POST", `${thread(id!)}/previews`, { port }) as Preview;
      const preview = v.wait === true ? await served(api, id!, port) : linked;
      return { json: preview, text: preview.ready ? preview.url : `${preview.url} (not served yet. \`--wait\` waits until it is)` };
    },
  },
  conversation: {
    args: [1, 1],
    async run(api, [id]) {
      const view = await api("GET", `${thread(id!)}/conversation`) as ConversationView;
      return { json: view, text: conversationText(view) };
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
    async run(api, [id], v) {
      const interval = int(str(v, "interval"), "--interval", 2000);
      if (interval === 0) throw new CliError("invalid", "--interval must be above 0");
      await watch(api, id!, interval, v.json === true);
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
      return { json: projects, text: projects.length === 0 ? "No projects." : table(projects.map((p) => [p.id, `node ${p.defaultNode}`, `branch ${p.defaultBranch}`, p.repoUrl])) };
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

const configSchema = z.strictObject({ url: z.string().optional(), socks: z.string().optional() });

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
async function endpoint(v: Values): Promise<Endpoint> {
  const config = await readConfig(configFile());
  const env = (name: string) => process.env[name] || undefined;
  const url = str(v, "url") ?? env("NEXUS_URL") ?? config.url ?? defaults.url;
  const socks = str(v, "socks") ?? env("NEXUS_SOCKS") ?? config.socks ?? defaults.socks;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("invalid", `the control plane URL ${url} is not a URL`);
  }
  if (parsed.protocol !== "http:") throw new CliError("invalid", `the control plane URL ${url} must be http://, which is what the API serves on the tailnet`);
  return { url: parsed, socks: socks === "none" ? null : hostPort(socks) };
}

function hostPort(value: string): HostPort {
  const m = /^(.+):(\d+)$/.exec(value);
  if (m === null || Number(m[2]) > 65535) throw new CliError("invalid", `the SOCKS proxy ${value} must be HOST:PORT or none`);
  return { host: m[1]!, port: Number(m[2]) };
}

const globalOptions: ParseArgsOptionsConfig = { json: { type: "boolean" }, url: { type: "string" }, socks: { type: "string" } };

async function run(argv: readonly string[]): Promise<void> {
  const [name, ...rest] = argv;
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
  const target = await endpoint(values);
  const result = await command.run((method, path, body) => call(target, method, path, body), positionals, values);
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
