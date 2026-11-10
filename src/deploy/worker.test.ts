import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { command, ReleaseInstaller } from "./install.ts";
import { parseWorkerConfig } from "./control-plane.ts";
import { prepareTries, retryBaseMs } from "./plan.ts";
import { releaseOutcome } from "../protocol/deploy.ts";

const commit = "a".repeat(40);
const supervisorLacks = ["flock", "timeout", "node"].filter((tool) => !["/usr/local/bin", "/usr/bin", "/bin"].some((dir) => existsSync(join(dir, tool))));

test("worker config bounds drain and health and takes the control plane from control-plane.json", () => {
  const deployer = { token: "a".repeat(64), drainTimeoutMs: 300000, healthTimeoutMs: 60000 };
  const control = { tailnetNodeId: "nControl", url: "http://control:7470/" };
  assert.deepEqual(parseWorkerConfig(deployer, control), { controlUrl: "http://control:7470/", controlNodeId: "nControl", ...deployer });
  for (const patch of [{ healthTimeoutMs: 0 }, { drainTimeoutMs: -1 }, { token: "" }]) assert.throws(() => parseWorkerConfig({ ...deployer, ...patch }, control));
});

test("wait outcome trusts the view's health from every role, whatever the caller's clock, and detects rollback and supersession", () => {
  const desired = { commit, requestedBy: "nMac", requestedAt: 0 };
  const report = { node: "node", role: "control" as const, commit, target: commit, state: "healthy" as const, reason: null, observedAt: Date.now() - 600_000 };
  assert.equal(releaseOutcome({ desired, nodes: [report] }, commit), "healthy", "a clock ahead of the control plane's does not make its view stale");
  assert.equal(releaseOutcome({ desired, nodes: [report, { ...report, role: "probe", state: "pending", reason: "deployer report is stale" }] }, commit), "pending");
  assert.equal(releaseOutcome({ desired, nodes: [{ ...report, state: "rolled-back" }] }, commit), "failed");
  assert.equal(releaseOutcome({ desired: null, nodes: [report] }, commit), "superseded");
  const again = { ...desired, requestedAt: report.observedAt + 1 };
  assert.equal(releaseOutcome({ desired: again, nodes: [{ ...report, state: "rolled-back" }] }, commit), "pending", "a deploy of the same commit again waits for a report of its own");
});

