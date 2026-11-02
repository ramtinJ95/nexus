/** Renders the home page: the inbox of what waits on the person, and every open thread. */
import { needsPerson } from "../attention.ts";
import type { ThreadDetail } from "../wire.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import { cannotLand, type Review } from "../review-model.ts";
import { heldBy } from "../policy.ts";
import type { Project } from "../project.ts";
import type { QueuedThread } from "../queue.ts";
import type { ItemPhase, PipelineItem } from "../pipeline.ts";
import { Html, html, dot, icon, menu, limitText, threadState, dims, ago, workingFor, type Part, type Tone } from "./view.ts";
import type { Context, Need, ThreadNeed } from "./context.ts";
import { prose, inline } from "./markdown.ts";
import { cleanupCard, judgmentCards, questionCard, prOf, landing, nudgeCard } from "./cards.ts";
import { heldAlone, itemsOf, lifeOfItem, lifeOfThread, miniTrack, needWhy, stages, steps, type Life, type Step } from "./lifecycle.ts";
import { layout, threadsOf, queuedLook, closedLabel, quietLabel, newProjectButton, lastActive, type Shell } from "./shell.ts";

/**
 * One line of the overview: a thread, a queued thread or an item not yet a thread, with where its life is and what
 * moves it on. `href` is null for an item, which has no page of its own.
 */
interface Line { title: string; project: string; href: string | null; life: Life; state: readonly [string, Tone]; node: string; when: Part; dim: boolean; actions: Part; order: number }

const threadLine = (c: Context, t: Thread): Line => {
  const r = c.row(t);
  const node = c.registry.node(r.pylon.node);
  return {
    title: t.title, project: t.project, href: `/threads/${t.id}`, life: lifeOfThread(c, t.id), state: threadState(r, c.now),
    node: `${r.pylon.node}${node?.state === "offline" ? ", offline" : ""}`, when: workingFor(t, c.now) ?? ago(lastActive(t), c.now), dim: dims(r), actions: null, order: -lastActive(t),
  };
};
const queuedLine = (c: Context, q: QueuedThread): Line => ({
  title: q.title, project: q.project, href: `/threads/${q.id}`, life: lifeOfThread(c, q.id), state: queuedLook(q), node: q.node, when: "queued", dim: false, actions: null, order: 0,
});
function itemLine(c: Context, i: PipelineItem): Line {
  const p = c.registry.project(i.project);
  return { title: i.title, project: i.project, href: null, life: lifeOfItem(c, i), state: [i.phase.kind, phaseTone[i.phase.kind]], node: "", when: ago(i.addedAt, c.now), dim: false, actions: p === undefined ? null : itemActions(i, p), order: i.addedAt };
}

/** An item's Approve, where its project waits for the person to approve each, and Cancel, until it becomes a thread. */
const itemActions = (i: PipelineItem, p: Project) => i.thread === null && i.phase.kind !== "cancelled" && [
  p.pipeline?.autoStart === false && i.approved === null && html`<button type="button" class="btn btn-xs" data-action="approve-item" data-item="${i.id}">Approve</button>`,
  html`<button type="button" class="btn btn-xs btn-ghost" data-action="cancel-item" data-item="${i.id}" data-confirm="Cancel ${i.title}? It never becomes a thread.">Cancel</button>`,
];
const phaseTone: Record<ItemPhase["kind"], Tone> = {
  planned: "idle", queued: "idle", building: "work", reviewing: "work", landing: "busy", landed: "ok", held: "bad", archived: "muted", cancelled: "muted",
};

const lineRow = (k: Line) => {
  const [label, tone] = k.state;
  return html`<tr${k.dim && html` class="dim"`}>
<td><span class="ov-title">${dot(tone, label)}${k.href === null ? html`<span>${k.title}</span>` : html`<a href="${k.href}">${k.title}</a>`}</span></td>
<td class="wide ov-proj">${k.project}</td>
<td><span class="ov-where">${miniTrack(k.life)}<span class="ov-why">${k.life.why}</span>${k.actions !== null && k.actions !== false && html`<span class="ov-act">${k.actions}</span>`}</span></td>
<td class="wide">${k.node}</td>
<td class="ov-when">${k.when}</td>
</tr>`;
};
const lineTable = (body: Part) => html`<table class="ov ov-life">
<thead><tr><th>Thread</th><th class="wide">Project</th><th>Where it is</th><th class="wide">Node</th><th>Last</th></tr></thead>
${body}
</table>`;
const foldTable = (c: Context, threads: readonly Thread[]) => lineTable(html`<tbody>${threads.map((t) => lineRow(threadLine(c, t)))}</tbody>`);

