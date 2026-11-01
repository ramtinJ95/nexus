/** The report store: each daily report of `nexus doctor`'s checks, in `doctor_reports`. */
import { json, type Db } from "./db.ts";
import type { DoctorReport, StoredReport } from "./doctor-model.ts";

/** Null for a row whose record does not parse, which every reader passes over rather than fail on. */
function reportRow(r: Record<string, unknown>): StoredReport | null {
  try {
    const record = json<DoctorReport>(r.record);
    return typeof record?.at === "string" && !Number.isNaN(Date.parse(record.at)) && Array.isArray(record.checks) ? { id: r.id as number, ...record } : null;
  } catch {
    return null;
  }
}
const rows = (found: Record<string, unknown>[]) => found.flatMap((r) => reportRow(r) ?? []);

export function reportStore(db: Db) {
  const { sql } = db;
  return {
    /** Stores the report and drops every report from before `keepSince`, in ms. */
    saveReport(report: DoctorReport, keepSince: number): StoredReport {
      return db.transaction(() => {
        const { id } = sql("INSERT INTO doctor_reports (at, record) VALUES (?, ?) RETURNING id").get(Date.parse(report.at), JSON.stringify(report))!;
        sql("DELETE FROM doctor_reports WHERE at < ?").run(keepSince);
        return { id: id as number, ...report };
      });
    },
    /** Newest first. */
    reports: (): StoredReport[] => rows(sql("SELECT id, record FROM doctor_reports ORDER BY at DESC, id DESC").all()),
    /** The newest report that parses. */
    latestReport: (): StoredReport | null => rows(sql("SELECT id, record FROM doctor_reports ORDER BY at DESC, id DESC").all())[0] ?? null,
    report(id: number): StoredReport | null {
      const row = sql("SELECT id, record FROM doctor_reports WHERE id = ?").get(id);
      return row === undefined ? null : reportRow(row);
    },
  };
}
