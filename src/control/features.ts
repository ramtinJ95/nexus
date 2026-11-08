/**
 * The control plane's optional features. main.ts builds each one its config allows and passes null for the rest, and
 * a route that needs one refuses with its sentence in not-configured.ts while it is null.
 */
import type { CleanupPass } from "./cleanup.ts";
import type { DoctorReport } from "./doctor-model.ts";
import { HttpError } from "./http-error.ts";
import type { ImageRollout } from "./image-rollout.ts";
import type { Pipeline } from "./pipeline.ts";
import type { Planning } from "./planning.ts";
import type { ThreadQueue } from "./queue.ts";
import type { ReviewLoop } from "./review.ts";
import type { UsageBackfillJob } from "./usage-backfill.ts";
import { notConfigured } from "./not-configured.ts";

export interface Features {
  /** Reads and merges with the control plane's GitHub token. */
  reviews: ReviewLoop | null;
  /** Learns from the GitHub token when a predecessor's pull request merged. */
  queue: ThreadQueue | null;
  /** Starts its items' threads through the queue. */
  pipeline: Pipeline | null;
  /** Marks planning threads, writes what their messages start with, and adds the items the person accepts from them. */
  planning: Planning | null;
  /** Asks the person what each node could delete, and deletes what they agree to. Without it, a deployer's releases are not recorded. */
  cleanup: CleanupPass | null;
  images: ImageRollout | null;
  usageBackfill: UsageBackfillJob | null;
  /** Runs `nexus doctor`'s checks now. */
  doctor: (() => Promise<DoctorReport>) | null;
}

export const noFeatures: Features = { reviews: null, queue: null, pipeline: null, planning: null, cleanup: null, images: null, usageBackfill: null, doctor: null };

/** The feature, or a 409 that says it is not configured. */
export function feature<K extends keyof Features>(features: Features, name: K): NonNullable<Features[K]> {
  const found = features[name];
  if (found === null) throw new HttpError(409, notConfigured[name]);
  return found as NonNullable<Features[K]>;
}
