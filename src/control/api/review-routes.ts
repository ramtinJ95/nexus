import { feature, type Features } from "../features.ts";
import { ok, created, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { demand, landing } from "./access.ts";
import { reviewRoutes as routes } from "../../contract/reviews.ts";
import { landSchema, reviewSchema } from "../../contract/reviews-parse.ts";
import type { Review } from "../review-model.ts";
import { reviewSaid } from "../wording.ts";

const said = (r: Review) => ({ ...r, said: reviewSaid(r) });

export function reviewRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { thread } = kit;

  const reviewsOrRefuse = () => feature(features, "reviews");

  return [
    on(routes.start, { role: "person", action: "start a review" }, async (params, r) => {
      const body = parse(reviewSchema, await r.body({}));
      const t = thread(params.thread);
      if (body.land) demand(r.roles, landing, r.caller);
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
