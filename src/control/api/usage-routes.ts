/**
 * The usage report, and the backfill a deployer starts and stops.
 */
import type { UsageBackfillJob } from "../usage-backfill.ts";
import { HttpError } from "../http-error.ts";
import { usageFilter } from "../usage.ts";
import { ok, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, type Policy } from "./access.ts";

/** The backfill wakes archived threads' pylons, so starting or stopping it takes the same right as `nexus deploy`. */
const steer: Policy = { role: "deployer", action: "start or stop the usage backfill" };

export function usageRoutes(kit: ApiKit, options: { usageBackfill?: UsageBackfillJob | undefined }): readonly RouteEntry[] {
  const { registry } = kit;

  function usageBackfill(): UsageBackfillJob {
    if (options.usageBackfill === undefined) throw new HttpError(409, "the usage backfill is not configured");
    return options.usageBackfill;
  }

  return [
    ["GET", /^\/v1\/usage$/, anyAllowed, (_, r) => ok(registry.usageReport(usageFilter(r.query, Date.now())))],
    ["GET", /^\/v1\/usage\/backfill$/, anyAllowed, () => ok({ backfill: usageBackfill().status(), plan: usageBackfill().plan() })],
    ["POST", /^\/v1\/usage\/backfill$/, steer, () => ok(usageBackfill().start())],
    ["DELETE", /^\/v1\/usage\/backfill$/, steer, () => ok(usageBackfill().stop())],
  ];
}
