/** These schemas need zod, so they stay out of pylon.ts, which a browser can bundle. */
import { z } from "zod";
import { pathsFit } from "../checkout-files.ts";
import { maxRecordBytes } from "../control/claude-transcript.ts";
import { sessionHarnessSchema } from "../protocol/agent-kinds.ts";
import { reservedPorts } from "../protocol/ports.ts";
import { changesBases, type ImageSource, type SessionRequest } from "./pylon.ts";

export const previewSchema = z.strictObject({ port: z.int().min(1).max(65535).refine((port) => !reservedPorts.has(port), "is Nexus's own") }) satisfies z.ZodType<unknown, { port: number }>;
export const sessionSchema = z.strictObject({
  harness: sessionHarnessSchema.default("claude-code"),
  title: z.string().trim().min(1).max(80).optional(),
}) satisfies z.ZodType<unknown, SessionRequest>;

/** A path in the checkout, relative to it. Empty is the checkout itself. */
export const checkoutPath = z.string().refine((path) => !path.includes("\0"), "has a NUL byte").refine((path) => pathsFit([path]), "is too long");
/** A diff's paths, which the probe's request must carry together. */
export const diffPaths = z.array(checkoutPath.min(1)).max(100).refine(pathsFit, "are too long together");
export const changesBaseSchema = z.enum(changesBases).default("start");

const queryCount = z.string().regex(/^\d{1,15}$/, "must be a whole number").transform(Number);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const imageSourceSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("transcript"), offset: queryCount, bytes: queryCount.refine((n) => n > 0 && n <= maxRecordBytes, "is not a record's length"), sha256: sha256Schema, index: queryCount }),
  z.strictObject({ source: z.literal("harness"), entry: queryCount, message: queryCount, part: queryCount, sha256: sha256Schema }),
  z.strictObject({ source: z.literal("file"), path: checkoutPath.min(1), base: z.enum(changesBases).optional() }),
]) satisfies z.ZodType<ImageSource>;
