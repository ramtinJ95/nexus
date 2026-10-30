/**
 * The usage report, and the backfill a deployer starts and stops.
 */
import type { TailnetNodeId } from "../../ids.ts";
import type { UsageBackfillJob } from "../usage-backfill.ts";
import { HttpError } from "../http-error.ts";
import { canDeploy, type DeploymentOptions } from "../releases.ts";
import { usageFilter } from "../usage.ts";
import { ok, type RouteEntry, type ApiKit } from "./kit.ts";

export function usageRoutes(kit: ApiKit, options: { usageBackfill?: UsageBackfillJob | undefined; deployment?: DeploymentOptions | undefined }): readonly RouteEntry[] {
  const { registry } = kit;

  function usageBackfill(): UsageBackfillJob {
    if (options.usageBackfill === undefined) throw new HttpError(409, "the usage backfill is not configured");
    return options.usageBackfill;
  }
  /** The backfill wakes archived threads' pylons, so starting or stopping it takes the same right as `nexus deploy`. */
  function steerUsageBackfill(caller: TailnetNodeId): UsageBackfillJob {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not start or stop the usage backfill: only deployers may, never infrastructure nodes or pylons");
    return usageBackfill();
  }

  return [
    ["GET", /^\/v1\/usage$/, (_, r) => ok(registry.usageReport(usageFilter(r.query, Date.now())))],
    ["GET", /^\/v1\/usage\/backfill$/, () => ok({ backfill: usageBackfill().status(), plan: usageBackfill().plan() })],
    ["POST", /^\/v1\/usage\/backfill$/, { open: "deployers only, which steerUsageBackfill checks" }, (_, r) => ok(steerUsageBackfill(r.caller).start())],
    ["DELETE", /^\/v1\/usage\/backfill$/, { open: "deployers only, which steerUsageBackfill checks" }, (_, r) => ok(steerUsageBackfill(r.caller).stop())],
  ];
}
