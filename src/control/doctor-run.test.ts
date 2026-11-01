import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer, TLSSocket } from "node:tls";
import { join } from "node:path";
import type { NodeName, TailnetNodeId } from "../ids.ts";
import { tempDir, testCapacity, testObservation } from "../test-kit.ts";
import { testCertificate } from "../test-certificate.ts";
import { ModelsError, type Models } from "@earendil-works/pi-ai/models";
import { harnessModels, loginState, openCredentials } from "../harness/credentials.ts";
import { readBackupStatus, writeBackupStatus } from "./backup-status.ts";
import { changesKeptMs, checkEveryMs, healthPasses, runDoctor, servedCertificate } from "./doctor-run.ts";
import { healthView, type Check, type DoctorReport, type Status } from "./doctor-model.ts";
import { testRegistry } from "./test-kit.ts";

const day = 24 * 60 * 60_000;
const start = Date.parse("2026-11-01T00:00:00Z");
const minute = 60_000;
const disk = (status: Status): Check => ({ node: "rj-firebat" as NodeName, name: "disk", status, text: `the disk is ${status}` });
const backup = (status: Status): Check => ({ node: null, name: "backup", status, text: `the backup is ${status}` });

/** Passes over a registry, each running the checks the test sets, 5 minutes apart from the end of the settling. */
function passes(t: import("node:test").TestContext, registry = testRegistry(t), startedAt = start) {
  let now = startedAt;
  let checks: Check[] = [backup("ok"), disk("ok")];
  const logged: string[] = [];
  const health = healthPasses({ registry, startedAt, clock: () => now, log: (m) => logged.push(m), run: async () => ({ at: new Date(now).toISOString(), status: "ok", checks }) });
  const alerts = () => registry.events("0", { kinds: ["health.changed"] }).map((e) => e.payload as { name: string; from: Status; status: Status });
  return {
    registry, logged, health, alerts,
    async pass(...next: Check[]) {
      if (next.length > 0) checks = next;
      now = Math.max(now + checkEveryMs, startedAt + 5 * minute);
      await health.poll();
    },
    view: () => healthView(health.latest(), registry.healthStates()),
    at: () => now,
    advance(ms: number) { now += ms; },
  };
}

test("a check that goes bad alerts once, on its second bad pass in a row, and a single bad pass alerts nothing", async (t) => {
  const p = passes(t);
  await p.pass();
  await p.pass(backup("ok"), disk("warn"));
  assert.deepEqual(p.alerts(), [], "one bad pass, as a deploy's restart of a probe gives");
  assert.equal(p.view().checks.find((c) => c.name === "disk")?.status, "warn", "the Health page still shows the pass as it ran");
  await p.pass(backup("ok"), disk("ok"));
  await p.pass(backup("ok"), disk("warn"));
  assert.deepEqual(p.alerts(), []);
  await p.pass();
  assert.deepEqual(p.alerts().map((a) => [a.name, a.from, a.status]), [["disk", "ok", "warn"]]);
  assert.deepEqual([p.view().problems.length, p.view().unseen], [1, 1]);
  await p.pass();
  await p.pass();
  assert.equal(p.alerts().length, 1, "a problem that stays alerts no more");
  await p.pass(backup("ok"), disk("fail"));
  assert.equal(p.alerts().length, 1, "one pass worse is not yet worse");
  await p.pass();
  assert.deepEqual(p.alerts().map((a) => [a.from, a.status]), [["ok", "warn"], ["warn", "fail"]]);
  assert.match(p.logged.join("\n"), /the rj-firebat disk check went from warn to fail: the disk is fail/);
});

test("a check that recovers clears its alert and the badge on its second good pass in a row", async (t) => {
  const p = passes(t);
  await p.pass(backup("fail"), disk("ok"));
  await p.pass();
  assert.deepEqual([p.view().problems.map((c) => c.name), p.view().unseen], [["backup"], 1]);
  await p.pass(backup("ok"), disk("ok"));
  assert.equal(p.alerts().length, 1, "one good pass is not yet steady");
  await p.pass();
  assert.deepEqual(p.alerts().map((a) => [a.name, a.from, a.status]), [["backup", "ok", "fail"], ["backup", "fail", "ok"]]);
  assert.deepEqual([p.view().problems, p.view().unseen], [[], 0]);
  await p.pass(backup("warn"), disk("ok"));
  await p.pass(backup("ok"), disk("ok"));
  assert.equal(p.alerts().length, 2, "a bad pass between good ones is noise");
});

