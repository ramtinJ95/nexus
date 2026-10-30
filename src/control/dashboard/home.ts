/** Renders the home page: the inbox of what waits on the person, and every open thread. */
import { desiredPhase } from "../../reconcile.ts";
import { needsPerson } from "../attention.ts";
import type { ThreadDetail } from "../wire.ts";
import type { Registry, Thread } from "../registry.ts";
import { cannotLand, type Review } from "../review-model.ts";
import { heldBy } from "../policy.ts";
import { Html, html, actualBadge, desiredTone, dot, state, icon, menu, limitText, threadState, dims, ago, workingFor, type Part } from "./view.ts";
import type { Context, Need } from "./context.ts";
import { prose, inline } from "./markdown.ts";
import { judgmentCards, questionCard, prOf, landing, nudgeCard } from "./cards.ts";
import { layout, threadsOf, queuedLook, threadTitle, closedLabel, newProjectButton, type Shell } from "./shell.ts";

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
  return layout(c, {
    title: dialogs.start !== undefined ? "Start a thread" : dialogs.addProject === true ? "New project" : "Threads",
    ...dialogs,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Threads</h1></div><div class="bar-end"><a class="btn btn-ghost" href="/projects/new" data-new-project>New project</a><a class="btn btn-new phone-only" href="/threads/new" data-start>New thread</a></div></header>
<div class="scroll"><div class="page page-needs"><p id="action-error" class="error" role="alert" hidden></p><section class="needs" id="needs-you" aria-labelledby="needs-h" data-live>${needsList(c)}</section></div>
<div class="page" id="overview" data-live>
${projects.length === 0 ? html`<div class="first-project"><p class="empty">No projects yet. A project names the repository its threads clone and the node they run on.</p>${newProjectButton}</div>` : projects.map((p) => {
  const { open, closed } = threadsOf(c, p.id);
  const queued = c.queuedIn(p.id);
  return html`<section aria-labelledby="project-${p.id}">
<div class="ov-head"><h2 id="project-${p.id}">${p.id}</h2><code class="dim">${p.repoUrl ?? "scratch, no remote"}</code><a class="btn btn-xs" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}">New thread</a></div>
${open.length === 0 ? html`<p class="empty">No open threads.</p>` : table(open)}
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
${closed.length > 0 && html`<details class="ov-closed" id="closed-${p.id}"><summary>${closedLabel(closed)}</summary>${table(closed)}</details>`}
</section>`;
})}
</div></div>`,
  });
}

/**
 * What waits on the person in the open threads, oldest first, so each card keeps its place while the person works down
 * the list and the one that has waited longest is first. Each source of a thread's `decision` gets its card, and any
 * other attention that needs the person one for the thread. A new reply does not wait on the person, so it has none,
 * but it outranks a dialog in the terminal, which the session's own state says waits.
 */
export function needsOf(c: Pick<Context, "registry" | "row" | "threads">, detail: (thread: Thread) => ThreadDetail): Need[] {
  return c.threads().filter((t) => t.status === "active" || t.status === "idle").flatMap((t): Need[] => {
    const { attention } = c.row(t);
    const review = c.registry.review(t.id);
    const holds = review !== null && review.phase.kind === "approved" && heldBy(review).length > 0;
    if (!holds && t.sessionWaiting !== true && (attention === "reply" || !needsPerson(attention))) return [];
    const d = detail(t);
    const nudged = c.registry.nudge(t.id);
    const needs: Need[] = [
      ...d.review?.phase.kind === "needs-person" || (holds && cannotLand(d.review!, d.thread, prOf(d)) === null) ? [{ kind: "review" as const, d, since: heldSince(c.registry, d.review!) }] : [],
      ...(d.questions ?? []).filter((q) => q.answer === null).map((question) => ({ kind: "question" as const, d, question, since: question.askedAt })),
      ...nudged?.state === "person" ? [{ kind: "nudge" as const, d, since: nudged.turn }] : [],
    ];
    const stuck = attention === "failed" || attention === "parked" || attention === "limited" ? attention : attention !== "decision" && t.sessionWaiting === true ? "waiting" : null;
    if (stuck !== null) needs.push({ kind: "thread", d, attention: stuck, since: t.usageLimit?.stoppedAt ?? Math.max(t.createdAt, t.lastAgentActivityAt) });
    return needs;
  }).sort((a, b) => a.since - b.since);
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

const needId = (n: Need) => `need-${n.d.thread.id}-${n.kind === "question" ? n.question.id : n.kind}`;

/** The inbox's cards, each the card its thread's page shows where there is one, under a line that links the thread. */
function needsList(c: Context): Html {
  const needs = c.needs();
  return html`<div class="ov-head"><h2 id="needs-h">Needs you</h2>${needs.length > 0 && html`<span class="count">${needs.length}</span>`}</div>
${needs.length === 0 ? html`<p class="empty">Nothing waits on you.</p>` : html`<div class="need-list">${needs.map((n) => {
  const t = n.d.thread;
  const [what, body] = needCard(c, n);
  return html`<article class="need need-${n.kind}" id="${needId(n)}" data-thread="${t.id}" data-attention="${n.kind === "thread" ? n.attention : "decision"}" tabindex="-1" aria-label="${what}: ${t.title}">
<div class="need-head"><span class="need-what">${what}</span><a class="need-thread" href="/threads/${t.id}"><span class="dim">${t.project} /</span> ${t.title}</a><span class="need-at">${ago(n.since, c.now)}</span></div>
${body}
</article>`;
})}</div>`}`;
}

/** What the card is, and what it shows: a review, question or nudge as its thread's page shows it, or what stopped the thread and the one action that gets past it. */
function needCard(c: Context, n: Need): [what: string, body: Html] {
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
