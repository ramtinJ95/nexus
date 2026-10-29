import { once } from "node:events";
import type { NexusEvent } from "../events.ts";
import { fullCommit, releaseOutcome, type ReleaseView } from "../deploy/model.ts";
/**
 * The Mac's nexus CLI: the control plane's API as commands, for a human at a shell and for the Claude Code and pi
 * integrations, which shell out to it. docs/cli.md is the contract: the commands, their JSON, the exit codes and
 * the watch stream. --json prints the API's reply as it is, except where docs/cli.md says otherwise.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { z } from "zod";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, InboxState, LiveState } from "@earendil-works/pi-durable";
import type { ListeningPort, NodeSummary, OpenedSession, ThreadDetail, ThreadRow, ViewFrame, Whoami } from "../control/api.ts";
import type { ImageEntry, ImageOperation, ImagesView } from "../control/image-rollout.ts";
import type { NodePylons, Placement, Room } from "../control/placement.ts";
import type { PipelineItem } from "../control/pipeline.ts";
import type { QueuedThread, Wait } from "../control/queue.ts";
import type { ClaudeSent, Preview, Thread } from "../control/registry.ts";
import type { Review } from "../control/review.ts";
import type { Question } from "../control/questions.ts";
import { reservedNames } from "../control/policy.ts";
import { maxEntries, usageLimitText, type ClaudeConversation, type ClaudeEntry, type PromptSource } from "../claude-transcript.ts";
import { claudeFrames, queuedOf, type ClaudeFrame } from "../control/claude-conversation.ts";
import { agentView } from "../control/thread-agent.ts";
import { liveNote, phaseNote, roundNote, roundsSpent } from "../control/review.ts";
import { breakdownLook, breakdowns, tokenColumns, tokenCount, type BackfillPlanRow, type UsageBackfill, type UsageReport, type UsageTotals } from "../control/usage.ts";
import type { Changes, Diff, Listing } from "../checkout-files.ts";
import type { ThreadSetup } from "../images.ts";
import type { Project, SecretGrant } from "../project.ts";
import type { ActualState } from "../reconcile.ts";
import type { NodeCapacity, NodeHealth } from "../protocol.ts";
import { sessionHarnessSchema } from "../sessions.ts";
import type { WebSocket } from "ws";
import { attachTerminal, processTty } from "./attach.ts";
import { call, CliError, exitCodes, follow, isMissingRoute, upgrade, type Endpoint, type HostPort } from "./transport.ts";

const version = "0.51.0";
/** Where `connect` looks for the API on a host: the dashboard's HTTPS port, then the plain HTTP port. */
const controlPorts = ["https://{host}:7443", "http://{host}:7470"];
const configFile = () => join(homedir(), ".config", "nexus", "cli.json");