test("the bootstrap that install-deployer.sh copies loads without the repo's node_modules", async (t) => {
  const repo = new URL("../../", import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), "nexus-bootstrap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await readFile(join(repo, "deploy/install-deployer.sh"), "utf8");
  const [, list, skip] = script.match(/^for source in (.+); do\n {2}\[\[ "\$source" = (\S+) \]\] \|\| install /m) ?? assert.fail("the copy loop comes from the script");
  const copied = (await command("bash", ["-c", `for source in ${list}; do [[ "$source" = ${skip} ]] || echo "$source"; done`], repo)).split("\n");
  assert.ok(copied.includes("src/deploy/worker.ts") && copied.includes("src/node-base/json-file.ts"), copied.join(" "));
  assert.deepEqual(copied.filter((file) => !/^src\/(deploy|node-base)\/[\w-]+\.ts$/.test(file)), ["src/protocol/deploy.ts"], "the bootstrap is src/deploy and src/node-base whole, and the deploy protocol");
  assert.deepEqual(copied.filter((file) => file.endsWith(".test.ts")), [], "the root-only bootstrap holds no tests");
  for (const file of copied) {
    await mkdir(join(dir, dirname(file)), { recursive: true });
    await cp(join(repo, file), join(dir, file));
  }
  await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
  await command(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(dir, "src/deploy/worker.ts"))})`], dir);
});

test("the supervisor rejects a worker that crashes, fails to load or hangs, and keeps one whose poll could not reach the control plane", { skip: supervisorLacks.length > 0 && `the supervisor runs on Linux nodes, and its PATH here lacks ${supervisorLacks.join(" and ")}` }, async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { controlCallFailedExit } = await import("./worker.ts");
  const script = (await readFile(new URL("../../deploy/supervise-deployer.sh", import.meta.url), "utf8")).replace("900s", "${deadline:-900s}");
  const supervise = async (promoted: string) => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-supervisor-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, "ran");
    for (const [name, code] of [["deployer/bootstrap", "'bootstrap'"], ["releases/promoted", promoted]] as const) {
      await mkdir(join(dir, name, "src/deploy"), { recursive: true });
      await writeFile(join(dir, name, "src/deploy/worker.ts"), name === "deployer/bootstrap" ? `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'bootstrap\\n');` : code);
    }
    await symlink("releases/promoted", join(dir, "deployer-current"));
    // Only a worker that never exits meets the shortened deadline, so the bootstrap after it keeps the real one.
    const promotedDeadline = promoted.startsWith("setInterval") ? 'deadline=1s run_worker "$worker"' : 'run_worker "$worker"';
    await writeFile(join(dir, "supervise.sh"), script.replace("prefix=/opt/nexus", `prefix=${JSON.stringify(dir)}`).replace('run_worker "$worker"', promotedDeadline));
    const { status } = spawnSync("bash", [join(dir, "supervise.sh")], { cwd: dir });
    return { status, ran: existsSync(marker) ? await readFile(marker, "utf8") : "", rejected: existsSync(join(dir, "deployer/rejected")) ? (await readFile(join(dir, "deployer/rejected"), "utf8")).trim() : null, current: existsSync(join(dir, "deployer-current")) };
  };
  for (const [worker, code] of [["succeeds", "process.exit(0)"], ["could not reach the control plane", `process.exit(${controlCallFailedExit})`]]) {
    assert.deepEqual(await supervise(code!), { status: code === "process.exit(0)" ? 0 : controlCallFailedExit, ran: "", rejected: null, current: true }, `a worker that ${worker} stays promoted and the bootstrap does not run`);
  }
  for (const [worker, code] of [["exits 1", "process.exit(1)"], ["fails to load", "import './missing.ts';"], ["exits as a timeout does", "process.exit(124)"], ["hangs", "setInterval(() => {}, 1000)"]]) {
    assert.deepEqual(await supervise(code!), { status: 0, ran: "bootstrap\n", rejected: "releases/promoted", current: false }, `a worker that ${worker} is rejected and the bootstrap runs`);
  }
});

test("a poll whose call to the control plane fails or is refused exits with the code the supervisor keeps the worker on, and a crash exits 1", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { reconcileRoles, controlApi, exitCode, controlCallFailedExit } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-exit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ["etc", "units", "deployer", `releases/${commit}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${commit}/release-commit`), commit);
  await symlink(`releases/${commit}`, join(dir, "current"));
  await writeFile(join(dir, "etc/probe.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 1 } }));
  const refusing = createServer((_req, res) => { res.statusCode = 503; res.end("control plane is restarting"); }).listen(0, "127.0.0.1");
  const closed = createServer().listen(0, "127.0.0.1");
  await Promise.all([once(refusing, "listening"), once(closed, "listening")]);
  t.after(() => { refusing.closeAllConnections(); refusing.close(); });
  const url = (server: typeof closed) => `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const down = url(closed);
  closed.close();
  await once(closed, "close");
  const boundary = { prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"), async checkout() {}, async run() { return ""; } };
  const poll = (controlUrl: string) => {
    const config = { controlUrl, controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
    return reconcileRoles(["probe"], config, controlApi(config), boundary).then(() => assert.fail("the poll fails"), (error: unknown) => error);
  };
  for (const [control, controlUrl] of [["unreachable", down], ["refusing the call", url(refusing)]]) {
    const error = await poll(controlUrl!);
    assert.equal(exitCode(error), controlCallFailedExit, `a control plane ${control}: ${String(error)}`);
  }
  await rm(join(dir, "etc/probe.json"));
  assert.equal(exitCode(await poll(url(refusing))), 1, "a poll that fails before it calls the control plane is the worker's fault");
  assert.equal(exitCode(new Error("crash")), 1);
});

