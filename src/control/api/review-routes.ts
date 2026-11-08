/**
 * Starting and cancelling a thread's review, and landing its pull request.
 */
import type { ReviewLoop } from "../review.ts";
import { HttpError } from "../http-error.ts";
import { ok, created, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { demand, landing } from "./access.ts";
import { reviewRoutes as routes } from "../../contract/reviews.ts";
import { landSchema, reviewSchema } from "../../contract/reviews-parse.ts";
import type { Review } from "../review-model.ts";
import { reviewSaid } from "../wording.ts";

const said = (r: Review) => ({ ...r, said: reviewSaid(r) });

export function reviewRoutes(kit: ApiKit, options: { reviews?: ReviewLoop | null | undefined }): readonly RouteEntry[] {
  const { thread } = kit;

  function reviewsOrRefuse(): ReviewLoop {
    if (!options.reviews) throw new HttpError(409, "the review loop needs the control plane's GitHub token (github.tokenFile), which is not configured");
    return options.reviews;
  }

  return [
    on(routes.start, { role: "person", action: "start a review" }, async (params, r) => {
      const body = parse(reviewSchema, await r.body({}));
      const t = thread(params.thread);
      if (body.land) demand(r.roles, landing);
      return created(said(await reviewsOrRefuse().start(t.id, { pr: body.pr, rounds: body.rounds, land: body.land ? r.caller : null })));
    }),
    on(routes.cancel, { role: "person", action: "cancel a review" }, (params, r) => ok(said(reviewsOrRefuse().cancel(thread(params.thread).id, r.caller)))),
    on(routes.land, landing, async (params, r) => {
      const body = parse(landSchema, await r.body({}));
      const t = thread(params.thread);
      return ok(said(reviewsOrRefuse().land(t.id, r.caller, body.head, body.waive)));
    }),
  ];
}