const usage = `nexus ${version}, the Nexus control plane from this Mac

  nexus connect <host>                         find the control plane on a tailnet name or URL, save it, and say what this device may do
  nexus events [--follow] [--since ID] [--thread T] [--project P] [--kind K]...
  nexus threads [--project P] [--all] [--queued]
    threads, then queued ones; deleted ones and cancelled queued ones only with --all, and --queued lists only queued ones
  nexus show <thread>                          a thread with its pylon, sessions, previews and outputs
  nexus ports <thread>                         the TCP ports the pylon listens on, and each one's preview
  nexus preview <thread> <port> [--wait]       publish a port as a preview, and print its URL
  nexus unpreview <thread> <port>              stop publishing a port that preview published
  nexus files <thread> [path]                  a directory of the pylon's checkout
  nexus changes <thread> [--uncommitted | --turn]       the files changed since boot, HEAD, or the latest turn
  nexus diff <thread> [path...] [--uncommitted | --turn]
  nexus conversation <thread>                  the agent's transcript, or the Claude worker's
  nexus session open <thread> [--harness ${sessionHarnessSchema.options.join("|")}] [--title T]
  nexus session close <thread> <pane|id>       a session in no pane by its ID, which \`nexus show\` gives
  nexus attach <thread>                        this terminal on the pylon's Herdr sessions, through the control plane
  nexus start --project P [--title T] [--message M | --claude PROMPT [--model ID]] [--node N|auto] [--branch B] [--commit C]
              [--cpus n] [--memory GiB] [--disk GiB] [--after THREAD[,THREAD...]] [--request-id ID] [--plan]
    --after queues it to start once each of those threads' pull requests has merged
    --plan makes it a planning thread, whose proposed items become questions you accept or reject
    --request-id makes a repeat of the start answer the thread the first made
  nexus start-queued <thread>                  start a queued thread now, without waiting for the threads it is queued after
  nexus items [--project P] [--all]            pipeline items and the phase each is in; cancelled ones only with --all
  nexus item add --project P [--title T] (--message M | --claude PROMPT [--model ID]) [--after ITEM[,ITEM...]]
                 [--node N|auto] [--branch B] [--commit C] [--cpus n] [--memory GiB] [--disk GiB]
    an item becomes a queued thread once the items it is after are, and starts once their pull requests merge
  nexus item show <item>                       an item with its phase, its thread and its brief
  nexus item approve <item>                    let an item become a thread, in a project whose pipeline waits for approval
  nexus item cancel <item>                     an item that is not a thread yet, which then never becomes one
  nexus send <thread> <text...> [--steer] [--request-id ID]
    a message to the agent, or typed into the Claude worker's session, which waits for a paused pylon to wake
  nexus watch <thread> [--interval MS]         the conversation, or the Claude worker's transcript, as it grows
  nexus seen <thread> [--unread | --last-reply-at MS]
    mark the latest reply seen, or unread, or only up to the reply at MS, as captured with what the client showed
  nexus abort|retry|retry-pylon|wake <thread>
  nexus archive|unarchive|delete <thread>
  nexus projects
  nexus project edit <id> [--node N|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]
    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...
    [--clear-hosts] [--clear-logins] [--clear-secrets] [--git-name NAME --git-email EMAIL | --clear-git-identity]
    [--auto-review off|review|land]   review each builder's PR on its own, and land it too; land needs a deployer
    [--pipeline off|approve|start]    turn pipeline items into threads, once the person approves each or on their own
  nexus project add <id> (<repo-url> | --scratch) [--node N|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]
                    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...
  nexus review <thread> [--pr N] [--rounds N] [--land]
    a reviewer on another model for the thread's open PR, round after round until it approves; --land merges and deploys under the merge policy
  nexus review --cancel <thread>               end the thread's running review and archive its reviewer, unless it began merging or deploying
  nexus land <thread>                          land an approved review under the merge policy, or try a held landing again
  nexus deploy <commit|main> [--wait]
  nexus release
  nexus image build [--wait]                   build the recipe of the control plane's release, and record the image
  nexus image rollout <image> [--wait]         copy an image to every online node, then make it current
  nexus image rollback [--wait]                roll out again the image that was current before this one
  nexus image list                             recorded images, the nodes that hold each, and the last image operation
  nexus image current                          the current image and the one before it
  nexus nodes
  nexus node <name>                            a node's load, memory, disk, temperatures and pylon processes, read now; deployers only
  nexus usage [--since today|7d|30d|all|DATE] [--project P] [--by model|project|kind|role|day]
    the tokens the agents spent, in all and by model, project, agent, role and day, or only --by's; --since is 7d by default
  nexus usage backfill [--dry-run | --stop]
    read archived threads' transcripts from their start, waking one pylon at a time, or list what it would read, or stop; deployers only
  nexus --version

Every command takes --json, --url URL and --socks HOST:PORT|none. The URL and proxy come from those flags,
then NEXUS_URL and NEXUS_SOCKS, then ${configFile()}, which \`nexus connect\` writes. Without a proxy the CLI
connects directly.
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

/** The --cpus, --memory and --disk given, or undefined for none, as `project edit` and `start` send them. */
function resourcesOf(v: Values): Partial<Project["resources"]> | undefined {
  const resources: Partial<Project["resources"]> = {};
  for (const [flag, field] of [["cpus", "cpus"], ["memory", "memoryGiB"], ["disk", "diskGiB"]] as const) {
    if (v[flag] !== undefined) resources[field] = int(str(v, flag), `--${flag}`, 0);
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
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

const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function backfillText(b: UsageBackfill): string {
  if (b.state === "never") return "Backfill: not run. A deployer runs `nexus usage backfill` to read archived threads' pylons.";
  const threads = `${b.read} of ${b.of} thread${b.of === 1 ? "" : "s"} read`;
  const recovered = `recovered ${b.recovered.calls} call${b.recovered.calls === 1 ? "" : "s"} and ${tokenCount(b.recovered.tokens)} tokens`;
  const doing = b.current === null ? b.waiting === null ? "" : ` It waits: ${b.waiting}.`
    : b.current.phase === "reading" ? ` It reads the pylon of ${b.current.thread}.` : ` It waits for the pylon of ${b.current.thread} to pause.`;
  const line = b.state === "running" ? `Backfill: running, ${threads}, ${recovered}.${doing}`
    : b.state === "stopped" ? `Backfill: stopped at ${threads}, ${recovered}.`
    : `Backfill: done at ${utc(b.finishedAt!)}, ${threads}, ${b.skipped.length} skipped, ${recovered}.`;
  if (b.state === "running" || b.skipped.length === 0) return line;
  return `${line}\nSkipped:\n${table(b.skipped.map((t) => [t.thread, t.title, t.reason ?? ""]))}`;
}

function backfillPlanText(plan: readonly BackfillPlanRow[]): string {
  if (plan.length === 0) return "No archived thread is left to read.";
  const lines = table(plan.map((r) => [r.thread, r.project, r.node, r.title])).split("\n");
  return [`A start reads ${plan.length} archived thread${plan.length === 1 ? "" : "s"}, one pylon at a time:`,
    ...lines.flatMap((line, i) => plan[i]!.reason === null ? [line] : [line, `  skipped before: ${plan[i]!.reason}`])].join("\n");
}

/** A control plane older than 0.33.0 reports no backfill. */
type ReportedUsage = Omit<UsageReport, "backfill"> & Partial<Pick<UsageReport, "backfill">>;

function usageText(r: ReportedUsage): string {
  const rows = (keyHead: string, of: readonly (UsageTotals & { key: string })[]) =>
    table([[keyHead, ...tokenColumns.map((col) => col.label), "Calls"], ...of.map((row) => [row.key, ...tokenColumns.map((col) => tokenCount(row[col.field])), String(row.calls)])]);
  const head = `Usage of ${r.project === null ? "all projects" : `project ${r.project}`} ${r.since === null ? "for all time" : `since ${utc(r.since)}`}. Counting started ${utc(r.countingSince)}.${r.backfill === undefined ? "" : `\n${backfillText(r.backfill)}`}`;
  if (r.total.calls === 0) return `${head}\nNo model calls were counted in this period.`;
  return [head, rows("", [{ key: "Total", ...r.total }]), ...breakdowns.flatMap((b) => {
    const { title, key } = breakdownLook[b];
    return r.by[b] === undefined ? [] : [`${title}\n${rows(key, r.by[b])}`];
  })].join("\n\n");
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

/** How a prompt's first line names who it came from. A person's is not named. */
const promptLabel: Record<PromptSource, string> = { person: "", command: "[slash command] ", other: "[Claude Code] " };

/**
 * One transcript entry as a line or more, empty for one that prints nothing alone: a result, which its call shows,
 * a queue operation, and a pull request `shown` already holds, which this adds to it. A call says how it ended
 * when `how` is given.
 */
function claudeEntryText(e: ClaudeEntry, shown: Set<string>, how?: string): string {
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
function claudeText(c: ClaudeConversation): string {
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
    // A control plane older than `usageLimit` sends none.
    ...c.usageLimit == null ? [] : [`(Claude ${usageLimitText(c.usageLimit, Date.now())}. Send it "continue" after the reset to resume)`],
  ];
  if (parts.length > 0) return parts.join("\n\n");
  return c.readAt === null ? "Claude's transcript has not been read yet. It is read while the pylon runs." : "Claude has not written a transcript yet.";
}

const gib = (n: number) => Number(n.toFixed(1));
/** A probe from before pylons were counted reports no CPUs or committed disk, and always 0 GiB of memory committed. */
function capacityText(c: Partial<NodeCapacity>, overcommitted: boolean): string {
  const counted = c.committedDiskGiB !== undefined;
  const n = (v: number | undefined, known = true) => v === undefined || !known ? "unknown" : gib(v);
  return `${n(c.committedCpus)}/${n(c.cpus)} CPUs, ${n(c.committedMemoryGiB, counted)}/${n(c.memoryGiB)} GiB memory committed${overcommitted ? ", overcommitted" : ""}, ${n(c.committedDiskGiB)} GiB disk committed, ${n(c.diskFreeGiB)} GiB disk free`;
}

/**
 * Such as `5 up holding 20 CPUs and 40 GiB, 1 paused needing 8 GiB to wake, 3 archived, 1 crashed needing 8 GiB to retry,
 * 1 orphaned (pylon-x)`. Empty
 * for a node with no pylons, or never observed, or from a control plane older than 0.25.0, which sends no `pylons`.
 */
function pylonsText(p: NodePylons | null): string {
  if (p === null) return "";
  return [
    ...p.up.pylons === 0 ? [] : [`${p.up.pylons} up holding ${p.up.cpus} CPUs and ${gib(p.up.memoryGiB)} GiB`],
    ...p.paused.pylons === 0 ? [] : [`${p.paused.pylons} paused needing ${gib(p.paused.memoryGiB)} GiB to wake`],
    ...p.archived.pylons === 0 ? [] : [`${p.archived.pylons} archived`],
    // A control plane older than `crashed` counts such pylons as up.
    ...(p.crashed?.pylons ?? 0) === 0 ? [] : [`${p.crashed.pylons} crashed needing ${gib(p.crashed.memoryGiB)} GiB to retry`],
    ...p.orphaned.length === 0 ? [] : [`${p.orphaned.length} orphaned (${p.orphaned.join(", ")})`],
  ].join(", ");
}

const roomText = (r: Room) => `${gib(r.memoryGiB)} GiB memory, ${r.cpus} CPUs and ${gib(r.diskGiB)} GiB disk left`;
function placementText(p: Placement): string {
  switch (p.how) {
    case "default": return `${p.node}, the project's default node`;
    case "named": return `${p.node}, as the start named`;
    case "auto": return [`auto chose ${p.node}, which had the most room left after this pylon`,
      ...p.weighed.map((w) => "left" in w ? `${w.node} had ${roomText(w.left)}` : `${w.node} ${w.refused}`)].join("; ");
  }
}

/** A fresh boot's reason may end in a failed build's log, which only --json prints. */
function setupText(s: ThreadSetup): string {
  switch (s.how) {
    case "template": return `from template ${s.template}, built ${ago(s.builtAt)}, then checked out ${s.commit.slice(0, 12)}`;
    case "fresh": return `fresh boot runs .nexus/setup, because ${s.reason.split("\n")[0]}${s.building === undefined ? "" : `; ${s.building} builds for the next thread`}`;
  }
}

/** A review's state for a person: its phase and round, its reviewer, and what it needs from them. */
function reviewText(r: Review): string {
  const { live } = r.rounds.at(-1)!;
  const note = liveNote(r);
  const round = roundNote(r);
  const phase = r.phase.kind === "landed" ? `landed as ${r.phase.commit}` : r.phase.kind === "deploying" ? `deploying ${r.phase.commit}` : r.phase.kind;
  return [
    `review ${r.id} of PR #${r.pr.number}${r.auto ? ", started on its own" : ""}: ${phase}, round ${roundsSpent(r)} of ${r.maxRounds}, reviewer ${r.reviewer} on ${r.models.reviewer}${r.land === null ? "" : ", landing when approved"}${phaseNote(r)}`,
    ...round === null ? [] : [round],
    ...note === null ? [] : [note],
    ...live?.kind === "ran" && !live.passed ? live.output.split("\n").slice(-20).map((line) => `  ${line}`) : [],
    ...r.phase.kind === "needs-person" ? r.phase.reasons.map((reason) => `needs you: ${reason}`) : [],
    // A control plane older than waivers sends none.
    ...r.waiver == null ? [] : [`waived by ${r.waiver.by} at ${r.waiver.head}, ${new Date(r.waiver.at).toISOString()}:`, ...r.waiver.holds.map((hold) => `  ${hold}`)],
  ].join("\n");
}

