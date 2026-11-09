/** These schemas need zod, so they stay out of release.ts, which a browser can bundle. */
import { z } from "zod";
import { fullCommit, reportStates, type ReportBody, type Role } from "../protocol/deploy.ts";
import type { ReleaseInventory } from "../deploy/release-cleanup.ts";
import { releaseName } from "../node-base/node-layout.ts";
import { deleteOutcomeSchema } from "../protocol/cleanup.ts";
import { pinsSchema } from "../protocol/images.ts";
import { isImageId, type ImageId, type NodeName } from "../ids.ts";

export const commitSchema = z.string().regex(fullCommit);
export const deploySchema = z.strictObject({ commit: z.union([z.literal("main"), commitSchema]) });
export const reportSchema = z.strictObject({
  role: z.enum(["control", "probe"] satisfies Role[]), commit: commitSchema.nullable(), target: commitSchema.nullable(),
  state: z.enum(reportStates),
  reason: z.string().max(20_000).nullable(),
}) satisfies z.ZodType<ReportBody>;

const name = z.string().regex(releaseName);
const pid = z.int().positive();
export const releasesSchema = z.strictObject({
  inventory: z.strictObject({
    releases: z.array(z.strictObject({ name, commit: commitSchema.nullable(), bytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), installedAt: z.number().nonnegative() })).max(10_000),
    links: z.strictObject({ current: name.nullable(), "control-current": name.nullable(), "deployer-current": name.nullable() }),
    replaced: z.strictObject({ probe: name.nullable(), control: name.nullable() }),
    running: z.record(name, pid),
  }) satisfies z.ZodType<ReleaseInventory>,
  outcomes: z.record(name, deleteOutcomeSchema).optional(),
});
export const drainSchema = z.strictObject({ commit: commitSchema, release: z.boolean().optional(), hold: z.boolean().optional() });

export const imageSchema = z.strictObject({
  id: z.custom<ImageId>(isImageId, "must be an image ID"),
  gondolinBuildId: z.string().min(1),
  pins: pinsSchema,
  builtOn: z.string().min(1).transform((node) => node as NodeName),
  builtAt: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const rolloutSchema = z.strictObject({ image: imageSchema.shape.id });
export const noFields = z.strictObject({});
