import type { ThreadDetail } from "../wire.ts";
import type { Thread } from "../thread-store.ts";
import type { TailnetNodeId, ThreadId } from "../../ids.ts";
import { blocks as blocking, cancellable, cannotLand, findingsOf, pushedHead, type Review } from "../review-model.ts";
import { answerFinal } from "../plain-wording.ts";
import { needLabels, reviewersNote, reviewPr, roundNote, roundOf, stoppedShort } from "../wording.ts";
import { holdRule } from "../holds.ts";
import { reservedNames } from "../../contract/reserved.ts";
import { holdsAt, landPress } from "../policy.ts";
import type { holdOptions } from "../../contract/reviews.ts";
import { askingHolds, type AnswerRefusal, type ClaudeQuestion, type CleanupQuestion, type HoldsQuestion, type JudgmentQuestion, type ProposalQuestion, type Question, type ThreadQuestion } from "../questions.ts";
import { bytesText, itemKey, itemText, type cleanupOptions } from "../cleanup-model.ts";
import type { judgmentOptions } from "../judgment.ts";
import type { proposalOptions } from "../planning.ts";
import { Html, html, ago, short } from "./view.ts";
import type { LandRefusal, Context } from "./context.ts";
import { prose } from "./markdown.ts";
import { landingTrack } from "./lifecycle.ts";
import { notConfigured } from "../not-configured.ts";

const landRefusals: Record<LandRefusal, (caller: TailnetNodeId) => string> = {
  "not a deployer": (caller) => `This device cannot land: landing deploys, so only the control plane's deployers may, and this device (tailnet node ${caller}) is not one. Land it from a deployer, or add this node to deployers in the control plane's config.`,
  "no review loop": () => `Nexus cannot land it now: ${notConfigured.reviews}.`,
};

const answerRefusals: Record<AnswerRefusal, (caller: TailnetNodeId) => string> = {
  "not a person": (caller) => `This device cannot answer: tailnet node ${caller} is the control plane or one of its nodes, whose pylons call under its identity, and only a person's device may answer. Answer it from your laptop or phone.`,
  "not a deployer": (caller) => `This device cannot answer: the answer may deploy, so only the control plane's deployers may, and this device (tailnet node ${caller}) is not one. Answer it from a deployer, or add this node to deployers in the control plane's config.`,
};
/** Where a thread's card shows: on its page, or in the Needs you inbox beside other threads' cards. */
export type Place = "page" | "inbox";
/** A card's element IDs, which the inbox suffixes with the thread's, as it shows several threads' cards. */
const namer = (place: Place, thread: ThreadId) => (name: string) => place === "inbox" ? `${name}-${thread}` : name;

const answerers: Record<Question["answerer"], string> = { person: "You answer.", deployer: "A deployer answers, as the answer may deploy." };

/** An option's button: its label, and what pressing it asks the person to confirm, or null when it answers at once. */
interface Offer<Q> { label: string; confirm: ((q: Q) => string) | null }
/** Each option of a question of one kind, by the value its answer names, so a label reworded here answers the same. */
type Offers<Q, Values> = Readonly<Record<Values extends readonly string[] ? Values[number] : Values[keyof Values] & string, Offer<Q>>>;
const answering = (label: string): Offer<unknown> => ({ label, confirm: () => `Answer "${label}"? ${answerFinal}` });
const offers = {
  // Land on a question about holds is a Land press, so its confirmation says what it waives and merges.
  holds: { Land: { label: "Land", confirm: (q) => `${q.text.split("\n")[0]} ${answerFinal}` }, "Leave it": answering("Leave it") } satisfies Offers<HoldsQuestion, typeof holdOptions>,
  proposal: { accept: answering("accept"), reject: answering("reject") } satisfies Offers<ProposalQuestion, typeof proposalOptions>,
  judgment: { Retry: answering("Retry"), "Retry on another node": answering("Retry on another node"), "Leave it failed": answering("Leave it failed") } satisfies Offers<JudgmentQuestion, typeof judgmentOptions>,
  cleanup: {
    Delete: { label: "Delete", confirm: (q) => `Delete ${q.cleanup.items.length === 1 ? "this item" : `these ${q.cleanup.items.length} items`} from ${q.node}? It cannot be undone.` },
    Keep: { label: "Keep", confirm: null },
  } satisfies Offers<CleanupQuestion, typeof cleanupOptions>,
};
const offerOf = <Q extends Exclude<Question, ClaudeQuestion>>(q: Q, option: string): Offer<Q> =>
  (offers[q.kind] as Readonly<Record<string, Offer<Q>>>)[option] ?? answering(option);

