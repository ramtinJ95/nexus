/** Renders the pipeline page: each project's items with the phase their records put them in. */
import type { Project } from "../project.ts";
import { itemView, type ItemPhase, type PipelineItem } from "../pipeline.ts";
import { Html, html, dot, state, menu, type Tone } from "./view.ts";
import { lifeOfItem, miniTrack, stages } from "./lifecycle.ts";
import type { Context } from "./context.ts";
import { layout, threadTitle } from "./shell.ts";

export const phaseTone: Record<ItemPhase["kind"], Tone> = {
  planned: "idle", queued: "idle", building: "work", reviewing: "work", landing: "busy", landed: "ok", held: "bad", archived: "muted", cancelled: "muted",
};
const pipelineSetting = (p: Project) => p.pipeline == null ? "The pipeline is off for this project, so its items stay planned."
  : p.pipeline.autoStart ? "Each item becomes a queued thread on its own once the items it is after are queued." : "Each item waits for the person to approve it before it becomes a queued thread.";

/** Approve while the project waits for the person to, and Cancel, while an item is not a thread yet. */
export const itemActions = (i: PipelineItem, p: Project) => i.thread === null && i.phase.kind !== "cancelled" && [
  p.pipeline?.autoStart === false && i.approved === null && html`<button type="button" class="btn btn-xs" data-action="approve-item" data-item="${i.id}">Approve</button>`,
  html`<button type="button" class="btn btn-xs btn-ghost" data-action="cancel-item" data-item="${i.id}" data-confirm="Cancel ${i.title}? It never becomes a thread.">Cancel</button>`,
];

/** Each project's items in the order they were added, with the phase their records put them in. */
export function pipelinePage(c: Context): Html {
  const items = c.registry.items().map((i) => itemView(c.registry, i));
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? id;
  const projects = c.registry.projects().filter((p) => p.pipeline != null || items.some((i) => i.project === p.id));
  const card = (i: PipelineItem, p: Project) => {
    const life = lifeOfItem(c, i);
    return html`<li class="card item-card" id="item-${i.id}" data-item="${i.id}" data-phase="${i.phase.kind}" data-stage="${life.stage}" data-at="${life.at}">
<div class="card-main">
<span class="card-title">${dot(phaseTone[i.phase.kind], i.phase.kind)}<span>${i.title}</span></span>
<code class="card-id">${i.id}</code>
${miniTrack(life)}
<span class="card-why">${state(i.phase.kind, phaseTone[i.phase.kind])} ${i.phase.why}</span>
<span class="card-rel"><span class="card-k">After</span> ${i.after.length === 0 ? html`<span class="dim">nothing</span>` : i.after.map((id) => html`<span class="ov-wait">${title(id)}</span>`)}</span>
<span class="card-rel"><span class="card-k">Thread</span> ${i.thread === null ? html`<span class="dim">none yet</span>` : html`<a class="link" href="/threads/${i.thread}">${threadTitle(c, i.thread)}</a>`}</span>
</div>
${itemActions(i, p) && html`<div class="card-act">${itemActions(i, p)}</div>`}
</li>`;
  };
  return layout(c, {
    title: "Pipeline",
    nav: "pipeline",
    main: html`<header class="bar">${menu}<div class="crumb"><h1>Pipeline</h1></div></header>
<div class="scroll"><div class="page pipeline" id="pipeline" data-live>
${projects.length === 0 ? html`<p class="empty">No project runs the pipeline. <code>nexus project edit &lt;id&gt; --pipeline start</code> turns it on, and <code>nexus item add</code> lines up an item.</p>` : projects.map((p) => {
  const own = items.filter((i) => i.project === p.id);
  const placed = Map.groupBy(own, (i) => lifeOfItem(c, i).stage ?? "closed");
  const closed = placed.get("closed") ?? [];
  return html`<section class="lane" aria-labelledby="pipeline-${p.id}">
<div class="ov-head"><h2 id="pipeline-${p.id}">${p.id}</h2><span class="dim">${pipelineSetting(p)}</span></div>
${own.length === 0 ? html`<p class="empty">No items. <code>nexus item add --project ${p.id}</code> lines one up.</p>` : html`<div class="lane-board">${stages.map((st) => {
  const here = placed.get(st.stage) ?? [];
  return html`<div class="lane-col" data-stage="${st.stage}"><h3 class="lane-h"><span class="col-mark mark-${st.tone}" aria-hidden="true"></span>${st.label}<span class="col-n">${here.length}</span></h3>${here.length > 0 && html`<ol class="col-cards">${here.map((i) => card(i, p))}</ol>`}</div>`;
})}</div>
${closed.length > 0 && html`<div class="lane-closed"><h3 class="lane-h"><span class="col-mark mark-muted" aria-hidden="true"></span>Archived or cancelled<span class="col-n">${closed.length}</span></h3><ol class="col-cards">${closed.map((i) => card(i, p))}</ol></div>`}`}
</section>`;
})}
</div></div>
<div class="dock"><p id="action-error" class="error" role="alert" hidden></p></div>`,
  });
}
