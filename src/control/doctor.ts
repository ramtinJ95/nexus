/**
 * `nexus doctor`'s checks, which the health passes run too: pure functions over the facts the control plane already
 * holds, gathered by src/control/doctor-run.ts. Each gives ok, warn or fail with one line that says what is wrong and
 * what to do.
 */
import type { ImageId, NodeName, ProjectId, ThreadId } from "../ids.ts";
import { diskText, keptFreeGiB, lowDisk } from "../disk-space.ts";
import { keptPastDay, settleFailuresFail, settleOverdueMs, type ActivityFacts, type ArchiveFacts } from "./reconcile.ts";
import type { ReleaseReport, ReleaseView } from "../protocol/deploy.ts";
import type { LoginState } from "./harness/credentials.ts";
import type { BackupStatusRead } from "./backup-status.ts";
import type { NodeSummary } from "./wire.ts";
import type { TokenAnswer } from "./github.ts";
import type { TailnetDevice } from "../tailscale.ts";
import { maxImageFetches, type ImageFetch } from "./image-store.ts";
import type { LoopLate } from "./loop-delay.ts";
import { worst, type Check, type ControlCheckName, type DoctorReport, type NodeCheckName, type Verdict } from "./doctor-model.ts";

/** The dashboard's certificate as a TLS client sees it on the dashboard's port, or `none` without control.json's https. */
export type CertificateFact =
  | { kind: "none" }
  | { kind: "unreachable"; hostname: string; error: string }
  | { kind: "served"; hostname: string; validTo: string; forHostname: boolean };