/**
 * Above the questions, each judgment of the thread's failed pylon: what failed, the verdict and who gave it, and what
 * Nexus did, with what the judgment was asked and what it answered. A question it asks is the question card below.
 */
export function judgmentCards(c: Context, d: ThreadDetail): Html[] {
  return d.judgments.map((j) => {
    const did = j.outcome !== null ? `Nexus ${j.outcome}.` : j.question !== null ? "It waits for your answer below." : j.verdict === null ? "Nexus acts on its answer." : "Nexus acts on it now.";
    return html`<section class="landing judgment" data-judgment="${j.failure}" aria-label="Judgment of a failure">
<div class="land-top"><h2>Failed on ${j.node}</h2><span class="land-meta">judged ${ago(j.startedAt, c.now)}</span></div>
<p class="land-note">${j.failed.split("\n")[0]}</p>
<p class="land-meta">${j.verdict === null ? "The judgment has not answered yet." : html`<b>${j.verdict.answer}</b>, by the ${j.verdict.by}: ${j.verdict.why}`}</p>
<p class="land-meta">${did}</p>
${j.brief !== null && html`<details><summary>What the judgment was asked and answered</summary><pre>${j.brief}</pre>${j.reply !== null && html`<pre>${j.reply}</pre>`}</details>`}
</section>`;
  });
}

/**
 * Above the landing card, each question the thread asked: open ones as a card with a button per option, and answered
 * ones as a line saying what the answer was. A Claude worker's open ask is a form, and an answered one shows in the
 * conversation instead. As with landing, the page says up front when the answer route would refuse this device.
 */
export function questionCards(c: Context, d: ThreadDetail): Html[] {
  return d.questions.filter((q) => q.kind !== "ask" || q.answer === null).map((q) => questionCard(c, q));
}

export function questionCard(c: Context, q: ThreadQuestion): Html {
  if (q.kind === "ask") return askCard(c, q);
  if (q.withdrawn !== undefined) {
    return html`<section class="landing question answered" data-question="${q.id}" aria-label="Withdrawn question"><div class="question-text">${prose(q.text)}</div>
<p class="land-meta">Withdrawn when the thread was archived, ${ago(q.withdrawn.at, c.now)}</p></section>`;
  }
  if (q.answer !== null) {
    return html`<section class="landing question answered" data-question="${q.id}" aria-label="Answered question"><div class="question-text">${prose(q.text)}</div>
<p class="land-meta">Answered "${q.answer.option}" from ${q.answer.by}, ${ago(q.answer.at, c.now)}</p></section>`;
  }
  const refusal = c.answerRefusal(q);
  const buttons = q.options.map((option) => {
    const { label, confirm } = offerOf(q, option);
    return refusal === null
      ? html`<button type="button" class="btn" data-action="answer" data-thread="${q.thread}" data-question="${q.id}" data-option="${option}"${confirm !== null && html` data-confirm="${confirm(q)}"`}>${label}</button>`
      : html`<button type="button" class="btn" data-question="${q.id}" data-option="${option}" disabled>${label}</button>`;
  });
  return html`<section class="landing question" data-question="${q.id}" aria-label="${needLabels.question}">
<div class="land-top"><h2>${needLabels.question}</h2>${q.kind === "holds" && q.reserved !== null && html`<span class="tag">reserved: ${reservedNames[q.reserved]}</span>`}</div>
<div class="question-text">${prose(q.text)}</div>
<p class="land-meta">Asked ${ago(q.askedAt, c.now)}. ${answerers[q.answerer]}</p>
<div class="land-act"><div class="question-options">${buttons}</div>${refusal !== null && html`<p class="error">${answerRefusals[refusal](c.caller)}</p>`}</div>
</section>`;
}