/** What an empty phase says, so an empty overview still reads as the path work takes. */
const emptyPhase: Record<Step, string> = {
  planned: "No items lined up.", queued: "Nothing waits in the queue.", building: "No agent is building.",
  review: "No pull request in review.", landing: "Nothing is landing.", deployed: "Nothing open has landed.",
};

/**
 * Needs you, then every open thread, queued thread and item not yet a thread under the step its life is at, read from
 * the records as the pipeline reads them. What waits on the person is in Needs you, so the overview leaves it out.
 * Each project's quiet and archived threads fold below, as the sidebar folds them.
 */
export function home(c: Context, dialogs: Pick<Shell, "start" | "addProject">): Html {
  const projects = c.registry.projects();
  const byProject = new Map(projects.map((p) => [p.id, threadsOf(c, p.id)]));
  const items = itemsOf(c);
  const lines = [
    ...items.filter((i) => i.thread === null).map((i) => itemLine(c, i)),
    ...projects.flatMap((p) => c.queuedIn(p.id)).map((q) => queuedLine(c, q)),
    ...[...byProject.values()].flatMap((t) => t.recent).map((t) => threadLine(c, t)),
  ];
  const placed = Map.groupBy(lines.filter((k) => k.life.stage !== null), (k) => k.life.stage!);
  for (const phase of placed.values()) phase.sort((a, b) => a.order - b.order);
  const held = [...lines, ...[...byProject.values()].flatMap((t) => t.quiet).map((t) => threadLine(c, t))].filter((k) => heldAlone(k.life));
  const folds = projects.flatMap((p) => {
    const { quiet, closed } = byProject.get(p.id)!;
    return [
      quiet.length > 0 && html`<details class="ov-closed" id="quiet-${p.id}"><summary>${quietLabel(quiet)} in ${p.id}</summary>${foldTable(c, quiet)}</details>`,
      closed.length > 0 && html`<details class="ov-closed" id="closed-${p.id}"><summary>${closedLabel(closed)} in ${p.id}</summary>${foldTable(c, closed)}</details>`,
    ];
  }).filter((f) => f !== false);
  return layout(c, {
    title: dialogs.start !== undefined ? "Start a thread" : dialogs.addProject === true ? "New project" : "Threads",
    ...dialogs,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Threads</h1></div><div class="bar-end"><a class="btn btn-ghost" href="/projects/new" data-new-project>New project</a><a class="btn btn-new phone-only" href="/threads/new" data-start>New thread</a></div></header>
<div class="scroll"><div class="page page-needs"><p id="action-error" class="error" role="alert" hidden></p><section class="needs" id="needs-you" aria-labelledby="needs-h" data-live>${needsList(c, held)}</section></div>
<div class="page" id="overview" data-live>
${projects.length === 0 ? html`<div class="first-project"><p class="empty">No projects yet. A project names the repository its threads clone and the node they run on.</p>${newProjectButton}</div>` : html`<section aria-labelledby="phases-h">
<div class="ov-head"><h2 id="phases-h">Everything else</h2><span class="dim">by the step each is at</span></div>
${lineTable(steps.map((step) => {
  const at = placed.get(step) ?? [];
  const s = stages.find((x) => x.stage === step)!;
  return html`<tbody class="phase" id="phase-${step}" aria-labelledby="phase-${step}-h">
<tr class="phase-h"><th colspan="5" scope="rowgroup"><span class="mark mark-${step}" aria-hidden="true"></span><span id="phase-${step}-h">${s.label}</span><span class="phase-n">${at.length}</span><span class="phase-means">${at.length > 0 ? s.means : step === "planned" && !projects.some((p) => p.pipeline != null) ? html`No project runs the pipeline. <code>nexus project edit &lt;id&gt; --pipeline start</code> turns it on.` : emptyPhase[step]}</span></th></tr>
${at.map(lineRow)}
</tbody>`;
}))}
</section>
${folds.length > 0 && html`<section class="ov-folds" aria-label="Quiet and archived">${folds}</section>`}`}
</div></div>`,
  });
}

/**
 * What waits on the person in the open threads and on the nodes, oldest first, so each card keeps its place while the
 * person works down the list and the one that has waited longest is first. Each source of a thread's `decision` gets
 * its card, and any other attention that needs the person one for the thread. A new reply does not wait on the person,
 * so it has none, but it outranks a dialog in the terminal, which the session's own state says waits. Each node's open
 * cleanup question gets its card too.
 */
export function needsOf(c: Pick<Context, "registry" | "row" | "threads">, detail: (thread: Thread) => ThreadDetail): Need[] {
  const cleanups = c.registry.openNodeQuestions().map((question): Need => ({ kind: "cleanup", question, since: question.askedAt }));
  return [...cleanups, ...c.threads().filter((t) => t.status === "active" || t.status === "idle").flatMap((t): ThreadNeed[] => {
    const { attention } = c.row(t);
    const review = c.registry.review(t.id);
    const holds = review !== null && review.phase.kind === "approved" && heldBy(review).length > 0;
    if (!holds && t.sessionWaiting !== true && (attention === "reply" || !needsPerson(attention))) return [];
    const d = detail(t);
    const nudged = c.registry.nudge(t.id);
    const needs: ThreadNeed[] = [
      ...d.review?.phase.kind === "needs-person" || (holds && cannotLand(d.review!, d.thread, prOf(d)) === null) ? [{ kind: "review" as const, d, since: heldSince(c.registry, d.review!) }] : [],
      ...(d.questions ?? []).filter((q) => q.answer === null).map((question) => ({ kind: "question" as const, d, question, since: question.askedAt })),
      ...nudged?.state === "person" ? [{ kind: "nudge" as const, d, since: nudged.turn }] : [],
    ];
    const stuck = attention === "failed" || attention === "parked" || attention === "limited" ? attention : attention !== "decision" && t.sessionWaiting === true ? "waiting" : null;
    if (stuck !== null) needs.push({ kind: "thread", d, attention: stuck, since: t.usageLimit?.stoppedAt ?? Math.max(t.createdAt, t.lastAgentActivityAt) });
    return needs;
  })].sort((a, b) => a.since - b.since);
}

/**
 * When the review entered the phase it is in, from the oldest of the `review.changed` events in a row that record it
 * there, as a label change records one again. The review's own `since` stands in once those events are gone.
 */
function heldSince(registry: Registry, r: Review): number {
  const changes = registry.events("0", { thread: r.builder, kinds: ["review.changed"] });
  const at = changes.findLastIndex((e) => e.payload.review !== r.id || (e.payload.phase as Review["phase"] | undefined)?.kind !== r.phase.kind);
  return changes[at + 1]?.time ?? r.since;
}

const needId = (n: Need) => n.kind === "cleanup" ? `need-${n.question.node}-${n.question.id}` : `need-${n.d.thread.id}-${n.kind === "question" ? n.question.id : n.kind}`;

/**
 * The inbox: each thing that waits on the person, oldest first, folded to one line that says what it is, whose it is
 * and why, and opening in place to the card its thread's page shows, with its actions. Work held for the person that
 * no card acts on, such as a blocked queued thread, follows as a line that links it.
 */
function needsList(c: Context, held: readonly Line[]): Html {
  const needs = c.needs();
  const count = needs.length + held.length;
  const line = (n: Need, what: string, who: Html, why: string, body: Html) => html`<details class="need-fold" id="fold-${needId(n)}"><summary class="need-sum"><span class="need-what">${what}</span>${who}<span class="need-why">${why}</span><span class="need-at">${ago(n.since, c.now)}</span>${icon("chevron")}</summary>
<div class="need-body">${body}</div></details>`;
  return html`<div class="ov-head"><h2 id="needs-h">Needs you</h2>${count > 0 && html`<span class="count">${count}</span>`}</div>
${count === 0 ? html`<p class="empty">Nothing waits on you.</p>` : html`<div class="need-list">${needs.map((n) => {
  if (n.kind === "cleanup") {
    const { node } = n.question;
    return html`<article class="need need-cleanup" id="${needId(n)}" data-node="${node}" tabindex="-1" aria-label="Cleanup: ${node}">
${line(n, "Cleanup", html`<a class="need-thread" href="/nodes/${node}"><span class="dim">node</span> ${node}</a>`, "Frees space once you confirm what to delete", cleanupCard(c, n.question))}
</article>`;
  }
  const t = n.d.thread;
  const [what, body] = needCard(c, n);
  const why = needWhy(n, c.now) || lifeOfThread(c, t.id).why;
  return html`<article class="need need-${n.kind}" id="${needId(n)}" data-thread="${t.id}" data-attention="${n.kind === "thread" ? n.attention : "decision"}" tabindex="-1" aria-label="${what}: ${t.title}">
${line(n, what, html`<a class="need-thread" href="/threads/${t.id}"><span class="dim">${t.project} /</span> ${t.title}</a>`, why, body)}
</article>`;
})}${held.map((k) => html`<div class="need need-held"><div class="need-sum"><span class="need-what">Held</span><span class="need-thread">${k.href === null ? html`<span class="dim">${k.project} /</span> ${k.title}` : html`<a href="${k.href}"><span class="dim">${k.project} /</span> ${k.title}</a>`}</span><span class="need-why">${k.life.why}</span>${k.actions !== null && k.actions !== false && html`<span class="need-act">${k.actions}</span>`}<span class="need-at">${k.when}</span></div></div>`)}</div>`}`;
}

/** What the card is, and what it shows: a review, question or nudge as its thread's page shows it, or what stopped the thread and the one action that gets past it. */
function needCard(c: Context, n: ThreadNeed): [what: string, body: Html] {
  const { d } = n;
  const t = d.thread;
  const button = (action: string, label: string) => html`<button type="button" class="btn btn-xs" data-action="${action}" data-thread="${t.id}">${label}</button>`;
  const fix = (why: Part, act: Part) => html`<p class="land-note">${why}</p><div class="need-act">${act}</div>`;
  switch (n.kind) {
    case "review": {
      const card = landing(c, d, (name) => `${name}-${t.id}`);
      const pr = prOf(d);
      if (cannotLand(d.review!, t, pr) !== null) return ["Review needs you", html`${card}`];
      const summary = pr?.summary;
      const quote = d.review!.rounds.at(-1)!.verdict?.notCheckedLive ?? null;
      return [d.review!.phase.kind === "needs-person" ? "Held review" : "Approved review", html`${summary !== undefined && summary !== "" && html`<p class="need-summary">${inline(summary)}</p>`}
<div class="need-unchecked"><h3>Not checked live</h3>${quote === null ? html`<p class="land-note">The reviewer quoted nothing.</p>` : prose(quote)}</div>
${card}`];
    }
    case "nudge": return ["Stopped short", nudgeCard(c, t, (name) => `${name}-${t.id}`)!];
    case "question": {
      const q = n.question;
      const judgment = (d.judgments ?? []).filter((j) => j.question === q.id);
      return [q.ask !== undefined ? "Claude asks" : q.proposal !== undefined ? "Proposed item" : judgment.length > 0 ? "Judgment" : "Question",
        html`${judgment.length > 0 && judgmentCards(c, { ...d, judgments: judgment })}${questionCard(c, q)}`];
    }
    case "thread": switch (n.attention) {
      case "waiting": return ["Dialog in its terminal", fix(`${t.sessionWaitingMessage ?? "A dialog waits for input"}, in the pylon's terminal.`, html`<a class="btn btn-xs" href="/threads/${t.id}#terminal">${icon("terminal")}Open terminal</a>`)];
      case "limited": return ["Usage limit", fix(`It ${limitText(t, c.now)}. Nexus has it continue once the limit resets, or archive it to stop it.`, button("archive", "Archive"))];
      case "parked": return ["Stuck", fix(`${d.agent?.parkedTasks ?? 0} ${d.agent?.parkedTasks === 1 ? "task" : "tasks"} hit the restart limit and hold the run.`, button("retry", "Retry"))];
      case "failed": {
        const why = d.pylon.failed?.split("\n")[0] ?? d.claudeWorker?.message ?? "It failed.";
        return ["Failed", d.pylon.failed !== null && d.pylon.retryRefused === null ? fix(`The planner gave up on its pylon: ${why}`, button("retry-pylon", "Retry"))
          : fix(d.pylon.failed !== null ? `The planner gave up on its pylon: ${why} ${d.pylon.retryRefused}.` : `The Claude worker failed: ${why}`, button("archive", "Archive"))];
      }
    }
  }
}
