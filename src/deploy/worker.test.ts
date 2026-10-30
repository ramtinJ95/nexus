import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { command, ReleaseInstaller } from "./install.ts";
import { parseWorkerConfig } from "./worker.ts";
import { releaseOutcome } from "./model.ts";

const commit = "a".repeat(40);
const supervisorLacks = ["flock", "timeout", "node"].filter((tool) => !["/usr/local/bin", "/usr/bin", "/bin"].some((dir) => existsSync(join(dir, tool))));

test("worker config bounds drain and health and rejects credential-bearing endpoints", () => {
  const config = { controlUrl: "http://control:7470/", controlNodeId: "nControl", token: "a".repeat(64), drainTimeoutMs: 300000, healthTimeoutMs: 60000 };
  assert.deepEqual(parseWorkerConfig(config), config);
  for (const patch of [{ controlUrl: "http://user:pass@control/" }, { healthTimeoutMs: 0 }, { drainTimeoutMs: -1 }, { token: "" }, { controlNodeId: "control" }, { controlNodeId: ["nControl"] }]) assert.throws(() => parseWorkerConfig({ ...config, ...patch }));
});

test("wait outcome trusts the view's health from every role, whatever the caller's clock, and detects rollback and supersession", () => {
  const desired = { commit, requestedBy: "nMac", requestedAt: 0 };
  const report = { node: "node", role: "control" as const, commit, target: commit, state: "healthy" as const, reason: null, observedAt: Date.now() - 600_000 };
  assert.equal(releaseOutcome({ desired, nodes: [report] }, commit), "healthy", "a clock ahead of the control plane's does not make its view stale");
  assert.equal(releaseOutcome({ desired, nodes: [report, { ...report, role: "probe", state: "pending", reason: "deployer report is stale" }] }, commit), "pending");
  assert.equal(releaseOutcome({ desired, nodes: [{ ...report, state: "rolled-back" }] }, commit), "failed");
  assert.equal(releaseOutcome({ desired: null, nodes: [report] }, commit), "superseded");
});

