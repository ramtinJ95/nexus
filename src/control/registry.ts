/**
 * The registry: every Nexus record, in one SQLite file. The control plane process holds one connection to it, so its
 * writes are synchronous statements that never interleave with each other. Another process may open the file too, such
 * as the join-token command, and SQLite's busy timeout makes the two take turns.
 *
 * Nested values (a project's hosts, a pylon's boot inputs, an observation) are stored as JSON columns. Only
 * the control plane reads them, always whole, so they need no columns of their own.
 */
import { planningStore } from "./planning-store.ts";
import { prWatchStore } from "./pr-watch-store.ts";
import { nudgeStore } from "./nudge-store.ts";
import { judgmentStore } from "./judgment-store.ts";
import { pipelineStore } from "./pipeline-store.ts";
import { queueStore } from "./queue-store.ts";
import { reviewStore } from "./review-store.ts";
import { questionStore } from "./question-store.ts";
import { usageStore } from "./usage-store.ts";
import { releaseStore } from "./release-store.ts";
import { healthStore } from "./health-store.ts";
import { nodeStore } from "./node-store.ts";
import { nodeMetricsStore } from "./node-metrics-store.ts";
import { projectStore } from "./project-store.ts";
import { imageStore } from "./image-store.ts";
import { openDb } from "./db.ts";
import { threadStore } from "./thread-store.ts";
import { placementMemory } from "./placement-model.ts";
import { owedReviews } from "./owed-review.ts";
import { roleOf } from "./agent-protocol.ts";
import type { Need } from "./attention.ts";
import type { ThreadId } from "../ids.ts";

export type Registry = ReturnType<typeof openRegistry>;

export function openRegistry(path: string, clock = Date.now, log = (message: string) => console.error(message)) {
  const kernel = openDb(path);
  const { saveObservation, saveNodeState, ...nodes } = nodeStore(kernel);
  const { holdReleased, ...placement } = placementMemory(clock);
  const { updateAttention, threadRecord, saveStartKey, start, archivedAt, recordSettle, ...threads } = threadStore(kernel, clock, { node: nodes.node, saveObservation, saveNodeState }, holdReleased);
  const { appendEvent, setThreadStatus, threadStatus, events } = threads;
  // A pull request's first review settles what every thread that links it is owed (owed-review.ts).
  const firstReview = (repo: string, number: number) => { for (const id of prWatches.linking(repo, number)) updateAttention(id); };
  const { participant: reviewing, ...reviews } = reviewStore(kernel, { setThreadStatus, appendEvent, updateAttention, events, firstReview });
  const { participant: asking, ...questions } = questionStore(kernel, clock, threadStatus, updateAttention);
  const { participant: nudging, ...nudges } = nudgeStore(kernel, updateAttention);
  const { participant: watching, ...prWatches } = prWatchStore(kernel, appendEvent, updateAttention);
  // A project's auto-review setting and secrets decide which of its threads' pull requests no review will start for.
  const projects = projectStore(kernel, (project) => {
    for (const t of threads.storedThreads()) if (t.project === project) updateAttention(t.id);
  });
  /** An open pull request no review will start for, whose builder's project reviews on its own (owed-review.ts). */
  const owing = {
    needs(id: ThreadId): Need[] {
      const t = threads.thread(id);
      if (t === undefined) return [];
      const role = roleOf(t.startedBy);
      const owed = owedReviews({
        status: t.status, serves: role === "reviewer" || role === "check" || role === "verify" || reviews.isReviewer(id), claude: threads.claudeWorker(id) !== undefined,
        project: projects.project(t.project), prs: prWatches.prWatch(id)?.links.map((l) => l.pr) ?? [], review: reviews.review(id), reviewed: reviews.prReviewed,
      });
      const since = t.archivedAt ?? Math.max(t.createdAt, t.lastAgentActivityAt);
      return owed.flatMap((o) => o.kind === "unmoved" ? [{ kind: "unreviewed" as const, pr: o.pr.number, url: o.pr.url, why: o.why, since }] : []);
    },
  };
  const { participant: queueing, ...queue } = queueStore(kernel, saveStartKey);
  const { participant: usageHolding, ...usage } = usageStore(kernel, { threadRecord, archivedAt, recordSettle });
  const { participant: piping, ...pipeline } = pipelineStore(kernel, threads.startRequest);
  start([reviewing, asking, nudging, watching, queueing, usageHolding, piping, owing], usage.failUsageRead);

  return {
    close() { kernel.db.close(); },
    /** The registry's clock, the one time source for decisions over its records. */
    now: clock,
    threads,
    reviews,
    questions,
    nudges,
    prWatches,
    queue,
    usage,
    placement,
    planning: planningStore(kernel),
    judgments: judgmentStore(kernel),
    releases: releaseStore(kernel, appendEvent),
    health: healthStore(kernel, appendEvent, log),
    nodes,
    nodeMetrics: nodeMetricsStore(kernel),
    projects,
    pipeline,
    images: imageStore(kernel),
  };
}
