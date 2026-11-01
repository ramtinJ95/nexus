/**
 * Where `nexus doctor`'s facts come from, and the passes that turn its checks into health alerts. The checks in
 * src/control/doctor.ts are pure; this reads the registry, the backup unit's status file, the harness's login and the
 * certificate the dashboard serves.
 */
import { connect } from "node:tls";
import type { TailnetNodeId } from "../ids.ts";
import type { LoginState } from "../harness/credentials.ts";
import { singleFlight } from "../single-flight.ts";
import type { BackupStatusRead } from "./backup-status.ts";
import { doctorReport, type CertificateFact } from "./doctor.ts";
import { checkKey, statuses, type Check, type DoctorReport, type HealthChange } from "./doctor-model.ts";
import { nodeSummary } from "./api/node-routes.ts";
import { releaseView } from "./releases.ts";
import type { Registry } from "./registry.ts";
import type { NewHealthChange } from "./report-store.ts";

export interface DoctorSources {
  registry: Pick<Registry, "nodes" | "pylonsWithStatusOn" | "pylonsWithThreadsOn" | "reserved" | "desiredRelease" | "nodeByTailnetId" | "releaseReports">;
  self: TailnetNodeId;
  backupStatus(): Promise<BackupStatusRead>;
  login(): Promise<LoginState>;
  certificate(): Promise<CertificateFact>;
  startedAt: number;
  clock?: () => number;
}

/** An error's code, such as pi-ai's `auth` or Node's `EACCES`, and never its message, which a change keeps 30 days. */
const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[\w-]{1,40}$/.test(code) ? code : err instanceof Error ? err.name : "unknown";
};

/** Each source that throws fails only its own check, so the others still report. */
export async function runDoctor(s: DoctorSources): Promise<DoctorReport> {
  const [backup, login, certificate] = await Promise.all([
    s.backupStatus().catch((err: unknown) => ({ unreadable: `${codeOf(err)} reading it` })),
    s.login().catch((err: unknown) => ({ unreadable: codeOf(err) })),
    s.certificate().catch((err: unknown): CertificateFact => ({ kind: "unreachable", hostname: "the dashboard", error: `${codeOf(err)} reading it` })),
  ]);
  const now = (s.clock ?? Date.now)();
  return doctorReport({
    now, upSince: s.startedAt,
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
      try {
        const leaf = socket.getPeerX509Certificate();
        if (leaf === undefined) return done({ kind: "unreachable", hostname, error: "it sent no certificate" });
        done({ kind: "served", hostname, validTo: validTo(leaf.validTo), forHostname: leaf.checkHost(hostname) !== undefined });
      } catch (err) {
        done({ kind: "unreachable", hostname, error: `its certificate does not read: ${(err as Error).message}` });
      }
    });
    socket.once("timeout", () => done({ kind: "unreachable", hostname, error: `no TLS answer within ${timeoutMs} ms` }));
    socket.once("error", (err) => done({ kind: "unreachable", hostname, error: err.message }));
  });
}

function validTo(text: string): string {
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`its expiry ${JSON.stringify(text)} is no date`);
  return new Date(at).toISOString();
}

export const checkEveryMs = 5 * 60_000;
export const changesKeptMs = 30 * 24 * 60 * 60_000;
/** After a restart the loop reconnects to every probe before the first pass, so a pass never finds nodes not yet followed. */
const settleMs = 5 * 60_000;

const rank = (c: Pick<Check, "status">) => statuses.indexOf(c.status);

/**
 * The changes a pass confirms. A check's status is the better of its last two passes, so it goes bad only on its
 * second bad pass in a row, and gets better on its first better pass. Before a start's first pass, the status
 * recorded stands for the pass before. A check that went bad and is no longer run, as a removed node's, recovers.
 */
export function confirmedChanges(recorded: readonly HealthChange[], previous: ReadonlyMap<string, Check> | null, report: DoctorReport): NewHealthChange[] {
  const states = new Map(recorded.map((c) => [checkKey(c), c]));
  const run = new Set(report.checks.map(checkKey));
  const changes: NewHealthChange[] = [];
  for (const check of report.checks) {
    const key = checkKey(check);
    const from = states.get(key)?.status ?? "ok";
    const prior = (previous === null ? states.get(key) : previous.get(key)) ?? { ...check, status: "ok" };
    const confirmed = rank(prior) < rank(check) ? prior : check;
    if (confirmed.status !== from) changes.push({ ...check, status: confirmed.status, text: confirmed.text, from, at: report.at });
  }
  for (const [key, state] of states) {
    if (!run.has(key) && state.status !== "ok") changes.push({ node: state.node, name: state.name, status: "ok", text: "no longer checked", from: state.status, at: report.at } as NewHealthChange);
  }
  return changes;
}

/**
 * Runs the checks every 5 minutes once the control plane has settled, and records each change they confirm, keeping 30
 * days of changes. It holds the latest pass, which the Health page shows.
 */
export function healthPasses(options: { registry: Pick<Registry, "healthStates" | "recordHealthChanges">; run(): Promise<DoctorReport>; startedAt: number; clock?: () => number; log?: (message: string) => void }) {
  const { registry, run, startedAt, clock = Date.now, log = (message: string) => console.error(message) } = options;
  let latest: DoctorReport | null = null;
  let previous: Map<string, Check> | null = null;
  // Every poll is fired and forgotten, so nothing may escape it: a rejection would end the control plane.
  async function pass() {
    try {
      if (clock() - startedAt < settleMs) return;
      const report = await run();
      const changes = registry.recordHealthChanges(confirmedChanges(registry.healthStates(), previous, report), clock() - changesKeptMs);
      previous = new Map(report.checks.map((c) => [checkKey(c), c]));
      latest = report;
      for (const c of changes) log(`the ${c.node ?? "control plane"} ${c.name} check went from ${c.from} to ${c.status}: ${c.text}`);
    } catch (err) {
      log(`a health pass failed: ${(err as Error).message}`);
    }
  }
  const passes = singleFlight(pass);
  return { poll: passes.join, close: passes.settled, latest: () => latest };
}
