/** Renders the usage page: the tokens every agent spent in a period, in all and by each breakdown. */
import type { ProjectId } from "../../ids.ts";
import type { ThreadId } from "../registry.ts";
import { breakdownLook, breakdowns, periods, periodStart, tokenColumns, tokenCount, utc, type Period, type UsageBackfill, type UsageTotals } from "../usage.ts";
import { Html, html, menu, type Part } from "./view.ts";
import type { Context } from "./context.ts";
import { layout } from "./shell.ts";

/** A phone hides the wide columns of a usage table. */
export const usageColumns = tokenColumns.map((col) => ({ ...col, wide: col.field === "cacheWrite" || col.field === "cacheRead" }));
export const exact = (n: number) => n.toLocaleString("en-US");

/** Each token count reads as 1.2M, with the exact number in its title and, for a script, in `data-tokens`. */
function usageTable(id: string, keyHead: string, rows: readonly (UsageTotals & { key: Part })[]): Html {
  const wide = (yes: boolean) => yes && html` class="wide"`;
  return html`<table class="ov usage-t" id="${id}">
<thead><tr><th>${keyHead}</th>${usageColumns.map((col) => html`<th${wide(col.wide)}>${col.label}</th>`)}<th class="wide">Calls</th></tr></thead>
<tbody>${rows.map((r) => html`<tr><td>${r.key}</td>${usageColumns.map((col) => html`<td${wide(col.wide)} data-column="${col.field}" data-tokens="${r[col.field]}" title="${exact(r[col.field])}">${tokenCount(r[col.field])}</td>`)}<td class="wide">${exact(r.calls)}</td></tr>`)}</tbody>
</table>`;
}

function backfillNote(c: Context, b: UsageBackfill): Html {
  const run = b.state === "never" ? null : b;
  const thread = (id: ThreadId) => html`<a class="link" href="/threads/${id}">${c.registry.thread(id)?.title ?? id}</a>`;
  const recovered = run === null ? "" : `${exact(run.recovered.calls)} calls and ${tokenCount(run.recovered.tokens)} tokens recovered`;
  const read = run === null ? "" : `${run.read} of ${run.of} threads read`;
  const doing = run?.current == null ? run?.waiting == null ? "" : html` It waits: ${run.waiting}.`
    : run.current.phase === "reading" ? html` It reads ${thread(run.current.thread)}.` : html` It waits for the pylon of ${thread(run.current.thread)} to pause.`;
  const said = run === null
    ? html`The calls archived threads made before then are counted once a deployer runs <code>nexus usage backfill</code>, which wakes their pylons one at a time to read them.`
    : run.state === "running" ? html`The backfill reads archived threads' pylons, one at a time: ${read}, ${recovered} so far.${doing}`
    : run.state === "stopped" ? html`The backfill stopped at ${read}, with ${recovered}. A deployer goes on with <code>nexus usage backfill</code>.`
    : html`The backfill read archived threads' pylons and finished <time datetime="${new Date(run.finishedAt!).toISOString()}">${utc(run.finishedAt!)}</time>: ${read}, ${run.skipped.length} skipped, ${recovered}.`;
  return html`<div id="usage-backfill" data-backfill-state="${b.state}"${run !== null && html` data-read="${run.read}" data-of="${run.of}" data-recovered-calls="${run.recovered.calls}" data-recovered-tokens="${run.recovered.tokens}"`}>
<p>${said}</p>
${run !== null && run.skipped.length > 0 && html`<table class="ov" id="usage-backfill-skipped"><thead><tr><th>Skipped thread</th><th>Why</th></tr></thead>
<tbody>${run.skipped.map((t) => html`<tr data-thread="${t.thread}"><td>${thread(t.thread)}</td><td>${t.reason}</td></tr>`)}</tbody></table>`}
</div>`;
}

/** The tokens every agent spent in the period, in all and by each breakdown, as `GET /v1/usage` reports them. */
export function usagePage(c: Context, period: Period, project: ProjectId | null): Html {
  const report = c.registry.usageReport({ since: periodStart(period, c.now), project, by: breakdowns });
  const href = (p: Period, of: string | null) => `/usage?period=${p}${of === null ? "" : `&project=${encodeURIComponent(of)}`}`;
  const seg = (label: string, to: string, current: boolean) => html`<a class="seg-tab" href="${to}"${current && html` aria-current="page"`}>${label}</a>`;
  return layout(c, {
    title: "Usage",
    nav: "usage",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Usage</h1></div></header>
<div class="scroll"><div class="page usage" id="usage" data-live>
<div class="usage-filters">
<nav class="seg-bar usage-seg" aria-label="Period">${(Object.keys(periods) as Period[]).map((p) => seg(periods[p], href(p, project), p === period))}</nav>
<nav class="seg-bar usage-seg" aria-label="Project">${seg("All projects", href(period, null), project === null)}${c.registry.projects().map((p) => seg(p.id, href(period, p.id), p.id === project))}</nav>
</div>
<section aria-labelledby="usage-totals-h"><div class="ov-head"><h2 id="usage-totals-h">Tokens${project !== null && ` in ${project}`}</h2></div>
${usageTable("usage-totals", "Period", [{ key: periods[period], ...report.total }])}
<div class="usage-notes">
<p>Counting started <time datetime="${new Date(report.countingSince).toISOString()}">${utc(report.countingSince)}</time>. The calls of threads that ran then were counted from the transcripts their pylons had. Threads deleted before then are not counted, as their Claude and pi transcripts went with their pylons, except for the Nexus agent's calls, which the harness keeps.</p>
${backfillNote(c, report.backfill)}
<p>The summaries the Nexus agent's compactions write, and model calls its tools make, are not counted.</p>
</div>
</section>
${report.total.calls === 0 ? html`<p class="empty">No model calls were counted in this period.</p>` : breakdowns.map((b) => html`<section aria-labelledby="usage-by-${b}-h"><div class="ov-head"><h2 id="usage-by-${b}-h">${breakdownLook[b].title}</h2></div>
${usageTable(`usage-by-${b}`, breakdownLook[b].key, report.by[b]!.map((r) => b === "project" ? { ...r, key: html`<a class="link" href="${href(period, r.key)}">${r.key}</a>` } : r))}
</section>`)}
</div></div>`,
  });
}
