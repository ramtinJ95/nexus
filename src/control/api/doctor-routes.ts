import { HttpError } from "../http-error.ts";
import { healthView, type DoctorReport } from "../doctor-model.ts";
import { noContent, ok, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed } from "./access.ts";
import { doctorRoutes as routes } from "../../contract/reports.ts";
import { checksSeenSchema } from "../../contract/reports-parse.ts";

export function doctorRoutes(kit: ApiKit, options: { doctor?: (() => Promise<DoctorReport>) | undefined; health?: (() => DoctorReport | null) | undefined }): readonly RouteEntry[] {
  const { registry } = kit;
  return [
    on(routes.doctor, anyAllowed, async () => {
      if (options.doctor === undefined) throw new HttpError(409, "this control plane runs no doctor");
      return ok(await options.doctor());
    }),
    on(routes.checks, anyAllowed, () => ok(healthView(options.health?.() ?? null, registry.healthStates()))),
    on(routes.changes, anyAllowed, () => ok(registry.healthChanges())),
    on(routes.seen, { role: "allowed", why: "what the person has seen changes no check" }, async (_, r) => {
      const { through } = parse(checksSeenSchema, await r.body({}));
      registry.markHealthSeen(through, Date.now());
      return noContent;
    }),
  ];
}