/**
 * A question's first line, its options and reserved case, and who must answer it or how it was answered. A Claude
 * worker's ask has a line per question it asks, and no options of its own.
 */
function questionText(q: Question): string {
  const [first, ...rest] = q.text.split("\n");
  return [
    `question ${q.id}: ${first}`,
    ...q.ask === undefined ? [] : rest.map((line) => `  ${line}`),
    ...q.options.length === 0 ? [] : [`  options: ${q.options.map((o) => JSON.stringify(o)).join(", ")}`],
    ...q.reserved === null ? [] : [`  reserved: ${reservedNames[q.reserved]}`],
    q.answer !== null ? `  answered ${JSON.stringify(q.answer.option)} by ${q.answer.by} at ${new Date(q.answer.at).toISOString()}` : q.answerer === "deployer" ? "  needs a deployer" : "  needs you",
  ].join("\n");
}

/** A judgment's verdict and who gave it, then what Nexus did or what it waits for. */
function judgmentText(j: ThreadDetail["judgments"][number]): string {
  return [
    `judgment of failure ${j.failure} on ${j.node}: ${j.verdict === null ? "no verdict yet" : `${j.verdict.answer}, by the ${j.verdict.by}: ${j.verdict.why}`}`,
    `  ${j.outcome ?? (j.question !== null ? `waits for your answer to question ${j.question}` : j.verdict === null ? `judging since ${new Date(j.startedAt).toISOString()}` : "Nexus acts on it")}`,
  ].join("\n");
}

const autoReviews = { off: null, review: { land: false }, land: { land: true } } as const;
const pipelines = { off: null, approve: { autoStart: false }, start: { autoStart: true } } as const;
/** A control plane older than `Project.pipeline` sends none, and has no pipeline. */
const pipelineText = (p: Project) => p.pipeline == null ? "pipeline off" : p.pipeline.autoStart ? "pipeline starts items" : "pipeline waits for approval";
/** A control plane older than `Project.autoReview` sends none, and reviews nothing on its own. */
const autoReviewText = (p: Project) => p.autoReview == null ? "auto review off" : p.autoReview.land ? `auto review and land, for ${p.autoReview.enabledBy}` : `auto review, set by ${p.autoReview.enabledBy}`;

/** A control plane older than `Thread.working` sends none. */
const working = (t: Thread) => t.working ?? (t.agentTurnRunning || t.sessionTurnRunning === true);

function detailText({ thread: t, pylon: p, agent, sessions, previews, ports, outputs, prWatch, pullRequests, claudeWorker, attention, review, questions, judgments, planning }: ThreadDetail): string {
  const observed = p.observedAt === null ? "" : `, observed ${ago(Date.parse(p.observedAt))}`;
  return [
    `${t.id}  ${t.title}`,
    `project: ${t.project}`,
    // A control plane older than 0.40.0 sends no planning.
    ...planning === true ? ["planning: its proposed items become questions you accept or reject"] : [],
    ...(claudeWorker === undefined ? [] : [`Claude worker: ${claudeWorker.state}, model ${claudeWorker.model ?? "unknown"}`, ...(claudeWorker.message === undefined ? [] : [`failed: ${claudeWorker.message}`])]),
    `attention: ${attention ?? "none"}`,
    ...t.usageLimit === undefined ? [] : [`usage limit: ${usageLimitText(t.usageLimit, Date.now())}. \`nexus send ${t.id} continue\` resumes it once the limit resets`],
    `status: ${t.status}${working(t) ? ", agent working" : ""}`,
    `pylon: ${p.id} on ${p.node}, ${p.actualState}${observed}`,
    ...t.status === "archived" || t.status === "deleted" ? [] : [`attach: nexus attach ${t.id}`],
    // A control plane older than the size in thread detail sends none.
    ...p.resources === undefined ? [] : [`size: ${p.resources.cpus} CPUs, ${p.resources.memoryGiB} GiB memory, ${p.resources.diskGiB} GiB disk${p.resources.nestedVirtualization === true ? ", nested virtualization" : ""}`],
    ...t.placement === undefined ? [] : [`placement: ${placementText(t.placement)}`],
    ...t.setup === undefined ? [] : [`setup: ${setupText(t.setup)}`],
    ...(p.grantsOutdated ? ["grants: older than project; start a new thread to apply current grants (archive/unarchive keeps these grants)"] : []),
    ...p.failed === null ? [] : [`failed: ${p.failed.replaceAll("\n", "\n  ")}`],
    ...p.retryRefused === null ? [] : [`retry refused: ${p.retryRefused}`],
    ...(agent?.parkedTasks ?? 0) === 0 ? [] : [`parked tasks: ${agent!.parkedTasks}. \`nexus retry ${t.id}\` runs them again`],
    // A session in no pane is closed by its ID. A control plane older than `Session.state` sends none, and every session it lists runs.
    ...sessions.map((s) => `session: ${s.harness}${s.title === null ? "" : ` ${JSON.stringify(s.title)}`} ${s.herdrPane === null ? `as ${s.id}` : `in pane ${s.herdrPane}`}, ${s.state === "paused" ? `paused (resumes on ${t.status === "archived" ? "unarchive" : "wake"})`
      : s.state === "failed" ? `failed: ${s.message}` : s.status}`),
    ...previews.map((v) => `preview: ${v.service} at ${v.url}${failureOf(v) !== null ? `, not ready: ${failureOf(v)}` : v.ready ? "" : ", not ready"}`),
    ...(ports ?? []).map((l) => `port: ${l.port}${l.service === null ? "" : `, service ${l.service}`}${l.preview === null ? "" : `, previewed at ${l.preview.url}`}`),
    ...(prWatch?.enabled ? [prWatch.stopped ? "PR watch: stopped (10 comment-only wakes)" : "PR watch: on", ...(prWatch.error ? [prWatch.error] : [])] : ["PR watch: off (no control-plane GitHub token configured)"]),
    ...(pullRequests ?? []).map((pr) => `PR #${pr.number}: ${pr.title} — ${pr.state}, checks ${pr.checks}, review ${pr.review} ${pr.url}`),
    ...review == null ? [] : [reviewText(review)],
    // A control plane older than 0.35.0 sends no questions.
    ...(questions ?? []).map(questionText),
    // A control plane older than 0.39.0 sends no judgments.
    ...(judgments ?? []).map(judgmentText),
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
/** The 409 codes that a wait fixes: the pylon not running yet, Claude not ready yet, or Claude's pane moved before it typed. */
const waitedOut = new Set(["not-running", "not-ready", "moved"]);
/** Longer than the probe takes to answer a command, at most 90 s. */
const pylonCommandMs = 120_000;
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
 * the first wakes a paused pylon, and a 409 that waiting fixes is tried again once a second until the pylon runs,
 * unless the thread is archived or deleted. Any other 409, such as Claude waiting at a prompt, fails at once. A
 * control plane older than error codes sends none, so a 409 without one is tried again too. `undone` says what the
 * failure after the wait leaves undone.
 */
async function whenRunning<T>(api: Api, id: string, send: () => Promise<T>, undone: string): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof CliError) || err.kind !== "conflict" || (err.code !== null && !waitedOut.has(err.code))) throw err;
      const { status } = (await api("GET", thread(id)) as ThreadDetail).thread;
      if (status === "archived" || status === "deleted") throw err;
      if (Date.now() >= deadline) throw new CliError("failed", `the pylon of ${id} did not run within ${waitMs / 1000} s, so ${undone}. ${err.message}`);
    }
    await sleep(waitPollMs);
  }
}

/** What a queued thread's row and `show` call its status: an archived one is cancelled. */
const queuedState = (q: QueuedThread) => q.status === "archived" ? "cancelled" : q.status === "deleted" ? "deleted" : q.blocked ? "blocked" : "queued";
const waitText = (w: Wait) => `${w.state === "waiting" ? "waits for" : w.state === "landed" ? "landed" : "blocked by"} ${w.thread}: ${w.why}`;
const queuedRow = (q: QueuedThread) => {
  const next = q.waits.find((w) => w.state === "blocked") ?? q.waits.find((w) => w.state === "waiting");
  return [q.id, queuedState(q), next === undefined ? `starting${q.lastError === null ? "" : `: ${clip(q.lastError, 80)}`}` : waitText(next), `node ${q.node}`, q.project, ago(q.createdAt), q.title];
};

