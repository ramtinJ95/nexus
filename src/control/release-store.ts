import { json, jsonOrNull, type Db, type Holding } from "./db.ts";
import type { EventKind } from "./events.ts";
import type { NodeName } from "../ids.ts";
import type { DesiredRelease, Drain, ReleaseReport } from "../protocol/deploy.ts";
import type { ReleaseInventory } from "../deploy/release-cleanup.ts";

export const holding = { tables: { release_reports: {} }, settings: ["release", "deploy-drain", "releases:"] } as const satisfies Holding;

export function releaseStore(db: Db, appendEvent: (kind: EventKind, thread: null, payload: Record<string, unknown>) => unknown) {
  const { sql } = db;
  const { setting, setSetting } = db.hold(holding);
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
    /** What the node's deployer last read of its releases, or null for a node whose deployer never said. */
    releaseInventory: (node: NodeName): ReleaseInventory | null => jsonOrNull<ReleaseInventory>(setting(`releases:${node}`)),
    saveReleaseInventory(node: NodeName, inventory: ReleaseInventory) { setSetting(`releases:${node}`, JSON.stringify(inventory)); },
    drain: (): Drain | null => jsonOrNull<Drain>(setting("deploy-drain")),
    /** Null is stored as the JSON text null, which reads back as null. */
    setDrain(drain: Drain | null) { setSetting("deploy-drain", JSON.stringify(drain)); },
  };
}
