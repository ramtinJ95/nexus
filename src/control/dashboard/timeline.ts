/**
 * A thread's timeline: the life of its work, one step of its track after another, each with what the
 * registry and the conversation record of it. The brief it started from, its turns, what it was asked, its pull
 * requests, each review round with its findings, its landing and deploy, and its archive.
 */
import type { ThreadDetail } from "../wire.ts";
import { isOpen } from "../questions.ts";
import type { ThreadId } from "../../ids.ts";
import { keptPastDay } from "../../reconcile.ts";
import { blocks, checkBeside, findingsOf, phaseNote, reviewerApproved, reviewersNote, roundsSpent, type Review, type Round, type Verdict } from "../review-model.ts";
import { Html, html, ago, short, dot, icon, limitText, type Part, type Tone } from "./view.ts";
import type { Context } from "./context.ts";
import { prose } from "./markdown.ts";
import { promptLabel, type Item } from "./items.ts";
import { clock } from "./elapsed.ts";
import { landingAt, landingSteps } from "./cards.ts";
import { pipelineItems, needLabel, stageLabel, stepStates, steps, type Life, type Step, type StepState } from "./lifecycle.ts";

/** One turn of the conversation: what started it and from whom, the tools it ran, and the answer it ended on. */
interface Turn { from: string; text: string; at: number; queued: boolean; tools: number; failed: number; reply: string | null; took: string | null; running: boolean }

const firstLine = (text: string) => (text.trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "").replaceAll("`", "");

function turnsOf(items: readonly Item[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      turns.push({ from: promptLabel[item.from], text: firstLine(item.text), at: item.at, queued: item.queued !== null, tools: 0, failed: 0, reply: null, took: null, running: false });
      continue;
    }
    const turn = turns.at(-1);
    if (turn === undefined) continue;
    if (item.kind === "tool") {
      turn.tools += 1;
      if (item.result.state === "done" && item.result.isError) turn.failed += 1;
      if (item.result.state === "running") turn.running = true;
    }
    if (item.kind === "agent") turn.reply = firstLine(item.text);
    if (item.kind === "note") turn.took = item.text.replace(/^Worked for /, "").replace(/\.$/, "");
  }
  return turns;
}

/** Each step's line on the spine, its marker, its name and when it began, so far as the records say. */
function step(id: Step | "archived", label: string, state: StepState, when: Part, body: Part, tone?: Tone): Html {
  return html`<li class="tl-step tl-${state}" id="tl-${id}" data-step="${id}"${tone !== undefined && html` data-tone="${tone}"`}>
<div class="tl-mark" aria-hidden="true">${state === "done" ? icon("check") : state === "held" ? "!" : ""}</div>
<div class="tl-body"><h3 class="tl-h"><span>${label}</span><span class="tl-state">${stateWord[state]}</span>${when !== null && when !== false && html`<span class="tl-when">${when}</span>`}</h3>
${body}</div>
</li>`;
}
const stateWord: Record<StepState, string> = { done: "done", now: "now", held: "held for you", todo: "ahead", skipped: "not reached" };

function turnsList(turns: readonly Turn[], now: number): Html {
  const row = (t: Turn, i: number) => html`<li class="tl-turn${t.queued && " queued"}"><span class="tl-n">${i + 1}</span><div class="tl-turn-b">
<p class="tl-ask"><b>${t.from}</b>${t.at > 0 && html` <span class="dim">${ago(t.at, now)}</span>`}${t.queued && html` <span class="tag">queued</span>`}<span class="tl-quote">${t.text || "(no text)"}</span></p>
${(t.tools > 0 || t.took !== null || t.running) && html`<p class="tl-tools">${t.tools > 0 && `${t.tools} ${t.tools === 1 ? "tool call" : "tool calls"}`}${t.failed > 0 && html` · <span class="del">${t.failed} failed</span>`}${t.took !== null && ` · worked for ${t.took}`}${t.running && html` · <span class="s-run"><span class="spin" aria-hidden="true"></span>running</span>`}</p>`}
${t.reply !== null && html`<p class="tl-reply">${t.reply}</p>`}
</div></li>`;
  if (turns.length === 0) return html`<p class="empty">No turns yet.</p>`;
  const shown = 6;
  const early = turns.slice(0, -shown);
  return html`<ol class="tl-turns">${early.length > 0 && html`<li class="tl-turn tl-early"><details id="tl-early"><summary>${early.length} earlier ${early.length === 1 ? "turn" : "turns"}</summary><ol class="tl-turns">${early.map(row)}</ol></details></li>`}${turns.slice(-shown).map((t, i) => row(t, early.length + i))}</ol>`;
}