function queuedText(q: QueuedThread): string {
  const { cpus, memoryGiB, diskGiB } = q.resources;
  return [
    `${q.id}  ${q.title}`,
    `project: ${q.project}`,
    `status: ${queuedState(q)}`,
    `node: ${q.node === "auto" ? "auto, the node with the most room once it starts" : q.node}`,
    `worker: ${q.worker === "claude" ? `Claude worker, model ${q.model ?? "unknown"}` : "Nexus agent"}`,
    `size: ${cpus} CPUs, ${memoryGiB} GiB memory, ${diskGiB} GiB disk`,
    ...q.branch === null ? [] : [`branch: ${q.branch}`],
    ...q.commit === null ? [] : [`commit: ${q.commit}`],
    ...q.prompt === null ? [] : [`${q.worker === "claude" ? "prompt" : "first message"}: ${clip(q.prompt.split("\n").find((line) => line.trim() !== "")?.trim() ?? "", 120)}`],
    ...q.waits.map(waitText),
    ...q.startNow === null ? [] : [`start-queued by ${q.startNow.by} ${ago(q.startNow.at)}, so it starts without waiting`],
    ...q.lastError === null ? [] : [`last start attempt: ${q.lastError}`],
    ...q.status === "queued" && q.blocked ? [`nexus start-queued ${q.id} starts it now; nexus archive ${q.id} cancels it.`] : [],
    ...q.status === "archived" ? [`nexus unarchive ${q.id} queues it again.`] : [],
  ].join("\n");
}

const itemRow = (i: PipelineItem) => [i.id, i.phase.kind, i.phase.why, i.thread ?? "no thread yet", i.project, ago(i.addedAt), i.title];

function itemText(i: PipelineItem): string {
  return [
    `${i.id}  ${i.title}`,
    `project: ${i.project}`,
    `phase: ${i.phase.kind}, ${i.phase.why}`,
    `thread: ${i.thread ?? "none yet"}`,
    `worker: ${i.worker === "claude" ? `Claude worker, model ${i.model ?? "unknown"}` : "Nexus agent"}`,
    ...i.after.map((id) => `after: ${id}`),
    ...i.brief === null ? [] : [`brief: ${clip(i.brief.split("\n").find((line) => line.trim() !== "")?.trim() ?? "", 120)}`],
    `added by ${i.addedBy} ${ago(i.addedAt)}`,
    ...i.approved === null ? [] : [`approved by ${i.approved.by} ${ago(i.approved.at)}`],
    ...i.thread === null ? [] : [`nexus show ${i.thread} shows its thread.`],
  ].join("\n");
}

