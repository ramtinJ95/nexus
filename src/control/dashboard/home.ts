/** Renders the home page: what waits on the person beside the work in flight, and the preview of a thread picked from either. */
import { desiredPhase } from "../../reconcile.ts";
import type { ThreadId } from "../../ids.ts";
import { threadPhase } from "../pipeline.ts";
import { needsPerson } from "../attention.ts";
import type { ThreadDetail } from "../wire.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import { cannotLand, type Review } from "../review-model.ts";
import { heldBy } from "../policy.ts";
import { Html, html, actualBadge, desiredTone, dot, state, icon, menu, limitText, threadState, dims, ago, workingFor, type Part } from "./view.ts";
import type { Context, HeldWork, Need, ThreadNeed } from "./context.ts";
import { prose, inline } from "./markdown.ts";
import { cleanupCard, judgmentCards, questionCard, prOf, landing, nudgeCard } from "./cards.ts";
import { layout, threadsOf, queuedLook, threadTitle, closedLabel, quietLabel, newProjectButton, type Shell } from "./shell.ts";
import { lifeOfThread, needWhy, itemsOf } from "./lifecycle.ts";
import { flightLines, flightStack, heldLine, inFlight, itemActions, peekHref, peekKey, peekView, type Peek } from "./flight.ts";

/**
 * Two columns: on the left what waits on the person, each a line that opens to its card, and on the right the work in
 * flight by phase, or by project as the full table of every thread, under the preview of the one the person picked.
 */
