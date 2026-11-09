import { HttpError } from "../http-error.ts";
import { itemView } from "../pipeline.ts";
import { feature, type Features } from "../features.ts";
import type { ItemId } from "../../ids.ts";
import { ok, created, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed } from "./access.ts";
import { itemRoutes as routes } from "../../contract/projects.ts";
import { itemSchema } from "../../contract/projects-parse.ts";

export function pipelineRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { registry } = kit;

  const pipelineOrRefuse = () => feature(features, "pipeline");

  function item(id: string) {
    const record = registry.pipeline.item(id as ItemId);
    if (record === undefined) throw new HttpError(404, `no item ${id}`);
    return itemView(registry, record, Date.now());
  }

  return [
    on(routes.list, anyAllowed, (_, { query: { project, cancelled } }) => {
      const items = registry.pipeline.items().filter((i) => project === undefined || i.project === project).map((i) => itemView(registry, i, Date.now()));
      return ok(cancelled === false ? items.filter((i) => i.phase.kind !== "cancelled") : items);
    }),
    on(routes.add, { role: "person", action: "add an item" }, async (_, r) => {
      const { after, message, ...request } = parse(itemSchema, await r.body());
      const pipeline = pipelineOrRefuse();
      const added = pipeline.add(request, message ?? null, after ?? [], r.caller);
      await pipeline.poll();
      return created(itemView(registry, added, Date.now()));
    }),
    on(routes.show, anyAllowed, ({ item: id }) => ok(item(id))),
    on(routes.cancel, { role: "person", action: "cancel an item" }, ({ item: id }, r) => ok(itemView(registry, pipelineOrRefuse().cancel(id, r.caller), Date.now()))),
    on(routes.approve, { role: "person", action: "approve an item" }, async ({ item: id }, r) => {
      const pipeline = pipelineOrRefuse();
      const approved = pipeline.approve(id, r.caller);
      await pipeline.poll();
      return ok(itemView(registry, approved, Date.now()));
    }),
  ];
}