test("the bootstrap that install-deployer.sh copies loads without the repo's node_modules", async (t) => {
  const repo = new URL("../../", import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), "nexus-bootstrap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await readFile(join(repo, "deploy/install-deployer.sh"), "utf8");
  const [, list, skip] = script.match(/^for source in (.+); do\n {2}\[\[ "\$source" = (\S+) \]\] \|\| install /m) ?? assert.fail("the copy loop comes from the script");
  const copied = (await command("bash", ["-c", `for source in ${list}; do [[ "$source" = ${skip} ]] || echo "$source"; done`], repo)).split("\n");
  assert.ok(copied.includes("src/deploy/worker.ts") && copied.includes("src/json-file.ts"), copied.join(" "));
  assert.deepEqual(copied.filter((file) => file.endsWith(".test.ts")), [], "the root-only bootstrap holds no tests");
  for (const file of copied) {
    await mkdir(join(dir, dirname(file)), { recursive: true });
    await cp(join(repo, file), join(dir, file));
  }
  await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
  await command(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(dir, "src/deploy/worker.ts"))})`], dir);
});

test("fixed supervisor falls back after a worker crashes or hangs, and accepts a later worker", { skip: supervisorLacks.length > 0 && `the supervisor runs on Linux nodes, and its PATH here lacks ${supervisorLacks.join(" and ")}` }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workerDir = (name: string) => join(dir, name, "src/deploy");
  for (const name of ["deployer/bootstrap", "releases/broken", "releases/fixed"]) await mkdir(workerDir(name), { recursive: true });
  const marker = join(dir, "ran");
  await writeFile(join(workerDir("deployer/bootstrap"), "worker.ts"), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'fallback\\n');`);
  await writeFile(join(workerDir("releases/fixed"), "worker.ts"), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'fixed\\n');`);
  const script = (await readFile(new URL("../../deploy/supervise-deployer.sh", import.meta.url), "utf8")).replace("prefix=/opt/nexus", `prefix=${JSON.stringify(dir)}`).replaceAll("900s", "1s");
  await writeFile(join(dir, "supervise.sh"), script);
  for (const broken of ["process.exit(1)", "setInterval(() => {}, 1000)"]) {
    await writeFile(join(workerDir("releases/broken"), "worker.ts"), broken);
    await symlink("releases/broken", join(dir, "deployer-current"));
    await command("bash", [join(dir, "supervise.sh")], dir);
    assert.equal((await readFile(join(dir, "deployer/rejected"), "utf8")).trim(), "releases/broken");
  }
  await symlink("releases/fixed", join(dir, "deployer-current"));
  await command("bash", [join(dir, "supervise.sh")], dir);
  assert.equal(await readFile(marker, "utf8"), "fallback\nfallback\nfixed\n");
});

test("activation failure rolls back through fake service executables in a temporary prefix", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink("old", join(dir, "control-current"));
  const service = join(dir, "service.sh");
  await writeFile(service, 'set -eu\nprintf "%s\\n" "$1" >> calls\n[ "$1" != healthy ] || [ "$(readlink control-current)" = old ]\n');
  const installer = new ReleaseInstaller(dir, "control", {
    prepare: async () => "new",
    restart: async () => { await command("bash", [service, "restart"], dir); },
    healthy: async () => { try { await command("bash", [service, "healthy"], dir); return true; } catch { return false; } },
    journal: async () => "fake journal",
  });
  assert.equal((await installer.install(commit)).state, "rolled-back");
  assert.equal(await readlink(join(dir, "control-current")), "old");
  assert.equal(await readFile(join(dir, "calls"), "utf8"), "restart\nhealthy\nrestart\nhealthy\n");
});

test("polling reconciles a desired control release, reports rollback and leaves the probe link alone", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { reconcileRole } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-poll-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = "b".repeat(40);
  for (const path of ["etc", "units", "deployer", `releases/${old}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${old}/release-commit`), old);
  await symlink(`releases/${old}`, join(dir, "control-current"));
  await symlink(`releases/${old}`, join(dir, "current"));
  await writeFile(join(dir, "units/nexus-control.service"), "old unit");
  let processCommit = old;
  const server = createServer((_req, res) => res.end(JSON.stringify({ commit: processCommit }))).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(join(dir, "etc/control.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  const reports: any[] = [];
  const calls: string[] = [];
  const api = async (path: string, body?: any) => {
    if (path === "release") return { desired: { commit, requestedBy: "nMac", requestedAt: 0 }, nodes: [] };
    if (path === "drain") return { idle: true };
    if (path === "report") { reports.push(body); return { ok: true }; }
    assert.fail(path);
  };
  const config = { controlUrl: "http://control/", controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
  const boundary = {
    prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"),
    async checkout() { calls.push("checkout"); },
    async run(program: string, args: readonly string[]) {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "env" && !args.includes("NEXUS_PREPARE=1")) {
        await mkdir(join(dir, `releases/${commit}`), { recursive: true });
        await writeFile(join(dir, `releases/${commit}/release-commit`), commit);
      }
      if (program === "env" && args.includes("NEXUS_PREPARE=1")) await writeFile(join(dir, "units/nexus-control.service"), "new unit");
      // The candidate process never answers with its commit; rollback starts the previous process.
      if (program === "systemctl" && args[0] === "restart") processCommit = old;
      return program === "journalctl" ? "candidate API failed" : "";
    },
  };
  await reconcileRole("control", config, api, boundary);
  assert.deepEqual(reports.map((r) => r.state), ["installing", "rolled-back"]);
  assert.match(reports.at(-1).reason, /candidate API failed/);
  assert.equal(await readFile(join(dir, "units/nexus-control.service"), "utf8"), "old unit");
  assert.equal(await readlink(join(dir, "current")), `releases/${old}`);
  assert.equal(await readlink(join(dir, "control-current")), `releases/${old}`);
  calls.length = 0;
  await reconcileRole("control", config, api, boundary);
  assert.equal(calls.length, 0, "bad commits remain quarantined, including across polling cycles");
});

test("a rolled-back install stays quarantined by its journal after its report is cleared, without draining control", async (t) => {
  const { reconcileRole } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-journal-quarantine-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = "b".repeat(40);
  for (const path of ["etc", "units", "deployer", `releases/${old}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${old}/release-commit`), old);
  await symlink(`releases/${old}`, join(dir, "control-current"));
  await writeFile(join(dir, "etc/control.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 1 } }));
  await writeFile(join(dir, "control-deploy.json"), JSON.stringify({
    commit, previous: `releases/${old}`, target: `releases/${commit}`, state: "rolled-back", reason: "candidate API failed",
  }));
  const reports: any[] = [];
  const drains: any[] = [];
  const calls: string[] = [];
  const api = async (path: string, body?: any) => {
    if (path === "release") return { desired: { commit, requestedBy: "nMac", requestedAt: 0 }, nodes: [] };
    if (path === "drain") { drains.push(body); return { idle: true, expiresAt: 0 }; }
    if (path === "report") { reports.push(body); return { ok: true }; }
    assert.fail(path);
  };
  const config = { controlUrl: "http://control/", controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
  const boundary = {
    prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"),
    async checkout() { calls.push("checkout"); },
    async run(program: string, args: readonly string[]) { calls.push(`${program} ${args.join(" ")}`); return ""; },
  };
  await reconcileRole("control", config, api, boundary);
  assert.deepEqual(drains, [{ commit, release: true }]);
  assert.deepEqual(reports.map((r) => [r.state, r.target, r.reason]), [["rolled-back", commit, "candidate API failed"]]);
  assert.deepEqual(calls, []);
});

test("a poll leaves its report as JSON private to its owner, with no temporary file beside it, and a role without its local config is refused", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { readdir, stat } = await import("node:fs/promises");
  const { reconcileRole } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ["etc", "units", "deployer", `releases/${commit}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${commit}/release-commit`), commit);
  await symlink(`releases/${commit}`, join(dir, "current"));
  const server = createServer((_req, res) => res.end(JSON.stringify({ commit }))).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = async (path: string) => {
    if (path === "release") return { desired: { commit, requestedBy: "nMac", requestedAt: 0 }, nodes: [] };
    if (path === "report") return { ok: true };
    assert.fail(path);
  };
  const config = { controlUrl: "http://control/", controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
  const boundary = { prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"), async checkout() {}, async run() { return ""; } };

  await assert.rejects(reconcileRole("probe", config, api, boundary));
  assert.equal(existsSync(join(dir, "probe-deploy-report.json")), false);

  await writeFile(join(dir, "etc/probe.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  const before = new Set(await readdir(dir));
  const start = Date.now();
  await reconcileRole("probe", config, api, boundary);
  const { observedAt, ...report } = JSON.parse(await readFile(join(dir, "probe-deploy-report.json"), "utf8"));
  assert.deepEqual(report, { role: "probe", commit, target: commit, state: "healthy", reason: null });
  assert.ok(observedAt >= start && observedAt <= Date.now());
  assert.equal((await stat(join(dir, "probe-deploy-report.json"))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter((name) => !before.has(name)), ["probe-deploy-report.json"]);
});

for (const readiness of ["stale", "unhealthy", "unreachable"] as const) test(`probe retries when control becomes ${readiness} during preparation, without switching or quarantining`, async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { reconcileRole } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-probe-poll-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = "b".repeat(40);
  for (const path of ["etc", "units", "deployer", `releases/${old}`, `releases/${commit}`]) await mkdir(join(dir, path), { recursive: true });
  for (const hash of [old, commit]) await writeFile(join(dir, `releases/${hash}/release-commit`), hash);
  await symlink(`releases/${old}`, join(dir, "current"));
  await symlink(`releases/${commit}`, join(dir, "control-current"));
  await writeFile(join(dir, "units/nexus-probe.service"), "old unit");
  let processCommit = old;
  const server = createServer((_req, res) => res.end(JSON.stringify({ commit: processCommit }))).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(join(dir, "etc/probe.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  const reports: string[] = [];
  let reads = 0;
  let activations = 0;
  let restarts = 0;
  const api = async (path: string, body?: any) => {
    if (path === "release") {
      reads++;
      if (reads === 2 && readiness === "unreachable") throw new Error("control connection lost");
      return {
        desired: { commit, requestedBy: "nMac", requestedAt: 0 },
        nodes: [{ node: "control", role: "control", commit, target: commit, reason: null,
          state: reads === 2 ? { stale: "pending", unhealthy: "failed", unreachable: "healthy" }[readiness] : "healthy",
          observedAt: Date.now() }],
      };
    }
    if (path === "report") { reports.push(body.state); return { ok: true }; }
    assert.fail(path);
  };
  const config = { controlUrl: "http://control/", controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
  const boundary = {
    prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"),
    async checkout() {},
    async run(program: string, args: readonly string[]) {
      if (program === "env" && args.includes("NEXUS_PREPARE=1")) activations++;
      if (program === "systemctl" && args[0] === "restart") { restarts++; processCommit = commit; }
      return "";
    },
  };
  await reconcileRole("probe", config, api, boundary);
  assert.equal(reads, 2, "control was fresh at planning and checked again after preparation");
  assert.deepEqual(reports, ["installing", "waiting-for-control"]);
  assert.equal(activations, 0);
  assert.equal(restarts, 0);
  assert.equal(await readlink(join(dir, "current")), `releases/${old}`);
  await assert.rejects(readFile(join(dir, "probe-deploy.json")), { code: "ENOENT" });
  await symlink("releases/interrupted", join(dir, "deployer-current.new"));
  await reconcileRole("probe", config, api, boundary);
  assert.equal(reads, 4);
  assert.deepEqual(reports, ["installing", "waiting-for-control", "installing", "healthy"]);
  assert.equal(activations, 1);
  assert.equal(restarts, 1);
  assert.equal(await readlink(join(dir, "current")), `releases/${commit}`);
  assert.equal(await readlink(join(dir, "control-current")), `releases/${commit}`);
  assert.equal(JSON.parse(await readFile(join(dir, "probe-deploy.json"), "utf8")).state, "healthy");
  assert.equal(await readlink(join(dir, "deployer-current")), `releases/${commit}`, "the checked worker is promoted over a link an interrupted swap left");
});

/** Both roles on one machine, each service answering health with its own commit, against a control plane that keeps the reports it gets. */
async function bothRoles(t: TestContext, linked: string) {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const dir = await mkdtemp(join(tmpdir(), "nexus-both-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ["etc", "units", "deployer", `releases/${linked}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${linked}/release-commit`), linked);
  const running: Record<string, string> = {};
  for (const [role, link] of [["control", "control-current"], ["probe", "current"]] as const) {
    await symlink(`releases/${linked}`, join(dir, link));
    await writeFile(join(dir, `units/nexus-${role}.service`), "unit");
    running[role] = linked;
    const server = createServer((_req, res) => res.end(JSON.stringify({ commit: running[role] }))).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    await writeFile(join(dir, `etc/${role}.json`), JSON.stringify({ listen: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  }
  const reports = new Map<string, any>();
  const posted: string[] = [];
  const control = { reads: 0, posted, reports, desired: { commit, requestedBy: "nMac", requestedAt: 0 } as object | null };
  const api = async (path: string, body?: any) => {
    if (path === "release") {
      control.reads++;
      return { desired: control.desired, nodes: [...reports.values()].map((r) => ({ node: "node", ...r,
        ...Date.now() - r.observedAt >= 90_000 ? { state: "pending", reason: "deployer report is stale" } : {} })) };
    }
    if (path === "drain") return { idle: true, expiresAt: Date.now() + 120_000 };
    if (path === "report") { reports.set(body.role, { ...body, observedAt: Date.now() }); posted.push(`${body.role} ${body.state}`); return { ok: true }; }
    assert.fail(path);
  };
  const boundary = {
    prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"),
    async checkout() {},
    async run(program: string, args: readonly string[]) {
      if (program === "env" && !args.includes("NEXUS_PREPARE=1")) {
        await mkdir(join(dir, `releases/${commit}`), { recursive: true });
        await writeFile(join(dir, `releases/${commit}/release-commit`), commit);
      }
      if (program === "systemctl" && args[0] === "restart") running[args[1]!.replace(/^nexus-|\.service$/g, "")] = commit;
      return "";
    },
  };
  const config = { controlUrl: "http://control/", controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
  return { dir, running, control, api, boundary, config };
}

test("a poll of two idle roles reads the release view once, and an unchanged report leaves its file alone", async (t) => {
  const { reconcileRoles } = await import("./worker.ts");
  const m = await bothRoles(t, commit);
  await reconcileRoles(["control", "probe"], m.config, m.api, m.boundary);
  const file = async (role: string) => {
    const path = join(m.dir, `${role}-deploy-report.json`);
    const s = await stat(path);
    return `${await readFile(path, "utf8")} ${s.ino} ${s.mtimeMs}`;
  };
  const before = [await file("control"), await file("probe")];
  m.control.reads = 0;
  m.control.posted.length = 0;
  await reconcileRoles(["control", "probe"], m.config, m.api, m.boundary);
  assert.equal(m.control.reads, 1);
  assert.deepEqual(m.control.posted, ["control healthy", "probe healthy"], "an unchanged report still reaches the control plane, which keeps it fresh");
  assert.deepEqual([await file("control"), await file("probe")], before);
  m.running.probe = "c".repeat(40);
  m.control.desired = null;
  await reconcileRoles(["control", "probe"], m.config, m.api, m.boundary);
  const { observedAt: _, ...probe } = JSON.parse(await readFile(join(m.dir, "probe-deploy-report.json"), "utf8"));
  assert.deepEqual(probe, { role: "probe", commit, target: null, state: "failed", reason: "running release is not healthy" });
});

test("a control upgrade makes the probe read the release view again, so both roles upgrade in one poll", async (t) => {
  const { reconcileRoles } = await import("./worker.ts");
  const m = await bothRoles(t, "b".repeat(40));
  await reconcileRoles(["control", "probe"], m.config, m.api, m.boundary);
  assert.deepEqual(m.control.posted, ["control installing", "control healthy", "probe installing", "probe healthy"]);
  assert.equal(m.control.reads, 4, "control plans and activates, then the probe plans and checks control again before it switches");
  assert.equal(await readlink(join(m.dir, "control-current")), `releases/${commit}`);
  assert.equal(await readlink(join(m.dir, "current")), `releases/${commit}`);
});

test("a probe a release behind reads the view again when control's unchanged report was stale there, and upgrades in the same poll", async (t) => {
  const { reconcileRoles } = await import("./worker.ts");
  const m = await bothRoles(t, "b".repeat(40));
  await mkdir(join(m.dir, `releases/${commit}`));
  await writeFile(join(m.dir, `releases/${commit}/release-commit`), commit);
  await rm(join(m.dir, "control-current"));
  await symlink(`releases/${commit}`, join(m.dir, "control-current"));
  m.running.control = commit;
  const report = { role: "control", commit, target: commit, state: "healthy", reason: null };
  await writeFile(join(m.dir, "control-deploy-report.json"), JSON.stringify({ ...report, observedAt: 0 }));
  m.control.reports.set("control", { ...report, observedAt: Date.now() - 90_001 });
  await reconcileRoles(["control", "probe"], m.config, m.api, m.boundary);
  assert.deepEqual(m.control.posted, ["control healthy", "probe installing", "probe healthy"]);
  assert.equal(JSON.parse(await readFile(join(m.dir, "control-deploy-report.json"), "utf8")).observedAt, 0, "control's report file was left as it was");
  assert.equal(await readlink(join(m.dir, "current")), `releases/${commit}`);
});