/**
 * A node's open question about what it could delete: each item and the space it takes, and the total, with Delete and
 * Keep. What an answered one did is the Cluster page's cleanup line.
 */
export function cleanupCard(c: Context, q: CleanupQuestion): Html {
  const { items } = q.cleanup;
  const total = items.reduce((sum, i) => sum + i.bytes, 0);
  const table = html`<table class="ov cleanup-items"><thead><tr><th class="wide">What</th><th>Space</th></tr></thead>
<tbody>${items.map((i) => html`<tr data-item="${itemKey(i)}"><td class="wide">${itemText(i)}</td><td>${bytesText(i.bytes)}</td></tr>`)}</tbody><tfoot><tr><td class="wide">Total</td><td>${bytesText(total)}</td></tr></tfoot></table>`;
  const refusal = c.answerRefusal(q);
  const buttons = q.options.map((option) => {
    const { label, confirm } = offerOf(q, option);
    return refusal === null
      ? html`<button type="button" class="btn" data-action="answer" data-question="${q.id}" data-option="${option}"${confirm !== null && html` data-confirm="${confirm(q)}"`}>${label}</button>`
      : html`<button type="button" class="btn" disabled>${label}</button>`;
  });
  return html`<section class="landing question cleanup" data-question="${q.id}" aria-label="Cleanup to confirm on ${q.node}">
<div class="land-top"><h2>Delete what ${q.node} no longer needs?</h2><span class="land-meta">frees ${bytesText(total)}</span></div>
${table}
<p class="land-meta">Asked ${ago(q.askedAt, c.now)}. ${answerers[q.answerer]} The node checks each item again before it deletes it and keeps any that came into use. Nexus asks again only once something new joins the list.</p>
<div class="land-act"><div class="question-options">${buttons}</div>${refusal !== null && html`<p class="error">${answerRefusals[refusal](c.caller)}</p>`}</div>
</section>`;
}

/**
 * A Claude worker's open AskUserQuestion as a form: each question with its options as radios, or checkboxes when it
 * takes several, each option's preview, an answer of the person's own, and notes. client.js sends it as the answer's
 * choices. The terminal's dialog stays open meanwhile, and whichever answers first is the answer.
 */
function askCard(c: Context, q: ClaudeQuestion): Html {
  const asked = q.ask.questions;
  const refusal = c.answerRefusal(q);
  // Each field has an ID, so a swap of the region keeps the focus in it.
  const field = (i: number, name: string) => `${q.id}-${i}-${name}`;
  return html`<section class="landing question ask" data-question="${q.id}" aria-label="${needLabels.ask}">
<div class="land-top"><h2>${needLabels.ask}</h2></div>
<form class="ask" data-thread="${q.thread}" data-question="${q.id}">
<fieldset class="ask-all"${refusal !== null && " disabled"}>
${asked.map((aq, i) => html`<fieldset class="ask-q" data-multi="${String(aq.multiSelect)}" data-header="${aq.header}">
<legend><span class="tag">${aq.header}</span> ${aq.question}</legend>
${aq.options.map((o, j) => html`<div class="ask-opt"><label><input type="${aq.multiSelect ? "checkbox" : "radio"}" name="picked-${i}" value="${o.label}" id="${field(i, `o${j}`)}"><span class="ask-label">${o.label}</span>${o.description !== "" && html`<span class="ask-desc">${o.description}</span>`}</label>${o.preview !== undefined && html`<pre class="ask-preview">${o.preview}</pre>`}</div>`)}
<div class="ask-opt ask-own">${aq.multiSelect
  ? html`<label for="${field(i, "own")}"><span class="ask-label">And your own answer</span></label>`
  : html`<label><input type="radio" name="picked-${i}" value="" id="${field(i, "pick-own")}"><span class="ask-label">Your own answer</span></label>`}<input type="text" name="own-${i}" id="${field(i, "own")}" maxlength="4000" aria-label="Your own answer to ${aq.header}"></div>
<input type="text" class="ask-notes" name="notes-${i}" id="${field(i, "notes")}" maxlength="4000" placeholder="Notes for Claude (optional)" aria-label="Notes on ${aq.header}">
</fieldset>`)}
</fieldset>
<p class="land-meta">Asked ${ago(q.askedAt, c.now)}. Answer here or in the pylon's terminal, whichever comes first.</p>
<div class="land-act"><button type="submit" class="btn"${refusal !== null && " disabled"}>Answer</button>${refusal !== null && html`<p class="error">${answerRefusals[refusal](c.caller)}</p>`}</div>
</form>
</section>`;
}

