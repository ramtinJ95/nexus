/**
 * Where `nexus doctor`'s facts come from, and the daily report. The checks in src/control/doctor.ts are pure; this reads
 * the registry, the backup unit's status file, the harness's login and the certificate the dashboard serves.
 */
import { connect } from "node:tls";
import type { TailnetNodeId } from "../ids.ts";
import type { LoginState } from "../harness/credentials.ts";
import { singleFlight } from "../single-flight.ts";
import type { BackupStatusRead } from "./backup-status.ts";
import { doctorReport, type CertificateFact } from "./doctor.ts";
import type { DoctorReport, StoredReport } from "./doctor-model.ts";
import { nodeSummary } from "./api/node-routes.ts";
import { releaseView } from "./releases.ts";
import type { Registry } from "./registry.ts";

export interface DoctorSources {
  registry: Pick<Registry, "nodes" | "pylonsWithStatusOn" | "pylonsWithThreadsOn" | "reserved" | "desiredRelease" | "nodeByTailnetId" | "releaseReports">;
  self: TailnetNodeId;
  backupStatus(): Promise<BackupStatusRead>;
  login(): Promise<LoginState>;
  certificate(): Promise<CertificateFact>;
  clock?: () => number;
}

export async function runDoctor(s: DoctorSources): Promise<DoctorReport> {
  const [backup, login, certificate] = await Promise.all([s.backupStatus(), s.login(), s.certificate()]);
  const now = (s.clock ?? Date.now)();
  return doctorReport({
    now,
    nodes: s.registry.nodes().map((record) => nodeSummary(s.registry, record)),
    release: releaseView(s.registry, s.self, now),
    controlNode: s.registry.nodeByTailnetId(s.self)?.name ?? null,
    backup, login, certificate,
  });
}

/** The certificate a browser gets from the dashboard's port, read over TLS without trusting it, so an expired one is still read. */
export function servedCertificate(host: string, port: number, hostname: string, timeoutMs = 10_000): Promise<CertificateFact> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs });
    const done = (fact: CertificateFact) => {
      socket.destroy();
      resolve(fact);
    };
    socket.once("secureConnect", () => {
      const leaf = socket.getPeerX509Certificate();
      if (leaf === undefined) return done({ kind: "unreachable", hostname, error: "it sent no certificate" });
      done({ kind: "served", hostname, validTo: new Date(leaf.validTo).toISOString(), forHostname: leaf.checkHost(hostname) !== undefined });
    });
    socket.once("timeout", () => done({ kind: "unreachable", hostname, error: `no TLS answer within ${timeoutMs} ms` }));
    socket.once("error", (err) => done({ kind: "unreachable", hostname, error: err.message }));
  });
}

export const reportEveryMs = 24 * 60 * 60_000;
export const reportsKeptMs = 30 * 24 * 60 * 60_000;
/** After a restart the loop reconnects to every probe before the first report, so a report never finds nodes not yet followed. */
const settleMs = 5 * 60_000;

/**
 * Runs the checks once a day and stores the report, keeping 30 days of them. Each poll runs them only when the newest
 * report is a day old, so a restart neither skips a day nor runs twice.
 */
export function dailyReports(options: { registry: Pick<Registry, "latestReport" | "saveReport">; run(): Promise<DoctorReport>; startedAt: number; clock?: () => number; log?: (message: string) => void }) {
  const { registry, run, startedAt, clock = Date.now, log = (message: string) => console.error(message) } = options;
  async function pass() {
    const now = clock();
    const latest = registry.latestReport();
    if (now - startedAt < settleMs || (latest !== null && now - Date.parse(latest.at) < reportEveryMs)) return;
    let report: StoredReport;
    try {
      report = registry.saveReport(await run(), now - reportsKeptMs);
    } catch (err) {
      log(`the daily report failed: ${(err as Error).message}`);
      return;
    }
    if (report.status !== "ok") log(`the daily report ${report.id} found a problem: ${report.checks.filter((c) => c.status !== "ok").map((c) => `${c.node ?? "control plane"} ${c.name} ${c.status}`).join(", ")}`);
  }
  const passes = singleFlight(pass);
  return { poll: passes.join, close: passes.settled };
}