test("a check that flips at its threshold on every pass alerts once, and stays one problem, seen once, until it is steady", async (t) => {
  const p = passes(t);
  await p.pass(backup("ok"), disk("warn"));
  await p.pass(backup("ok"), disk("fail"));
  assert.deepEqual(p.alerts().map((a) => [a.from, a.status]), [["ok", "warn"]], "two bad passes, the better of them");
  const [problem] = p.view().problems;
  p.registry.markHealthSeen(problem!.id, p.at());
  for (const status of ["ok", "warn", "ok", "warn", "ok", "fail", "warn"] as const) await p.pass(backup("ok"), disk(status));
  assert.equal(p.alerts().length, 1, "no recovery and no new alert while it flips");
  assert.deepEqual([p.view().problems.map((c) => c.id), p.view().unseen], [[problem!.id], 0]);
  await p.pass(backup("ok"), disk("ok"));
  await p.pass();
  assert.deepEqual(p.alerts().map((a) => a.status), ["warn", "ok"], "steady at ok, it recovers");
});

test("the first pass waits 5 minutes after a start, and a restart neither alerts again on a problem recorded nor on its own first pass", async (t) => {
  const registry = testRegistry(t);
  let now = start;
  let runs = 0;
  let checks = [backup("warn")];
  const health = (startedAt: number) => healthPasses({ registry, startedAt, clock: () => now, log: () => {}, run: async () => { runs++; return { at: new Date(now).toISOString(), status: "warn", checks }; } });
  const alerts = () => registry.events("0", { kinds: ["health.changed"] }).length;
  let first = health(start);
  now += 5 * minute - 1;
  await first.poll();
  assert.deepEqual([runs, first.latest()], [0, null], "not while the loop reconnects to every probe");
  for (const _ of [1, 2]) {
    now += checkEveryMs;
    await first.poll();
  }
  assert.equal(alerts(), 1);
  first = health(now);
  for (const _ of [1, 2, 3]) {
    now += checkEveryMs;
    await first.poll();
  }
  assert.equal(alerts(), 1, "the restarted control plane finds the warn it recorded");
  checks = [backup("warn"), disk("fail")];
  first = health(now);
  now += checkEveryMs;
  await first.poll();
  assert.equal(alerts(), 1, "a new node's first pass after a restart is only one pass");
  now += checkEveryMs;
  await first.poll();
  assert.equal(alerts(), 2);
});

test("a problem whose check is no longer run, as a removed node's, recovers", async (t) => {
  const p = passes(t);
  await p.pass(backup("ok"), disk("fail"));
  await p.pass();
  await p.pass(backup("ok"));
  assert.deepEqual(p.registry.healthStates().map((c) => [c.name, c.status, c.text]), [["disk", "ok", "no longer checked"]]);
  assert.deepEqual(p.view().problems, []);
});

test("a pass whose checks or registry throw logs it and records nothing, so a fired poll never rejects and the next pass tries again", async (t) => {
  const logged: string[] = [];
  let fails = true;
  const registry = testRegistry(t);
  const health = healthPasses({ registry, startedAt: start - checkEveryMs, clock: () => start, log: (m) => logged.push(m), run: async () => { if (fails) throw new Error("registry is busy"); return { at: new Date(start).toISOString(), status: "fail", checks: [backup("fail")] }; } });
  await assert.doesNotReject(health.poll());
  assert.deepEqual([health.latest(), logged], [null, ["a health pass failed: registry is busy"]]);
  fails = false;
  await health.poll();
  assert.equal(health.latest()?.checks[0]?.status, "fail");
  const throwing = healthPasses({ registry: { healthStates: () => { throw new SyntaxError("Unexpected token"); }, recordHealthChanges: () => [] }, startedAt: start - checkEveryMs, clock: () => start, log: (m) => logged.push(m), run: async () => ({ at: new Date(start).toISOString(), status: "ok", checks: [] }) });
  await assert.doesNotReject(throwing.poll());
  assert.equal(logged.at(-1), "a health pass failed: Unexpected token");
});