/**
 * Above the composer, for a builder whose review the person can land or is landing. The land route decides who may
 * land, and the page says so up front rather than offer a button that fails. In the inbox it leaves out the title and
 * the pull request, which its head and strip say, and folds what the person need not read to decide. `lands` is whether
 * the thread's project lands its reviews on its own.
 */
export function landing(c: Context, d: ThreadDetail, lands: boolean, place: Place = "page"): Html | null {
  const r = d.review;
  if (r == null) return null;
  const card = place === "inbox";
  const id = namer(place, d.thread.id);
  const prLink = html`<a href="${r.pr.url}" target="_blank" rel="noreferrer">#${r.pr.number} ${r.pr.title} ↗</a>`;
  const top = (title: string) => !card && html`<div class="land-top"><h2 id="${id("landing-h")}">${title}</h2>${prLink}</div>`;
  const named = (title: string) => card ? html`aria-label="${title}"` : html`aria-labelledby="${id("landing-h")}"`;
  const track = landingTrack(r, c.deploys(r));
  if (track !== null) {
    const { at, unverified } = track;
    const title = at.step === "landed" ? "Landed" : r.phase.kind === "needs-person" ? "Merged, not deployed" : r.phase.kind === "rolling-back" ? "Rolling back" : "Landing";
    const phase = r.phase;
    return html`<section class="landing" ${named(title)}>
${top(title)}
<ol class="land-steps">${track.steps.map(({ step, label, state }) => html`<li class="land-step land-${state}"${state === "now" && html` aria-current="step"`}>${label}${state === "skipped" && (step === "verifying" ? unverified : " (nothing to deploy)")}</li>`)}</ol>
${phase.kind === "quoting" ? html`<p class="land-note">The reviewer quotes, from the description as it is now, what could not be checked live at ${short(r.rounds.at(-1)!.head)}, then .nexus/check runs there.</p>`
  : phase.kind === "checking" ? html`<p class="land-note">.nexus/check runs at ${short(r.rounds.at(-1)!.head)}, unless it passed there already.</p>`
  : phase.kind === "verifying" ? html`<p class="land-note">${phase.thread === null && phase.refused !== undefined ? html`No node can take the verify pylon yet: ${phase.refused}` : html`.nexus/verify runs at ${short(r.rounds.at(-1)!.head)} in a verify pylon${phase.thread !== null && html`, <a href="/threads/${phase.thread}">${phase.thread}</a>`}.`}</p>`
  : phase.kind === "merging" && phase.waiting !== undefined ? html`<p class="land-note">Waiting while ${phase.waiting}, since landings deploy one at a time, then merging ${short(r.rounds.at(-1)!.head)}.</p>`
  : phase.kind === "merging" ? html`<p class="land-note">Checking the merge policy again with what GitHub says now, then merging ${short(r.rounds.at(-1)!.head)}.</p>`
  : phase.kind === "deploying" ? html`<p class="land-note">Deploying the merge commit ${short(phase.commit)} until every service reports it healthy.</p>`
  : phase.kind === "rolling-back" ? html`<p class="error">${phase.why} Rolling back to ${short(phase.previous)}.</p>`
  : phase.kind === "landed" ? html`<p class="land-note">Merged as ${short(phase.commit)}${c.deploys(r) && ", deployed, and every service reports it healthy"}.</p>`
  : phase.kind === "needs-person" && html`<ul class="error">${phase.holds.map((h) => html`<li>${h.text}</li>`)}</ul>
<p class="land-note">The merge commit ${short(r.merged!)} is on the default branch, but not deployed. Deploy it from a deployer with nexus deploy ${r.merged!}, or leave the fleet where it is, and cancel the review once nothing more is needed.</p>
<div class="land-act need-act">${cancelReview(d.thread.id, r, "btn-ghost")}</div>`}
</section>`;
  }
  const pr = reviewPr(d);
  if (cannotLand(r, d.thread, pr) !== null) return r.phase.kind === "needs-person" ? heldReview(c, d, r, pr, lands, place) : null;
  const round = r.rounds.at(-1)!;
  // The PR watch can read a push before the loop's next pass starts a round on it.
  const moved = pushedHead(r, pr);
  const held = r.phase.kind === "needs-person";
  const reasons = holdsAt(r);
  const rules = reasons.map((h) => ({ reason: h.text, ...holdRule(h.code) }));
  const press = landPress(r);
  const waived = press.kind === "lands" ? press.waives.map((h) => h.text) : [];
  // The review's question about these holds is how the person waives them, so the card does not offer a second way.
  const asking = askingHolds(d.questions, r.id, round) !== undefined;
  // A hold that meets every landing again, and that the person cannot waive, leaves only merging on GitHub.
  const stuck = press.kind === "stuck";
  const checks = press.kind === "lands" && press.quotes ? "Nexus first asks the reviewer to quote, from the description as it is now, what could not be checked live, then checks" : "Nexus checks";
  const findings = findingsOf(round);
  const deploys = c.deploys(r) ? " and deploys the merge commit" : "";
  const confirm = waived.length === 0
    ? `Land pull request #${r.pr.number}, "${r.pr.title}", at commit ${round.head.slice(0, 12)}? ${checks} the merge policy again, merges that commit${deploys}.`
    : `Land pull request #${r.pr.number}, "${r.pr.title}", at commit ${round.head.slice(0, 12)}, waiving ${waived.length === 1 ? "the hold" : `the ${waived.length} holds`} the merge policy reserves for you? ${checks} everything else again, merges that commit${deploys}.`;
  const tag = (h: typeof rules[number]) => h.waivable ? html`<span class="tag tag-ok">you may waive</span>` : html`<span class="tag">${h.holdsAgain ? "holds again" : "not waivable"}</span>`;
  const nothing = html`<p class="land-note">Nothing holds it. The review stopped at approval because it was started without --land.</p>`;
  const found = html`<h3>The ${r.second?.kind === "claude" ? "reviewers'" : "reviewer's"} findings</h3>
${findings.length === 0 ? html`<p class="land-note">None.</p>` : html`<ul class="land-findings">${findings.map((f) => {
  const answer = r.rounds.flatMap((rd) => rd.answers ?? []).findLast((a) => a.id === f.id);
  return html`<li><span class="tag${blocking(f) ? " tag-bad" : ""}">${f.priority}</span> <b>${f.id}</b>${f.where && html` <code>${f.where}</code>`}: ${f.summary}${answer && html` <span class="dim">(builder: ${answer.action}${answer.reason && `, ${answer.reason}`})</span>`}</li>`;
})}</ul>`}
${round.check !== null && html`<details id="${id("land-check")}"><summary>.nexus/check ${round.check.passed ? "passed" : "failed"} at ${round.head.slice(0, 12)}</summary><pre>${round.check.output}</pre></details>`}
${round.live?.kind === "ran" && html`<details id="${id("land-live")}"><summary>The live check ${round.live.passed ? "passed" : "failed"} at ${round.head.slice(0, 12)}</summary><pre>${round.live.output}</pre></details>`}`;
  const title = held ? "Held for you" : "Approved, not landed";
  return html`<section class="landing" ${named(title)}>
${top(title)}
${roundNote(r) !== null && html`<p class="land-note">${roundNote(r)}</p>`}
<p class="land-meta">Head ${short(round.head)} · approved by ${r.models.reviewer} (${r.reviewerKind})${r.second?.kind === "claude" && ` and ${r.second.model} (second reviewer)`}${r.second?.kind === "none" && " alone, with no second reviewer"}${!card && ` in ${roundOf(r)}`} · .nexus/check passed · ${round.live === undefined ? "no live check ran" : round.live.kind === "absent" ? "no .nexus/verify, so no live check" : `live check ${round.live.passed ? "passed" : "failed"}`}</p>
${card ? html`${reasons.length === 0 ? nothing : html`<ul class="land-reasons">${rules.map((h, i) => html`<li><details id="${id(`land-hold-${i}`)}"><summary>${h.reason} ${tag(h)}</summary><span class="dim">${h.why}</span></details></li>`)}</ul>`}
<details id="${id("land-why")}"><summary>Findings and checks</summary>${found}</details>`
  : html`<details id="${id("land-why")}" open><summary>Why it waits for you</summary>
${reasons.length === 0 ? nothing : html`<ul class="land-reasons">${rules.map((h) => html`<li>${h.reason} ${tag(h)}<br><span class="dim">${h.why}</span></li>`)}</ul>`}
${found}
</details>`}
${moved !== null ? html`<p class="land-note">The PR watch last read the pull request at ${short(moved)}, not ${short(round.head)}, so ${short(round.head)} is not offered for landing. Nexus confirms the head with GitHub, and a new head gets a new round, or holds for you when no round is left.</p>`
  : stuck ? html`<p class="land-note">Landing checks the merge policy again, and what is marked "holds again" holds every landing of this commit. Only you can get past it, by merging the pull request on GitHub${c.deploys(r) && " and deploying it with nexus deploy"}.</p>`
  : asking ? html`<p class="land-note">Answer the question about its holds${!card && " above"} to waive them and land it.</p>`
  : c.landRefusal === null ? html`<div class="land-act"><button type="button" class="btn btn-primary" id="${id("land")}" data-action="land" data-thread="${d.thread.id}" data-head="${round.head}"${waived.length > 0 && html` data-holds="${JSON.stringify(waived)}"`} data-confirm="${confirm}">Land #${r.pr.number}</button>${waived.length > 0 && html`<p class="land-note">Pressing Land waives what is marked "you may waive", for commit ${short(round.head)} and any rebase of it that leaves the change as it is. Landing checks everything else again.</p>`}</div>`
  : html`<div class="land-act"><button type="button" class="btn" id="${id("land")}" disabled>Land #${r.pr.number}</button><p class="error">${landRefusals[c.landRefusal](c.caller)}</p></div>`}