export function home(c: Context, dialogs: Pick<Shell, "start" | "addProject">, peek: Peek | null = null): Html {
  const placed = flightLines(c);
  const peeked = peek === null ? null : peekKey(peek);
  const flying = inFlight(placed);
  const waiting = c.needs().length;
  return layout(c, {
    title: dialogs.start !== undefined ? "Start a thread" : dialogs.addProject === true ? "New project" : "Threads",
    ...dialogs,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Threads</h1></div><div class="bar-end"><a class="btn btn-ghost" href="/projects/new" data-new-project>New project</a><a class="btn btn-new phone-only" href="/threads/new" data-start>New thread</a></div></header>
<div class="seg-bar home-seg" role="radiogroup" aria-label="Show"><label class="seg-tab"><input type="radio" name="home-side" value="needs" id="side-needs" checked>Needs you<span class="seg-n" id="seg-needs-n" data-live>${waiting || ""}</span></label><label class="seg-tab"><input type="radio" name="home-side" value="flight" id="side-flight">In flight<span class="seg-n" id="seg-flight-n" data-live>${flying || ""}</span></label></div>
<div class="split${peek !== null && " peeking"}" id="split">
<p id="action-error" class="error split-error" role="alert" hidden></p>
<section class="split-needs" id="needs-you" aria-labelledby="needs-h" data-live>${needsList(c)}</section>
<div class="split-peek" id="peek" data-live>${peekView(c, peek)}</div>
<section class="split-flight" id="in-flight" aria-labelledby="flight-h">
<div class="ov-head flight-head"><h2 id="flight-h">In flight</h2><span class="count" id="flight-n" data-live>${flying}</span>
<div class="seg-bar flight-view" role="radiogroup" aria-label="List the work"><label class="seg-tab"><input type="radio" name="flight-view" value="phase" id="view-phase" checked>By phase</label><label class="seg-tab"><input type="radio" name="flight-view" value="project" id="view-project">By project</label></div></div>
<div class="flight" id="flight" data-live>${flightStack(placed, peeked)}</div>
<div class="flight-projects" id="overview" data-live>${overview(c)}</div>
</section>
</div>`,
  });
}

/** Each project's threads as a table of what each pylon is asked to be and is, with its queued threads and its quiet and closed folds. */
function overview(c: Context): Html {
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
  return html`${projects.length === 0 ? html`<div class="first-project"><p class="empty">No projects yet. A project names the repository its threads clone and the node they run on.</p>${newProjectButton}</div>` : projects.map((p) => {
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
})}`;
}

/**
 * What waits on the person in the open threads and on the nodes, oldest first, so each card keeps its place while the
 * person works down the list and the one that has waited longest is first. Each source of a thread's `decision` gets
 * its card, and any other attention that needs the person one for the thread. A new reply does not wait on the person,
 * so it has none, but it outranks a dialog in the terminal, which the session's own state says waits. Each node's open
 * cleanup question gets its card too. After the cards, oldest first too, comes the work its pipeline phase holds for
 * the person that no card acts on.
 */
export function needsOf(c: Pick<Context, "registry" | "row" | "threads" | "queuedIn">, detail: (thread: Thread) => ThreadDetail): Need[] {
  const cleanups = c.registry.openNodeQuestions().map((question): Need => ({ kind: "cleanup", question, since: question.askedAt }));
  const cards = [...cleanups, ...c.threads().filter((t) => t.status === "active" || t.status === "idle").flatMap((t): ThreadNeed[] => {
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
  const carded = new Set(cards.flatMap((n) => n.kind === "cleanup" || n.kind === "held" ? [] : [n.d.thread.id]));
  const holds = (id: ThreadId) => threadPhase(c.registry, id).kind === "held";
  const held = [
    ...itemsOf(c).filter((item) => item.thread === null && item.phase.kind === "held").map((item): Need => ({ kind: "held", work: { kind: "item", item }, since: item.addedAt })),
    ...c.registry.projects().flatMap((p) => c.queuedIn(p.id)).filter((q) => holds(q.id)).map((q): Need => ({ kind: "held", work: { kind: "queued", q }, since: q.createdAt })),
    ...c.threads().filter((t) => t.status !== "deleted" && !carded.has(t.id) && holds(t.id)).map((thread): Need => ({ kind: "held", work: { kind: "thread", thread }, since: Math.max(thread.createdAt, thread.lastAgentActivityAt) })),
  ].sort((a, b) => a.since - b.since);
  return [...cards, ...held];
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

const needId = (n: Need) => n.kind === "cleanup" ? `need-${n.question.node}-${n.question.id}`
  : n.kind === "held" ? `need-${heldKey(n.work)}`
  : `need-${n.d.thread.id}-${n.kind === "question" ? n.question.id : n.kind}`;
const heldKey = (w: HeldWork) => w.kind === "item" ? w.item.id : w.kind === "queued" ? w.q.id : w.thread.id;

/**
 * Needs you: the inbox's cards, oldest first, each folded to one line of what it is, its thread and why it waits, and
 * opening in place to the card its thread's page shows where there is one, or for held work to what moves it on.
 */
function needsList(c: Context): Html {
  const needs = c.needs();
  const fold = (id: string, head: Html, body: Html, why: string) => html`<details class="need-fold" id="fold-${id}"><summary class="need-sum" data-why="${why}">${icon("chevron")}${head}</summary><div class="need-body">${body}</div></details>`;
  return html`<div class="ov-head"><h2 id="needs-h">Needs you</h2>${needs.length > 0 && html`<span class="count">${needs.length}</span>`}</div>
${needs.length === 0 ? html`<p class="empty">Nothing waits on you.</p>` : html`<div class="need-list">${needs.map((n) => {
  if (n.kind === "cleanup") {
    const { node } = n.question;
    return html`<article class="need need-cleanup" id="${needId(n)}" data-node="${node}" tabindex="-1" aria-label="Cleanup: ${node}">
${fold(needId(n), html`<div class="need-head"><span class="need-what">Cleanup</span><a class="need-thread" href="/nodes/${node}"><span class="dim">node</span> ${node}</a><span class="need-at">${ago(n.since, c.now)}</span></div>`, cleanupCard(c, n.question), `Frees space on ${node} once you confirm what to delete`)}
</article>`;
  }
  if (n.kind === "held") {
    const l = heldLine(c, n.work);
    const item = n.work.kind === "item" ? n.work.item : undefined;
    const project = item === undefined ? undefined : c.registry.project(item.project);
    const what = item === undefined ? (l.state[0] === "blocked" ? "Blocked" : "Held") : item.approved === null && project?.pipeline?.autoStart === false ? "Approve item" : "Held item";
    return html`<article class="need need-held" id="${needId(n)}" data-peek-key="${l.key}" tabindex="-1" aria-label="${what}: ${l.title}">
${fold(needId(n), html`<div class="need-head"><span class="need-what">${what}</span><a class="need-thread" href="${peekHref(l.key)}" data-peek="${l.key}"><span class="dim">${l.project} /</span> ${l.title}</a><span class="need-at">${l.when}</span></div>`,
  html`<p class="land-note">${l.life.why.replace(/\.$/, "")}.</p>${item !== undefined && project !== undefined ? itemActions(item, project) : html`<div class="need-act"><a class="btn btn-xs" href="/threads/${l.key}">Open thread</a></div>`}`, l.life.why)}
</article>`;
  }
  const t = n.d.thread;
  const [what, body] = needCard(c, n);
  const why = needWhy(n, c.now) || lifeOfThread(c, t.id).why;
  return html`<article class="need need-${n.kind}" id="${needId(n)}" data-thread="${t.id}" data-attention="${n.kind === "thread" ? n.attention : "decision"}" tabindex="-1" aria-label="${what}: ${t.title}">
${fold(needId(n), html`<div class="need-head"><span class="need-what">${what}</span><a class="need-thread" href="/threads/${t.id}" data-peek="${t.id}"><span class="dim">${t.project} /</span> ${t.title}</a><span class="need-at">${ago(n.since, c.now)}</span></div>`, body, why)}
</article>`;
})}</div>`}`;
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
