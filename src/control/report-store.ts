/** The report store: each daily report of `nexus doctor`'s checks, in `doctor_reports`. */
import { json, type Db } from "./db.ts";
import type { DoctorReport, StoredReport } from "./doctor-model.ts";

const reportRow = (r: Record<string, unknown>): StoredReport => ({ id: r.id as number, ...json<DoctorReport>(r.record) });

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
    reports: (): StoredReport[] => sql("SELECT id, record FROM doctor_reports ORDER BY at DESC, id DESC").all().map(reportRow),
    latestReport(): StoredReport | null {
      const row = sql("SELECT id, record FROM doctor_reports ORDER BY at DESC, id DESC LIMIT 1").get();
      return row === undefined ? null : reportRow(row);
    },
    report(id: number): StoredReport | null {
      const row = sql("SELECT id, record FROM doctor_reports WHERE id = ?").get(id);
      return row === undefined ? null : reportRow(row);
    },
  };
}
