/** It imports only route.ts at run time, so a browser can bundle it. */
import type { z } from "zod";
import type { DrainReply, ReleaseView } from "../protocol/deploy.ts";
import type { ImageManifest } from "../protocol/images.ts";
import type { ImageEntry, ImagesView } from "../control/image-rollout.ts";
import type { ImageOperation } from "../control/image-store.ts";
import type { deploySchema, drainSchema, imageSchema, releasesSchema, reportSchema, rolloutSchema } from "./release-parse.ts";
import { route } from "./route.ts";

export type { ImageEntry, ImagesView } from "../control/image-rollout.ts";
export type { ImageOperation } from "../control/image-store.ts";

/** How long a deploy has to report every service healthy: `nexus deploy --wait` waits so long, and a landing then rolls back. */
export const deployWaitMs = 30 * 60_000;

export interface ImagesCurrent { current: ImageEntry | null; previous: ImageEntry | null }

export const releaseRoutes = {
  release: route<ReleaseView>()("GET", "/v1/release"),
  deploy: route<ReleaseView, z.input<typeof deploySchema>>()("PUT", "/v1/release"),
  deployerRelease: route<ReleaseView>()("GET", "/v1/deployer/release"),
  report: route<{ ok: true }, z.input<typeof reportSchema>>()("POST", "/v1/deployer/report"),
  /** `delete` names the releases the deployer may delete. */
  releases: route<{ delete: string[] }, z.input<typeof releasesSchema>>()("POST", "/v1/deployer/releases"),
  drain: route<DrainReply, z.input<typeof drainSchema>>()("POST", "/v1/deployer/drain"),
} as const;

export const imageRoutes = {
  list: route<ImagesView>()("GET", "/v1/images"),
  record: route<ImageManifest, z.input<typeof imageSchema>>()("POST", "/v1/images"),
  current: route<ImagesCurrent>()("GET", "/v1/images/current"),
  build: route<ImageOperation>()("POST", "/v1/images/build"),
  rollout: route<ImageOperation, z.input<typeof rolloutSchema>>()("POST", "/v1/images/rollout"),
  rollback: route<ImageOperation>()("POST", "/v1/images/rollback"),
} as const;
