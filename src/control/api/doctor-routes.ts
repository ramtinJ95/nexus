import { feature, type Features } from "../features.ts";
import { healthView, type DoctorReport } from "../doctor-model.ts";
import { noContent, ok, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed } from "./access.ts";
import { doctorRoutes as routes } from "../../contract/reports.ts";
import { checksSeenSchema } from "../../contract/reports-parse.ts";

export function doctorRoutes(kit: ApiKit, options: { features: Features; health(): DoctorReport | null }): readonly RouteEntry[] {
  const { registry } = kit;
  return [
    on(routes.doctor, anyAllowed, async () => {
      return ok(await feature(options.features, "doctor")());
    }),
    on(routes.checks, anyAllowed, () => ok(healthView(options.health(), registry.healthStates()))),
    on(routes.changes, anyAllowed, () => ok(registry.healthChanges())),
    on(routes.seen, { role: "allowed", why: "what the person has seen changes no check" }, async (_, r) => {
      const { through } = parse(checksSeenSchema, await r.body({}));
      registry.markHealthSeen(through, Date.now());
      return noContent;
    }),
  ];
}
