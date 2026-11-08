/** Renders the home page: what waits on the person beside the work in flight, and the preview of a thread picked from either. */
import { desiredPhase } from "../reconcile.ts";
import type { ThreadId } from "../../ids.ts";
import type { ThreadDetail } from "../wire.ts";
import type { Thread } from "../thread-store.ts";
import type { Project } from "../project.ts";
import { cannotLand, settled, type Review } from "../review-model.ts";
import { needWording, reviewPr, roundOf, type NeedAction } from "../wording.ts";
import { Html, html, actualBadge, desiredTone, dot, state, icon, menu, threadState, dims, ago, workingFor, type Part } from "./view.ts";
import type { Context } from "./context.ts";
import type { HeldWork, InboxNeed, ThreadNeed } from "../work.ts";
import { prose, inline } from "./markdown.ts";
import { cleanupCard, judgmentCards, questionCard, landing, nudgeCard, resumeCard } from "./cards.ts";
import { layout, threadsOf, queuedLook, threadTitle, closedLabel, quietLabel, newProjectButton, type Shell } from "./shell.ts";
import { lifeOfThread, roleLine, type Life } from "./lifecycle.ts";
import { threadRole } from "../work-model.ts";
import { flightLines, flightRows, flightStack, heldLine, inFlight, itemActions, itemBrief, peekHref, peekKey, peekView, type Peek } from "./flight.ts";
import { lifeTrack } from "./timeline.ts";
import type { Item } from "./items.ts";

/**
 * Two columns: on the left what waits on the person, each a line that opens to its card, and on the right the work in
 * flight by phase, or by project as the full table of every thread, under the preview of the one the person picked.
 * What waits on the person says so only in its card: its line in the work in flight leads there, and picking it
 * marks the card and gives it the latest reply in place of a preview. `card` names which of the thread's cards was picked.
 */
