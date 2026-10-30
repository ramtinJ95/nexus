/**
 * The release store: the desired release and the deploy drain, in the `release` and `deploy-drain` settings, and each
 * node's release report, in `release_reports`.
 */
import { json, jsonOrNull, type Db } from "./db.ts";
import type { EventKind } from "../events.ts";
import type { DesiredRelease, Drain, ReleaseReport } from "../deploy/model.ts";

export type ReleaseStore = ReturnType<typeof releaseStore>;

export function releaseStore(db: Db, appendEvent: (kind: EventKind, thread: null, payload: Record<string, unknown>) => unknown) {
  const { sql, setting, setSetting } = db;
  return {
    desiredRelease: (): DesiredRelease | null => jsonOrNull<DesiredRelease>(setting("release")),
    setDesiredRelease(release: DesiredRelease) {
      appendEvent("release.changed", null, { desired: release });
      setSetting("release", JSON.stringify(release));
    },
    releaseReports(): ReleaseReport[] {
      return sql("SELECT record FROM release_reports ORDER BY node, role").all().map((r) => JSON.parse(r.record as string) as ReleaseReport);
    },
    reportRelease(report: ReleaseReport) {
      const previous = sql("SELECT record FROM release_reports WHERE node = ? AND role = ?").get(report.node, report.role);
      const { observedAt: _, ...state } = report;
      const before = previous === undefined ? null : json<ReleaseReport>(previous.record);
      if (before === null || before.state !== report.state || before.commit !== report.commit || before.target !== report.target || before.reason !== report.reason) appendEvent("release.changed", null, state);
      sql("INSERT INTO release_reports VALUES (?, ?, ?) ON CONFLICT(node, role) DO UPDATE SET record = excluded.record").run(report.node, report.role, JSON.stringify(report));
    },
    drain: (): Drain | null => jsonOrNull<Drain>(setting("deploy-drain")),
    /** Null is stored as the JSON text null, which reads back as null. */
    setDrain(drain: Drain | null) { setSetting("deploy-drain", JSON.stringify(drain)); },
  };
}
