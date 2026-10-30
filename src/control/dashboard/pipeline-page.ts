/** Renders the pipeline page: each project's items with the phase their records put them in. */
import type { Project } from "../project.ts";
import { itemView, type ItemPhase, type PipelineItem } from "../pipeline.ts";
import { Html, html, dot, state, menu, type Tone } from "./view.ts";
import type { Context } from "./context.ts";
import { layout, threadTitle } from "./shell.ts";

const phaseTone: Record<ItemPhase["kind"], Tone> = {
  planned: "idle", queued: "idle", building: "work", reviewing: "work", landing: "busy", landed: "ok", held: "bad", archived: "muted", cancelled: "muted",
};
const pipelineSetting = (p: Project) => p.pipeline == null ? "The pipeline is off for this project, so its items stay planned."
  : p.pipeline.autoStart ? "Each item becomes a queued thread on its own once the items it is after are queued." : "Each item waits for the person to approve it before it becomes a queued thread.";

/** Each project's items in the order they were added, with the phase their records put them in. */
export function pipelinePage(c: Context): Html {
  const items = c.registry.items().map((i) => itemView(c.registry, i));
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? id;
  const projects = c.registry.projects().filter((p) => p.pipeline != null || items.some((i) => i.project === p.id));
  const actions = (i: PipelineItem, p: Project) => i.thread === null && i.phase.kind !== "cancelled" && [
    p.pipeline?.autoStart === false && i.approved === null && html`<button type="button" class="btn btn-xs" data-action="approve-item" data-item="${i.id}">Approve</button>`,
    html`<button type="button" class="btn btn-xs btn-ghost" data-action="cancel-item" data-item="${i.id}" data-confirm="Cancel ${i.title}? It never becomes a thread.">Cancel</button>`,
  ];
  return layout(c, {
    title: "Pipeline",
    nav: "pipeline",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Pipeline</h1></div></header>
<div class="scroll"><div class="page pipeline" id="pipeline" data-live>
${projects.length === 0 ? html`<p class="empty">No project runs the pipeline. <code>nexus project edit &lt;id&gt; --pipeline start</code> turns it on, and <code>nexus item add</code> lines up an item.</p>` : projects.map((p) => {
  const own = items.filter((i) => i.project === p.id);
  return html`<section aria-labelledby="pipeline-${p.id}">
<div class="ov-head"><h2 id="pipeline-${p.id}">${p.id}</h2><span class="dim">${pipelineSetting(p)}</span></div>
${own.length === 0 ? html`<p class="empty">No items. <code>nexus item add --project ${p.id}</code> lines one up.</p>` : html`<table class="ov ov-items">
<thead><tr><th>Item</th><th>Phase</th><th class="wide">After</th><th class="wide">Thread</th><th class="ov-act"></th></tr></thead>
<tbody>${own.map((i) => html`<tr data-item="${i.id}" data-phase="${i.phase.kind}">
<td><span class="ov-title">${dot(phaseTone[i.phase.kind], i.phase.kind)}<span>${i.title}</span></span><code class="dim">${i.id}</code></td>
<td>${state(i.phase.kind, phaseTone[i.phase.kind])}<span class="ov-why">${i.phase.why}</span></td>
<td class="wide">${i.after.length === 0 ? html`<span class="dim">nothing</span>` : i.after.map((id) => html`<span class="ov-wait">${title(id)}</span>`)}</td>
<td class="wide">${i.thread === null ? html`<span class="dim">none yet</span>` : html`<a class="link" href="/threads/${i.thread}">${threadTitle(c, i.thread)}</a>`}</td>
<td>${actions(i, p)}</td>
</tr>`)}</tbody>
</table>`}
</section>`;
})}
</div></div>
<div class="dock"><p id="action-error" class="error" role="alert" hidden></p></div>`,
  });
}