const priorityTone = (priority: string) => priority === "P0" || priority === "P1" ? "tag-bad" : priority === "P3" ? "" : "tag-warn";

/** A review round: the head it reviewed, the reviewer's verdict and findings with the builder's answers, and its checks. */
function roundView(r: Review, round: Round, i: number, last: boolean): Html {
  const findings = findingsOf(round);
  const said = (v: Verdict | null) => v === null ? (last ? "reading" : "no verdict") : v.verdict === "approve" ? "approved" : "changes asked";
  const verdict = round.carried !== undefined ? "approval carried over" : round.secondVerdict !== undefined ? `reviewer ${said(round.verdict)} · second reviewer ${said(round.secondVerdict)}`
    : round.verdict === null ? (last ? "the reviewer is reading it" : "no verdict") : round.verdict.verdict === "approve" ? "approved" : "changes asked";
  const asked = [round.verdict, round.secondVerdict].some((v) => v != null && v.verdict !== "approve");
  const tone: Tone = asked ? "bad" : round.verdict === null || round.secondVerdict === null ? "work" : reviewerApproved(round) ? "ok" : "bad";
  return html`<li class="tl-round"><p class="tl-round-h">${dot(tone)}<b>Round ${i + 1}</b> at ${short(round.head)}<span class="tl-verdict tl-${tone}">${verdict}</span>${round.check !== null && html`<span class="tag ${round.check.passed ? "tag-ok" : "tag-bad"}">check ${round.check.passed ? "passed" : "failed"}</span>`}${round.live?.kind === "ran" && html`<span class="tag ${round.live.passed ? "tag-ok" : "tag-bad"}">live ${round.live.passed ? "passed" : "failed"}</span>`}</p>
${findings.length > 0 && html`<ul class="tl-findings">${findings.map((f) => {
  const answer = (round.answers ?? []).find((a) => a.id === f.id) ?? r.rounds.slice(i + 1).flatMap((rd) => rd.answers ?? []).find((a) => a.id === f.id);
  return html`<li><span class="tag ${priorityTone(f.priority)}">${f.priority}</span> <b>${f.id}</b>${f.where && html` <code>${f.where}</code>`} ${f.summary}${answer !== undefined ? html`<span class="tl-answer tl-${answer.action}">${answer.action}${answer.reason !== "" && html`: ${answer.reason}`}</span>` : blocks(f) && html`<span class="tl-answer tl-open">open</span>`}</li>`;
})}</ul>`}
</li>`;
}

/** The landing's own steps, as the landing card in the dock shows them, without its actions. */
function landingView(c: Context, r: Review): Html | false {
  const at = landingAt(r);
  if (at === null) return false;
  const index = landingSteps.findIndex(([s]) => s === at.step);
  const deploys = c.deploys(r);
  return html`<ol class="land-steps">${landingSteps.map(([s, label], i) => {
    const state = s === "deploying" && !deploys ? "skipped" : i < index || at.step === "landed" ? "done" : i > index ? "todo" : at.failed ? "failed" : "now";
    return html`<li class="land-step land-${state}">${label}</li>`;
  })}</ol>`;
}

/** The thread's brief: its item's, its Claude worker's prompt, or the first message it was sent. */
function briefOf(c: Context, d: ThreadDetail, turns: readonly Turn[], items: readonly Item[]): { text: string | null; item: string | null } {
  const item = pipelineItems(c).find((i) => i.thread === d.thread.id);
  const agent = c.registry.agent(d.thread);
  const first = items.find((i) => i.kind === "user");
  const text = item?.brief ?? (agent.kind === "claude" ? agent.worker.prompt : null) ?? (first?.kind === "user" ? first.text : null) ?? (turns[0]?.text || null);
  return { text, item: item?.id ?? null };
}

