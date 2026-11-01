/** Renders the Health page: the latest pass of `nexus doctor`'s checks, each problem open, and the changes kept 30 days. */
import { checkKey, healthView, worst, type Check, type DoctorReport } from "../doctor-model.ts";
import { utc } from "../usage.ts";
import { Html, html, dot, menu, state } from "./view.ts";
import type { Context } from "./context.ts";
import { layout, statusTone as tone } from "./shell.ts";

const name = (c: Pick<Check, "node" | "name">) => `${c.node ?? "Control plane"} ${c.name}`;
const at = (iso: string) => html`<time datetime="${iso}">${utc(Date.parse(iso))}</time>`;

/**
 * The latest pass's checks grouped by the control plane and each node, or before a start's first pass the problems
 * recorded, and every change kept, newest first. `data-health-through` names the newest problem shown, which the page
 * marks seen once the person looks at it.
 */
export function healthPage(c: Context, latest: DoctorReport | null): Html {
  const view = healthView(latest, c.registry.healthStates());
  const open = new Map(view.problems.map((p) => [checkKey(p), p]));
  const shown = latest?.checks ?? view.problems;
  const groups = [...Map.groupBy(shown, (check) => check.node ?? "Control plane")];
  const changes = c.registry.healthChanges();
  const status = worst(view.problems);
  return layout(c, {
    title: "Health",
    nav: "health",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Health</h1></div></header>
<div class="scroll"><div class="page report" id="health" data-live>
<p data-health-through="${Math.max(0, ...view.problems.map((p) => p.id))}">${state(view.problems.length === 0 ? "Every check is ok" : `${view.problems.length} open ${view.problems.length === 1 ? "problem" : "problems"}`, tone[status])}${latest === null ? html` No pass since the control plane started. It runs <code>nexus doctor</code>'s checks every 5 minutes from 5 minutes after a start, and <code>nexus doctor</code> runs them now.` : html` Checked at ${at(latest.at)}.`}</p>
${groups.map(([group, checks]) => html`<section aria-label="${group}"><div class="ov-head"><h2>${group}</h2></div>
<table class="ov ov-report"><thead><tr><th>Check</th><th class="wide">What it found</th><th>Since</th></tr></thead>
<tbody>${checks.map((check) => {
  const problem = open.get(checkKey(check));
  const since = problem !== undefined ? html`${problem.status} since ${at(problem.at)}${problem.seenAt === null && html` <em>new</em>`}`
    : check.status !== "ok" ? "this pass only, so it alerts if the next agrees" : "";
  return html`<tr data-check="${check.name}" data-status="${check.status}"><td><span class="ov-title">${dot(tone[check.status], check.status)}<span>${check.name}</span></span></td><td class="wide">${check.text}</td><td>${since}</td></tr>`;
})}</tbody>
</table></section>`)}
<section aria-labelledby="changes-h"><div class="ov-head"><h2 id="changes-h">Changes in the last 30 days</h2></div>
${changes.length === 0 ? html`<p class="empty">No check has changed.</p>` : html`<ul class="report-list">${changes.map((change) => html`<li data-change="${change.id}" data-status="${change.status}">${at(change.at)} ${name(change)} ${state(change.from, tone[change.from])} to ${state(change.status, tone[change.status])}: ${change.text}</li>`)}</ul>`}
</section>
</div></div>`,
  });
}
