/**
 * Probe contract, cleanup: the space each image and template the node could delete takes, and deleting the
 * ones the person agreed to. The deployer deletes releases with the same outcomes (src/deploy/release-cleanup.ts).
 */
import { z } from "zod";
import { isPortableArtifactId, type PortableArtifactId } from "../ids.ts";

/**
 * What one delete did. `gone`: nothing was there, as after an earlier run of the same delete. `skipped`: the node
 * found it in use when it came to delete it, and says why.
 */
export type DeleteOutcome = { state: "deleted"; bytes: number } | { state: "gone" } | { state: "skipped"; reason: string };

/** GET /v1/cleanup: each image and template the backend could delete, with the bytes its files take on disk. */
export interface ArtifactUsage { artifacts: readonly { id: PortableArtifactId; bytes: number }[] }
/** POST /v1/cleanup takes the artifacts to delete, in order, and answers with what each delete did. */
export interface DropRequest { drop: readonly PortableArtifactId[] }
export interface DropReply { outcomes: Readonly<Record<PortableArtifactId, DeleteOutcome>> }

const artifactId = z.string().refine(isPortableArtifactId, "expected an image or template ID, and no cleanup deletes a checkpoint").pipe(z.custom<PortableArtifactId>());
const bytes = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const deleteOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("deleted"), bytes }),
  z.strictObject({ state: z.literal("gone") }),
  z.strictObject({ state: z.literal("skipped"), reason: z.string().max(2_000) }),
]) satisfies z.ZodType<DeleteOutcome>;
export const artifactUsageSchema = z.looseObject({ artifacts: z.array(z.looseObject({ id: artifactId, bytes })) }) satisfies z.ZodType<ArtifactUsage>;
/** The most artifacts one POST /v1/cleanup names. */
export const maxDrops = 1_000;
export const dropRequestSchema = z.strictObject({ drop: z.array(artifactId).max(maxDrops) }) satisfies z.ZodType<DropRequest>;
export const dropReplySchema = z.looseObject({ outcomes: z.record(z.string(), deleteOutcomeSchema) }).transform((reply) => reply as DropReply);
