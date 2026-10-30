/**
 * Starting and cancelling a thread's review, and landing its pull request.
 */
import { z } from "zod";
import type { ReviewLoop } from "../review.ts";
import { HttpError } from "../http-error.ts";
import { commitSchema } from "../releases.ts";
import { maxRounds } from "../review-model.ts";
import { ok, created, parse, type RouteEntry, type ApiKit } from "./kit.ts";

const reviewSchema = z.strictObject({
  pr: z.int().positive().optional(),
  rounds: z.int().min(1).max(maxRounds).optional(),
  /** Land the PR under the merge policy once the review approves it and its checks pass. */
  land: z.boolean().default(false),
});

const holdsSchema = z.array(z.string().min(1).max(4_000)).min(1).max(20);
/** A waiver names the commit the person saw, so a review that moved on is not landed past holds they did not see. */
const landSchema = z.strictObject({ head: commitSchema.optional(), waive: holdsSchema.optional() })
  .refine((b) => b.waive === undefined || b.head !== undefined, "a waiver needs the head it confirmed");

export function reviewRoutes(kit: ApiKit, options: { reviews?: ReviewLoop | null | undefined }): readonly RouteEntry[] {
  const { thread, mayLand } = kit;

  function reviewsOrRefuse(): ReviewLoop {
    if (!options.reviews) throw new HttpError(409, "the review loop needs the control plane's GitHub token (github.tokenFile), which is not configured");
    return options.reviews;
  }

  return [
    ["POST", /^\/v1\/threads\/([^/]+)\/review$/, { person: "start a review" }, async (m, r) => {
      const body = parse(reviewSchema, await r.body({}));
      const t = thread(m[1]!);
      if (body.land) mayLand(r.caller);
      return created(await reviewsOrRefuse().start(t.id, { pr: body.pr, rounds: body.rounds, land: body.land ? r.caller : null }));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/review\/cancel$/, { person: "cancel a review" }, (m, r) => {
      return ok(reviewsOrRefuse().cancel(thread(m[1]!).id, r.caller));
    }],
    ["POST", /^\/v1\/threads\/([^/]+)\/land$/, { open: "deployers only, which mayLand checks" }, async (m, r) => {
      const body = parse(landSchema, await r.body({}));
      const t = thread(m[1]!);
      mayLand(r.caller);
      return ok(reviewsOrRefuse().land(t.id, r.caller, body.head, body.waive));
    }],
  ];
}
