/**
 * `nexus doctor`'s checks, which the daily report runs too: pure functions over the facts the control plane already
 * holds, gathered by src/control/doctor-run.ts. Each gives ok, warn or fail with one line that says what is wrong and
 * what to do.
 */
import type { NodeName } from "../ids.ts";
import { diskText, keptFreeGiB, lowDisk } from "../disk-space.ts";
import { countedCapacity } from "../protocol/observations.ts";
import type { ReleaseReport, ReleaseView } from "../deploy/model.ts";
import type { LoginState } from "../harness/credentials.ts";
import type { BackupStatusRead } from "./backup-status.ts";
import type { NodeSummary } from "./wire.ts";
import { worst, type Check, type ControlCheckName, type DoctorReport, type NodeCheckName, type Verdict } from "./doctor-model.ts";

/** The dashboard's certificate as a TLS client sees it on the dashboard's port, or `none` without control.json's https. */
export type CertificateFact =
  | { kind: "none" }
  | { kind: "unreachable"; hostname: string; error: string }
  | { kind: "served"; hostname: string; validTo: string; forHostname: boolean };

export interface DoctorFacts {
  now: number;
  nodes: readonly NodeSummary[];
  release: ReleaseView;
  /** The node the control plane runs on, which alone reports the control role. Null when no node is it. */
  controlNode: NodeName | null;
  backup: BackupStatusRead;
  login: LoginState;
  certificate: CertificateFact;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** A probe sends a snapshot every minute, and the loop reconnects a link silent for 90 s. */
export const staleObservationMs = 5 * minute;
/** A day between runs and the timer's random hour, with an hour to spare. */
export const backupMaxAgeMs = 26 * hour;
/** The API asks tailscaled for a certificate valid a week and reloads it every 12 hours, so less than this left means renewal fails. */
export const certificateWarnMs = 6 * day;
export const certificateFailMs = 2 * day;

const span = (ms: number) => ms < hour ? `${Math.max(1, Math.round(ms / minute))} min` : ms < 2 * day ? `${Math.round(ms / hour)} h` : `${Math.round(ms / day)} days`;
const ok = (text: string): Verdict => ({ status: "ok", text });
const warn = (text: string): Verdict => ({ status: "warn", text });
const fail = (text: string): Verdict => ({ status: "fail", text });

function online(n: NodeSummary, f: DoctorFacts): Verdict {
  if (n.observedAt === null) return fail("never observed. Check that nexus-probe runs on it and that this machine reaches it over the tailnet");
  const age = f.now - Date.parse(n.observedAt);
  if (n.state === "offline") return fail(`offline, last observed ${span(age)} ago. Check nexus-probe on it and its tailnet connection`);
  if (age > staleObservationMs) return warn(`online, but last observed ${span(age)} ago. Its probe sends a snapshot every minute, so check journalctl -u nexus-probe on it`);
  return ok("online and observed in the last 5 min");
}

function release(report: ReleaseReport | undefined, desired: ReleaseView["desired"]): Verdict {
  if (report === undefined) return warn("no node is the control plane's, so nothing reports its release");
  const where = `${report.role} on ${report.node}`;
  const reason = report.reason === null ? "" : `: ${report.reason}`;
  const commit = report.commit?.slice(0, 12) ?? "an unknown commit";
  if (report.state === "failed" || report.state === "rolled-back") return fail(`${where} ${report.state} toward ${report.target?.slice(0, 12) ?? "the desired release"}${reason}. journalctl -u nexus-deployer on ${report.node} says why`);
  if (desired === null) return ok(`${where} runs ${commit}, and no release is desired`);
  if (report.state === "healthy" && report.commit === desired.commit) return ok(`${where} runs the desired ${commit} and is healthy`);
  return warn(`${where} runs ${commit} and is ${report.state} toward ${desired.commit.slice(0, 12)}${reason}. nexus release shows where it is, and a deployer that stopped reporting needs nexus-deployer.timer on ${report.node}`);
}

function disk(n: NodeSummary): Verdict {
  const disks = countedCapacity(n.capacity)?.disks;
  if (disks === undefined) return warn(n.capacity === null ? "no filesystems reported, since the node was never observed" : "its probe is older than the filesystems it reports, so update it with nexus deploy");
  const short = disks.filter((d) => d.pylons === true && d.freeGiB < keptFreeGiB(d.totalGiB));
  if (short.length > 0) return fail(`${short.map(diskText).join("; ")}, under the ${keptFreeGiB(short[0]!.totalGiB).toFixed(1)} GiB it keeps free, so it refuses every start and wake. Delete archived threads or free space there`);
  const low = disks.filter(lowDisk);
  if (low.length > 0) return warn(`${low.map(diskText).join("; ")}. Free space there, or delete archived threads`);
  return ok(`${disks.length} ${disks.length === 1 ? "filesystem" : "filesystems"}, none under 10% or 20 GiB free`);
}

function pylons(n: NodeSummary): Verdict {
  const p = n.pylons;
  const problems = [
    ...p === null || p.crashed.pylons === 0 ? [] : [`${p.crashed.pylons} crashed ${p.crashed.pylons === 1 ? "pylon" : "pylons"}, whose threads nexus show explains`],
    ...p === null || p.orphaned.length === 0 ? [] : [`${p.orphaned.length} orphaned (${p.orphaned.join(", ")}), which the registry does not know and nothing deletes`],
    ...n.overcommitted ? ["overcommitted, its running pylons holding more CPUs or memory than it has, so pause or archive threads on it"] : [],
  ];
  if (problems.length > 0) return warn(problems.join("; "));
  return ok(p === null ? "no pylons observed yet" : `${p.up.pylons} up, ${p.paused.pylons} paused, none crashed or orphaned`);
}

function backup(f: DoctorFacts): Verdict {
  const s = f.backup;
  const look = "sudo systemctl status nexus-backup and journalctl -u nexus-backup on the control plane's machine say why";
  if (s === "missing") return fail(`no backup has run on this machine. Start one with sudo systemctl start nexus-backup, and enable nexus-backup.timer`);
  if ("unreadable" in s) return fail(`the backup's status is unreadable: ${s.unreadable}`);
  if (s.newest === null) return fail(`no complete backup exists. ${look}`);
  if (!s.newest.verified || s.newest.createdAt === null) return fail(`the newest backup, ${s.newest.name}, does not verify. sudo node /opt/nexus/control-current/src/control/backup.ts check says why`);
  const age = f.now - Date.parse(s.newest.createdAt);
  const lastRun = s.succeeded ? "" : `, and the run at ${s.ranAt} failed`;
  if (age > backupMaxAgeMs) return fail(`the newest backup, ${s.newest.name}, is ${span(age)} old${lastRun}. ${look}`);
  if (!s.succeeded) return warn(`the run at ${s.ranAt} failed, so the newest backup is ${s.newest.name}, ${span(age)} old. ${look}`);
  return ok(`the newest backup, ${s.newest.name}, is ${span(age)} old and verified`);
}

function login(f: DoctorFacts): Verdict {
  const { provider, modelId, credential, offered, refresh } = f.login;
  const signIn = "Stop the control plane and sign it in with node src/control/login.ts as nexus-control";
  if (offered === null) return fail(`harness.model names provider ${provider}, which the harness does not have. Fix control.json`);
  if (credential === null || offered.length === 0) return fail(`the harness is not signed in to ${provider}, so every thread fails at its first turn. ${signIn}`);
  if (!refresh.ok) return fail(`the harness's ${provider} login no longer resolves, with pi-ai's ${refresh.code} error. ${signIn}`);
  if (!offered.includes(modelId)) return fail(`the harness's ${provider} login does not offer harness.model ${modelId}. Name one of ${offered.toSorted().join(", ")} in control.json`);
  return ok(credential === "oauth" ? `signed in to ${provider} with ChatGPT, which offers ${modelId}` : `an API key for ${provider}, which Nexus cannot check without calling a model`);
}

function certificate(f: DoctorFacts): Verdict {
  const c = f.certificate;
  if (c.kind === "none") return ok("control.json sets no https, so the dashboard serves no certificate");
  const look = "journalctl -u nexus-control says why tailscaled's renewal failed";
  if (c.kind === "unreachable") return fail(`the dashboard's HTTPS on ${c.hostname} does not answer: ${c.error}. ${look}`);
  if (!c.forHostname) return fail(`the dashboard's certificate is not for ${c.hostname}. Check https.hostname in control.json`);
  const left = Date.parse(c.validTo) - f.now;
  if (left <= 0) return fail(`the dashboard's certificate for ${c.hostname} expired at ${c.validTo}. ${look}`);
  if (left < certificateFailMs) return fail(`the dashboard's certificate for ${c.hostname} expires in ${span(left)}. ${look}`);
  if (left < certificateWarnMs) return warn(`the dashboard's certificate for ${c.hostname} expires in ${span(left)}, so its renewal is failing. ${look}`);
  return ok(`the dashboard's certificate for ${c.hostname} is valid for ${span(left)}`);
}

const nodeChecks: Readonly<Record<NodeCheckName, (n: NodeSummary, f: DoctorFacts) => Verdict>> = {
  online,
  release: (n, f) => release(f.release.nodes.find((r) => r.node === n.name && r.role === "probe"), f.release.desired),
  disk,
  pylons,
};
const controlChecks: Readonly<Record<ControlCheckName, (f: DoctorFacts) => Verdict>> = {
  release: (f) => release(f.release.nodes.find((r) => r.node === f.controlNode && r.role === "control"), f.release.desired),
  backup,
  login,
  certificate,
};

/** Every check, the control plane's first and then each node's. */
export function doctorReport(f: DoctorFacts): DoctorReport {
  const checks: Check[] = [
    ...Object.entries(controlChecks).map(([name, check]) => ({ node: null, name: name as ControlCheckName, ...check(f) })),
    ...f.nodes.flatMap((n) => Object.entries(nodeChecks).map(([name, check]) => ({ node: n.name, name: name as NodeCheckName, ...check(n, f) }))),
  ];
  return { at: new Date(f.now).toISOString(), status: worst(checks), checks };
}