export function timeline(c: Context, d: ThreadDetail, items: readonly Item[], life: Life): Html {
  const t = d.thread;
  const states = stepStates(life);
  const turns = turnsOf(items);
  const brief = briefOf(c, d, turns, items);
  const r = d.review;
  const agent = c.registry.agent(t);
  const queued = c.registry.queuedThread(t.id as ThreadId);
  const held = life.stage === "held" && html`<div class="tl-hold"><p class="tl-hold-h">Held for you${life.needs.length > 0 && html`: ${[...new Set(life.needs.map(needLabel))].join(", ")}`}</p><p>${life.why.replace(/\.$/, "")}.</p><p class="dim">The card under the timeline is what moves it on.</p></div>`;
  const heldAt = (s: Step) => life.at === s && held;
  const asked = (d.questions ?? []).filter((q) => q.ask === undefined || q.answer !== null);
  const judgments = d.judgments ?? [];
  const outputs = d.outputs.filter((o) => o.kind === "branch" || o.kind === "diff" || o.kind === "file");
  const { cpus, memoryGiB, diskGiB } = d.pylon.resources;

  const body: Record<Step, Part> = {
    planned: html`${brief.text === null ? html`<p class="empty">It started without a brief.</p>` : html`<div class="tl-brief">${prose(brief.text)}</div>`}
<p class="tl-meta">${brief.item !== null && html`Item <a class="link" href="/?peek=${brief.item}"><code>${brief.item}</code></a> on the pipeline · `}Started by ${t.startedBy} · ${agent.kind === "claude" ? `Claude Code${agent.worker.model !== null ? `, ${agent.worker.model}` : ""}` : agent.kind === "harness" ? "Nexus agent" : "no agent"}${d.planning && " · planning thread"}</p>
${heldAt("planned")}`,
    queued: html`<p class="tl-meta">${queued === undefined ? "Started at once, with nothing ahead of it in the queue." : html`Queued after ${queued.after.length === 0 ? "nothing" : queued.after.map((id, i) => html`${i > 0 && ", "}<a class="link" href="/threads/${id}">${c.registry.thread(id)?.title ?? id}</a>`)}.`} Its pylon runs on <a class="link" href="/nodes/${encodeURIComponent(d.pylon.node)}">${d.pylon.node}</a> with ${cpus} CPUs, ${memoryGiB} GiB of memory and ${diskGiB} GiB of disk.</p>${heldAt("queued")}`,
    building: html`${turnsList(turns, c.now)}
${t.working && html`<p class="tl-event tl-work">${dot("work")}<span>Its agent is working${t.workingSince !== undefined && html` for <time data-since="${t.workingSince}">${clock(c.now - t.workingSince)}</time>`}.</span></p>`}
${t.usageLimit !== undefined && html`<p class="tl-event tl-bad">${dot("bad")}<span>It ${limitText(t, c.now)}, ${ago(t.usageLimit.stoppedAt, c.now)}.</span></p>`}
${d.pylon.failed !== null && html`<p class="tl-event tl-bad">${dot("bad")}<span>Its pylon failed: ${d.pylon.failed.split("\n")[0]}</span></p>`}
${judgments.map((j) => html`<p class="tl-event">${dot(j.verdict === null ? "work" : "bad")}<span>Judged a failure on ${j.node} ${ago(j.startedAt, c.now)}: ${j.verdict === null ? "no answer yet" : html`<b>${j.verdict.answer}</b>, ${j.verdict.why}`}</span></p>`)}
${asked.map((q) => html`<p class="tl-event">${dot(isOpen(q) ? "bad" : "ok")}<span class="tl-quote">Asked ${ago(q.askedAt, c.now)}: ${firstLine(q.text || (q.ask?.questions[0]?.question ?? ""))}${q.answer !== null && html` Answered <b>${q.answer.option}</b> ${ago(q.answer.at, c.now)}.`}${q.withdrawn !== undefined && html` Withdrawn when the thread was archived ${ago(q.withdrawn.at, c.now)}.`}</span></p>`)}
${outputs.length > 0 && html`<p class="tl-meta">${outputs.map((o, i) => html`${i > 0 && " · "}${o.kind} <code>${o.ref}</code>`)}</p>`}
<p class="tl-go"><button type="button" class="btn btn-xs" data-tab-go="convo">${icon("chat")}Open the conversation</button></p>
${heldAt("building")}`,
    review: html`${d.pullRequests.length === 0 && r === null ? html`<p class="empty">No pull request yet.</p>` : html`<ul class="tl-prs">${d.pullRequests.map((pr) => html`<li><a class="link" href="${pr.url}" target="_blank" rel="noreferrer">#${pr.number} ${pr.title} ↗</a> <span class="tag">${pr.state}</span> <span class="dim">checks ${pr.checks}${pr.review !== "" && ` · ${pr.review}`}</span></li>`)}</ul>`}
${r !== null && html`<p class="tl-meta">Reviewed by <a class="link" href="/threads/${r.reviewer}">${r.reviewer}</a> on ${r.models.reviewer} (${r.reviewerKind}) · round ${roundsSpent(r)} of ${r.maxRounds}${r.land !== null && " · lands once approved"} · ${r.phase.kind.replace("-", " ")}${phaseNote(r)}${checkBeside(r)}</p>
${reviewersNote(r) !== null && html`<p class="tl-meta">${reviewersNote(r)}</p>`}
${r.rounds.length > 0 && html`<ol class="tl-rounds">${r.rounds.map((round, i) => roundView(r, round, i, i === r.rounds.length - 1))}</ol>`}`}
${heldAt("review")}`,
    landing: html`${r === null ? html`<p class="empty">It lands once its review approves it.</p>` : landingView(c, r) || html`<p class="empty">${r.land === null ? "It lands once you press Land." : "It lands once its review approves it."}</p>`}
${r?.phase.kind === "rolling-back" && html`<p class="error">${r.phase.why}</p>`}
${heldAt("landing")}`,
    deployed: html`${r?.phase.kind === "landed" ? html`<p class="tl-meta">Merged as ${short(r.phase.commit)}${c.deploys(r) ? ", deployed, and every service reports it healthy." : "."}</p>`
      : r?.phase.kind === "merged" ? html`<p class="tl-meta">Merged on GitHub outside its review.</p>`
      : life.stage === "deployed" ? html`<p class="tl-meta">${life.why}.</p>` : html`<p class="empty">Not yet.</p>`}`,
  };
  const when: Record<Step, Part> = {
    planned: ago(t.createdAt, c.now), queued: null, building: turns[0] !== undefined && turns[0].at > 0 ? ago(turns[0].at, c.now) : null,
    review: r === null ? null : ago(r.startedAt, c.now), landing: null, deployed: null,
  };
  const label: Record<Step, string> = { planned: "Brief", queued: "Queued", building: "Building", review: "Pull request and review", landing: "Landing", deployed: "Deployed" };
  const closed = t.status === "archived" || t.status === "deleted";
  // A pylon its node does not list has no disk left to keep.
  const kept = d.pylon.actualState === "absent" ? null : keptPastDay(t, c.now);
  return html`<ol class="tl">${steps.map((s) => step(s, label[s], states[s], when[s], body[s]))}
${closed && step("archived", t.status === "archived" ? "Archived" : "Deleted", "done", t.archivedAt === undefined ? null : ago(t.archivedAt, c.now), html`<p class="tl-meta">${t.status === "archived" ? "Its pylon is paused. Unarchive it to pick the work up again." : "Its pylon and disk are gone."}</p>
${kept !== null && html`<p class="tl-meta">Its disk is kept past its 24 hours, as ${kept}.</p>`}
${t.status === "archived" && t.usageUnread !== undefined && html`<p class="tl-meta">Usage unread: ${d.pylon.actualState === "absent" ? "its disk went" : "its disk goes 24 hours after the archive"} with the token usage on it unread, as ${t.usageUnread}.</p>`}`)}
</ol>`;
}

/** The track of a piece of work's steps, each with its name and state, and on its thread's page a link to its place in the timeline. */
export function lifeTrack(life: Life, linked = true): Html {
  const states = stepStates(life);
  const inside = (s: Step) => html`<span class="life-dot" aria-hidden="true"></span><span class="life-name">${stageLabel[s]}</span>${states[s] === "held" && html`<span class="life-tag">held for you</span>`}`;
  return html`<ol class="life" aria-label="Where this work is">${steps.map((s) => html`<li class="life-${states[s]}"${(states[s] === "now" || states[s] === "held") && html` aria-current="step"`}>${linked ? html`<a href="#tl-${s}" data-tab-go="timeline">${inside(s)}</a>` : html`<span class="life-step">${inside(s)}</span>`}</li>`)}</ol>`;
}
