/** Renders a daily report of `nexus doctor`'s checks. */
import type { StoredReport } from "../doctor-model.ts";
import { utc } from "../usage.ts";
import { Html, html, dot, menu, state } from "./view.ts";
import type { Context } from "./context.ts";
import { layout, reportTone as tone } from "./shell.ts";

/** The report's checks grouped by the control plane and each node, and every report kept, newest first. */
export function reportPage(c: Context, report: StoredReport | null): Html {
  const groups = report === null ? [] : [...Map.groupBy(report.checks, (check) => check.node ?? "Control plane")];
  const kept = c.registry.reports();
  return layout(c, {
    title: report === null ? "Daily report" : `Daily report ${report.id}`,
    nav: "reports",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Daily report</h1></div></header>
<div class="scroll"><div class="page report" id="report" data-live>
${report === null ? html`<p class="empty">No daily report yet. The control plane runs <code>nexus doctor</code>'s checks once a day, and <code>nexus doctor</code> runs them now.</p>` : html`<p>${state(report.status, tone[report.status])} Checked at <time datetime="${report.at}">${utc(Date.parse(report.at))}</time>.</p>
${groups.map(([group, checks]) => html`<section aria-label="${group}"><div class="ov-head"><h2>${group}</h2></div>
<table class="ov ov-report"><thead><tr><th>Check</th><th class="wide">What it found</th></tr></thead>
<tbody>${checks.map((check) => html`<tr data-check="${check.name}" data-status="${check.status}"><td><span class="ov-title">${dot(tone[check.status], check.status)}<span>${check.name}</span></span></td><td class="wide">${check.text}</td></tr>`)}</tbody>
</table></section>`)}`}
${kept.length > 0 && html`<section aria-labelledby="reports-h"><div class="ov-head"><h2 id="reports-h">Kept 30 days</h2></div>
<ul class="report-list">${kept.map((r) => html`<li><a class="link" href="/reports/${r.id}"${r.id === report?.id && html` aria-current="page"`}>${utc(Date.parse(r.at))}</a> ${state(r.status, tone[r.status])}</li>`)}</ul></section>`}
</div></div>`,
  });
}