export interface DoctorFacts {
  now: number;
  /** When this control plane process started, which a deploy restarts. */
  upSince: number;
  nodes: readonly NodeSummary[];
  release: ReleaseView;
  /** The node the control plane runs on, which alone reports the control role. Null when no node is it. */
  controlNode: NodeName | null;
  /** How late the control plane's event loop ran in the slowest of its last minutes. */
  loop: LoopLate;
  backup: BackupStatusRead;
  /** `unreadable` holds the error's code, never its message, which can carry the login's own text. */
  login: LoginState | { unreadable: string };
  /** The projects whose pylons are granted the token of the harness's ChatGPT sign-in, which the control plane hands every probe. */
  tokenProjects: readonly ProjectId[];
  certificate: CertificateFact;
  /** What GitHub last said of the control plane's token, `none` when control.json names no github.tokenFile, or why GitHub gave no answer. */
  github: TokenAnswer | { kind: "none" } | { kind: "unread"; error: string };
  /** Every device tailscaled on the control plane's machine lists, itself among them, or why its status could not be read. */
  tailnet: readonly TailnetDevice[] | { unreadable: string };
  /** The archived threads whose disk may be kept for their usage, as the registry's keptArchives lists them, less those whose node has no disk for them. */
  keptArchives: readonly (ActivityFacts & ArchiveFacts & { id: ThreadId; title: string })[];
  /** Each open pull request no review will start for, in a project that reviews on its own (owed-review.ts), and why. */
  unreviewed: readonly { thread: ThreadId; title: string; pr: number; why: string }[];
  /** The current image, the nodes whose last observation lists it, online or not, and the fetches the image worker keeps of it. */
  image: { current: ImageId | null; holders: readonly NodeName[]; fetches: readonly ImageFetch[] };
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** A probe sends a snapshot every minute, and the loop reconnects a link silent for 90 s. */
export const staleObservationMs = 5 * minute;
/** A day between runs and the timer's random hour, with an hour to spare. */
export const backupMaxAgeMs = 26 * hour;
/**
 * How long a role may take to reach a desired release before its check warns: the deadline `nexus deploy --wait` and a
 * landing give a rollout outside a busy drain, its build and its health check, and
 * the probes after it.
 */
export const rolloutMs = 30 * minute;
/** The API asks tailscaled for a certificate valid a week and reloads it every 12 hours, so less than this left means renewal fails. */
export const certificateWarnMs = 6 * day;
export const certificateFailMs = 2 * day;
/**
 * How late the event loop may run at the 99th percentile of a minute before its check warns, and fails. A healthy
 * control plane runs a few milliseconds late. On 2026-11-15 it ran about 1.5 s late for hours before it stopped
 * answering, and 2 to 6 s late once it had.
 */
export const loopWarnMs = 500;
export const loopFailMs = 2_000;
/** A credential that expires sooner warns, so the person has two weeks to renew it. */
export const expiryWarnMs = 14 * day;

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

const late = (ms: number) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

function eventLoop(f: DoctorFacts): Verdict {
  const { slowest: l, minutes } = f.loop;
  const when = minutes === 0 ? `in the ${Math.max(1, Math.round(l.overMs / 1000))} s since it started` : minutes === 1 ? "in its last minute" : `in the slowest of its last ${minutes} minutes`;
  const found = `${when} the control plane ran what was due ${late(l.p99Ms)} late at the 99th percentile, ${late(l.maxMs)} at worst, and was at work ${Math.round(l.busy * 100)} % of the time`;
  if (l.p99Ms < loopWarnMs) return ok(found);
  // The share at work is a hint, not a proof: a process stopped in the middle of its work counts the stop as work.
  const look = "Every request and every probe's event waits that long. A loop at work most of that time is held by its own work, which a restart helps only until it returns. One at work little of it was more likely stopped, or its machine suspended or short of CPU. journalctl -u nexus-control on its machine shows what it logged";
  return (l.p99Ms < loopFailMs ? warn : fail)(`${found}. ${look}`);
}

function release(report: ReleaseReport | undefined, desired: ReleaseView["desired"], now: number): Verdict {
  if (report === undefined) return warn("no node is the control plane's, so nothing reports its release");
  const where = `${report.role} on ${report.node}`;
  const reason = report.reason === null ? "" : `: ${report.reason}`;
  const commit = report.commit?.slice(0, 12) ?? "an unknown commit";
  if (report.state === "failed" || report.state === "rolled-back") return fail(`${where} ${report.state} toward ${report.target?.slice(0, 12) ?? "the desired release"}${reason}. journalctl -u nexus-deployer on ${report.node} says why`);
  if (desired === null) return ok(`${where} runs ${commit}, and no release is desired`);
  if (report.state === "healthy" && report.commit === desired.commit) return ok(`${where} runs the desired ${commit} and is healthy`);
  const since = now - desired.requestedAt;
  if (since < rolloutMs) return ok(`${where} is ${report.state} toward ${desired.commit.slice(0, 12)}, requested ${span(since)} ago, which a rollout may take up to ${span(rolloutMs)}`);
  return warn(`${where} runs ${commit} and is ${report.state} toward ${desired.commit.slice(0, 12)}${reason}. nexus release shows where it is, and a deployer that stopped reporting needs nexus-deployer.timer on ${report.node}`);
}

function disk(n: NodeSummary): Verdict {
  const disks = n.capacity?.disks;
  if (disks === undefined) return warn(n.capacity === null ? "no filesystems reported, since the node was never observed" : "its probe is older than the filesystems it reports, so update it with nexus deploy");
  const short = disks.filter((d) => d.pylons === true && d.freeGiB < keptFreeGiB(d.totalGiB));
  if (short.length > 0) return fail(`${short.map(diskText).join("; ")}, under the ${keptFreeGiB(short[0]!.totalGiB).toFixed(1)} GiB it keeps free, so it refuses every start and wake. Delete archived threads or free space there`);
  const low = disks.filter(lowDisk);
  if (low.length > 0) return warn(`${low.map(diskText).join("; ")}. Free space there, or delete archived threads`);
  return ok(`${disks.length} ${disks.length === 1 ? "filesystem" : "filesystems"}, none under 10% or 20 GiB free`);
}

function pylons(n: NodeSummary, f: DoctorFacts): Verdict {
  const p = n.pylons;
  const stuck = p?.stuck ?? [];
  const problems = [
    ...stuck.length === 0 ? [] : [`${stuck.length} stuck: ${stuck.map((s) => [
      `${s.pylonId} of ${s.thread} ${s.doing} for ${span(f.now - Date.parse(s.since))}`,
      ...s.deleteAskedAt === null || s.doing === "deleting" ? [] : [`its delete asked ${span(f.now - Date.parse(s.deleteAskedAt))} ago`],
      ...s.memoryGiB > 0 ? [`holding ${s.cpus} CPUs and ${s.memoryGiB} GiB`] : [],
    ].join(", ")).join("; ")}. A boot or a delete that stays stuck needs its node: controller.log in the pylon's instance directory says what it waits on`],
    ...p === null || p.crashed.pylons === 0 ? [] : [`${p.crashed.pylons} crashed ${p.crashed.pylons === 1 ? "pylon" : "pylons"}, whose threads nexus show explains`],
    ...p === null || p.orphaned.length === 0 ? [] : [`${p.orphaned.length} orphaned (${p.orphaned.join(", ")}), which the registry does not know and nothing deletes`],
    ...n.overcommitted ? ["overcommitted, its running pylons holding more CPUs or memory than it has, so pause or archive threads on it"] : [],
  ];
  if (problems.length > 0) return warn(problems.join("; "));
  return ok(p === null ? "no pylons observed yet" : `${p.up.pylons} up, ${p.paused.pylons} paused, none stuck, crashed or orphaned`);
}

function backup(f: DoctorFacts): Verdict {
  const s = f.backup;
  const look = "sudo systemctl status nexus-backup and journalctl -u nexus-backup on the control plane's machine say why";
  // The unit writes the status from the release that added it on, so right after that deploy no run has written one yet.
  if (s === "missing") {
    const up = f.now - f.upSince;
    if (up < backupMaxAgeMs) return warn(`no backup run is recorded yet. The backup unit records each run from this release on, so its next nightly run records one, and sudo systemctl start nexus-backup records one now`);
    return fail(`no backup run is recorded in the ${span(up)} this control plane has run. Start one with sudo systemctl start nexus-backup, and check that nexus-backup.timer is enabled`);
  }
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
  if ("unreadable" in f.login) return fail(`the harness's login could not be read, with a ${f.login.unreadable} error. Check that nexus-control can read harness.credentials in control.json`);
  const { provider, modelId, credential, offered, refresh } = f.login;
  // The sign-in is the control plane's own, for its reviews and judgments, and its token is what a probe is handed for such a project's pylons.
  const boots = provider !== "openai" || f.tokenProjects.length === 0 ? ""
    : `. Pylons of ${f.tokenProjects.join(", ")} reach OpenAI with its token, so none of them boots or wakes on a node whose probe has restarted since, which \`nexus show\` says of each thread it holds`;
  const signIn = `Stop the control plane and sign it in with node src/control/login.ts as nexus-control${boots}`;
  if (offered === null) return fail(`harness.model names provider ${provider}, which the harness does not have. Fix control.json`);
  if (credential === null || offered.length === 0) return fail(`the harness is not signed in to ${provider}, so every thread fails at its first turn. ${signIn}`);
  if (!refresh.ok) return fail(`the harness's ${provider} login no longer resolves, with pi-ai's ${refresh.code} error. ${signIn}`);
  if (!offered.includes(modelId)) return fail(`the harness's ${provider} login does not offer harness.model ${modelId}. Name one of ${offered.toSorted().join(", ")} in control.json`);
  return ok(credential === "oauth" ? `signed in to ${provider} with ChatGPT, which offers ${modelId}` : `an API key for ${provider}, which Nexus cannot check without calling a model`);
}

function githubToken(f: DoctorFacts): Verdict {
  const t = f.github;
  if (t.kind === "none") return ok("control.json names no github.tokenFile, so the PR watch, the review loop and landings are off");
  const copy = "This is the control plane's token in github.tokenFile. Each node's GH_TOKEN in /etc/nexus/secrets.env, which the pylons get, is another copy this check does not read";
  const renew = `Install a new token in github.tokenFile and restart nexus-control, as deploy/README.md's Control-plane GitHub PR watch says. ${copy}`;
  if (t.kind === "unread") return warn(`GitHub gave no answer about the control plane's token, with a ${t.error} error, so its expiry is unknown. ${copy}`);
  if (t.kind === "refused") return fail(`GitHub refuses the control plane's token, as it does an expired or revoked one, so the PR watch, the review loop and landings fail. ${renew}`);
  if (t.expiresAt === null) return ok(`GitHub reports no expiry for the control plane's token. ${copy}`);
  const left = Date.parse(t.expiresAt) - f.now;
  if (left <= 0) return fail(`the control plane's GitHub token expired at ${t.expiresAt}, so the PR watch, the review loop and landings fail. ${renew}`);
  if (left < expiryWarnMs) return warn(`the control plane's GitHub token expires in ${span(left)}, at ${t.expiresAt}, and then the PR watch, the review loop and landings fail. ${renew}`);
  return ok(`the control plane's GitHub token is valid for ${span(left)}. ${copy}`);
}

function tailnetKey(n: NodeSummary, f: DoctorFacts): Verdict {
  if ("unreadable" in f.tailnet) return warn(`tailscaled's status on the control plane's machine could not be read, with a ${f.tailnet.unreadable} error, so this node's key expiry is unknown`);
  const device = f.tailnet.find((d) => d.id === n.tailnetNodeId);
  if (device === undefined) return warn(`tailscaled on the control plane's machine does not list tailnet node ${n.tailnetNodeId}, so its key expiry is unknown. Check that ${n.tailnetHost} is in the tailnet`);
  if (device.keyExpiry === null) return ok("key expiry is off for it in the tailnet");
  const control = n.name === f.controlNode ? ", which takes the API, the dashboard, the CLI and every alert with it" : "";
  const renew = "Turn off key expiry for it in Tailscale's admin console, or reauthenticate it with sudo tailscale up --force-reauth from a console that does not run over the tailnet";
  const left = Date.parse(device.keyExpiry) - f.now;
  if (left <= 0) return fail(`its tailnet key expired at ${device.keyExpiry}, so it is off the tailnet${control}. ${renew}`);
  if (left < expiryWarnMs) return warn(`its tailnet key expires in ${span(left)}, at ${device.keyExpiry}, and then it drops off the tailnet${control}. ${renew}`);
  return ok(`its tailnet key is valid for ${span(left)}`);
}

function image(n: NodeSummary, f: DoctorFacts): Verdict {
  const { current, holders, fetches } = f.image;
  if (current === null) return ok("no image is current");
  if (holders.includes(n.name)) return ok(`holds the current image ${current}`);
  if (n.state !== "online" || n.observedAt === null) return ok(`offline, which the online check reports, and the control plane sends it the current image ${current} once it is back online`);
  const lacks = `lacks the current image ${current}, so auto placement passes over it`;
  const fetch = fetches.find((r) => r.node === n.name && r.image === current);
  // A probe's reason can end in its log's lines, which nexus image list shows.
  const reason = fetch?.reason?.split("\n")[0];
  if (fetch?.state === "failed") {
    const why = fetch.failures >= maxImageFetches ? `${fetch.failures} fetches of it in a row failed, the last with ${reason}` : `Its probe refused the fetch of it as invalid: ${reason}`;
    return warn(`${lacks}. ${why}. nexus image rollout ${current} tries again`);
  }
  if (fetch?.state === "running") return warn(`${lacks}. A fetch-artifact job copies it there now`);
  const online = new Set(f.nodes.filter((m) => m.state === "online").map((m) => m.name));
  if (!holders.some((h) => h !== n.name && online.has(h))) return warn(`${lacks}. No other online node holds it to copy it from`);
  if (fetch !== undefined && fetch.failures > 0) return warn(`${lacks}. The last of ${fetch.failures} ${fetch.failures === 1 ? "fetch" : "fetches"} of it failed with ${reason}, and another is sent after the backoff`);
  return warn(`${lacks}. The control plane sends it a fetch-artifact job on its next pass`);
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

function archivedDisks(f: DoctorFacts): Verdict {
  const kept = f.keptArchives.filter((t) => keptPastDay(t, f.now) !== null);
  if (kept.length === 0) return ok("no archived disk is kept past its 24 hours");
  const named = (ts: typeof kept) => ts.map((t) => `${t.id} (${t.title})`).join(", ");
  const lastFailure = (ts: typeof kept) => ts.flatMap((t) => t.settleFailure ?? []).toSorted((a, b) => b.at - a.at)[0]?.reason;
  const failing = kept.filter((t) => (t.settleFailure?.count ?? 0) >= settleFailuresFail);
  if (failing.length > 0) {
    return fail(`reading the token usage on the disk of ${named(failing)} failed ${settleFailuresFail} or more times in a row, the last because ${lastFailure(failing)}, so ${failing.length === 1 ? "it is" : "they are"} kept. nexus show says why, and nexus delete deletes a thread with its disk and the usage on it unread`);
  }
  const overdue = kept.filter((t) => t.usageSettledAt === undefined && f.now - t.archivedAt! >= settleOverdueMs);
  if (overdue.length > 0) {
    return fail(`${named(overdue)} ${overdue.length === 1 ? "is" : "are"} still unread ${span(settleOverdueMs)} after ${overdue.length === 1 ? "its" : "their"} archive, so ${overdue.length === 1 ? "its disk is" : "their disks are"} kept, the first as ${keptPastDay(overdue[0]!, f.now)}. Bring its node online or free room there, or delete the thread with its disk and its unread usage`);
  }
  const read = kept.flatMap((t) => t.usageSettledAt ?? []);
  const oldest = f.now - Math.min(...read);
  if (read.length > 0 && oldest > backupMaxAgeMs) {
    return fail(`${read.length === 1 ? "1 archived disk waits" : `${read.length} archived disks wait`} past the 24 hours for a backup that begins after the token usage on it was read, the oldest read ${span(oldest)} ago. The backup check says why none verified since, and sudo systemctl status nexus-backup on the control plane's machine says more`);
  }
  const unread = kept.filter((t) => t.usageSettledAt === undefined);
  if (unread.length > 0) {
    const failed = unread.filter((t) => t.settleFailure !== undefined);
    const what = unread.length === 1 ? `${named(unread)} is kept past its 24 hours, as ${keptPastDay(unread[0]!, f.now)}`
      : `${unread.length} archived disks wait past the 24 hours for the token usage on them to be read to its end${failed.length === 0 ? "" : `, ${failed.length} after a failed read, the last because ${lastFailure(failed)}`}`;
    return warn(`${what}. Each is read once its pylon paused, while its node is online with a current probe and room for it`);
  }
  return ok(`${read.length === 1 ? "1 archived disk waits" : `${read.length} archived disks wait`} past the 24 hours for the next backup, and then ${read.length === 1 ? "goes" : "go"}`);
}

function unreviewedPrs(f: DoctorFacts): Verdict {
  if (f.unreviewed.length === 0) return ok("every open pull request in a project that reviews on its own has its review, or one that starts on its own");
  return warn(f.unreviewed.map((u) => `pull request #${u.pr} of ${u.thread} (${u.title}) is open, and ${u.why}`).join("; "));
}

const nodeChecks: Readonly<Record<NodeCheckName, (n: NodeSummary, f: DoctorFacts) => Verdict>> = {
  online,
  release: (n, f) => release(f.release.nodes.find((r) => r.node === n.name && r.role === "probe"), f.release.desired, f.now),
  disk,
  pylons,
  "tailnet-key": tailnetKey,
  image,
};
const controlChecks: Readonly<Record<ControlCheckName, (f: DoctorFacts) => Verdict>> = {
  release: (f) => release(f.release.nodes.find((r) => r.node === f.controlNode && r.role === "control"), f.release.desired, f.now),
  "event-loop": eventLoop,
  backup,
  login,
  "github-token": githubToken,
  certificate,
  "archived-disks": archivedDisks,
  "unreviewed-prs": unreviewedPrs,
};

/** Every check, the control plane's first and then each node's. */
export function doctorReport(f: DoctorFacts): DoctorReport {
  const checks: Check[] = [
    ...Object.entries(controlChecks).map(([name, check]) => ({ node: null, name: name as ControlCheckName, ...check(f) })),
    ...f.nodes.flatMap((n) => Object.entries(nodeChecks).map(([name, check]) => ({ node: n.name, name: name as NodeCheckName, ...check(n, f) }))),
  ];
  return { at: new Date(f.now).toISOString(), status: worst(checks), checks };
}
