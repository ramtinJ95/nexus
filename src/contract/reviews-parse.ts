/** These schemas need zod, so they stay out of reviews.ts, which a browser can bundle. */
import { z } from "zod";
import { maxRounds } from "../control/review-model.ts";
import { commitSchema } from "./release-parse.ts";

export const reviewSchema = z.strictObject({
  pr: z.int().positive().optional(),
  rounds: z.int().min(1).max(maxRounds).optional(),
  /** Land the PR under the merge policy once the review approves it and its checks pass. */
  land: z.boolean().default(false),
});

const holdsSchema = z.array(z.string().min(1).max(4_000)).min(1).max(20);
/** A waiver names the commit the person saw, so a review that moved on is not landed past holds they did not see. */
export const landSchema = z.strictObject({ head: commitSchema.optional(), waive: holdsSchema.optional() })
  .refine((b) => b.waive === undefined || b.head !== undefined, "a waiver needs the head it confirmed");

/** An ask is answered with a choice per question it asks, and any other question with one of its options. */
export const answerSchema = z.union([z.strictObject({ option: z.string() }), z.strictObject({ choices: z.array(z.unknown()) })]);
