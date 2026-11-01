import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { ReleaseReport } from "../deploy/model.ts";
import type { DiskFact } from "../protocol/observations.ts";
import { testCapacity } from "../test-kit.ts";
import { doctorReport, type DoctorFacts } from "./doctor.ts";
import type { Check, Status } from "./doctor-model.ts";
import type { NodeSummary } from "./wire.ts";

const now = Date.parse("2026-11-01T12:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const hour = 3_600_000;
const day = 24 * hour;
const commit = "c".repeat(40);
const older = "b".repeat(40);
const node = "rj-firebat" as NodeName;
const peer = "infra-testbench" as NodeName;
const none = { pylons: 0, cpus: 0, memoryGiB: 0 };
const pylonsDisk = { paths: ["/var/lib/nexus/pylons", "/var/lib/nexus"], totalGiB: 500, freeGiB: 300, pylons: true as const };
const controlDisk = { paths: ["/var/lib/nexus-control"], totalGiB: 100, freeGiB: 60 };

function nodeOf(name: NodeName, over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    name, tailnetHost: `${name}.example.ts.net`, tailnetNodeId: `n${name}` as TailnetNodeId, state: "online",
    capacity: testCapacity({ disks: [pylonsDisk, controlDisk] }), observedAt: iso(now - 30_000), overcommitted: false,
    pylons: { up: { pylons: 2, cpus: 4, memoryGiB: 8 }, paused: none, archived: none, crashed: none, orphaned: [] }, ...over,
  };
}
const report = (n: NodeName, role: ReleaseReport["role"], over: Partial<ReleaseReport> = {}): ReleaseReport =>
  ({ node: n, role, commit, target: commit, state: "healthy", reason: null, observedAt: now - 10_000, ...over });

function healthy(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    now,
    upSince: now - 3 * day,
    nodes: [nodeOf(node), nodeOf(peer)],
    release: { desired: { commit, requestedBy: "nLAPTOP", requestedAt: now - day }, nodes: [report(node, "control"), report(node, "probe"), report(peer, "probe")] },
    controlNode: node,
    backup: { ranAt: iso(now - 3 * hour), succeeded: true, newest: { name: "2026-11-01T09-00-00Z", verified: true, createdAt: iso(now - 3 * hour) } },
    login: { provider: "openai", modelId: "gpt-6-astra", credential: "oauth", offered: ["gpt-6-astra", "gpt-6-mini"], refresh: { ok: true } },
    certificate: { kind: "served", hostname: "rj-firebat.example.ts.net", validTo: iso(now + 60 * day), forHostname: true },
    ...over,
  };
}

function check(facts: DoctorFacts, where: NodeName | null, name: Check["name"]): Check {
  const found = doctorReport(facts).checks.find((c) => c.node === where && c.name === name);
  assert.ok(found !== undefined, `${where ?? "control plane"} has a ${name} check`);
  return found;
}
function expect(facts: DoctorFacts, where: NodeName | null, name: Check["name"], status: Status, text: RegExp) {
  const found = check(facts, where, name);
  assert.equal(found.status, status, `${where ?? "control plane"} ${name}: ${found.text}`);
  assert.match(found.text, text);
  assert.doesNotMatch(found.text, /\n/, "one line");
}

test("a healthy install passes every check, the control plane's first and then each node's, and the report is ok", () => {
  const r = doctorReport(healthy());
  assert.equal(r.at, iso(now));
  assert.equal(r.status, "ok");
  assert.deepEqual(r.checks.map((c) => [c.node, c.name, c.status]), [
    [null, "release", "ok"], [null, "backup", "ok"], [null, "login", "ok"], [null, "certificate", "ok"],
    [node, "online", "ok"], [node, "release", "ok"], [node, "disk", "ok"], [node, "pylons", "ok"],
    [peer, "online", "ok"], [peer, "release", "ok"], [peer, "disk", "ok"], [peer, "pylons", "ok"],
  ]);
});

