/**
 * `nexus doctor`'s checks, run now, and the daily reports the control plane keeps 30 days.
 */
import { HttpError } from "../http-error.ts";
import { summary, type DoctorReport } from "../doctor-model.ts";
import { ok, type RouteEntry, type ApiKit } from "./kit.ts";

export function doctorRoutes(kit: ApiKit, options: { doctor?: (() => Promise<DoctorReport>) | undefined }): readonly RouteEntry[] {
  const { registry } = kit;
  return [
    ["GET", /^\/v1\/doctor$/, async () => {
      if (options.doctor === undefined) throw new HttpError(409, "this control plane runs no doctor");
      return ok(await options.doctor());
    }],
    ["GET", /^\/v1\/reports$/, () => ok(registry.reports().map(summary))],
    ["GET", /^\/v1\/reports\/([^/]+)$/, ([, id]) => {
      const report = id === "latest" ? registry.latestReport() : /^\d+$/.test(id!) ? registry.report(Number(id)) : null;
      if (report === null) throw new HttpError(404, id === "latest" ? "no daily report yet" : `no report ${id}`);
      return ok(report);
    }],
  ];
}
