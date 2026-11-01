/** Renders the home page: the inbox of what waits on the person, and every open thread. */
import { desiredPhase } from "../../reconcile.ts";
import { needsPerson } from "../attention.ts";
import type { ThreadDetail } from "../wire.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import { cannotLand, type Review } from "../review-model.ts";
import { heldBy } from "../policy.ts";
import { Html, html, actualBadge, desiredTone, dot, state, icon, menu, limitText, threadState, dims, ago, workingFor, type Part } from "./view.ts";
import type { Context, Need, ThreadNeed } from "./context.ts";
import { prose, inline } from "./markdown.ts";
import { cleanupCard, judgmentCards, questionCard, prOf, landing, nudgeCard } from "./cards.ts";
import { boardCards, boardNav, card, columnHead } from "./board.ts";
import { lifeOfThread, miniTrack, needWhy, type Stage } from "./lifecycle.ts";
import { layout, threadsOf, queuedLook, threadTitle, closedLabel, quietLabel, newProjectButton, type Shell } from "./shell.ts";

/** Every open thread with what its pylon is asked to be and is, for the desk and for the phone's thread list. */
export function home(c: Context, dialogs: Pick<Shell, "start" | "addProject">): Html {
  const projects = c.registry.projects();
  const nodes = new Map(c.registry.nodes().map((n) => [n.name, n]));
  const table = (threads: readonly Thread[]) => html`<table class="ov">
<thead><tr><th>Thread</th><th class="wide">Desired</th><th>Observed</th><th class="wide">Node</th><th class="wide">Human</th><th class="wide">Agent</th></tr></thead>
<tbody>${threads.map((t) => {
  const r = c.row(t);
  const desired = desiredPhase(t, c.now);
  const [label, tone] = threadState(r, c.now);
  return html`<tr${dims(r) && html` class="dim"`}>
<td><span class="ov-title">${dot(tone, label)}<a href="/threads/${t.id}">${t.title}</a>${t.status !== "active" && html`<span class="tag">${t.status}</span>`}</span></td>
<td class="wide">${state(desired, desiredTone[desired])}</td>
<td>${state(...actualBadge[r.pylon.actualState])}</td>
<td class="wide">${r.pylon.node}${nodes.get(r.pylon.node)!.state === "offline" && html` <span class="tag">offline</span>`}</td>
<td class="wide">${ago(t.lastHumanActivityAt, c.now)}</td>
<td class="wide">${workingFor(t, c.now) ?? ago(t.lastAgentActivityAt, c.now)}</td>
</tr>`;
})}</tbody>
</table>`;
  const placed = boardCards(c);
  // A held thread with a card in the inbox shows as that card, once.
  const held = (placed.get("held") ?? []).filter((k) => k.life.needs.length === 0);
  const heldCount = c.needs().length + held.length;
  const column = (stage: Exclude<Stage, "held">) => {
    const cards = placed.get(stage) ?? [];
    return html`<section class="col" id="col-${stage}" data-stage="${stage}" aria-labelledby="col-${stage}-h" data-live>${columnHead(stage, cards.length)}
${cards.length === 0 ? html`<p class="col-empty">${emptyColumn[stage]}</p>` : html`<ol class="col-cards">${cards.map(card)}</ol>`}</section>`;
  };
  return layout(c, {
    title: dialogs.start !== undefined ? "Start a thread" : dialogs.addProject === true ? "New project" : "Board",
    ...dialogs,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Board</h1></div>
<div class="seg-bar views" role="radiogroup" aria-label="View"><label class="seg-tab"><input type="radio" name="home-view" value="board" id="view-board" checked>${icon("board")}<span class="seg-label">Board</span></label><label class="seg-tab"><input type="radio" name="home-view" value="table" id="view-table">${icon("list")}<span class="seg-label">Table</span></label></div>
<div class="bar-end"><a class="btn btn-ghost" href="/projects/new" data-new-project>New project</a><a class="btn btn-new phone-only" href="/threads/new" data-start>New thread</a></div></header>
<div class="scroll home-scroll"><p id="action-error" class="error" role="alert" hidden></p>
<nav class="board-nav" id="board-nav" aria-label="Columns" data-live>${boardNav(placed, heldCount)}</nav>
<div class="board" id="board">
${(["planned", "queued", "building", "review"] as const).map(column)}
<section class="col col-held needs" id="needs-you" data-stage="held" aria-labelledby="needs-h" data-live>${needsList(c, held)}</section>
${(["landing", "deployed"] as const).map(column)}
</div>
<div class="page" id="overview" data-live>
${projects.length === 0 ? html`<div class="first-project"><p class="empty">No projects yet. A project names the repository its threads clone and the node they run on.</p>${newProjectButton}</div>` : projects.map((p) => {
  const { recent, quiet, closed } = threadsOf(c, p.id);
  const queued = c.queuedIn(p.id);
  return html`<section aria-labelledby="project-${p.id}">
<div class="ov-head"><h2 id="project-${p.id}">${p.id}</h2><code class="dim">${p.repoUrl ?? "scratch, no remote"}</code><a class="btn btn-xs" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}">New thread</a></div>
${recent.length > 0 ? table(recent) : quiet.length === 0 && html`<p class="empty">No open threads.</p>`}
${queued.length > 0 && html`<h3 class="ov-sub">Queued</h3><table class="ov ov-queued">
<thead><tr><th>Thread</th><th>Waits for</th><th class="wide">Node</th></tr></thead>
<tbody>${queued.map((q) => {
  const [label, tone] = queuedLook(q);
  return html`<tr>
<td><span class="ov-title">${dot(tone, label)}<a href="/threads/${q.id}">${q.title}</a><span class="tag">${label}</span></span></td>
<td>${q.waits.map((w) => html`<span class="ov-wait">${threadTitle(c, w.thread)}: ${w.why}</span>`)}</td>
<td class="wide">${q.node}</td>
</tr>`;
})}</tbody>
</table>`}
${quiet.length > 0 && html`<details class="ov-closed" id="quiet-${p.id}"><summary>${quietLabel(quiet)}</summary>${table(quiet)}</details>`}
${closed.length > 0 && html`<details class="ov-closed" id="closed-${p.id}"><summary>${closedLabel(closed)}</summary>${table(closed)}</details>`}
</section>`;
})}
</div></div>`,
  });
}

/** What an empty column says, so an empty board still reads as the path work takes. */
const emptyColumn: Record<Exclude<Stage, "held">, string> = {
  planned: "No items lined up.", queued: "Nothing waits in the queue.", building: "No agent is building.",
  review: "No pull request in review.", landing: "Nothing is landing.", deployed: "Nothing has landed yet.",
};

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
 * The column held for the person: the inbox's cards, oldest first, each folded to its head and the card its thread's
 * page shows where there is one, then the work held for them that no card acts on, such as an item to approve.
 */
function needsList(c: Context, held: Parameters<typeof card>[0][]): Html {
  const needs = c.needs();
  const fold = (n: Need, head: Html, body: Html, why: string) => html`<details class="need-fold" id="fold-${needId(n)}"><summary class="need-sum" data-why="${why}">${head}</summary>${body}</details>`;
  return html`${columnHead("held", needs.length + held.length, "needs-h")}
${needs.length + held.length === 0 ? html`<p class="col-empty">Nothing waits on you.</p>` : html`<div class="need-list">${needs.map((n) => {
  if (n.kind === "cleanup") {
    const { node } = n.question;
    return html`<article class="need need-cleanup" id="${needId(n)}" data-node="${node}" tabindex="-1" aria-label="Cleanup: ${node}">
${fold(n, html`<div class="need-head"><span class="need-what">Cleanup</span><a class="need-thread" href="/nodes/${node}"><span class="dim">node</span> ${node}</a><span class="need-at">${ago(n.since, c.now)}</span></div>`, cleanupCard(c, n.question), `Frees space on ${node} once you confirm what to delete.`)}
</article>`;
  }
  const t = n.d.thread;
  const [what, body] = needCard(c, n);
  const life = lifeOfThread(c, t.id);
  const why = needWhy(n, c.now);
  return html`<article class="need need-${n.kind}" id="${needId(n)}" data-thread="${t.id}" data-attention="${n.kind === "thread" ? n.attention : "decision"}" tabindex="-1" aria-label="${what}: ${t.title}">
${fold(n, html`<div class="need-head"><span class="need-what">${what}</span><a class="need-thread" href="/threads/${t.id}"><span class="dim">${t.project} /</span> ${t.title}</a><span class="need-at">${ago(n.since, c.now)}</span></div>${miniTrack(life)}`, body, why === "" ? life.why : why)}
</article>`;
})}</div>${held.length > 0 && html`<ol class="col-cards">${held.map(card)}</ol>`}`}`;
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