/** "A", "A and B", or "A, B and C". */
const listed = (names: readonly string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A control plane older than queued threads has no such route, so it has none queued. */
async function queuedThreads(api: Api, query: string): Promise<QueuedThread[]> {
  try {
    return await api("GET", `/v1/queued${query}`) as QueuedThread[];
  } catch (err) {
    if (isMissingRoute(err)) return [];
    throw err;
  }
}

const threadRow = (t: ThreadRow) => [t.id, t.status, t.usageLimit !== undefined ? usageLimitText(t.usageLimit, Date.now()) : working(t) ? "working" : "-", `pylon ${t.pylon.actualState}`, t.project, ago(t.createdAt), t.title];

/** The first line of a message, as the title of the thread it starts. */
const titleOf = (message: string) => clip(message.split("\n").find((line) => line.trim() !== "")?.trim() ?? message, 80);

async function send(api: Api, id: string, text: string, steer: boolean, requestId: string, idleMs?: number): Promise<{ submission: number } | { claude: ClaudeSent }> {
  return await api("POST", `${thread(id)}/messages`, { text, requestId, mode: steer ? "steer" : "followUp" }, idleMs) as { submission: number } | { claude: ClaudeSent };
}

/** A thread action whose route answers 204. Its JSON is null. */
const action = (path: string, done: string, body?: unknown): Command => ({
  args: [1, 1],
  async run(api, [id]) {
    await api("POST", `${thread(id!)}/${path}`, body);
    return { json: null, text: `${done} ${id}.` };
  },
});

/** A thread action whose route answers the thread, or the queued thread when it has not started. */
const statusChange = (method: string, path: string, done: string, queued: string): Command => ({
  args: [1, 1],
  async run(api, [id]) {
    const t = await api(method, `${thread(id!)}${path}`) as Thread | QueuedThread;
    return { json: t, text: `${done} ${t.id}.${"waits" in t ? ` ${queued}` : ""}` };
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
/** A Claude worker's transcript entry with the CLI's plain rendering of it. */
export interface RenderedClaudeEntry { entry: ClaudeEntry; text: string }
export type WatchEvent =
  | { type: "reset"; thread: string; entries: RenderedEntry[] }
  | { type: "entry"; thread: string } & RenderedEntry
  | { type: "claude-reset"; thread: string; session: string | null; dropped: number; entries: RenderedClaudeEntry[] }
  | { type: "claude-entry"; thread: string } & RenderedClaudeEntry
  | WatchState
  | WatchLive
  | { type: "error"; thread: string; kind: "unreachable" | "failed"; message: string };

function stateOf(d: ThreadDetail, working: boolean, queued: number): WatchState {
  const parkedTasks = d.agent?.parkedTasks ?? 0;
  return {
    type: "state", thread: d.thread.id, status: d.thread.status, run: parkedTasks > 0 ? "parked" : working ? "working" : "idle",
    parkedTasks, queued, pylon: d.pylon.actualState, failed: d.pylon.failed, ports: d.ports,
  };
}

/** What watch keeps of a Claude worker's transcript: the stream's entries, the newest maxEntries of them. */
type Transcript = Omit<ClaudeFrame, "reset">;

/** A Claude worker's run in flight: what Claude Code queued, and each call of the running turn without a result. */
function claudeLiveOf(id: string, c: Transcript): WatchLive {
  const lastTurn = c.entries.findLastIndex((e) => e.kind === "turn");
  const done = new Set(c.entries.flatMap((e) => e.kind === "result" ? [e.toolUseId] : []));
  const running = c.working ? c.entries.slice(lastTurn + 1).flatMap((e) => e.kind === "tool" && !done.has(e.id) ? [{ callId: e.id, output: "" }] : []) : [];
  return { type: "live", thread: id, queued: queuedOf(c.entries).map((q) => q.text ?? ""), tools: running, partial: null, retry: null };
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

const one = (n: number) => Number(n.toFixed(1));

/** Null readings are what the node's host does not expose, so they print as unknown, never as zero. */
function healthText(h: NodeHealth): string {
  const { load, memory, temperatures, pylons } = h;
  return [
    `node: ${h.node}, read ${h.readAt}`,
    `load: ${load === null ? "unknown" : `${load.one.toFixed(2)} ${load.five.toFixed(2)} ${load.fifteen.toFixed(2)} (1, 5, 15 min)`} on ${h.cpus} CPUs`,
    `memory: ${memory === null ? "unknown" : `${one(memory.availableGiB)} of ${one(memory.totalGiB)} GiB available`}`,
    `swap: ${memory === null ? "unknown" : memory.swapTotalGiB === 0 ? "none" : `${one(memory.swapTotalGiB - memory.swapFreeGiB)} of ${one(memory.swapTotalGiB)} GiB used`}`,
    `disk: ${one(h.disk.freeGiB)} of ${one(h.disk.totalGiB)} GiB free at ${h.disk.path}`,
    `temperatures: ${temperatures === null ? "unknown" : temperatures.map((t) => `${t.sensor} ${t.celsius.toFixed(1)} °C`).join(", ")}`,
    ...pylons === null ? ["pylons: unknown"] : pylons.length === 0 ? ["pylons: none running"]
      : pylons.map((p) => `pylon: ${p.pylonId}, ${p.processes} ${p.processes === 1 ? "process" : "processes"}, ${one(p.cpuPercent)}% CPU, ${one(p.residentGiB)} GiB resident`),
  ].join("\n");
}

function stateText(s: WatchState): string {
  const run = s.run === "working" ? ", agent working" : s.run === "parked" ? `, ${s.parkedTasks} parked tasks hold the run` : "";
  const ports = (s.ports ?? []).map((l: ListeningPort) => l.preview?.ready === true ? `${l.port} at ${l.preview.url}` : String(l.port));
  return `-- ${s.status}, pylon ${s.pylon}${s.failed === null ? "" : ` (${s.failed.split("\n")[0]})`}${run}${s.queued === 0 ? "" : `, ${s.queued} queued`}${ports.length === 0 ? "" : `, listening on ${ports.join(", ")}`}`;
}

/**
 * Follows the thread's conversation as the API streams it, and polls the thread. The conversation is pi-durable's
 * active context, not the full history: a new head marker, a compaction or a delete can reorder or drop entries.
 * So the first print shows the context whole, a later one that only appends prints each new entry, and any other
 * change prints it whole again. A Claude worker's transcript streams instead, and prints the same way, whole first
 * and when it was replaced. Then the thread's state and the run in flight, when they changed. Every print comes
 * from the latest of both sources, so an answer's entry is printed before the live event that drops its partial.
 * An unreachable or failing control plane is reported once and retried through, so a live pane survives a restart
 * of the control plane. Ends after the state that says the thread is deleted, or once the process that started it
 * is gone.
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
  const joined = (entries: readonly { text: string }[]) => entries.map((e) => e.text).filter((text) => text !== "").join("\n");
  /** The IDs of the active context as last printed, or null before the first print. */
  let printed: number[] | null = null;
  let shown: string | null = null;
  let liveShown: string | null = null;
  /** The thread as last polled, and its conversation as last streamed. */
  let detail: ThreadDetail | null = null;
  let streamed: View | null = null;
  /** A Claude worker's transcript as streamed, or "none" when it does not stream, such as from an older control plane. */
  let transcript: Transcript | "none" | null = null;
  /** What of the transcript is printed, so each entry prints once across reconnects. */
  const claudePrinted = claudeFrames();
  /** The pull requests printed since the last whole print of the transcript, which Claude Code names again and again. */
  let pullRequests = new Set<string>();
  /** Whether the text stream has printed any of the transcript, which a replaced one then says it replaces. */
  let textShown = false;
  const firstDetail = Promise.withResolvers<ThreadDetail>();
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

  /** Prints what the harness conversation gained, and answers what its run does, or null until its first frame. */
  function printConversation(d: ThreadDetail): { working: boolean; live: WatchLive } | null {
    // A thread with a conversation waits for its first frame.
    if (d.agent !== null && streamed === null) return null;
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
    return { working: view !== null && busy(view), live: liveOf(id, view) };
  }

  /** Prints what a Claude worker's transcript gained, and answers what its turn does, or null until its first frame. */
  function printTranscript(d: ThreadDetail): { working: boolean; live: WatchLive } | null {
    if (transcript === null) return null;
    if (transcript === "none") return { working: d.thread.sessionTurnRunning === true, live: { type: "live", thread: id, queued: [], tools: [], partial: null, retry: null } };
    const frame = claudePrinted(transcript);
    const claudeRendered = (entry: ClaudeEntry): RenderedClaudeEntry => ({
      entry, text: entry.kind === "result" && entry.isError ? `[tool error] ${clip(entry.output, 400)}` : claudeEntryText(entry, pullRequests),
    });
    if (frame?.reset === true) {
      pullRequests = new Set();
      const all = frame.entries.map(claudeRendered);
      // A worker's first session replaces an empty transcript, which replaces nothing a person saw.
      emit({ type: "claude-reset", thread: id, session: frame.session, dropped: frame.dropped, entries: all }, textShown ? `-- Claude's transcript was replaced. It now reads:\n${joined(all)}` : joined(all));
      textShown = all.some((e) => e.text !== "");
    } else {
      for (const entry of frame?.entries ?? []) {
        const e = claudeRendered(entry);
        textShown ||= e.text !== "";
        emit({ type: "claude-entry", thread: id, ...e }, e.text);
      }
    }
    return { working: transcript.working, live: claudeLiveOf(id, transcript) };
  }

  function print() {
    const d = detail;
    if (d === null) return;
    const run = d.claudeWorker === undefined ? printConversation(d) : printTranscript(d);
    if (run === null) return;
    const state = stateOf(d, run.working, run.live.queued.length);
    const key = JSON.stringify(state);
    // After an outage the state is printed again, which tells the consumer the control plane is back.
    if (key !== shown || recovered) emit(state, stateText(state));
    shown = key;
    recovered = false;
    // The text stream already says what the state does of the run, so only JSON carries it.
    const liveKey = JSON.stringify(run.live);
    if (liveKey !== liveShown) emit(run.live, "");
    liveShown = liveKey;
  }

  /** Each connection's first frame is the whole view, and each later one replaces what changed. */
  const onView = (data: unknown, first: boolean) => {
    const frame = data as ViewFrame;
    const docs = { ...first ? {} : streamed!.docs, ...frame.docs };
    for (const [kind, doc] of Object.entries(docs)) if (doc === null) delete docs[kind];
    streamed = { entries: frame.entries ?? streamed!.entries, docs: docs as View["docs"] };
  };
  /** Each connection's first frame is the whole transcript, and each later one adds entries. */
  const onTranscript = (data: unknown) => {
    const { reset, ...frame } = data as ClaudeFrame;
    const entries = reset || transcript === null || transcript === "none" ? frame.entries : [...transcript.entries, ...frame.entries];
    // The server keeps the same newest maxEntries, and its `dropped` counts every entry before them.
    transcript = { ...frame, entries: entries.slice(-maxEntries) };
  };

  const stop = new AbortController();
  /**
   * A dropped stream is opened again after 100 ms, doubling up to the poll interval, and from 100 ms again once a
   * frame arrives. A thread without a conversation, or a deleted one, refuses the stream, and never streams again.
   * A control plane without the route for Claude transcripts is older than it, and streams nothing.
   */
  async function stream() {
    const claude = (await firstDetail.promise).claudeWorker !== undefined;
    for (let attempt = 0; !stop.signal.aborted; attempt++) {
      let first = true;
      try {
        await follow(claude ? `${thread(id)}/claude/events` : `${thread(id)}/events`, (data) => {
          if (claude) onTranscript(data);
          else onView(data, first);
          first = false;
          attempt = 0;
          succeeded("stream");
          print();
        }, stop.signal);
      } catch (err) {
        if (err instanceof CliError && err.kind === "conflict") {
          // A deleted thread's transcript is gone, and its poll still prints its state.
          if (claude) transcript = "none";
          return;
        }
        if (claude && isMissingRoute(err)) {
          transcript = "none";
          emit({ type: "error", thread: id, kind: "failed", message: `The control plane does not stream Claude transcripts. Upgrade it, or run nexus conversation ${id}` }, `-- The control plane does not stream Claude transcripts. Upgrade it, or run nexus conversation ${id}`);
          print();
          return;
        }
        failed("stream", err);
      }
      await sleep(Math.min(100 * 2 ** attempt, intervalMs), undefined, { signal: stop.signal }).catch(() => {});
    }
  }
  async function poll() {
    while (!stop.signal.aborted) {
      try {
        detail = await api("GET", thread(id)) as ThreadDetail;
        firstDetail.resolve(detail);
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

const imageRow = (image: ImageEntry, role: string): string[] => [
  image.id, role, `built ${image.builtAt} on ${image.builtOn}`, `release ${image.release?.slice(0, 12) ?? "unknown"}`,
  `on ${image.nodes.length === 0 ? "none" : image.nodes.join(", ")}`,
];

function operationText(o: ImageOperation): string {
  return [`${o.kind} ${o.image}: ${o.state}${o.state === "failed" ? `: ${o.reason}` : ""}`, ...o.steps.map((s) => `  ${s.node}: ${s.state}${s.reason === null ? "" : `: ${s.reason}`}`)].join("\n");
}

function imagesText(view: ImagesView): string {
  const role = (id: string) => id === view.current ? "current" : id === view.previous ? "previous" : "-";
  const images = view.images.length === 0 ? "No images." : table(view.images.map((image) => imageRow(image, role(image.id))));
  return view.operation === null ? images : `${images}\n${operationText(view.operation)}`;
}

/**
 * Polls the images every 2 s until the operation ends, through restarts of the control plane, as deploy --wait does. Each
 * change of a running step goes to stderr, so a build of minutes shows where it is and stdout stays one value for --json.
 */
async function imageWait(api: Api, started: ImageOperation): Promise<Result> {
  const deadline = Date.now() + 45 * 60_000;
  let operation = started;
  let view: ImagesView | null = null;
  for (;;) {
    if (operation.state === "done") {
      view ??= await api("GET", "/v1/images") as ImagesView;
      return { json: view, text: imagesText(view) };
    }
    if (operation.state === "failed") throw new CliError("failed", operationText(operation));
    if (Date.now() >= deadline) throw new CliError("failed", `image wait timed out\n${operationText(operation)}`);
    await sleep(2_000);
    try { view = await api("GET", "/v1/images") as ImagesView; }
    catch (error) { if (!(error instanceof CliError) || error.kind !== "unreachable") throw error; continue; }
    const now = view.operation;
    if (now === null || now.kind !== started.kind || now.image !== started.image || now.requestedAt !== started.requestedAt) {
      throw new CliError("conflict", `another image operation replaced the ${started.kind} of ${started.image}${now === null ? "" : `\n${operationText(now)}`}`);
    }
    if (now.state === "running" && operationText(now) !== operationText(operation)) process.stderr.write(`${operationText(now)}\n`);
    operation = now;
  }
}

/** Starts an image operation, and with --wait follows it until it ends. */
const imageCommand = (path: string, args: Command["args"], body: (positionals: readonly string[]) => unknown): Command => ({
  args, options: { wait: { type: "boolean" } },
  async run(api, positionals, v) {
    const operation = await api("POST", path, body(positionals)) as ImageOperation;
    return v.wait === true ? imageWait(api, operation) : { json: operation, text: operationText(operation) };
  },
});

/** A URL as given, or a tailnet name at each of the control plane's ports. */
function candidatesOf(host: string): URL[] {
  if (host.includes("://")) return [controlUrl(host)];
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new CliError("invalid", `${host} is neither a tailnet name, such as rj-firebat or rj-firebat.example.ts.net, nor a URL`);
  return controlPorts.map((url) => controlUrl(url.replace("{host}", host)));
}

function connectText(url: string, file: string, caller: Whoami | null): string {
  const head = `Connected to ${url}, saved in ${file}.`;
  const overridden = process.env.NEXUS_URL ? [`NEXUS_URL is set, so it overrides ${file} until you unset it.`] : [];
  if (caller === null) return [head, "This control plane allows this device, and is too old to say whether it may start threads or deploy. Upgrade it, as deploy/README.md describes, and run nexus connect again.", ...overridden].join("\n");
  const may = (yes: boolean, what: string) => `  ${yes ? "may" : "may not"} ${what}`;
  const admit = (why: string) => `To let it ${why}, run this on the control plane's machine, in its nexus checkout: sudo deploy/install.sh --admit ${caller.node}`;
  return [
    head,
    `This device is tailnet node ${caller.node}. It`,
    may(caller.allowed, "read threads, projects and nodes"),
    may(caller.person, "start and message threads"),
    may(caller.deployer, "deploy, land reviews and build images"),
    ...!caller.allowed ? [admit("use Nexus and deploy")]
      : !caller.person ? ["It is the control plane's own node or one of its nodes, which never act as a person. Connect from your own device."]
      : !caller.deployer ? [admit("deploy")] : [],
    ...overridden,
  ].join("\n");
}

const commands: Readonly<Record<string, Command>> = {
  connect: {
    args: [1, 1],
    async run(_, [host], v) {
      const file = configFile();
      const config = await readConfig(file);
      const socks = socksOf(v, config);
      const tried: string[] = [];
      for (const url of candidatesOf(host!)) {
        const endpoint = { url, socks };
        try {
          await call(endpoint, "GET", "/v1/health");
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          // A control plane refuses health to a caller it does not allow, which whoami then names.
          if (err.status !== 403) {
            tried.push(`${url.origin}: ${(err as Error).message}`);
            continue;
          }
        }
        let caller: Whoami | null;
        try {
          caller = await call(endpoint, "GET", "/v1/whoami") as Whoami;
        } catch (err) {
          if (!(err instanceof CliError) || (err.status !== 404 && err.status !== 403)) throw err;
          if (err.status === 403) throw new CliError("refused", `the control plane at ${url.origin} answers, but ${err.message}. Connect with the name the control plane lists in listen.hostnames, such as its full MagicDNS name`, 403);
          caller = null;
        }
        const saved = { ...config, url: url.origin, ...str(v, "socks") === undefined ? {} : { socks: str(v, "socks") } };
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
        return { json: { url: url.origin, socks: saved.socks ?? null, config: file, caller }, text: connectText(url.origin, file, caller) };
      }
      throw new CliError("unreachable", [`no Nexus control plane answers at ${host}${socks === null ? "" : ` through the SOCKS proxy at ${socks.host}:${socks.port}`}:`,
        ...tried.map((line) => `  ${line}`),
        socks === null ? "If this device reaches the tailnet only through a SOCKS5 proxy, such as ts-home's userspace tailscaled, give it with --socks HOST:PORT" : ""].join("\n").trimEnd());
    },
  },
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
  review: {
    args: [1, 1], options: { pr: { type: "string" }, rounds: { type: "string" }, land: { type: "boolean" }, cancel: { type: "boolean" } },
    async run(api, [id], v) {
      if (v.cancel === true) {
        if (v.pr !== undefined || v.rounds !== undefined || v.land !== undefined) throw new CliError("invalid", "--cancel takes no --pr, --rounds or --land");
        const r = await api("POST", `${thread(id!)}/review/cancel`, {}) as Review;
        return { json: r, text: `Cancelled ${reviewText(r)}` };
      }
      const pr = str(v, "pr");
      const rounds = str(v, "rounds");
      const body = { ...pr === undefined ? {} : { pr: int(pr, "--pr", 0) }, ...rounds === undefined ? {} : { rounds: int(rounds, "--rounds", 0) }, ...v.land === true ? { land: true } : {} };
      const r = await api("POST", `${thread(id!)}/review`, body) as Review;
      return { json: r, text: `Started ${reviewText(r)}` };
    },
  },
  land: {
    args: [1, 1],
    async run(api, [id]) {
      const r = await api("POST", `${thread(id!)}/land`, {}) as Review;
      return { json: r, text: `Landing ${reviewText(r)}` };
    },
  },
  deploy: {
    args: [1, 1], options: { wait: { type: "boolean" } },
    async run(api, [commit], values) {
      if (commit !== "main" && !fullCommit.test(commit!)) throw new CliError("invalid", "deploy takes main or a full lower-case commit hash");
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
  "image build": imageCommand("/v1/images/build", [0, 0], () => ({})),
  "image rollout": imageCommand("/v1/images/rollout", [1, 1], ([image]) => ({ image })),
  "image rollback": imageCommand("/v1/images/rollback", [0, 0], () => ({})),
  "image list": {
    args: [0, 0],
    async run(api) {
      const view = await api("GET", "/v1/images") as ImagesView;
      return { json: view, text: imagesText(view) };
    },
  },
  "image current": {
    args: [0, 0],
    async run(api) {
      const images = await api("GET", "/v1/images/current") as { current: ImageEntry | null; previous: ImageEntry | null };
      const rows = (["current", "previous"] as const).flatMap((role) => images[role] === null ? [] : [imageRow(images[role], role)]);
      return { json: images, text: rows.length === 0 ? "No image is current." : table(rows) };
    },
  },
  threads: {
    args: [0, 0],
    options: { project: { type: "string" }, all: { type: "boolean" }, queued: { type: "boolean" } },
    async run(api, _, v) {
      const project = str(v, "project");
      const query = project === undefined ? "" : `?project=${encodeURIComponent(project)}`;
      const queued = (await queuedThreads(api, query)).filter((q) => v.all === true || q.status === "queued");
      if (v.queued === true) return { json: queued, text: queued.length === 0 ? "No queued threads." : table(queued.map(queuedRow)) };
      const threads = await api("GET", `/v1/threads${query}`) as ThreadRow[];
      const shown = v.all === true ? threads : threads.filter((t) => t.status !== "deleted");
      const rows = [...shown.map(threadRow), ...queued.map(queuedRow)];
      return { json: shown, text: rows.length === 0 ? "No threads." : table(rows) };
    },
  },
  show: {
    args: [1, 1],
    async run(api, [id]) {
      let d: ThreadDetail;
      try {
        d = await api("GET", thread(id!)) as ThreadDetail;
      } catch (err) {
        // A queued thread has no row, which the thread route answers with a 409, and an older control plane with a 404.
        if (!(err instanceof CliError) || (err.status !== 404 && err.status !== 409)) throw err;
        const q = await api("GET", `/v1/queued/${encodeURIComponent(id!)}`).catch(() => { throw err; }) as QueuedThread;
        return { json: q, text: queuedText(q) };
      }
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
      const served = agentView(await api("GET", `${thread(id!)}/conversation`) as ConversationView | ClaudeConversation);
      return { json: served.view, text: served.kind === "claude" ? claudeText(served.view) : conversationText(served.view) };
    },
  },
  "session open": {
    args: [1, 1],
    options: { harness: { type: "string" }, title: { type: "string" } },
    async run(api, [id], v) {
      const body = Object.fromEntries((["harness", "title"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
      // The API answers once the agent is ready or waits for its human, which can take a minute.
      const opened = await whenRunning(api, id!, () => api("POST", `${thread(id!)}/sessions`, body, pylonCommandMs), "no session was opened") as OpenedSession;
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
      await attachTerminal(local.connect, id!, processTty());
    },
  },
  start: {
    args: [0, 0],
    options: {
      model: { type: "string" }, claude: { type: "string" }, project: { type: "string" }, title: { type: "string" }, message: { type: "string" }, node: { type: "string" }, branch: { type: "string" }, commit: { type: "string" },
      cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, after: { type: "string" }, "request-id": { type: "string" }, plan: { type: "boolean" },
    },
    async run(api, _, v) {
      const project = str(v, "project");
      if (v.plan === true && (v.claude !== undefined || v.after !== undefined)) throw new CliError("invalid", "--plan starts a Nexus agent thread now, so it takes neither --claude nor --after");
      const message = str(v, "message");
      const claude = str(v, "claude");
      if (v.model !== undefined && claude === undefined) throw new CliError("invalid", "--model requires --claude");
      if (message !== undefined && claude !== undefined) throw new CliError("invalid", "--claude and --message are mutually exclusive");
      const title = str(v, "title") ?? (message === undefined && claude === undefined ? undefined : titleOf(message ?? claude!));
      if (project === undefined) throw new CliError("invalid", "start needs --project");
      if (title === undefined) throw new CliError("invalid", "start needs --title, --message or --claude");
      const optional = Object.fromEntries((["node", "branch", "commit", "claude", "model"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
      const resources = resourcesOf(v);
      const requestId = str(v, "request-id");
      // One request: the control plane sends the first message once the thread starts, as the person's.
      const body = { project, title, ...optional, ...resources === undefined ? {} : { resources }, ...message === undefined ? {} : { message }, ...requestId === undefined ? {} : { requestId }, ...v.plan === true ? { planning: true } : {} };
      const after = str(v, "after")?.split(",").map((id) => id.trim()).filter((id) => id !== "");
      if (after !== undefined) {
        if (after.length === 0) throw new CliError("invalid", "--after needs a thread");
        const q = await api("POST", "/v1/threads", { ...body, after }) as QueuedThread | Thread;
        // A repeat of the request ID after the queued thread started answers the thread.
        if (!("after" in q)) return { json: q, text: `Started ${q.id} on ${q.project}: ${q.title}` };
        return { json: q, text: `Queued ${q.id} on ${q.project}: ${q.title}. It starts once ${listed(q.after)} ${q.after.length === 1 ? "has merged its pull request" : "have merged their pull requests"}.` };
      }
      const t = await api("POST", "/v1/threads", body) as Thread;
      return { json: t, text: `Started ${v.plan === true ? "planning thread " : ""}${t.id} on ${t.project}: ${t.title}${message === undefined ? "" : "\nSent the first message."}` };
    },
  },
  items: {
    args: [0, 0],
    options: { project: { type: "string" }, all: { type: "boolean" } },
    async run(api, _, v) {
      const project = str(v, "project");
      const items = (await api("GET", `/v1/items${project === undefined ? "" : `?project=${encodeURIComponent(project)}`}`) as PipelineItem[]).filter((i) => v.all === true || i.phase.kind !== "cancelled");
      return { json: items, text: items.length === 0 ? "No pipeline items." : table(items.map(itemRow)) };
    },
  },
  "item add": {
    args: [0, 0],
    options: {
      model: { type: "string" }, claude: { type: "string" }, project: { type: "string" }, title: { type: "string" }, message: { type: "string" }, node: { type: "string" }, branch: { type: "string" }, commit: { type: "string" },
      cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, after: { type: "string" },
    },
    async run(api, _, v) {
      const project = str(v, "project");
      const message = str(v, "message");
      const claude = str(v, "claude");
      if (v.model !== undefined && claude === undefined) throw new CliError("invalid", "--model requires --claude");
      if (message !== undefined && claude !== undefined) throw new CliError("invalid", "--claude and --message are mutually exclusive");
      if (project === undefined) throw new CliError("invalid", "item add needs --project");
      if (message === undefined && claude === undefined) throw new CliError("invalid", "item add needs a brief: --message, or --claude for a Claude worker");
      const optional = Object.fromEntries((["node", "branch", "commit", "claude", "model", "message"] as const).flatMap((key) => v[key] === undefined ? [] : [[key, v[key]]]));
      const resources = resourcesOf(v);
      const after = str(v, "after")?.split(",").map((id) => id.trim()).filter((id) => id !== "");
      const i = await api("POST", "/v1/items", { project, title: str(v, "title") ?? titleOf(message ?? claude!), ...optional, ...resources === undefined ? {} : { resources }, ...after === undefined ? {} : { after } }) as PipelineItem;
      return { json: i, text: `Added ${i.id} to ${i.project}: ${i.title}. It is ${i.phase.kind}: ${i.phase.why}.` };
    },
  },
  "item show": {
    args: [1, 1],
    async run(api, [id]) {
      const i = await api("GET", `/v1/items/${encodeURIComponent(id!)}`) as PipelineItem;
      return { json: i, text: itemText(i) };
    },
  },
  "item approve": {
    args: [1, 1],
    async run(api, [id]) {
      const i = await api("POST", `/v1/items/${encodeURIComponent(id!)}/approve`, {}) as PipelineItem;
      return { json: i, text: `Approved ${i.id}. It is ${i.phase.kind}: ${i.phase.why}.` };
    },
  },
  "item cancel": {
    args: [1, 1],
    async run(api, [id]) {
      const i = await api("POST", `/v1/items/${encodeURIComponent(id!)}/cancel`, {}) as PipelineItem;
      return { json: i, text: `Cancelled ${i.id}. It will never become a thread.` };
    },
  },
  "start-queued": {
    args: [1, 1],
    async run(api, [id]) {
      const t = await api("POST", `${thread(id!)}/start`) as Thread;
      return { json: t, text: `Started ${t.id} on ${t.project}: ${t.title}` };
    },
  },
  send: {
    args: [2, Infinity],
    options: { steer: { type: "boolean" }, "request-id": { type: "string" } },
    async run(api, [id, ...words], v) {
      const steer = v.steer === true;
      // The API treats a resend with the same request ID as the same message, so a caller that retries passes one.
      const requestId = str(v, "request-id") ?? `msg:${randomUUID()}`;
      // A Claude worker's message is typed in its pylon, so its send waits for a paused pylon to wake.
      const claude = (await api("GET", thread(id!)) as ThreadDetail).claudeWorker !== undefined;
      const message = () => send(api, id!, words.join(" "), steer, requestId, claude ? pylonCommandMs : undefined);
      const reply = claude ? await whenRunning(api, id!, message, "the message was not sent") : await message();
      if ("claude" in reply) {
        const resumed = reply.claude.resumed ? " Its session was resumed to take it." : "";
        return { json: reply, text: reply.claude.outcome === "queued" ? `Queued for Claude in ${id}, which takes it at its next step.${resumed}` : `Sent to Claude in ${id}.${resumed}` };
      }
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
    options: { unread: { type: "boolean" }, "last-reply-at": { type: "string" } },
    async run(api, [id], v) {
      const shown = str(v, "last-reply-at");
      if (shown !== undefined && v.unread) throw new CliError("invalid", "--last-reply-at marks a reply seen, so it cannot go with --unread");
      await api("POST", `${thread(id!)}/${v.unread ? "unseen" : "seen"}`, shown === undefined ? {} : { lastReplyAt: int(shown, "--last-reply-at", 0) });
      return { json: null, text: `Marked ${id} ${v.unread ? "unread" : "seen"}.` };
    },
  },
  abort: action("abort", "Aborted the run of"),
  retry: action("retry", "Retried the parked tasks of"),
  "retry-pylon": action("pylon/retry", "Retried the pylon of"),
  wake: action("activity", "Recorded activity on", { kind: "human" }),
  archive: statusChange("POST", "/archive", "Archived", "Its queued start is cancelled."),
  unarchive: statusChange("POST", "/unarchive", "Unarchived", "It is queued again."),
  delete: statusChange("DELETE", "", "Deleted", "It will never start."),
  projects: {
    args: [0, 0],
    async run(api) {
      const projects = await api("GET", "/v1/projects") as Project[];
      return { json: projects, text: projects.length === 0 ? "No projects." : table(projects.map((p) => [p.id, `node ${p.defaultNode}`, `branch ${p.defaultBranch}`, autoReviewText(p), pipelineText(p), p.repoUrl ?? "scratch"])) };
    },
  },
  "project edit": {
    args: [1, 1],
    options: {
      node: { type: "string" }, branch: { type: "string" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" },
      "allow-host": { type: "string", multiple: true }, login: { type: "string", multiple: true }, secret: { type: "string", multiple: true },
      "clear-hosts": { type: "boolean" }, "clear-logins": { type: "boolean" }, "clear-secrets": { type: "boolean" },
      "git-name": { type: "string" }, "git-email": { type: "string" }, "clear-git-identity": { type: "boolean" },
      "auto-review": { type: "string" }, pipeline: { type: "string" },
    },
    async run(api, [id], v) {
      const patch: Record<string, unknown> = {};
      for (const [flag, field] of [["node", "defaultNode"], ["branch", "defaultBranch"]] as const) {
        if (v[flag] !== undefined) patch[field] = str(v, flag);
      }
      const resources = resourcesOf(v);
      if (resources !== undefined) patch.resources = resources;
      for (const [flag, clear, field] of [["allow-host", "clear-hosts", "allowedHosts"], ["login", "clear-logins", "logins"], ["secret", "clear-secrets", "secrets"]] as const) {
        if (v[clear] && v[flag] !== undefined) throw new CliError("invalid", `--${clear} conflicts with --${flag}`);
        if (v[clear] || v[flag] !== undefined) patch[field] = flag === "secret" ? strs(v, flag).map(secretGrantOf) : strs(v, flag);
      }
      const name = str(v, "git-name"), email = str(v, "git-email");
      if ((name === undefined) !== (email === undefined) || (v["clear-git-identity"] && name !== undefined)) throw new CliError("invalid", "use --git-name with --git-email, or --clear-git-identity");
      if (v["clear-git-identity"]) patch.gitIdentity = null;
      else if (name !== undefined) patch.gitIdentity = { name, email };
      const auto = str(v, "auto-review");
      if (auto !== undefined) {
        if (!(auto in autoReviews)) throw new CliError("invalid", "--auto-review takes off, review or land");
        patch.autoReview = autoReviews[auto as keyof typeof autoReviews];
      }
      const items = str(v, "pipeline");
      if (items !== undefined) {
        if (!(items in pipelines)) throw new CliError("invalid", "--pipeline takes off, approve or start");
        patch.pipeline = pipelines[items as keyof typeof pipelines];
      }
      const p = await api("PATCH", `/v1/projects/${encodeURIComponent(id!)}`, patch) as Project;
      return { json: p, text: `Updated project ${p.id}, ${autoReviewText(p)}, ${pipelineText(p)}. Existing threads keep their boot settings and grants; start a new thread to apply them.` };
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
      const resources = { cpus: int(str(v, "cpus"), "--cpus", 2), memoryGiB: int(str(v, "memory"), "--memory", 6), diskGiB: int(str(v, "disk"), "--disk", 10) };
      const secrets = strs(v, "secret").map(secretGrantOf);
      const p = await api("POST", "/v1/projects", {
        id, repoUrl, defaultBranch: str(v, "branch") ?? "main", defaultNode: str(v, "node") ?? "auto", resources,
        allowedHosts: strs(v, "allow-host"), secrets, logins: strs(v, "login"), preSetup: null,
      }) as Project;
      return { json: p, text: p.repoUrl === null ? `Added scratch project ${p.id} on ${p.defaultNode}` : `Added project ${p.id} (${p.repoUrl}) on ${p.defaultNode}` };
    },
  },
  usage: {
    args: [0, 0],
    options: { since: { type: "string" }, project: { type: "string" }, by: { type: "string" } },
    async run(api, _, v) {
      const query = new URLSearchParams({ since: str(v, "since") ?? "7d" });
      for (const key of ["project", "by"]) if (str(v, key) !== undefined) query.set(key, str(v, key)!);
      const report = await api("GET", `/v1/usage?${query}`) as ReportedUsage;
      return { json: report, text: usageText(report) };
    },
  },
  "usage backfill": {
    args: [0, 0],
    options: { "dry-run": { type: "boolean" }, stop: { type: "boolean" } },
    async run(api, _, v) {
      if (v["dry-run"] === true && v.stop === true) throw new CliError("invalid", "--dry-run and --stop do not go together");
      if (v["dry-run"] === true) {
        const view = await api("GET", "/v1/usage/backfill") as { backfill: UsageBackfill; plan: BackfillPlanRow[] };
        return { json: view, text: backfillPlanText(view.plan) };
      }
      const state = await api(v.stop === true ? "DELETE" : "POST", "/v1/usage/backfill") as UsageBackfill;
      return { json: state, text: backfillText(state) };
    },
  },
  node: {
    args: [1, 1],
    async run(api, [name]) {
      const health = await api("GET", `/v1/nodes/${encodeURIComponent(name!)}/health`) as NodeHealth;
      return { json: health, text: healthText(health) };
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
          n.capacity === null ? "" : capacityText(n.capacity, n.overcommitted ?? false),
        ])).split("\n").flatMap((line, i) => {
          const held = pylonsText(nodes[i]!.pylons ?? null);
          return held === "" ? [line] : [line, `  pylons: ${held}`];
        }).join("\n"),
      };
    },
  },
};

const configSchema = z.strictObject({ url: z.string().optional(), socks: z.string().optional() });

async function readConfig(file: string): Promise<Config> {
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

type Config = z.infer<typeof configSchema>;
const env = (name: string) => process.env[name] || undefined;

/** Each setting from its flag, then the environment, then the config file. No URL is set until `connect` saves one. */
async function settings(v: Values): Promise<Endpoint> {
  const config = await readConfig(configFile());
  const url = str(v, "url") ?? env("NEXUS_URL") ?? config.url;
  if (url === undefined) throw new CliError("invalid", "no control plane is set. Run nexus connect <host> with its tailnet name, or give --url or NEXUS_URL");
  return { url: controlUrl(url), socks: socksOf(v, config) };
}

function socksOf(v: Values, config: Config): HostPort | null {
  const socks = str(v, "socks") ?? env("NEXUS_SOCKS") ?? config.socks;
  return socks === undefined || socks === "none" ? null : hostPort(socks);
}

function controlUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("invalid", `the control plane URL ${url} is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new CliError("invalid", `the control plane URL ${url} must be http:// or https://`);
  return parsed;
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
  // Only once a command calls the API, since connect sets the URL rather than reading it.
  let target: Promise<Endpoint> | undefined;
  const endpoint = () => target ??= settings(values);
  const result = await command.run(async (method, path, body, idleMs) => call(await endpoint(), method, path, body, idleMs), positionals, values,
    async (path, onEvent, signal, onCursor) => follow(await endpoint(), path, onEvent, signal, onCursor), { connect: async (path) => upgrade(await endpoint(), path) });
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
    process.stderr.write(json ? `${JSON.stringify({ error: err.message, kind: err.kind, status: err.status, code: err.code })}\n`
      : argv.length === 0 ? usage : `nexus: ${err.message}${err.kind === "invalid" && err.status === null ? ". Run nexus --help for usage" : ""}\n`);
    return exitCodes[err.kind];
  }
}

process.exitCode = await main(process.argv.slice(2));
