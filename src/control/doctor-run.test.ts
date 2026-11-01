import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:tls";
import { join } from "node:path";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import { tempDir, testCapacity, testObservation } from "../test-kit.ts";
import { testCertificate } from "../test-certificate.ts";
import { harnessModels, loginState, openCredentials } from "../harness/credentials.ts";
import { readBackupStatus, writeBackupStatus } from "./backup-status.ts";
import { dailyReports, reportsKeptMs, runDoctor, servedCertificate } from "./doctor-run.ts";
import type { DoctorReport } from "./doctor-model.ts";
import { testRegistry } from "./test-kit.ts";

const day = 24 * 60 * 60_000;
const start = Date.parse("2026-11-01T00:00:00Z");
const report = (at: number, status: DoctorReport["status"] = "ok"): DoctorReport => ({ at: new Date(at).toISOString(), status, checks: [{ node: null, name: "backup", status, text: status }] });

test("the daily report runs once the control plane has settled, then once a day, through restarts, and keeps 30 days of reports", async (t) => {
  const registry = testRegistry(t);
  let now = start;
  let runs = 0;
  const logged: string[] = [];
  const reports = (startedAt: number) => dailyReports({ registry, startedAt, clock: () => now, log: (m) => logged.push(m), run: async () => { runs++; return report(now, runs % 2 === 0 ? "warn" : "ok"); } });
  let first = reports(start);
  await first.poll();
  assert.equal(runs, 0, "not in the first minutes after a start, while the loop reconnects to every probe");
  now += 5 * 60_000;
  await first.poll();
  assert.equal(runs, 1);
  now += day - 60_000;
  await first.poll();
  assert.equal(runs, 1, "not again within a day");
  now += 60_000;
  await first.poll();
  assert.equal(runs, 2);
  assert.match(logged.join("\n"), /the daily report 2 found a problem: control plane backup warn/);
  first = reports(now);
  now += 6 * 60_000;
  await first.poll();
  assert.equal(runs, 2, "a restart runs nothing while the latest report is under a day old");
  now += 2 * day;
  await first.poll();
  assert.equal(runs, 3, "and a control plane that was down a day runs one as soon as it settles");
  assert.deepEqual(registry.reports().map((r) => r.id), [3, 2, 1]);
  for (let i = 0; i < 31; i++) {
    now += day;
    await first.poll();
  }
  const kept = registry.reports();
  assert.ok(kept.every((r) => Date.parse(r.at) >= now - reportsKeptMs), "none older than 30 days is kept");
  assert.equal(kept.length, 31, "a report a day for 30 days, and today's");
  assert.equal(registry.report(1), null);
  assert.equal(registry.latestReport()?.id, 34);
});

test("a daily report whose checks throw is logged and stores nothing, so the next poll tries again", async (t) => {
  const registry = testRegistry(t);
  const logged: string[] = [];
  let fails = true;
  const reports = dailyReports({ registry, startedAt: start - day, clock: () => start, log: (m) => logged.push(m), run: async () => { if (fails) throw new Error("registry is busy"); return report(start); } });
  await reports.poll();
  assert.deepEqual([registry.latestReport(), logged], [null, ["the daily report failed: registry is busy"]]);
  fails = false;
  await reports.poll();
  assert.equal(registry.latestReport()?.at, new Date(start).toISOString());
});

test("the doctor reads each node, the release and the control node from the registry, and the rest from what it is handed", async (t) => {
  const registry = testRegistry(t);
  const node = "rj-firebat" as NodeName;
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.example.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  const now = Date.now();
  registry.apply({ record: "node", node, state: "online", capacity: testCapacity({ disks: [{ paths: ["/var/lib/nexus/pylons"], totalGiB: 500, freeGiB: 5, pylons: true }] }) });
  registry.ingested(testObservation(node, { observedAt: new Date(now - 10_000).toISOString() }), []);
  registry.setDesiredRelease({ commit: "c".repeat(40), requestedBy: "nLAPTOP", requestedAt: now });
  const r = await runDoctor({
    registry, self: "nFIREBAT" as TailnetNodeId, clock: () => now,
    backupStatus: async () => "missing",
    login: async () => ({ provider: "openai", modelId: "gpt-6-astra", credential: null, offered: [], refresh: { ok: true } }),
    certificate: async () => ({ kind: "none" }),
  });
  const status = Object.fromEntries(r.checks.map((c) => [`${c.node ?? "control"} ${c.name}`, c.status]));
  assert.deepEqual(status, {
    "control release": "warn", "control backup": "fail", "control login": "fail", "control certificate": "ok",
    "rj-firebat online": "ok", "rj-firebat release": "warn", "rj-firebat disk": "fail", "rj-firebat pylons": "ok",
  }, "no deployer has reported, so both roles are pending, and the pylons' filesystem is under its reserve");
  assert.match(r.checks.find((c) => c.node === null && c.name === "release")!.text, /control on rj-firebat .* no deployer report/);
});

