/**
 * Renders a thread's cards, on its page and in the inbox: its landing and review, the judgments of a failed pylon,
 * its questions and its nudge.
 */
import type { ThreadDetail } from "../wire.ts";
import type { Thread, ThreadId } from "../registry.ts";
import type { TailnetNodeId } from "../../ids.ts";
import { blocks as blocking, cancellable, cannotLand, findingsOf, pushedHead, roundNote, roundsSpent, type Review } from "../review-model.ts";
import { holdRule, reservedNames } from "../holds.ts";
import { heldBy } from "../policy.ts";
import type { AnswerRefusal, AskedQuestion, Question } from "../questions.ts";
import { Html, html, ago, short } from "./view.ts";
import type { LandRefusal, Context } from "./context.ts";
import { prose } from "./markdown.ts";

/** The steps of a landing, in order. */
const landingSteps = [["checking", "Check"], ["verifying", "Live check"], ["merging", "Merge"], ["deploying", "Deploy"], ["landed", "Landed"]] as const;
type Step = typeof landingSteps[number][0];
/**
 * The step a landing is at, and whether it failed there. A landing held after its merge stopped at the deploy, which
 * failed or rolled back. One held before its merge is not on its way anywhere, and is landable again or not at all.
 */
function landingAt(r: Review): { step: Step; failed: boolean } | null {
  switch (r.phase.kind) {
    case "checking": case "verifying": return r.land === null ? null : { step: r.phase.kind, failed: false };
    case "merging": case "deploying": case "landed": return { step: r.phase.kind, failed: false };
    case "rolling-back": return { step: "deploying", failed: true };
    case "needs-person": return r.merged !== null && r.land !== null ? { step: "deploying", failed: true } : null;
    default: return null;
  }
}

const landRefusals: Record<LandRefusal, (caller: TailnetNodeId) => string> = {
  "not a deployer": (caller) => `This device cannot land: landing deploys, so only the control plane's deployers may, and this device (tailnet node ${caller}) is not one. Land it from a deployer, or add this node to deployers in the control plane's config.`,
  "no review loop": () => "Nexus cannot land it now: the review loop needs the control plane's GitHub token (github.tokenFile), which is not configured.",
};

const answerRefusals: Record<AnswerRefusal, (caller: TailnetNodeId) => string> = {
  "not a person": (caller) => `This device cannot answer: tailnet node ${caller} is the control plane or one of its nodes, whose pylons call under its identity, and only a person's device may answer. Answer it from your laptop or phone.`,
  "not a deployer": (caller) => `This device cannot answer: the answer may deploy, so only the control plane's deployers may, and this device (tailnet node ${caller}) is not one. Answer it from a deployer, or add this node to deployers in the control plane's config.`,
};
const answerers: Record<Question["answerer"], string> = { person: "You answer.", deployer: "A deployer answers, as the answer may deploy." };

/**
 * Above the questions, each judgment of the thread's failed pylon: what failed, the verdict and who gave it, and what
 * Nexus did, with what the judgment was asked and what it answered. A question it asks is the question card below.
 */
