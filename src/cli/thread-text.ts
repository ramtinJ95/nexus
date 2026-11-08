/**
 * A thread, a queued thread and a pylon's checkout as text, as `show`, `threads`, `review` and the checkout commands
 * print them.
 */
import { usageLimitText, type Placement, type QueuedThread, type Room, type ThreadDetail, type ThreadRow, type ThreadSetup, type Wait } from "../contract/threads.ts";
import type { Question, Review } from "../contract/reviews.ts";
import { reservedNames } from "../contract/reserved.ts";
import { diskGoes, freshVm, keptPast, liveNote, prWatchText, reviewersNote, reviewLine, roundNote, sessionPaused } from "../control/wording.ts";
import type { Changes, Listing } from "../contract/pylon.ts";
import { ago, table, clip } from "./kit.ts";
import { gib } from "../util/gib.ts";

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
export function reviewText(r: Review): string {
  const { live } = r.rounds.at(-1)!;
  const note = liveNote(r);
  const round = roundNote(r);
  const reviewers = reviewersNote(r);
  const { lead, tail } = reviewLine(r);
  return [
    `${lead}${r.reviewer}${tail}`,
    ...reviewers === null ? [] : [reviewers],
    ...round === null ? [] : [round],
    ...note === null ? [] : [note],
    ...live?.kind === "ran" && !live.passed ? live.output.split("\n").slice(-20).map((line) => `  ${line}`) : [],
    ...r.phase.kind === "needs-person" ? r.phase.holds.map((h) => `needs you: ${h.text}`) : [],
    ...r.waiver === null ? [] : [`waived by ${r.waiver.by}${r.waiver.yolo === undefined ? "" : `, by project ${r.waiver.yolo}'s yolo setting,`} at ${r.waiver.head}${r.waiver.from === undefined ? "" : ` (carried from ${r.waiver.from})`}, ${new Date(r.waiver.at).toISOString()}:`, ...r.waiver.holds.map((hold) => `  ${hold}`)],
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
    ..."ask" in q ? rest.map((line) => `  ${line}`) : [],
    ...q.options.length === 0 ? [] : [`  options: ${q.options.map((o) => JSON.stringify(o)).join(", ")}`],
    ...q.reserved === null ? [] : [`  reserved: ${reservedNames[q.reserved]}`],
    q.withdrawn !== undefined ? `  withdrawn when the thread was archived at ${new Date(q.withdrawn.at).toISOString()}`
      : q.answer !== null ? `  answered ${JSON.stringify(q.answer.option)} by ${q.answer.by} at ${new Date(q.answer.at).toISOString()}` : q.answerer === "deployer" ? "  needs a deployer" : "  needs you",
  ].join("\n");
}

/** A judgment's verdict and who gave it, then what Nexus did or what it waits for. */
function judgmentText(j: ThreadDetail["judgments"][number]): string {
  return [
    `judgment of failure ${j.failure} on ${j.node}: ${j.verdict === null ? "no verdict yet" : `${j.verdict.answer}, by the ${j.verdict.by}: ${j.verdict.why}`}`,
    `  ${j.outcome ?? (j.question !== null ? `waits for your answer to question ${j.question}` : j.verdict === null ? `judging since ${new Date(j.startedAt).toISOString()}` : "Nexus acts on it")}`,
  ].join("\n");
}

/** Why a Claude worker's latest turn died and what Nexus does about it, or why Nexus stopped resuming it. */
function deathLines(t: ThreadDetail["thread"], resume: ThreadDetail["resume"]): string[] {
  if (resume?.state === "person") return [`resume: stopped. ${resume.why} Write to it to resume it`];
  if (t.turnDied === undefined) return [];
  const then = resume == null ? "" : resume.state === "left-alone" ? "; Nexus leaves it to you, as you wrote to it"
    : resume.state === "waiting" ? `; Nexus resumes it at ${new Date(resume.due).toISOString()}, ${resume.count} in a row` : `; Nexus resumed it, ${resume.count} in a row`;
  return [`turn died: ${t.turnDied.reason}, at ${new Date(t.turnDied.at).toISOString()}${then}`];
}

export function detailText({ thread: t, pylon: p, agent, sessions, previews, ports, outputs, prWatch, pullRequests, claudeWorker, resume, attention, review, keptPastDay: kept, questions, judgments, planning }: ThreadDetail): string {
  const observed = p.observedAt === null ? "" : `, observed ${ago(Date.parse(p.observedAt))}`;
  return [
    `${t.id}  ${t.title}`,
    `project: ${t.project}`,
    ...planning ? ["planning: its proposed items become questions you accept or reject"] : [],
    ...t.standingRulesRevision === undefined ? [] : [`standing rules: revision ${t.standingRulesRevision} of the project's, sent with its first message`],
    ...(claudeWorker === undefined ? [] : [`Claude worker: ${claudeWorker.state}, model ${claudeWorker.model ?? "unknown"}`, ...(claudeWorker.message === undefined ? [] : [`failed: ${claudeWorker.message}`])]),
    `attention: ${attention ?? "none"}`,
    ...deathLines(t, resume),
    ...t.usageLimit === undefined ? [] : [`usage limit: ${usageLimitText(t.usageLimit, Date.now())}. \`nexus send ${t.id} continue\` resumes it once the limit resets`],
    `status: ${t.status}${t.working ? ", agent working" : ""}`,
    `pylon: ${p.id} on ${p.node}, ${p.actualState}${observed}`,
    ...p.notAnswering === undefined ? [] : [`guest: not answering since ${ago(Date.parse(p.notAnswering.since))}, as its last ${p.notAnswering.timeouts} guest commands got no answer, so messages, files and diffs fail. ${freshVm(t.id)}`],
    ...kept == null ? [] : [`disk: ${keptPast}, as ${kept}`],
    ...t.status !== "archived" || t.usageUnread === undefined ? [] : [`usage: unread, as ${t.usageUnread}, so ${diskGoes(p.actualState === "absent")} without it`],
    ...t.status === "archived" || t.status === "deleted" ? [] : [`attach: nexus attach ${t.id}`],
    `size: ${p.resources.cpus} CPUs, ${p.resources.memoryGiB} GiB memory, ${p.resources.diskGiB} GiB disk${p.resources.nestedVirtualization === true ? ", nested virtualization" : ""}`,
    ...t.placement === undefined ? [] : [`placement: ${placementText(t.placement)}`],
    ...t.setup === undefined ? [] : [`setup: ${setupText(t.setup)}`],
    ...(p.grantsOutdated ? ["grants: older than project; start a new thread to apply current grants (archive/unarchive keeps these grants)"] : []),
    ...p.failed === null ? [] : [`failed: ${p.failed.replaceAll("\n", "\n  ")}`],
    ...p.retryRefused === null ? [] : [`retry refused: ${p.retryRefused}`],
    ...(agent?.parkedTasks ?? 0) === 0 ? [] : [`parked tasks: ${agent!.parkedTasks}. \`nexus retry ${t.id}\` runs them again`],
    // A session in no pane is closed by its ID.
    ...sessions.map((s) => `session: ${s.harness}${s.title === null ? "" : ` ${JSON.stringify(s.title)}`} ${s.herdrPane === null ? `as ${s.id}` : `in pane ${s.herdrPane}`}, ${s.state === "paused" ? sessionPaused(t)
      : s.state === "failed" ? `failed: ${s.message}` : s.status}`),
    ...previews.map((v) => `preview: ${v.service} at ${v.url}${v.failed !== null ? `, not ready: ${v.failed}` : v.ready ? "" : ", not ready"}`),
    ...(ports ?? []).map((l) => `port: ${l.port}${l.service === null ? "" : `, service ${l.service}`}${l.preview === null ? "" : `, previewed at ${l.preview.url}`}`),
    prWatchText(prWatch),
    ...prWatch.enabled && prWatch.error ? [prWatch.error] : [],
    ...pullRequests.map((pr) => `PR #${pr.number}: ${pr.title} — ${pr.state}, checks ${pr.checks}, review ${pr.review} ${pr.url}`),
    ...review == null ? [] : [reviewText(review)],
    ...questions.map(questionText),
    ...judgments.map(judgmentText),
    ...outputs.map((o) => `output: ${o.kind} ${o.ref}`),
  ].join("\n");
}

export function portsText(ports: ThreadDetail["ports"], id: string): string {
  if (ports === null) return "The pylon's listening ports could not be read.";
  if (ports.length === 0) return "No listening ports.";
  return [
    table(ports.map((l) => [String(l.port), l.service ?? "-", l.preview === null ? "-" : `${l.preview.url}${l.preview.failed !== null ? ` (not ready: ${l.preview.failed})` : l.preview.ready ? "" : " (not served yet)"}`])),
    ...ports.some((l) => l.preview === null) ? [`\`nexus preview ${id} <port>\` publishes a port.`] : [],
  ].join("\n");
}

export function listingText(l: Listing): string {
  const where = l.path === "" ? "the checkout" : l.path;
  if (l.entries.length === 0) return `${where} is empty.`;
  return [
    // A directory has no size, so its padding is trimmed.
    table(l.entries.map((e) => [e.kind === "dir" ? `${e.name}/` : e.kind === "symlink" ? `${e.name}@` : e.name, e.size === null ? "" : String(e.size)])).replace(/ +$/gm, ""),
    ...l.truncated ? [`Only the first ${l.entries.length} entries of ${where} are listed.`] : [],
  ].join("\n");
}

export function changesText(c: Changes): string {
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

/** What a queued thread's row and `show` call its status: an archived one is cancelled. */
const queuedState = (q: QueuedThread) => q.status === "archived" ? "cancelled" : q.status === "deleted" ? "deleted" : q.blocked ? "blocked" : "queued";
const waitText = (w: Wait) => `${w.state === "waiting" ? "waits for" : w.state === "landed" ? "landed" : "blocked by"} ${w.thread}: ${w.why}`;
export const queuedRow = (q: QueuedThread) => {
  const next = q.waits.find((w) => w.state === "blocked") ?? q.waits.find((w) => w.state === "waiting");
  return [q.id, queuedState(q), next === undefined ? `${q.blocked ? "refused" : "starting"}${q.lastError === null ? "" : `: ${clip(q.lastError, 80)}`}` : waitText(next), `node ${q.node}`, q.project, ago(q.createdAt), q.title];
};

export function queuedText(q: QueuedThread): string {
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

export const threadRow = (t: ThreadRow) => [t.id, t.status, t.usageLimit !== undefined ? usageLimitText(t.usageLimit, Date.now()) : t.working ? "working" : "-", `pylon ${t.pylon.actualState}`, t.project, ago(t.createdAt), t.title];
