/**
 * `nexus doctor`'s checks, run now, and the health the control plane's passes keep: the latest pass, each problem
 * open, and the changes of the last 30 days.
 */
import { z } from "zod";
import { HttpError } from "../http-error.ts";
import { healthView, type DoctorReport } from "../doctor-model.ts";
import { noContent, ok, parse, type RouteEntry, type ApiKit } from "./kit.ts";

const seenSchema = z.strictObject({ through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });

export function doctorRoutes(kit: ApiKit, options: { doctor?: (() => Promise<DoctorReport>) | undefined; health?: (() => DoctorReport | null) | undefined }): readonly RouteEntry[] {
  const { registry } = kit;
  return [
    ["GET", /^\/v1\/doctor$/, async () => {
      if (options.doctor === undefined) throw new HttpError(409, "this control plane runs no doctor");
      return ok(await options.doctor());
    }],
    ["GET", /^\/v1\/checks$/, () => ok(healthView(options.health?.() ?? null, registry.healthStates()))],
    ["GET", /^\/v1\/checks\/changes$/, () => ok(registry.healthChanges())],
    ["POST", /^\/v1\/checks\/seen$/, { open: "what the person has seen changes no check" }, async (_, r) => {
      const { through } = parse(seenSchema, await r.body({}));
      registry.markHealthSeen(through, Date.now());
      return noContent;
    }],
  ];
}