</section>`;
}

/**
 * A review that ended for the person with nothing to land: why it ended, its round and reviewer, and what moves it on.
 * A pull request still open is reviewed again from round 1, landing once approved when the project lands its reviews.
 * One that merged or closed outside the review has nothing left to review. Cancelling it ends it for the person, who
 * then owns the pull request, and archives its reviewer.
 */
function heldReview(c: Context, d: ThreadDetail, r: Review, pr: ReturnType<typeof reviewPr>, land: boolean, place: Place): Html {
  const card = place === "inbox";
  const id = namer(place, d.thread.id);
  const outside = pr === undefined || pr.state === "open" ? null : pr.state;
  const refusal = land || c.landRefusal === "no review loop" ? c.landRefusal : null;
  const again = outside === null && d.thread.status === "active";
  const confirm = `Review pull request #${r.pr.number}, "${r.pr.title}", again? A new reviewer thread starts at round 1${land ? ", and Nexus lands the pull request once it approves, as this project lands its reviews" : ""}.`;
  const title = outside === "merged" ? "Merged outside its review" : outside === "closed" ? "Closed outside its review" : needLabels["held-review"];
  return html`<section class="landing held-review" ${card ? html`aria-label="${title}"` : html`aria-labelledby="${id("landing-h")}"`}>
${!card && html`<div class="land-top"><h2 id="${id("landing-h")}">${title}</h2><a href="${r.pr.url}" target="_blank" rel="noreferrer">#${r.pr.number} ${r.pr.title} ↗</a></div>`}
<p class="land-meta">${card ? "Reviewer" : `Ended in ${roundOf(r)} · reviewer`} <a href="/threads/${r.reviewer}">${r.reviewer}</a> on ${r.models.reviewer} (${r.reviewerKind})${r.second?.kind === "claude" && html` · second reviewer <a href="/threads/${r.second.thread}">${r.second.thread}</a> on ${r.second.model}`}</p>
${reviewersNote(r) !== null && html`<p class="land-note">${reviewersNote(r)}</p>`}
${r.phase.kind === "needs-person" && html`<ul class="error">${r.phase.holds.map((h) => html`<li>${h.text}</li>`)}</ul>`}
${outside === "merged" ? html`<p class="land-note">Pull request #${r.pr.number} merged on GitHub outside this review, so nothing is left to review or land.${c.deploys(r) && " Nexus deploys only what it lands, so deploy the merge commit with nexus deploy if it should run."} Cancel the review once nothing more is needed.</p>`
  : outside === "closed" ? html`<p class="land-note">Pull request #${r.pr.number} closed on GitHub, so nothing is left to review or land. Cancel the review once nothing more is needed.</p>`
  : !again && html`<p class="land-note">The thread is ${d.thread.status}, so it cannot be reviewed again.</p>`}