test("the report is as bad as its worst check", () => {
  assert.equal(doctorReport(healthy({ nodes: [nodeOf(node, { overcommitted: true })] })).status, "warn");
  assert.equal(doctorReport(healthy({ nodes: [nodeOf(node, { overcommitted: true }), nodeOf(peer, { state: "offline" })] })).status, "fail");
});

test("a node is ok online and observed lately, warns when its link is up but its snapshots stopped, and fails offline or never observed", () => {
  expect(healthy(), peer, "online", "ok", /online/);
  expect(healthy({ nodes: [nodeOf(peer, { observedAt: iso(now - 12 * 60_000) })] }), peer, "online", "warn", /last observed 12 min ago.*journalctl -u nexus-probe/);
  expect(healthy({ nodes: [nodeOf(peer, { state: "offline", observedAt: iso(now - 3 * hour) })] }), peer, "online", "fail", /offline, last observed 3 h ago.*nexus-probe/);
  expect(healthy({ nodes: [nodeOf(peer, { state: "offline", observedAt: null, capacity: null, pylons: null })] }), peer, "online", "fail", /never observed/);
});

test("each role is ok on the desired release and healthy, warns while it deploys or its deployer stopped reporting, and fails once it failed or rolled back", () => {
  const releaseOf = (...nodes: ReleaseReport[]) => ({ desired: { commit, requestedBy: "nLAPTOP", requestedAt: 0 }, nodes });
  expect(healthy(), null, "release", "ok", /control on rj-firebat runs the desired cccccccccccc and is healthy/);
  expect(healthy({ release: releaseOf(report(node, "control"), report(node, "probe"), report(peer, "probe", { state: "installing", commit: older })) }), peer, "release", "warn", /probe on infra-testbench runs bbbbbbbbbbbb and is installing toward cccccccccccc/);
  expect(healthy({ release: releaseOf(report(node, "control"), report(node, "probe"), report(peer, "probe", { state: "pending", reason: "deployer report is stale" })) }), peer, "release", "warn", /pending.*deployer report is stale.*nexus-deployer\.timer on infra-testbench/);
  expect(healthy({ release: releaseOf(report(node, "control"), report(node, "probe"), report(peer, "probe", { commit: older })) }), peer, "release", "warn", /runs bbbbbbbbbbbb and is healthy toward cccccccccccc/);
  expect(healthy({ release: releaseOf(report(node, "control", { state: "failed", commit: older, reason: "health check timed out" }), report(node, "probe"), report(peer, "probe")) }), null, "release", "fail", /control on rj-firebat failed toward cccccccccccc: health check timed out\. journalctl -u nexus-deployer on rj-firebat/);
  expect(healthy({ release: releaseOf(report(node, "control"), report(node, "probe", { state: "rolled-back", commit: older }), report(peer, "probe")) }), node, "release", "fail", /rolled-back/);
  expect(healthy({ release: { desired: null, nodes: [report(node, "control", { state: "pending", reason: "no deployer report", commit: null, target: null })] } }), null, "release", "ok", /no release is desired/);
  expect(healthy({ controlNode: null }), null, "release", "warn", /no node is the control plane's/);
});

test("a node's filesystems are ok with room, warn when one is low, and fail when the pylons' one is under the reserve every start keeps", () => {
  const with_ = (disks: DiskFact[]) => healthy({ nodes: [nodeOf(peer, { capacity: testCapacity({ disks }) })] });
  expect(healthy(), peer, "disk", "ok", /2 filesystems, none under 10% or 20 GiB free/);
  expect(with_([pylonsDisk, { ...controlDisk, freeGiB: 8 }]), peer, "disk", "warn", /8\.0 of 100\.0 GiB free at \/var\/lib\/nexus-control, low\. Free space/);
  expect(with_([{ ...pylonsDisk, freeGiB: 40 }, controlDisk]), peer, "disk", "warn", /40\.0 of 500\.0 GiB free.*low/);
  expect(with_([{ ...pylonsDisk, freeGiB: 20 }, controlDisk]), peer, "disk", "fail", /20\.0 of 500\.0 GiB free.*under the 25\.0 GiB it keeps free, so it refuses every start and wake/);
  expect(with_([pylonsDisk, { ...controlDisk, freeGiB: 2 }]), peer, "disk", "warn", /2\.0 of 100\.0 GiB free at \/var\/lib\/nexus-control, low/);
  expect(healthy({ nodes: [nodeOf(peer, { capacity: { memoryGiB: 6, committedMemoryGiB: 0, diskFreeGiB: 100 } })] }), peer, "disk", "warn", /older than the filesystems it reports/);
  expect(healthy({ nodes: [nodeOf(peer, { capacity: testCapacity() })] }), peer, "disk", "warn", /older than the filesystems it reports/);
});

test("a node's pylons are ok when none crashed or is orphaned, and warn for each crashed or orphaned pylon and an overcommitted node", () => {
  const pylons = nodeOf(peer).pylons!;
  expect(healthy(), peer, "pylons", "ok", /2 up, 0 paused, none crashed or orphaned/);
  expect(healthy({ nodes: [nodeOf(peer, { pylons: { ...pylons, crashed: { pylons: 2, cpus: 0, memoryGiB: 0 } } })] }), peer, "pylons", "warn", /2 crashed pylons/);
  expect(healthy({ nodes: [nodeOf(peer, { pylons: { ...pylons, orphaned: ["pylon-gone" as PylonId] } })] }), peer, "pylons", "warn", /1 orphaned \(pylon-gone\)/);
  expect(healthy({ nodes: [nodeOf(peer, { overcommitted: true })] }), peer, "pylons", "warn", /overcommitted/);
});

test("the backup is ok while the newest is verified and under 26 hours old, warns when the last run failed, and fails when it is missing, unverified or old", () => {
  const ran = iso(now - hour);
  expect(healthy(), null, "backup", "ok", /the newest backup, 2026-11-01T09-00-00Z, is 3 h old and verified/);
  expect(healthy({ backup: { ranAt: ran, succeeded: false, newest: { name: "2026-11-01T09-00-00Z", verified: true, createdAt: iso(now - 3 * hour) } } }), null, "backup", "warn", /the run at .* failed, so the newest backup is 2026-11-01T09-00-00Z, 3 h old\. .*journalctl -u nexus-backup/);
  expect(healthy({ backup: { ranAt: ran, succeeded: true, newest: { name: "2026-10-31T09-00-00Z", verified: true, createdAt: iso(now - 27 * hour) } } }), null, "backup", "fail", /is 27 h old\. /);
  expect(healthy({ backup: { ranAt: ran, succeeded: false, newest: { name: "2026-10-30T09-00-00Z", verified: true, createdAt: iso(now - 3 * day) } } }), null, "backup", "fail", /is 3 days old, and the run at .* failed/);
  expect(healthy({ backup: { ranAt: ran, succeeded: false, newest: { name: "2026-11-01T09-00-00Z", verified: false, createdAt: null } } }), null, "backup", "fail", /does not verify\. .*backup\.ts check says why/);
  expect(healthy({ backup: { ranAt: ran, succeeded: false, newest: null } }), null, "backup", "fail", /no complete backup exists/);
  expect(healthy({ backup: "missing" }), null, "backup", "fail", /no backup run is recorded in the 3 days this control plane has run.*nexus-backup\.timer is enabled/);
  expect(healthy({ backup: { unreadable: "EACCES: permission denied" } }), null, "backup", "fail", /unreadable: EACCES/);
});

test("the harness's login is ok signed in and offering its model, and fails without the provider, signed out, refusing to refresh, or not offering the model", () => {
  const login = healthy().login;
  expect(healthy(), null, "login", "ok", /signed in to openai with ChatGPT, which offers gpt-6-astra/);
  expect(healthy({ login: { ...login, credential: "api_key" } }), null, "login", "ok", /an API key for openai, which Nexus cannot check without calling a model/);
  expect(healthy({ login: { ...login, provider: "anthropic", credential: null, offered: null } }), null, "login", "fail", /provider anthropic, which the harness does not have/);
  expect(healthy({ login: { ...login, credential: null, offered: [] } }), null, "login", "fail", /not signed in to openai.*src\/control\/login\.ts/);
  expect(healthy({ login: { ...login, refresh: { ok: false, code: "oauth" } } }), null, "login", "fail", /no longer resolves, with pi-ai's oauth error\. Stop the control plane and sign it in/);
  expect(healthy({ login: { ...login, offered: ["gpt-6-mini"] } }), null, "login", "fail", /does not offer harness\.model gpt-6-astra\. Name one of gpt-6-mini/);
});

test("the dashboard's certificate is ok with weeks left or without https, warns under 6 days, and fails under 2, expired, for another name, or unreachable", () => {
  const served = (left: number, forHostname = true) => healthy({ certificate: { kind: "served", hostname: "rj-firebat.example.ts.net", validTo: iso(now + left), forHostname } });
  expect(healthy(), null, "certificate", "ok", /valid for 60 days/);
  expect(healthy({ certificate: { kind: "none" } }), null, "certificate", "ok", /sets no https/);
  expect(served(5 * day), null, "certificate", "warn", /expires in 5 days, so its renewal is failing/);
  expect(served(30 * hour), null, "certificate", "fail", /expires in 30 h/);
  expect(served(-hour), null, "certificate", "fail", /expired at/);
  expect(served(60 * day, false), null, "certificate", "fail", /is not for rj-firebat\.example\.ts\.net/);
  expect(healthy({ certificate: { kind: "unreachable", hostname: "rj-firebat.example.ts.net", error: "connect ECONNREFUSED" } }), null, "certificate", "fail", /does not answer: connect ECONNREFUSED/);
});

test("a role still rolling out toward a release requested under 30 minutes ago is ok, and warns once the rollout overstays that, while a failure fails at once", () => {
  const rollout = (minutesAgo: number, control: Partial<ReleaseReport>) => healthy({ release: { desired: { commit, requestedBy: "nLAPTOP", requestedAt: now - minutesAgo * 60_000 }, nodes: [report(node, "control", control), report(node, "probe", { state: "waiting-for-control", commit: older }), report(peer, "probe", { state: "pending", reason: "deployer report is stale" })] } });
  expect(rollout(12, { state: "waiting-for-idle", commit: older }), null, "release", "ok", /control on rj-firebat is waiting-for-idle toward cccccccccccc, requested 12 min ago, which a rollout may take up to 30 min/);
  expect(rollout(12, { state: "installing", commit: older }), node, "release", "ok", /probe on rj-firebat is waiting-for-control/);
  expect(rollout(12, { state: "installing", commit: older }), peer, "release", "ok", /is pending toward/);
  expect(rollout(31, { state: "installing", commit: older }), null, "release", "warn", /is installing toward cccccccccccc/);
  expect(rollout(31, { state: "installing", commit: older }), peer, "release", "warn", /deployer report is stale/);
  expect(rollout(2, { state: "failed", commit: older, reason: "build failed" }), null, "release", "fail", /failed toward cccccccccccc: build failed/);
});

test("a missing backup status only warns while this control plane has run under 26 hours, since the unit records a run from this release on", () => {
  expect(healthy({ backup: "missing", upSince: now - 10 * 60_000 }), null, "backup", "warn", /no backup run is recorded yet.*its next nightly run records one/);
  expect(healthy({ backup: "missing", upSince: now - 25 * hour }), null, "backup", "warn", /recorded yet/);
  expect(healthy({ backup: "missing", upSince: now - 27 * hour }), null, "backup", "fail", /no backup run is recorded in the 27 h this control plane has run/);
});

test("a login that could not be read fails the login check with the error's code", () => {
  expect(healthy({ login: { unreadable: "EACCES" } }), null, "login", "fail", /could not be read, with a EACCES error/);
});