export function judgmentCards(c: Context, d: ThreadDetail): Html[] {
  return (d.judgments ?? []).map((j) => {
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
  return (d.questions ?? []).filter((q) => q.ask === undefined || q.answer === null).map((q) => questionCard(c, q));
}

export function questionCard(c: Context, q: Question): Html {
  if (q.ask !== undefined) return askCard(c, q, q.ask.questions);
  if (q.answer !== null) {
    return html`<section class="landing question answered" data-question="${q.id}" aria-label="Answered question"><div class="question-text">${prose(q.text)}</div>
<p class="land-meta">Answered "${q.answer.option}" from ${q.answer.by}, ${ago(q.answer.at, c.now)}</p></section>`;
  }
  const refusal = c.answerRefusal(q);
  const buttons = q.options.map((option) => refusal === null
    ? html`<button type="button" class="btn" data-action="answer" data-thread="${q.thread}" data-question="${q.id}" data-option="${option}" data-confirm="Answer &quot;${option}&quot;? The answer cannot be changed.">${option}</button>`
    : html`<button type="button" class="btn" data-question="${q.id}" data-option="${option}" disabled>${option}</button>`);
  return html`<section class="landing question" data-question="${q.id}" aria-label="Needs your decision">
<div class="land-top"><h2>Needs your decision</h2>${q.reserved !== null && html`<span class="tag">reserved: ${reservedNames[q.reserved]}</span>`}</div>
<div class="question-text">${prose(q.text)}</div>
<p class="land-meta">Asked ${ago(q.askedAt, c.now)}. ${answerers[q.answerer]}</p>
<div class="land-act"><div class="question-options">${buttons}</div>${refusal !== null && html`<p class="error">${answerRefusals[refusal](c.caller)}</p>`}</div>
</section>`;
}

/**
 * A Claude worker's open AskUserQuestion as a form: each question with its options as radios, or checkboxes when it
 * takes several, each option's preview, an answer of the person's own, and notes. client.js sends it as the answer's
 * choices. The terminal's dialog stays open meanwhile, and whichever answers first is the answer.
 */
function askCard(c: Context, q: Question, asked: readonly AskedQuestion[]): Html {
  const refusal = c.answerRefusal(q);
  // Each field has an ID, so a swap of the region keeps the focus in it.
  const field = (i: number, name: string) => `${q.id}-${i}-${name}`;
  return html`<section class="landing question ask" data-question="${q.id}" aria-label="Claude asks">
<div class="land-top"><h2>Claude asks</h2></div>
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

/** The review's PR as the PR watch last read it. */
export const prOf = (d: ThreadDetail) => d.pullRequests?.find((p) => p.repo === d.review?.pr.repo && p.number === d.review.pr.number);

/**
 * Above the composer, for a builder whose review the person can land or is landing: why it waits for them, with the
 * Land button, and then the landing's steps until it lands or ends for them again. The land route decides who may
 * land, and the page says so up front rather than offer a button that fails. `id` names its elements, so the inbox
 * can show several.
 */
export function landing(c: Context, d: ThreadDetail, id = (name: string) => name): Html | null {
  const r = d.review;
  if (r == null) return null;
  const prLink = html`<a href="${r.pr.url}" target="_blank" rel="noreferrer">#${r.pr.number} ${r.pr.title} ↗</a>`;
  const at = landingAt(r);
  if (at !== null) {
    const deploys = c.deploys(r);
    const index = landingSteps.findIndex(([step]) => step === at.step);
    const { live } = r.rounds.at(-1)!;
    // A landing past the live check with none recorded is one from before live checks.
    const unverified = live?.kind === "absent" ? " (no .nexus/verify)" : live === undefined && index > 1 ? " (not run)" : null;
    const stateOf = (step: Step, i: number) => (step === "deploying" && !deploys) || (step === "verifying" && unverified !== null) ? "skipped"
      : i < index || at.step === "landed" ? "done" : i > index ? "todo" : at.failed ? "failed" : "now";
    const title = at.step === "landed" ? "Landed" : r.phase.kind === "needs-person" ? "Merged, not deployed" : r.phase.kind === "rolling-back" ? "Rolling back" : "Landing";
    const phase = r.phase;
    return html`<section class="landing" aria-labelledby="${id("landing-h")}">
<div class="land-top"><h2 id="${id("landing-h")}">${title}</h2>${prLink}</div>
<ol class="land-steps">${landingSteps.map(([step, label], i) => {
  const state = stateOf(step, i);
  return html`<li class="land-step land-${state}"${state === "now" && html` aria-current="step"`}>${label}${state === "skipped" && (step === "verifying" ? unverified : " (nothing to deploy)")}</li>`;
})}</ol>
${phase.kind === "checking" ? html`<p class="land-note">.nexus/check runs at ${short(r.rounds.at(-1)!.head)}, or its kept result for that commit is read.</p>`
  : phase.kind === "verifying" ? html`<p class="land-note">${phase.thread === null && phase.refused !== undefined ? html`No node can take the verify pylon yet: ${phase.refused}` : html`.nexus/verify runs at ${short(r.rounds.at(-1)!.head)} in a verify pylon${phase.thread !== null && html`, <a href="/threads/${phase.thread}">${phase.thread}</a>`}.`}</p>`
  : phase.kind === "merging" && phase.waiting !== undefined ? html`<p class="land-note">Waiting while ${phase.waiting}, since landings deploy one at a time, then merging ${short(r.rounds.at(-1)!.head)}.</p>`
  : phase.kind === "merging" ? html`<p class="land-note">Checking the merge policy again with what GitHub says now, then merging ${short(r.rounds.at(-1)!.head)}.</p>`
  : phase.kind === "deploying" ? html`<p class="land-note">Deploying the merge commit ${short(phase.commit)} until every service reports it healthy.</p>`
  : phase.kind === "rolling-back" ? html`<p class="error">${phase.why} Rolling back to ${short(phase.previous)}.</p>`
  : phase.kind === "landed" ? html`<p class="land-note">Merged as ${short(phase.commit)}${deploys && ", deployed, and every service reports it healthy"}.</p>`
  : phase.kind === "needs-person" && html`<ul class="error">${phase.reasons.map((reason) => html`<li>${reason}</li>`)}</ul>
<p class="land-note">The merge commit ${short(r.merged!)} is on the default branch, but not deployed. Deploy it from a deployer with nexus deploy ${r.merged!}, or leave the fleet where it is, and cancel the review once nothing more is needed.</p>
<div class="land-act need-act">${cancelReview(d.thread.id, r, "btn-ghost")}</div>`}
</section>`;
  }
  const pr = prOf(d);
  if (cannotLand(r, d.thread, pr) !== null) return r.phase.kind === "needs-person" ? heldReview(c, d, r, pr, id) : null;
  const round = r.rounds.at(-1)!;
  // The PR watch can read a push before the loop's next pass starts a round on it. A stopped watch reads nothing new.
  const moved = d.prWatch?.stopped ? null : pushedHead(r, pr);
  const held = r.phase.kind === "needs-person";
  const reasons = heldBy(r);
  const rules = reasons.map((h) => ({ reason: h.text, ...holdRule(h.code) }));
  const waived = rules.filter((h) => h.waivable).map((h) => h.reason);
  // A hold that meets every landing again, and that the person cannot waive, leaves only merging on GitHub.
  const stuck = rules.some((h) => h.holdsAgain && !h.waivable);
  const findings = findingsOf(round);
  const deploys = c.deploys(r) ? " and deploys the merge commit" : "";
  const confirm = waived.length === 0
    ? `Land pull request #${r.pr.number}, "${r.pr.title}", at commit ${round.head.slice(0, 12)}? Nexus checks the merge policy again, merges that commit${deploys}.`
    : `Land pull request #${r.pr.number}, "${r.pr.title}", at commit ${round.head.slice(0, 12)}, waiving ${waived.length === 1 ? "the hold" : `the ${waived.length} holds`} the merge policy reserves for you? Nexus checks everything else again, merges that commit${deploys}.`;
  return html`<section class="landing" aria-labelledby="${id("landing-h")}">
<div class="land-top"><h2 id="${id("landing-h")}">${held ? "Held for you" : "Approved, not landed"}</h2>${prLink}</div>
${roundNote(r) !== null && html`<p class="land-note">${roundNote(r)}</p>`}
<p class="land-meta">Head ${short(round.head)} · approved by ${r.models.reviewer} (${r.reviewerKind}) in round ${roundsSpent(r)} of ${r.maxRounds} · .nexus/check passed · ${round.live === undefined ? "no live check ran" : round.live.kind === "absent" ? "no .nexus/verify, so no live check" : `live check ${round.live.passed ? "passed" : "failed"}`}</p>
<details id="${id("land-why")}" open><summary>Why it waits for you</summary>
${reasons.length === 0 ? html`<p class="land-note">Nothing holds it. The review stopped at approval because it was started without --land.</p>`
  : html`<ul class="land-reasons">${rules.map((h) => html`<li>${h.reason} ${h.waivable ? html`<span class="tag tag-ok">you may waive</span>` : html`<span class="tag">${h.holdsAgain ? "holds again" : "not waivable"}</span>`}<br><span class="dim">${h.why}</span></li>`)}</ul>`}
<h3>The reviewer's findings</h3>
${findings.length === 0 ? html`<p class="land-note">None.</p>` : html`<ul class="land-findings">${findings.map((f) => {
  const answer = r.rounds.flatMap((rd) => rd.answers ?? []).findLast((a) => a.id === f.id);
  return html`<li><span class="tag${blocking(f) ? " tag-bad" : ""}">${f.priority}</span> <b>${f.id}</b>${f.where && html` <code>${f.where}</code>`}: ${f.summary}${answer && html` <span class="dim">(builder: ${answer.action}${answer.reason && `, ${answer.reason}`})</span>`}</li>`;
})}</ul>`}
${round.check !== null && html`<details id="${id("land-check")}"><summary>.nexus/check ${round.check.passed ? "passed" : "failed"} at ${round.head.slice(0, 12)}</summary><pre>${round.check.output}</pre></details>`}
${round.live?.kind === "ran" && html`<details id="${id("land-live")}"><summary>The live check ${round.live.passed ? "passed" : "failed"} at ${round.head.slice(0, 12)}</summary><pre>${round.live.output}</pre></details>`}
</details>
${moved !== null ? html`<p class="land-note">The PR watch last read the pull request at ${short(moved)}, not ${short(round.head)}, so ${short(round.head)} is not offered for landing. Nexus confirms the head with GitHub, and a new head gets a new round, or holds for you when no round is left.</p>`
  : stuck ? html`<p class="land-note">Landing checks the merge policy again, and what is marked "holds again" holds every landing of this commit. Only you can get past it, by merging the pull request on GitHub${c.deploys(r) && " and deploying it with nexus deploy"}.</p>`
  : c.landRefusal === null ? html`<div class="land-act"><button type="button" class="btn btn-primary" id="${id("land")}" data-action="land" data-thread="${d.thread.id}" data-head="${round.head}"${waived.length > 0 && html` data-holds="${JSON.stringify(waived)}"`} data-confirm="${confirm}">Land #${r.pr.number}</button>${waived.length > 0 && html`<p class="land-note">Pressing Land waives what is marked "you may waive", for commit ${short(round.head)} only. Landing checks everything else again.</p>`}</div>`
  : html`<div class="land-act"><button type="button" class="btn" id="${id("land")}" disabled>Land #${r.pr.number}</button><p class="error">${landRefusals[c.landRefusal](c.caller)}</p></div>`}
</section>`;
}

/**
 * A review that ended for the person with nothing to land: why it ended, its round and reviewer, and what moves it on.
 * A pull request still open is reviewed again from round 1, landing once approved when the project lands its reviews.
 * One that merged or closed outside the review has nothing left to review. Cancelling it ends it for the person, who
 * then owns the pull request, and archives its reviewer.
 */
function heldReview(c: Context, d: ThreadDetail, r: Review, pr: ReturnType<typeof prOf>, id: (name: string) => string): Html {
  const outside = pr === undefined || pr.state === "open" ? null : pr.state;
  const land = c.registry.project(d.thread.project)?.autoReview?.land === true;
  const refusal = land || c.landRefusal === "no review loop" ? c.landRefusal : null;
  const again = outside === null && d.thread.status === "active";
  const confirm = `Review pull request #${r.pr.number}, "${r.pr.title}", again? A new reviewer thread starts at round 1${land ? ", and Nexus lands the pull request once it approves, as this project lands its reviews" : ""}.`;
  return html`<section class="landing held-review" aria-labelledby="${id("landing-h")}">
<div class="land-top"><h2 id="${id("landing-h")}">${outside === "merged" ? "Merged outside its review" : outside === "closed" ? "Closed outside its review" : "Review needs you"}</h2><a href="${r.pr.url}" target="_blank" rel="noreferrer">#${r.pr.number} ${r.pr.title} ↗</a></div>
<p class="land-meta">Ended in round ${roundsSpent(r)} of ${r.maxRounds} · reviewer <a href="/threads/${r.reviewer}">${r.reviewer}</a> on ${r.models.reviewer} (${r.reviewerKind})</p>
${r.phase.kind === "needs-person" && html`<ul class="error">${r.phase.reasons.map((reason) => html`<li>${reason}</li>`)}</ul>`}
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

/**
 * Above the landing card, for a builder that ended its turns short of a pull request after two nudges: Nexus stopped
 * nudging it and waits on the person, whose message makes the thread theirs. `id` names its elements, as `landing`'s.
 */
export function nudgeCard(c: Context, t: Thread, id = (name: string) => name): Html | null {
  if (c.registry.nudge(t.id)?.state !== "person") return null;
  return html`<section class="landing nudge" aria-labelledby="${id("nudge-h")}">
<div class="land-top"><h2 id="${id("nudge-h")}">Stopped short of a pull request</h2></div>
<p class="land-note">Its turn ended without a pull request after two nudges, so Nexus stopped nudging it. Write to it to say what to do next: your message makes the thread yours, and Nexus leaves it alone from then on.</p>
<div class="land-act need-act"><a class="btn btn-primary" href="/threads/${t.id}#write" data-write>Write to it</a></div>
</section>`;
}