test("a report says which worker sent it, and goes again without that to a control plane from before the field", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { reconcileRole, controlApi } = await import("./worker.ts");
  const { reportSchema } = await import("../contract/release-parse.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-worker-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ["etc", "units", "deployer", `releases/${commit}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${commit}/release-commit`), commit);
  await symlink(`releases/${commit}`, join(dir, "current"));
  let older = false;
  const received: unknown[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.url === "/v1/health") return res.end(JSON.stringify({ commit }));
    if (req.url === "/v1/deployer/release") return res.end(JSON.stringify({ desired: { commit, requestedBy: "nMac", requestedAt: 0 }, nodes: [] }));
    assert.equal(req.url, "/v1/deployer/report");
    const parsed = (older ? reportSchema.omit({ worker: true }) : reportSchema).safeParse(JSON.parse(text));
    if (!parsed.success) { res.statusCode = 400; return res.end(parsed.error.message); }
    received.push(parsed.data);
    res.end(JSON.stringify({ ok: true }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  await writeFile(join(dir, "etc/probe.json"), JSON.stringify({ listen: { host: "127.0.0.1", port } }));
  const config = { controlUrl: `http://127.0.0.1:${port}/`, controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 60_000, drainTimeoutMs: 0 };
  const boundary = { prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"), worker: "bootstrap", async checkout() {}, async run() { return ""; } };
  const healthy = { role: "probe", commit, target: commit, state: "healthy", reason: null };
  await reconcileRole("probe", config, controlApi(config), boundary);
  older = true;
  await reconcileRole("probe", config, controlApi(config), boundary);
  assert.deepEqual(received, [{ ...healthy, worker: "bootstrap" }, healthy]);
  const { observedAt: _, ...saved } = JSON.parse(await readFile(join(dir, "probe-deploy-report.json"), "utf8"));
  assert.deepEqual(saved, { ...healthy, worker: "bootstrap", requestedAt: 0 });
});

test("a worker loaded through deployer-current names the release it was promoted from, and the bootstrap names itself", async (t) => {
  const repo = new URL("../../", import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), "nexus-worker-name-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const copy of [`releases/${commit}`, "deployer/bootstrap"]) {
    for (const source of ["src/deploy", "src/node-base", "src/protocol"]) await cp(join(repo, source), join(dir, copy, source), { recursive: true });
    await writeFile(join(dir, copy, "package.json"), '{"type":"module"}\n');
  }
  await writeFile(join(dir, `releases/${commit}/release-commit`), commit);
  await symlink(`releases/${commit}`, join(dir, "deployer-current"));
  const linked = `${dir}-link`;
  await symlink(dir, linked);
  t.after(() => rm(linked, { force: true }));
  const name = async (copy: string) => ((await import(join(dir, copy, "src/deploy/worker.ts"))) as typeof import("./worker.ts")).workerName(linked);
  assert.equal(await name("deployer-current"), commit, "a prefix reached through a symlink still names the release");
  assert.equal(await name("deployer/bootstrap"), "bootstrap");
  assert.equal(await (await import("./worker.ts")).workerName(dir), undefined, "a worker run from a checkout names no release");
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

test("a failed deploy that migrated the registry stays on its release with a backup taken first, and a rollback past the migration is refused before it switches", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { reconcileRole } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = "b".repeat(40);
  for (const path of ["etc", "units", "deployer", `releases/${old}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${old}/release-commit`), old);
  await symlink(`releases/${old}`, join(dir, "control-current"));
  await writeFile(join(dir, "units/nexus-control.service"), "old unit");
  // Neither release ever answers health with its own commit, so every install fails its health check.
  const server = createServer((_req, res) => res.end(JSON.stringify({ commit: "c".repeat(40) }))).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(join(dir, "etc/control.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: (server.address() as { port: number }).port } }));
  let desired = commit;
  let schema = 3;
  const reports: any[] = [];
  const calls: string[] = [];
  const api = async (path: string, body?: any) => {
    if (path === "release") return { desired: { commit: desired, requestedBy: "nMac", requestedAt: 0 }, nodes: [] };
    if (path === "drain") { if (body.hold) calls.push("drain hold"); return { idle: true }; }
    if (path === "report") { reports.push(body); return { ok: true }; }
    assert.fail(path);
  };
  const config = { controlUrl: "http://control/", controlNodeId: "nControl", token: "a".repeat(64), healthTimeoutMs: 1000, drainTimeoutMs: 0 };
  const boundary = {
    prefix: dir, etc: join(dir, "etc"), units: join(dir, "units"),
    async checkout() {},
    async run(program: string, args: readonly string[]) {
      const release = args.find((a) => a.startsWith("NEXUS_COMMIT="))?.slice("NEXUS_COMMIT=".length);
      if (program === "env" && !args.includes("NEXUS_PREPARE=1")) {
        await mkdir(join(dir, `releases/${release}`), { recursive: true });
        await writeFile(join(dir, `releases/${release}/release-commit`), release!);
      }
      if (program === "env" && args.includes("NEXUS_PREPARE=1")) calls.push(`activate ${release}`);
      if (program === "systemctl" && (args[0] === "stop" || args[0] === "start")) calls.push(args[0]);
      if (program === "systemctl" && args[0] === "restart") {
        calls.push(`restart ${await readlink(join(dir, "control-current"))}`);
        if (await readlink(join(dir, "control-current")) === `releases/${commit}`) schema = 4;
      }
      return "";
    },
    registry: {
      version: async () => schema,
      known: async (release: string): Promise<number> => release === `releases/${commit}` ? 4 : 3,
      backUp: async () => { calls.push(`backup at ${schema}`); return "2026-11-04T00-00-00Z"; },
    },
  };

  await reconcileRole("control", config, api, boundary);
  assert.deepEqual(calls, ["drain hold", "backup at 3", `activate ${commit}`, `restart releases/${commit}`, "stop", "start"],
    "the backup comes after the drain seals and before the link moves, and the registry is read with the target stopped");
  assert.deepEqual(reports.map((r) => r.state), ["installing", "failed"]);
  assert.match(reports.at(-1).reason, /not rolled back: the registry is at schema version 4, and the previous release, releases\/b{40}, applies 3 registry migrations/);
  assert.match(reports.at(-1).reason, /restore backup 2026-11-04T00-00-00Z, taken just before it,/);
  assert.equal(await readlink(join(dir, "control-current")), `releases/${commit}`);
  assert.equal(JSON.parse(await readFile(join(dir, "control-deploy.json"), "utf8")).backup, "2026-11-04T00-00-00Z");

  calls.length = 0;
  desired = old;
  await reconcileRole("control", config, api, boundary);
  assert.deepEqual(calls, ["drain hold"], "a release older than the registry never backs up, switches or restarts");
  assert.equal(reports.at(-1).state, "failed");
  assert.equal(reports.at(-1).target, old);
  assert.match(reports.at(-1).reason, new RegExp(`release ${old} applies 3 registry migrations, but the registry is at schema version 4`));
  assert.equal(await readlink(join(dir, "control-current")), `releases/${commit}`);
  const third = "d".repeat(40);
  await rm(join(dir, "control-deploy-report.json"));
  await rm(join(dir, "control-deploy.json"));
  calls.length = 0;
  desired = third;
  boundary.registry.known = async (release) => release === `releases/${third}` ? 5 : release === `releases/${commit}` ? 4 : 3;
  const version = boundary.registry.version;
  boundary.registry.version = async () => { if (calls.includes("stop")) throw new Error("registry unreadable"); return version(); };
  await reconcileRole("control", config, api, boundary);
  assert.deepEqual(calls.slice(-2), ["stop", "start"], "a control plane stopped for a check that failed is started again");
  assert.equal(reports.at(-1).state, "failed");
  assert.match(reports.at(-1).reason, /not rolled back: whether the previous release can start could not be read: Error: registry unreadable/);
  assert.equal(await readlink(join(dir, "control-current")), `releases/${third}`);
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
  let requestedAt = 0;
  let busy = false;
  const api = async (path: string, body?: any) => {
    if (path === "release") return { desired: { commit, requestedBy: "nMac", requestedAt }, nodes: [] };
    if (path === "drain") { drains.push(body); return { idle: !busy, expiresAt: 0 }; }
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
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await readFile(join(dir, "control-deploy.json"), "utf8")).requestedAt, 0, "a journal from before requestedAt is held for the request desired when it was read");
  requestedAt = 1;
  busy = true;
  for (let poll = 0; poll < 2; poll++) {
    await reconcileRole("control", config, api, boundary);
    assert.equal(reports.at(-1).state, "waiting-for-idle", "a new request is not held by the old journal, even once a report names the new request");
  }
  busy = false;
  await reconcileRole("control", config, api, boundary);
  assert.ok(calls.includes("checkout"), "a new request for the commit tries it again");
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
  assert.deepEqual(report, { role: "probe", commit, target: commit, state: "healthy", reason: null, requestedAt: 0 });
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

test("a control upgrade lets the probe see control healthy on the new release, so both roles upgrade in one poll", async (t) => {
  const { reconcileRoles } = await import("./worker.ts");
  const m = await bothRoles(t, "b".repeat(40));
  await reconcileRoles(["control", "probe"], m.config, m.api, m.boundary);
  assert.deepEqual(m.control.posted, ["control installing", "control healthy", "probe installing", "probe healthy"]);
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
  await writeFile(join(m.dir, "control-deploy-report.json"), JSON.stringify({ ...report, requestedAt: 0, observedAt: 0 }));
  m.control.reports.set("control", { ...report, observedAt: Date.now() - 90_001 });
  await reconcileRoles(["control", "probe"], m.config, m.api, m.boundary);
  assert.deepEqual(m.control.posted, ["control healthy", "probe installing", "probe healthy"]);
  assert.equal(JSON.parse(await readFile(join(m.dir, "control-deploy-report.json"), "utf8")).observedAt, 0, "control's report file was left as it was");
  assert.equal(await readlink(join(m.dir, "current")), `releases/${commit}`);
});

test("busy turns outlast the old timeout across polls without quarantine, then a real install failure quarantines", async (t) => {
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
  const drains: { commit: string; release?: boolean; hold?: boolean }[] = [];
  let busy = true;
  let requestedAt = 0;
  const api = async (path: string, body?: any) => {
    if (path === "release") return { desired: { commit, requestedBy: "nMac", requestedAt }, nodes: [] };
    if (path === "drain") { drains.push(body); return { idle: !busy, threads: busy ? ["th-builder"] : [] }; }
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
  for (let poll = 0; poll < 2; poll++) {
    await reconcileRole("control", config, api, boundary);
    assert.equal(reports.at(-1).state, "waiting-for-idle");
    assert.match(reports.at(-1).reason, /threads: th-builder/);
    assert.ok(!calls.includes("checkout"));
    assert.deepEqual(drains, Array.from({ length: poll + 1 }, () => ({ commit })), "waiting polls renew the lease without releasing admission");
  }
  drains.length = 0;
  busy = false;
  reports.length = 0;
  await reconcileRole("control", config, api, boundary);
  assert.deepEqual(reports.map((r) => r.state), ["installing", "rolled-back"]);
  assert.deepEqual(drains.filter((body) => body.release), [{ commit, release: true }]);
  assert.deepEqual(drains.at(-1), { commit, release: true }, "the settled install releases the lease");
  assert.match(reports.at(-1).reason, /candidate API failed/);
  assert.equal(await readFile(join(dir, "units/nexus-control.service"), "utf8"), "old unit");
  assert.equal(await readlink(join(dir, "current")), `releases/${old}`);
  assert.equal(await readlink(join(dir, "control-current")), `releases/${old}`);
  calls.length = 0;
  await reconcileRole("control", config, api, boundary);
  assert.equal(calls.length, 0, "bad commits remain quarantined, including across polling cycles");
  requestedAt = 1;
  reports.length = 0;
  await reconcileRole("control", config, api, boundary);
  assert.ok(calls.includes("checkout"), "running nexus deploy for the commit again tries it again");
  assert.deepEqual(reports.map((r) => r.state), ["installing", "rolled-back"]);
  calls.length = 0;
  await reconcileRole("control", config, api, boundary);
  assert.equal(calls.length, 0, "the rollback at the new request is quarantined too");
});

test("a failure before the link switch is tried again after a doubling wait and then installs, and the last allowed try quarantines until the commit is requested again", async (t) => {
  const { reconcileRole } = await import("./worker.ts");
  const old = "b".repeat(40);
  const m = await bothRoles(t, old);
  let clock = 1_000;
  let fetches = 0;
  let offline = true;
  const boundary = { ...m.boundary, now: () => clock, async checkout() { fetches++; if (offline) throw new Error("git fetch: Could not resolve host: github.com"); } };
  const saved = async () => JSON.parse(await readFile(join(m.dir, "control-deploy-report.json"), "utf8"));
  const poll = async () => { m.control.posted.length = 0; await reconcileRole("control", m.config, m.api, boundary); return m.control.reports.get("control"); };

  let report = await poll();
  assert.deepEqual(m.control.posted, ["control installing", "control pending"]);
  assert.equal(report.reason, `try 1 of ${prepareTries} failed before the link switch, so it runs again after ${new Date(clock + retryBaseMs).toISOString()}: Error: git fetch: Could not resolve host: github.com`);
  assert.equal(await readlink(join(m.dir, "control-current")), `releases/${old}`, "the running release is left as it was");
  clock += retryBaseMs - 1;
  report = await poll();
  assert.equal(fetches, 1, "a poll inside the wait does not try again");
  assert.deepEqual(m.control.posted, ["control pending"]);
  assert.match(report.reason, /^try 1 of/);
  clock += 1;
  report = await poll();
  assert.equal(fetches, 2);
  assert.match(report.reason, /^try 2 of/);
  assert.equal((await saved()).retryAt, clock + 2 * retryBaseMs, "the wait doubles");
  clock = (await saved()).retryAt;
  offline = false;
  await poll();
  assert.deepEqual(m.control.posted, ["control installing", "control healthy"]);
  assert.equal(await readlink(join(m.dir, "control-current")), `releases/${commit}`);

  await rm(join(m.dir, "control-current"));
  await symlink(`releases/${old}`, join(m.dir, "control-current"));
  m.running.control = old;
  m.control.desired = { commit, requestedBy: "nMac", requestedAt: 1 };
  offline = true;
  fetches = 0;
  for (let tries = 1; tries <= prepareTries; tries++) {
    report = await poll();
    clock = (await saved()).retryAt ?? clock;
  }
  assert.equal(fetches, prepareTries);
  assert.equal(report.state, "failed");
  assert.match(report.reason, new RegExp(`^${prepareTries} tries failed before the link switch, so this request is quarantined until the commit is requested again\\. The last: Error: git fetch`));
  clock += 24 * 60 * 60_000;
  offline = false;
  await poll();
  assert.equal(fetches, prepareTries, "the quarantined request is not tried again");
  assert.deepEqual(m.control.posted, ["control failed"]);
  m.control.desired = { commit, requestedBy: "nMac", requestedAt: 2 };
  await poll();
  assert.deepEqual(m.control.posted, ["control installing", "control healthy"], "a new request for the commit clears the quarantine");
  assert.equal((await saved()).failed, undefined, "the new request starts its count again");
});

test("the node's registry reads give the registry's version and a release's migrations, and null only for what does not exist yet", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { nodeRegistry } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ["home", "releases/new/src/control", "releases/old/src/deploy", "releases/broken/src/control"]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, "control.json"), JSON.stringify({ db: "registry.db" }));
  const registry = nodeRegistry({ config: join(dir, "control.json"), home: join(dir, "home"), prefix: dir, status: join(dir, "status.json") });
  assert.equal(await registry.version(), null, "the control plane has not made a registry yet");
  const db = new DatabaseSync(join(dir, "home/registry.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); PRAGMA user_version = 7");
  assert.equal(await registry.version(), 7, "read while another connection holds the registry open");
  db.close();
  await writeFile(join(dir, "releases/new/src/control/schema.ts"), "export const migrations: readonly string[] = [`CREATE TABLE a (x)`, `CREATE TABLE b (x)`];\n");
  assert.equal(await registry.known("releases/new"), 2);
  assert.equal(await registry.known(join(dir, "releases/new")), 2, "an absolute link target");
  assert.equal(await registry.known("releases/old"), null, "a release from before schema.ts");
  await writeFile(join(dir, "releases/broken/src/control/schema.ts"), "export const migrations = [;\n");
  await assert.rejects(registry.known("releases/broken"), SyntaxError);
});

test("a backup before a migration counts only a successful run that began after it was asked for, and gives up within its budget", async (t) => {
  const { nodeRegistry } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-backup-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const status = join(dir, "status.json");
  const paths = { config: join(dir, "control.json"), home: dir, prefix: dir, status };
  const write = (ranAt: Date, succeeded = true) => writeFile(status, JSON.stringify({ ranAt: ranAt.toISOString(), succeeded, newest: { name: `backup-${ranAt.getTime()}`, verified: succeeded, createdAt: ranAt.toISOString() } }));
  const stale = new Date(Date.now() - 60_000);
  let starts: number[] = [];
  const run = (runs: ((n: number) => Promise<void>)[]) => async (program: string, args: readonly string[], _cwd: string, timeoutMs?: number) => {
    assert.deepEqual([program, ...args], ["systemctl", "start", "nexus-backup.service"]);
    starts.push(timeoutMs!);
    await runs[starts.length - 1]!(starts.length);
    return "";
  };

  const fresh = new Date(Date.now() + 1000);
  assert.equal(await nodeRegistry(paths, run([() => write(stale), () => write(fresh)])).backUp(), `backup-${fresh.getTime()}`, "a start that joined an earlier run starts once more");
  assert.equal(starts.length, 2);

  starts = [];
  await assert.rejects(nodeRegistry(paths, run([() => write(stale), () => write(stale)])).backUp(), /no backup that began after the drain sealed succeeded/, "a status left by an earlier run, as when the status write failed");
  assert.equal(starts.length, 2);

  starts = [];
  await assert.rejects(nodeRegistry(paths, run([() => write(new Date(Date.now() + 1000), false), () => write(new Date(Date.now() + 1000), false)])).backUp(), /did not succeed|no backup/);

  starts = [];
  await assert.rejects(nodeRegistry(paths, run([async () => { await new Promise((r) => setTimeout(r, 60)); await write(stale); }]), 50).backUp(), /no backup/);
  assert.equal(starts.length, 1, "no second start once the budget is spent");
  assert.ok(starts[0]! <= 50, "each start is bounded by what is left of the budget");
});

test("a target whose schema.ts fails to load fails its try with that error before the link switch, rather than reading as a release from before schema.ts", async (t) => {
  const { reconcileRole, nodeRegistry } = await import("./worker.ts");
  const dir = await mkdtemp(join(tmpdir(), "nexus-broken-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = "b".repeat(40);
  for (const path of ["etc", "units", "deployer", "home", `releases/${old}`]) await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, `releases/${old}/release-commit`), old);
  await symlink(`releases/${old}`, join(dir, "control-current"));
  await writeFile(join(dir, "units/nexus-control.service"), "old unit");
  await writeFile(join(dir, "etc/control.json"), JSON.stringify({ db: "registry.db", listen: { host: "127.0.0.1", port: 1 } }));
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
    async checkout() {},
    async run(program: string, args: readonly string[]) {
      if (program === "env" && !args.includes("NEXUS_PREPARE=1")) {
        await mkdir(join(dir, `releases/${commit}/src/control`), { recursive: true });
        await writeFile(join(dir, `releases/${commit}/release-commit`), commit);
        await writeFile(join(dir, `releases/${commit}/src/control/schema.ts`), "export const migrations = [;\n");
      }
      if (program === "env" && args.includes("NEXUS_PREPARE=1") || program === "systemctl" && args[0] === "restart") calls.push(`${program} ${args.join(" ")}`);
      return "";
    },
    registry: nodeRegistry({ config: join(dir, "etc/control.json"), home: join(dir, "home"), prefix: dir, status: join(dir, "status.json") }),
  };
  await reconcileRole("control", config, api, boundary);
  assert.deepEqual(reports.map((r) => r.state), ["installing", "pending"], "a failure before the link switch is tried again");
  assert.match(reports.at(-1).reason, /^try 1 of 5 failed before the link switch, .*SyntaxError/s);
  assert.doesNotMatch(reports.at(-1).reason, /has no src\/control\/schema\.ts/);
  assert.deepEqual(calls, [], "the target never activates or restarts");
  assert.equal(await readlink(join(dir, "control-current")), `releases/${old}`);
  await writeFile(join(dir, `releases/${commit}/src/control/schema.ts`), 'import "./missing.ts";\nexport const migrations = [];\n');
  await assert.rejects(boundary.registry.known(`releases/${commit}`), { code: "ERR_MODULE_NOT_FOUND" }, "a schema.ts whose own import is missing is not a release from before schema.ts");
});