export function home(c: Context, dialogs: Pick<Shell, "start" | "addProject">, peek: Peek | null = null, card: string | null = null): Html {
  const cards = needCards(c);
  const placed = flightRows(flightLines(c), cards);
  // An item that became a thread is that thread's work, and its card is the thread's.
  const peeked = peek === null ? null : peek.kind === "item" && peek.item.thread !== null ? peek.item.thread : peekKey(peek);
  const carded = peeked !== null && cards.has(peeked);
  const flying = inFlight(placed);
  const waiting = c.needs().length;
  return layout(c, {
    title: dialogs.start !== undefined ? "Start a thread" : dialogs.addProject === true ? "New project" : "Threads",
    ...dialogs,
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Threads</h1></div><div class="bar-end"><a class="btn btn-ghost" href="/projects/new" data-new-project>New project</a><a class="btn btn-new phone-only" href="/threads/new" data-start>New thread</a></div></header>
<div class="seg-bar home-seg" role="radiogroup" aria-label="Show"><label class="seg-tab"><input type="radio" name="home-side" value="needs" id="side-needs" checked>Needs you<span class="seg-n" id="seg-needs-n" data-live>${waiting || ""}</span></label><label class="seg-tab"><input type="radio" name="home-side" value="flight" id="side-flight">In flight<span class="seg-n" id="seg-flight-n" data-live>${flying || ""}</span></label></div>
<div class="split${peek !== null && !carded && " peeking"}" id="split">
<p id="action-error" class="error split-error" role="alert" hidden></p>
<section class="split-needs" id="needs-you" aria-labelledby="needs-h" data-live>${needsList(c, carded ? { key: peeked, card, items: peek?.kind === "thread" ? peek.items : null } : null)}</section>
<div class="split-peek" id="peek" data-live>${peekView(c, carded ? null : peek)}</div>
<section class="split-flight" id="in-flight" aria-labelledby="flight-h">
<div class="ov-head flight-head"><h2 id="flight-h">In flight</h2><span class="count" id="flight-n" data-live>${flying}</span>
<div class="seg-bar flight-view" role="radiogroup" aria-label="List the work"><label class="seg-tab"><input type="radio" name="flight-view" value="phase" id="view-phase" checked>By phase</label><label class="seg-tab"><input type="radio" name="flight-view" value="project" id="view-project">By project</label></div></div>
<div class="flight" id="flight" data-live>${flightStack(placed, peeked)}</div>
<div class="flight-projects" id="overview" data-live>${overview(c)}</div>
</section>
</div>`,
  });
}

const autoModes = [["off", "Off"], ["review", "Review"], ["land", "Land"], ["yolo", "Yolo"]] as const;
/** The project's auto-review setting, which a press switches as `nexus project edit --auto-review` does. Landing modes need a deployer. */
function autoReviewSwitch(c: Context, p: Project): Html {
  const current = p.autoReview?.mode ?? "off";
  const by = p.autoReview == null ? "" : `, set by ${p.autoReview.enabledBy}`;
  return html`<span class="auto-review" role="group" aria-label="Auto review for ${p.id}${by}"><span class="dim">Auto review</span>${autoModes.map(([mode, label]) => {
  const refused = mode !== current && (mode === "land" || mode === "yolo") && c.landRefusal === "not a deployer";
  return html`<button type="button" class="btn btn-xs${mode === current ? " btn-primary" : ""}" data-action="auto-review" data-project="${p.id}" data-mode="${mode}" aria-pressed="${mode === current ? "true" : "false"}"${(mode === current || refused) && html` disabled`}${refused && html` title="Landing deploys, so only a deployer may turn it on"`}${mode === "yolo" && html` data-confirm="Turn on yolo for project ${p.id}? Nexus then answers each review's holds question with Land for you, waiving every hold the policy lets you waive, reserved paths and data-deleting migrations included, until you switch it off."`}>${label}</button>`;
})}</span>`;
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
<div class="ov-head"><h2 id="project-${p.id}">${p.id}</h2><code class="dim">${p.repoUrl ?? "scratch, no remote"}</code>${autoReviewSwitch(c, p)}<a class="btn btn-xs" href="/threads/new?project=${encodeURIComponent(p.id)}" data-start="${p.id}">New thread</a></div>
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

/** The key of the work a card is for, as the work in flight and the preview name it. A node's cleanup is no work's. */
const keyOf = (n: InboxNeed) => n.kind === "cleanup" ? null : n.kind === "held" ? heldKey(n.work) : n.d.thread.id;

const needCards = (c: Context) => new Set(c.needs().map(keyOf).filter((key) => key !== null));

const needId = (n: InboxNeed) => n.kind === "cleanup" ? `need-${n.question.node}-${n.question.id}`
  : n.kind === "held" ? `need-${heldKey(n.work)}`
  : `need-${n.d.thread.id}-${n.kind === "question" ? n.question.id : n.kind}`;
const heldKey = (w: HeldWork) => w.kind === "item" ? w.item.id : w.kind === "queued" ? w.q.id : w.thread.id;

/**
 * Needs you: the inbox's cards, oldest first, each folded to one line of what it is, its thread and why it waits, and
 * opening in place to where its work is and the card its thread's page shows where there is one, or for held work to
 * what moves it on. The work the person picked is marked, and its card has the latest reply `picked` read.
 */
function needsList(c: Context, picked: { key: string; card: string | null; items: readonly Item[] | null } | null): Html {
  const needs = c.needs();
  // A thread with several cards says where its work is, and is picked, on the card the person picked, or else its first.
  const lead = (key: string | null) => needs.find((n) => keyOf(n) === key && key === picked?.key && needId(n) === picked.card) ?? needs.find((n) => keyOf(n) === key);
  const leads = new Set(needs.filter((n) => lead(keyOf(n)) === n));
  const mark = (n: InboxNeed) => leads.has(n) && keyOf(n) === picked?.key && " picked";
  const itemsOf = (key: string) => key === picked?.key ? picked.items : null;
  // The picked card opens, so a link to it shows it on a fresh load. A reader's own close survives each poll's swap.
  const fold = (id: string, head: Html, body: Html, why: string, open: Part = false) => html`<details class="need-fold" id="fold-${id}"${open && " open"}><summary class="need-sum" data-why="${why}">${icon("chevron")}${head}</summary><div class="need-body">${body}</div></details>`;
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
    return html`<article class="need need-held${mark(n)}" id="${needId(n)}" data-peek-key="${l.key}" tabindex="-1" aria-label="${what}: ${l.title}">
${fold(needId(n), html`<div class="need-head"><span class="need-what">${what}</span><a class="need-thread" href="${peekHref(l.key)}" data-peek="${l.key}"><span class="dim">${l.project} /</span> ${l.title}</a><span class="need-at">${l.when}</span></div>`,
  html`${n.work.kind === "thread" ? whereNow(c, n.work.d, l.life, itemsOf(l.key)) : html`<div class="need-ctx">${lifeTrack(l.life, false)}</div>`}<p class="land-note">${l.life.why.replace(/\.$/, "")}.</p>${item !== undefined && itemBrief(c, item)}${item !== undefined && project !== undefined ? itemActions(item, project) : n.work.kind === "queued" && html`<div class="need-act"><a class="btn btn-xs" href="/threads/${l.key}">Open thread</a></div>`}`, l.life.why, mark(n))}
</article>`;
  }
  const t = n.d.thread;
  const [what, body] = needCard(c, n);
  const life = lifeOfThread(c, t.id);
  const why = needWording(n, c.now).why || life.why;
  return html`<article class="need need-${n.kind}${mark(n)}" id="${needId(n)}" data-thread="${t.id}" data-attention="${n.kind === "thread" ? n.attention : "decision"}" tabindex="-1" aria-label="${what}: ${t.title}">
${fold(needId(n), html`<div class="need-head"><span class="need-what">${what}</span><a class="need-thread" href="/threads/${t.id}" data-peek="${t.id}"><span class="dim">${t.project} /</span> ${t.title}</a><span class="need-at">${ago(n.since, c.now)}</span></div>`, html`${leads.has(n) ? whereNow(c, n.d, life, itemsOf(t.id)) : n.kind === "review" && html`<p class="need-facts">${prFact(n.d.review!.pr, n.d.review)}</p>`}${body}`, why, mark(n))}
</article>`;
})}</div>`}`;
}

/**
 * Where a thread's work is, in a strip above its card: for a builder the steps it took and the one it waits on the
 * person at, and for any other thread its role line, then its pull request and round, its pylon, and the latest reply
 * once the person picked it, as reading it costs a read of the conversation.
 */
function whereNow(c: Context, d: ThreadDetail, life: Life, items: readonly Item[] | null): Html {
  // A review still under way names the pull request Land merges. One that ended may be of an older one.
  const r = d.review !== null && !settled(d.review) ? d.review : null;
  const pr = r?.pr ?? d.pullRequests.find((x) => x.state === "open") ?? d.pullRequests.at(-1);
  const reply = items?.findLast((i) => i.kind === "agent" && i.text.trim() !== "");
  const role = threadRole(c.registry, d.thread);
  return html`<div class="need-ctx">${role === "builder" ? lifeTrack(life, false) : roleLine(c, d.thread.id, role)}
<p class="need-facts">${pr !== undefined && prFact(pr, r)}<span>${state(...actualBadge[d.pylon.actualState])} <span class="dim">on</span> ${d.pylon.node}</span><a class="link" href="/threads/${d.thread.id}">Open thread</a></p>
${reply?.kind === "agent" && html`<p class="need-reply"><span class="dim">Latest reply${d.thread.lastReplyAt !== null && html` ${ago(d.thread.lastReplyAt, c.now)}`}</span> ${inline(reply.text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim())}</p>`}
</div>`;
}

/** A pull request's link, with its review's round while the review is under way. */
const prFact = (pr: { url: string; title: string; number: number }, r: Review | null) => html`<span><a class="link" href="${pr.url}" target="_blank" rel="noreferrer" title="${pr.title}">#${pr.number}</a>${r !== null && r.rounds.length > 0 && html` <span class="dim">${roundOf(r)}</span>`}</span>`;

/** What the card is, and what it shows: a review, question or nudge as its thread's page shows it, or what stopped the thread and the one action that gets past it. */
function needCard(c: Context, n: ThreadNeed): [what: string, body: Html] {
  const { d } = n;
  const t = d.thread;
  const { label, fix } = needWording(n, c.now);
  if (fix !== null) return [label, html`<p class="land-note">${fix.body}</p><div class="need-act">${needAction(t, fix.action)}</div>`];
  const named = (name: string) => `${name}-${t.id}`;
  switch (n.kind) {
    case "review": {
      const card = landing(c, d, named, true);
      const refused = cannotLand(d.review!, t, reviewPr(d));
      if (refused !== null) return [label, card ?? html`<p class="land-note">It cannot land, as ${refused}.</p>`];
      const summary = reviewPr(d)?.summary;
      const quote = d.review!.rounds.at(-1)!.verdict?.notCheckedLive ?? null;
      return [label, html`${summary !== undefined && summary !== "" && html`<p class="need-summary">${inline(summary)}</p>`}
<div class="need-unchecked"><h3>Not checked live</h3>${quote === null ? html`<p class="land-note">The reviewer quoted nothing.</p>` : prose(quote.replace(/^\s*(#{1,6}\s*)?not checked live:?\s*(\n|$)/i, ""))}</div>
${card}`];
    }
    case "nudge": return [label, nudgeCard(c, t, named)!];
    case "resume": return [label, resumeCard(c, t, named)!];
    case "question": {
      const q = n.question;
      if (q.holds !== undefined) return [label, html`${questionCard(c, q)}${landing(c, d, named, true)}`];
      const judgment = d.judgments.filter((j) => j.question === q.id);
      return [label, html`${judgment.length > 0 && judgmentCards(c, { ...d, judgments: judgment })}${questionCard(c, q)}`];
    }
    default: throw new Error(`need ${n.kind} has no card`);
  }
}

function needAction(t: Thread, a: NeedAction): Html {
  if (a.kind === "terminal") return html`<a class="btn btn-xs" href="/threads/${t.id}#terminal">${icon("terminal")}Open terminal</a>`;
  return html`<button type="button" class="btn btn-xs${a.danger && " danger"}" data-action="${a.action}" data-thread="${t.id}"${a.confirm !== undefined && html` data-confirm="${a.confirm}"`}>${a.label}</button>`;
}