<div class="land-act need-act">${again && (refusal === null
  ? html`<button type="button" class="btn btn-primary" data-action="review-again" data-thread="${d.thread.id}" data-pr="${r.pr.number}"${land && html` data-land="true"`} data-confirm="${confirm}">Review again</button>`
  : html`<button type="button" class="btn" disabled>Review again</button>`)}${cancelReview(d.thread.id, r, "btn-ghost")}</div>
${again && refusal !== null && html`<p class="error">${landRefusals[refusal](c.caller)}</p>`}
</section>`;
}

/** As `nexus review --cancel`, wherever the review can be cancelled. */
export const cancelReview = (thread: ThreadId, r: Review, look: string) => cancellable(r)
  && html`<button type="button" class="btn ${look}" data-action="cancel-review" data-thread="${thread}" data-confirm="Cancel review ${r.id} of pull request #${r.pr.number}?${r.phase.kind === "needs-person" && " It stops waiting on you."} Its reviewer thread is archived, and this thread stays as it is.">Cancel review</button>`;

/** For a Claude worker whose turns kept dying after Nexus resumed them, which waits on the person, with why Nexus stopped resuming it. */
export function resumeCard(t: Thread, why: string, place: Place = "page"): Html {
  const id = namer(place, t.id);
  return html`<section class="landing nudge" aria-labelledby="${id("resume-h")}">
<div class="land-top"><h2 id="${id("resume-h")}">${needLabels.resume}</h2></div>
<p class="land-note">${why} Write to it to resume it: your message makes the thread yours, and Nexus leaves it alone from then on.</p>
<div class="land-act need-act"><a class="btn btn-primary" href="/threads/${t.id}#write" data-write>Write to it</a></div>
</section>`;
}

/**
 * Above the landing card, for a builder that ended its turns short of a pull request after its nudges: Nexus stopped
 * nudging it and waits on the person, whose message makes the thread theirs.
 */
export function nudgeCard(t: Thread, place: Place = "page"): Html {
  const id = namer(place, t.id);
  return html`<section class="landing nudge" aria-labelledby="${id("nudge-h")}">
<div class="land-top"><h2 id="${id("nudge-h")}">${needLabels.nudge}</h2></div>
<p class="land-note">${stoppedShort}, so Nexus stopped nudging it. Write to it to say what to do next: your message makes the thread yours, and Nexus leaves it alone from then on.</p>
<div class="land-act need-act"><a class="btn btn-primary" href="/threads/${t.id}#write" data-write>Write to it</a></div>
</section>`;
}
