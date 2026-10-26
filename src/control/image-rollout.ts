import type { ImageId } from "../images.ts";
import type { JobId, NodeName, TailnetNodeId } from "../protocol.ts";

/** One node's part of an image operation. */
export interface ImageStep {
  node: NodeName;
  /**
   * done: the node's observation lists the image. skipped: the node was offline when the rollout began, so it fetches
   * the image on first use (planPylon's missing-artifact rule).
   */
  state: "pending" | "running" | "done" | "failed" | "skipped";
  /** The job last sent for this step, saved before it is sent, so a restarted control plane asks the probe about it. */
  job: { id: JobId; notAfter: string } | null;
  reason: string | null;
}

/** A build has one step, on the image build node. A rollout has one step per registry node. */
export type ImageOperation = {
  kind: "build" | "rollout";
  image: ImageId;
  requestedBy: TailnetNodeId;
  requestedAt: number;
  steps: readonly ImageStep[];
} & ({ state: "running" } | { state: "done"; finishedAt: number } | { state: "failed"; finishedAt: number; reason: string });
