/**
 * The pipeline's items, which a person adds, approves and cancels.
 */
import { HttpError } from "../http-error.ts";
import { itemView, type Pipeline } from "../pipeline.ts";
import type { ItemId } from "../../ids.ts";
import { ok, created, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed } from "./access.ts";
import { itemRoutes as routes } from "../../contract/projects.ts";
import { itemSchema } from "../../contract/projects-parse.ts";

export function pipelineRoutes(kit: ApiKit, options: { pipeline?: Pipeline | null | undefined }): readonly RouteEntry[] {
  const { registry } = kit;

  function pipelineOrRefuse(): Pipeline {
    if (!options.pipeline) throw new HttpError(409, "pipeline items need the control plane's GitHub token (github.tokenFile), which is not configured");
    return options.pipeline;
  }

  function item(id: string) {
    const record = registry.item(id as ItemId);
    if (record === undefined) throw new HttpError(404, `no item ${id}`);
    return itemView(registry, record);
  }

  return [
    on(routes.list, anyAllowed, (_, { query: { project, cancelled } }) => {
      const items = registry.items().filter((i) => project === undefined || i.project === project).map((i) => itemView(registry, i));
      return ok(cancelled === false ? items.filter((i) => i.phase.kind !== "cancelled") : items);
    }),
    on(routes.add, { role: "person", action: "add an item" }, async (_, r) => {
      const { after, message, ...request } = parse(itemSchema, await r.body());
      const pipeline = pipelineOrRefuse();
      const added = pipeline.add(request, message ?? null, after ?? [], r.caller);
      await pipeline.poll();
      return created(itemView(registry, added));
    }),
    on(routes.show, anyAllowed, ({ item: id }) => ok(item(id))),
    on(routes.cancel, { role: "person", action: "cancel an item" }, ({ item: id }, r) => ok(itemView(registry, pipelineOrRefuse().cancel(id, r.caller)))),
    on(routes.approve, { role: "person", action: "approve an item" }, async ({ item: id }, r) => {
      const pipeline = pipelineOrRefuse();
      const approved = pipeline.approve(id, r.caller);
      await pipeline.poll();
      return ok(itemView(registry, approved));
    }),
  ];
}
