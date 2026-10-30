/**
 * The registry: every Nexus record, in one SQLite file. The control plane process is its only writer, and
 * it holds one connection, so every write is a synchronous statement and no two writes interleave.
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
import { nodeStore } from "./node-store.ts";
import { projectStore } from "./project-store.ts";
import { imageStore } from "./image-store.ts";
import { openDb } from "./db.ts";
import type { StartKey } from "./start-request.ts";
import type { ThreadId } from "../ids.ts";
import { threadStore, type ThreadParticipant } from "./thread-store.ts";

// Temporary: ThreadId moved to ids.ts, StartKey to start-request.ts, NodeRecord, JoinedNode and RecordedImage to their stores, and the thread core's types to thread-store.ts, and E1 deletes these re-exports.
export type { StartKey, ThreadId };
export type { JoinedNode, NodeRecord } from "./node-store.ts";
export type { RecordedImage } from "./image-store.ts";
export type { ClaudeSent, ClaudeWorker, Output, Placement, PortRange, Preview, Room, Session, StoredPylon, StoredThread, Thread, ThreadAgent, Weighed } from "./thread-store.ts";

export type Registry = ReturnType<typeof openRegistry>;

/** Opens the file, creating it if needed, and applies any migrations it has not seen. */
export function openRegistry(path: string, clock = Date.now) {
  const kernel = openDb(path);
  const participants: ThreadParticipant[] = [];
  const { saveObservation, saveNodeState, ...nodes } = nodeStore(kernel);
  // Called from start() on, so after usageStore below.
  const { updateAttention, threadRecord, saveStartKey, start, ...core } = threadStore(kernel, clock, { node: nodes.node, saveObservation, saveNodeState }, participants, () => readingUsage());
  const { appendEvent, setThreadStatus, threadStatus } = core;
  const { participant: reviewing, ...reviews } = reviewStore(kernel, { setThreadStatus, appendEvent, updateAttention });
  const { participant: asking, ...questions } = questionStore(kernel, threadStatus, updateAttention);
  const { participant: nudging, ...nudges } = nudgeStore(kernel, updateAttention);
  const { participant: watching, ...prWatches } = prWatchStore(kernel, appendEvent);
  const { participant: queueing, ...queue } = queueStore(kernel, saveStartKey);
  const { readingUsage, ...usage } = usageStore(kernel, threadRecord);
  participants.push(reviewing, asking, nudging, watching, queueing);
  start();

  return {
    close() { kernel.db.close(); },
    ...core,
    ...usage,
    ...reviews,
    ...questions,
    ...planningStore(kernel),
    ...prWatches,
    ...judgmentStore(kernel),
    ...nudges,
    ...releaseStore(kernel, appendEvent),
    ...nodes,
    ...projectStore(kernel),
    ...pipelineStore(kernel),
    ...queue,
    ...imageStore(kernel),
  };
}