test("the dashboard's certificate is read as a browser gets it, an expiring one included, and a port that does not answer says so", async (t) => {
  const dir = await tempDir("nexus-doctor-cert-", t);
  const hostname = "dashboard.example.ts.net";
  const server = createServer(await testCertificate(dir, hostname));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as import("node:net").AddressInfo;
  const served = await servedCertificate("127.0.0.1", port, hostname);
  assert.equal(served.kind, "served");
  assert.ok(served.kind === "served" && served.forHostname && Date.parse(served.validTo) - Date.now() < 2 * day + 60_000, "the test certificate is valid two days");
  const other = await servedCertificate("127.0.0.1", port, "other.example.ts.net");
  assert.ok(other.kind === "served" && !other.forHostname);
  server.close();
  await new Promise<void>((resolve) => server.once("close", resolve));
  const down = await servedCertificate("127.0.0.1", port, hostname);
  assert.equal(down.kind, "unreachable");
  assert.match(down.kind === "unreachable" ? down.error : "", /ECONNREFUSED/);
});

test("the backup's status file is world-readable in a directory its writer owns, never written through a link, and read back as missing or unreadable", async (t) => {
  const dir = await tempDir("nexus-backup-status-", t);
  const path = join(dir, "nexus-backup", "status.json");
  assert.equal(await readBackupStatus(path), "missing");
  const status = { ranAt: "2026-11-01T00:23:41.000Z", succeeded: true, newest: { name: "2026-11-01T00-23-41Z", verified: true, createdAt: "2026-11-01T00:23:41.000Z" } };
  const before = process.umask(0o077);
  try {
    await writeBackupStatus(path, status);
  } finally {
    process.umask(before);
  }
  assert.deepEqual(await readBackupStatus(path), status);
  assert.equal((await lstat(path)).mode & 0o777, 0o644, "the control plane's user reads it, though the backup unit's umask is 0077");
  assert.equal((await lstat(join(dir, "nexus-backup"))).mode & 0o777, 0o755);
  await writeFile(path, "{ not json");
  const unreadable = await readBackupStatus(path);
  assert.ok(typeof unreadable === "object" && "unreadable" in unreadable && /does not parse/.test(unreadable.unreadable));
  await mkdir(join(dir, "elsewhere"));
  await symlink(join(dir, "elsewhere"), join(dir, "linked"));
  await assert.rejects(writeBackupStatus(join(dir, "linked", "status.json"), status), /is a link, not a directory, or not this user's/);
});

test("the harness's login state says whether it is signed in and which models it offers, without calling a model", async (t) => {
  const dir = await tempDir("nexus-doctor-login-", t);
  const credentials = await openCredentials(join(dir, "harness-credentials.json"));
  const models = harnessModels(credentials);
  const model = { provider: "openai", modelId: "gpt-6-astra" };
  assert.deepEqual(await loginState(models, model), { ...model, credential: null, offered: [], refresh: { ok: true } });
  assert.deepEqual(await loginState(models, { provider: "nobody", modelId: "x" }), { provider: "nobody", modelId: "x", credential: null, offered: null, refresh: { ok: true } });
  await credentials.store.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
  const keyed = await loginState(models, model);
  assert.equal(keyed.credential, "api_key");
  assert.ok(keyed.offered !== null && keyed.offered.length > 0);
  assert.deepEqual(keyed.refresh, { ok: true });
});