test("changes are kept 30 days, but the one that set a problem still open", async (t) => {
  const p = passes(t);
  await p.pass(backup("warn"), disk("ok"));
  await p.pass();
  await p.pass(backup("ok"), disk("ok"));
  await p.pass(backup("ok"), disk("fail"));
  await p.pass();
  assert.equal(p.registry.healthChanges().length, 3);
  p.advance(changesKeptMs);
  await p.pass();
  assert.deepEqual(p.registry.healthChanges().map((c) => [c.name, c.status]), [["disk", "fail"]], "the backup's changes went, and the disk's open problem stays");
  assert.deepEqual(p.alerts().length, 3, "and it raises no alert again");
});


test("the doctor reads each node, the release and the control node from the registry, and the rest from what it is handed", async (t) => {
  const registry = testRegistry(t);
  const node = "rj-firebat" as NodeName;
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.example.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  const now = Date.now();
  registry.apply({ record: "node", node, state: "online", capacity: testCapacity({ disks: [{ paths: ["/var/lib/nexus/pylons"], totalGiB: 500, freeGiB: 5, pylons: true }] }) });
  registry.ingested(testObservation(node, { observedAt: new Date(now - 10_000).toISOString() }), []);
  registry.setDesiredRelease({ commit: "c".repeat(40), requestedBy: "nLAPTOP", requestedAt: now - day });
  const r = await runDoctor({
    registry, self: "nFIREBAT" as TailnetNodeId, clock: () => now, startedAt: now - 3 * day,
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

test("a login that no longer refreshes keeps only pi-ai's error code, never the token endpoint's reply", async () => {
  const models = {
    getProvider: () => ({}), checkAuth: async () => ({ type: "oauth" }), getAvailable: async () => [{ id: "gpt-6-astra" }],
    getAuth: async () => { throw new ModelsError("oauth", 'token refresh failed: HTTP 400 {"error":"invalid_grant","refresh_token":"rt-secret"}'); },
  } as unknown as Models;
  const state = await loginState(models, { provider: "openai", modelId: "gpt-6-astra" });
  assert.deepEqual(state.refresh, { ok: false, code: "oauth" });
  assert.doesNotMatch(JSON.stringify(state), /rt-secret|invalid_grant/);
});

test("a certificate that throws while it is read becomes an unreachable fact, not an uncaught error", async (t) => {
  const dir = await tempDir("nexus-doctor-badcert-", t);
  const server = createServer(await testCertificate(dir, "dashboard.example.ts.net"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const read = TLSSocket.prototype.getPeerX509Certificate;
  TLSSocket.prototype.getPeerX509Certificate = function () { throw new Error("the certificate is malformed"); };
  t.after(() => { TLSSocket.prototype.getPeerX509Certificate = read; });
  const fact = await servedCertificate("127.0.0.1", (server.address() as import("node:net").AddressInfo).port, "dashboard.example.ts.net");
  assert.deepEqual(fact, { kind: "unreachable", hostname: "dashboard.example.ts.net", error: "its certificate does not read: the certificate is malformed" });
});

test("a source that throws fails only its own check, with the error's code and not its message, and the rest still report", async (t) => {
  const registry = testRegistry(t);
  registry.upsertNode({ name: "rj-firebat" as NodeName, tailnetHost: "rj-firebat.example.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  const failing = (code: string) => async () => { throw Object.assign(new Error("the file holds sk-secret"), { code }); };
  const r = await runDoctor({
    registry, self: "nFIREBAT" as TailnetNodeId, clock: () => start, startedAt: start,
    backupStatus: failing("EIO"), login: failing("EACCES"), certificate: failing("ECONNRESET"),
  });
  const of = (name: string) => r.checks.find((c) => c.node === null && c.name === name)!;
  assert.deepEqual([of("backup").status, of("login").status, of("certificate").status], ["fail", "fail", "fail"]);
  assert.match(of("login").text, /could not be read, with a EACCES error/);
  assert.match(of("backup").text, /EIO reading it/);
  assert.match(of("certificate").text, /ECONNRESET reading it/);
  assert.doesNotMatch(JSON.stringify(r), /sk-secret/);
  assert.deepEqual(r.checks.filter((c) => c.node !== null).map((c) => c.name), ["online", "release", "disk", "pylons"], "the node's checks still report");
});
