import { feature, type Features } from "../features.ts";
import { usageFilter } from "../usage.ts";
import { ok, on, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, type Policy } from "./access.ts";
import { usageRoutes as routes } from "../../contract/reports.ts";

/** The backfill wakes archived threads' pylons, so starting or stopping it takes the same right as `nexus deploy`. */
const steer = { role: "deployer", action: "start or stop the usage backfill" } satisfies Policy;

export function usageRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { registry } = kit;

  const usageBackfill = () => feature(features, "usageBackfill");

  return [
    on(routes.report, anyAllowed, (_, r) => ok(registry.usageReport(usageFilter(r.query, Date.now())))),
    on(routes.backfill, anyAllowed, () => ok({ backfill: usageBackfill().status(), plan: usageBackfill().plan() })),
    on(routes.startBackfill, steer, () => ok(usageBackfill().start())),
    on(routes.stopBackfill, steer, () => ok(usageBackfill().stop())),
  ];
}
