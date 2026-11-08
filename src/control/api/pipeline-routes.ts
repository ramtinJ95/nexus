/**
 * The pipeline's items, which a person adds, approves and cancels.
 */
import { z } from "zod";
import { HttpError } from "../http-error.ts";
import { itemView, type Pipeline } from "../pipeline.ts";
import type { ItemId } from "../../ids.ts";
import { ok, created, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed } from "./access.ts";
import { startSchema } from "../../contract/threads-parse.ts";

/** A pipeline item: what its queued thread starts with, after the items whose threads must merge first. */
const itemSchema = startSchema.omit({ after: true, requestId: true, planning: true }).extend({ after: z.array(z.string().min(1)).max(32).optional() });

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
    ["GET", /^\/v1\/items$/, anyAllowed, (_, r) => {
      const project = r.query.get("project");
      return ok(registry.items().filter((i) => project === null || i.project === project).map((i) => itemView(registry, i)));
    }],
    ["POST", /^\/v1\/items$/, { role: "person", action: "add an item" }, async (_, r) => {
      const { after, message, ...request } = parse(itemSchema, await r.body());
      const pipeline = pipelineOrRefuse();
      const added = pipeline.add(request, message ?? null, after ?? [], r.caller);
      await pipeline.poll();
      return created(itemView(registry, added));
    }],
    ["GET", /^\/v1\/items\/([^/]+)$/, anyAllowed, ([, id]) => ok(item(id!))],
    ["POST", /^\/v1\/items\/([^/]+)\/cancel$/, { role: "person", action: "cancel an item" }, ([, id], r) => {
      return ok(itemView(registry, pipelineOrRefuse().cancel(id!, r.caller)));
    }],
    ["POST", /^\/v1\/items\/([^/]+)\/approve$/, { role: "person", action: "approve an item" }, async ([, id], r) => {
      const pipeline = pipelineOrRefuse();
      const approved = pipeline.approve(id!, r.caller);
      await pipeline.poll();
      return ok(itemView(registry, approved));
    }],
  ];
}
