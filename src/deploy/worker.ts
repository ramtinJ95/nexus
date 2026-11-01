import { copyFile, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { command, checkoutMerged, commitAt, pointLink, releaseLink, ReleaseInstaller, type Transaction } from "./install.ts";
import { planDeploy, quarantined, type Attempt, type ReleaseHealth } from "./plan.ts";
import type { DrainBody, DrainReply, ReleaseReport, ReleaseView, ReportBody, Role } from "./model.ts";
import { jsonRequest, urlHost } from "./http.ts";
import { checkControlPlaneFile, readControlPlane, type ControlPlane } from "./control-plane.ts";
import { readJson, saveJson } from "../json-file.ts";
import { localApiWhois } from "../tailscale.ts";

export interface WorkerConfig {
  controlUrl: string;
  controlNodeId: string;
  token: string;
  drainTimeoutMs: number;
  healthTimeoutMs: number;
}
/** The control plane comes from control-plane.json. The controlUrl and controlNodeId an older deployer.json holds are left for older code. */
export function parseWorkerConfig(deployer: unknown, control: ControlPlane): WorkerConfig {
  const v = deployer as WorkerConfig;
  if (typeof v !== "object" || v === null || typeof v.token !== "string" || !/^[0-9a-f]{64}$/.test(v.token) ||
      !Number.isInteger(v.drainTimeoutMs) || v.drainTimeoutMs < 0 || v.drainTimeoutMs > 600_000 ||
      !Number.isInteger(v.healthTimeoutMs) || v.healthTimeoutMs < 1000 || v.healthTimeoutMs > 60_000) throw new Error("invalid deployer.json");
  return { controlUrl: control.url, controlNodeId: control.tailnetNodeId, token: v.token, drainTimeoutMs: v.drainTimeoutMs, healthTimeoutMs: v.healthTimeoutMs };
}

const prefix = "/opt/nexus";
const configPath = "/etc/nexus/deployer.json";

export async function runWorker(check = false): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("deployer must run as root");
  const mode = await stat(configPath);
  if (mode.uid !== 0 || (mode.mode & 0o077) !== 0) throw new Error("deployer.json must be root-owned mode 0600");
  await checkControlPlaneFile();
  const config = parseWorkerConfig(await readJson(configPath, null), await readControlPlane());
  const peer = { id: config.controlNodeId, whois: localApiWhois() };
  const api = (path: string, body?: unknown) => jsonRequest(new URL(`/v1/deployer/${path}`, config.controlUrl), body === undefined ? "GET" : "POST", body, config.token, peer);
  if (check) { await api("release"); return; }
  const roles: Role[] = [];
  for (const role of ["control", "probe"] as const) {
    try { await stat(join(prefix, "deployer", "roles", role)); roles.push(role); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await reconcileRoles(roles, config, api);
}

class WaitingForControl extends Error {}

type Api = (path: string, body?: unknown) => Promise<any>;
const nodeBoundary = { prefix, etc: "/etc/nexus", units: "/etc/systemd/system", run: command, checkout: checkoutMerged };

/** What a probe plans from: control's report in the view. */
function controlHealth(view: ReleaseView): ReleaseHealth {
  const control = view.nodes.find((r) => r.role === "control");
  return { commit: control?.commit ?? null, healthy: control?.state === "healthy" };
}

/** One poll. Its roles share one read of the release view, read again once control's report would change what it shows. */
export async function reconcileRoles(roles: readonly Role[], config: WorkerConfig, api: Api, boundary = nodeBoundary): Promise<void> {
  let view: Promise<ReleaseView> | undefined;
  const reporting: Api = async (path, body) => {
    const answer = await api(path, body);
    const report = body as ReportBody;
    if (path === "report" && report.role === "control" && view !== undefined) {
      const shown = controlHealth(await view);
      if (shown.commit !== report.commit || shown.healthy !== (report.state === "healthy")) view = undefined;
    }
    return answer;
  };
  for (const role of roles) await reconcileRole(role, config, reporting, boundary, () => view ??= api("release"));
}

export async function reconcileRole(role: Role, config: WorkerConfig, api: Api, boundary = nodeBoundary,
  readView: () => Promise<ReleaseView> = () => api("release")): Promise<void> {
  const { prefix, etc, units, run, checkout } = boundary;
  const link = releaseLink(prefix, role);
  const service = `nexus-${role}.service`;
  const unit = join(units, service);
  const savedUnit = join(prefix, `${role}-deploy.unit`);
  const reportPath = join(prefix, `${role}-deploy-report.json`);
  const repo = join(prefix, "deployer", "repo");
  const local = await readJson(join(etc, `${role}.json`), null) as { listen: { host: string; port: number } };
  const healthUrl = new URL(`http://${urlHost(local.listen.host)}:${local.listen.port}/v1/health`);
  const healthy = async () => {
    const expected = await commitAt(link);
    const until = Date.now() + config.healthTimeoutMs;
    do {
      try {
        await run("systemctl", ["is-active", "--quiet", service], prefix, Math.max(1, Math.min(5000, until - Date.now())));
        if ((await jsonRequest(healthUrl, "GET", undefined, null, undefined, Math.max(1, Math.min(10_000, until - Date.now())))).commit === expected) return true;
      } catch { /* Retry while the service binds and the harness opens. */ }
      await sleep(500);
    } while (Date.now() < until);
    return false;
  };
  const report = async (state: ReleaseReport["state"], target: string | null, reason: string | null = null) => {
    const wire: ReportBody = { role, commit: await commitAt(link), target, state, reason };
    const saved = await readJson(reportPath, null).catch(() => null) as ReleaseReport | null;
    if (saved === null || (Object.keys(wire) as (keyof typeof wire)[]).some((key) => saved[key] !== wire[key])) {
      await saveJson(reportPath, { ...wire, observedAt: Date.now() });
    }
    await api("report", wire).catch(() => { console.error(`could not report ${role} release; retained locally for the next poll`); });
  };
  const settled = (result: Transaction) => report(result.state === "installing" ? "failed" : result.state, result.commit, result.reason);
  let desired: string | null = null;
  let renewal: NodeJS.Timeout | undefined;
  let drainLost = false;
  const drain = async () => {
    if (desired === null) throw new Error("no desired release to drain");
    return api("drain", { commit: desired } satisfies DrainBody) as Promise<DrainReply>;
  };
  const installer = new ReleaseInstaller(prefix, role, {
    async prepare(commit) {
      await checkout(repo, commit);
      await copyFile(unit, savedUnit);
      await run("env", [`NEXUS_COMMIT=${commit}`, "bash", "-c", '. "$1/deploy/release.sh"; install_release "$1"', "build", repo], repo);
      return `releases/${commit}`;
    },
    async beforeSwitch() {
      if (role === "probe") {
        let view: ReleaseView;
        try { view = await api("release") as ReleaseView; }
        catch { throw new WaitingForControl("control readiness could not be read; retrying next poll"); }
        if (view.desired?.commit !== desired) throw new WaitingForControl("release superseded before activation; retrying next poll");
        if (!view.nodes.some((r) => r.role === "control" && r.commit === desired && r.state === "healthy")) {
          throw new WaitingForControl("control plane is not healthy on the desired release; retrying next poll");
        }
      }
      if (role === "control" && !(await api("drain", { commit: desired!, hold: true } satisfies DrainBody)).idle) throw new Error("agent turn entered after the drain lease expired; refusing restart");
    },
    async activate() {
      if (role === "control") {
        const view = await api("release") as ReleaseView;
        if (view.desired?.commit !== desired) throw new Error("release superseded before activation");
        if (drainLost || !(await drain()).idle) throw new Error("drain barrier lost before restart");
      }
      await run("env", [`NEXUS_COMMIT=${desired}`, "NEXUS_PREPARE=1", "bash", join(repo, "deploy", `install-${role}.sh`)], repo);
    },
    async restart() {
      const transaction = await installer.observed();
      if (transaction !== null && await readlink(link) === transaction.previous) {
        await copyFile(savedUnit, unit);
        await run("systemctl", ["daemon-reload"], prefix);
      }
      if (role === "control" && transaction !== null && await readlink(link) !== transaction.previous && (drainLost || !(await drain()).idle)) throw new Error("drain barrier lost at restart");
      await run("systemctl", ["restart", service], prefix, 60_000);
    },
    healthy,
    journal: () => run("journalctl", ["-u", service, "-n", "40", "--no-pager"], prefix, 5000),
  });
  // Recovery must not depend on the API whose failed upgrade may have stopped it.
  const recovered = await installer.recover();
  if (recovered !== null) await settled(recovered);
  const view = await readView();
  desired = view.desired?.commit ?? null;
  const prior = await readJson(reportPath, null) as ReleaseReport | null;
  const journal = await installer.observed();
  // The report also holds failures that never reached the journal, such as a failed build or a drain refusal.
  const attempts: Attempt[] = [...prior === null ? [] : [{ commit: prior.target, state: prior.state, reason: prior.reason }], ...journal === null ? [] : [journal]];
  const held = quarantined(view.desired, attempts);
  if (held !== null) {
    await report(held.state, desired, held.reason);
    if (role === "control") await api("drain", { commit: desired!, release: true } satisfies DrainBody).catch(() => {});
    return;
  }
  const current = { commit: await commitAt(link), healthy: await healthy() };
  const observedControl = controlHealth(view);
  const step = planDeploy({ desired: view.desired, role, current, control: observedControl, attempts, turnRunning: false, drainStartedAt: null, drainTimeoutMs: config.drainTimeoutMs, now: Date.now() });
  if (step.kind === "idle" || step.kind === "healthy") {
    await report(current.healthy ? "healthy" : "failed", desired, current.healthy ? null : "running release is not healthy");
    if (role === "control" && desired !== null) await api("drain", { commit: desired, release: true } satisfies DrainBody).catch(() => {});
    return;
  }
  if (step.kind !== "install") { await report("waiting-for-control", desired); return; }
  try {
    if (role === "control") {
      const start = Date.now();
      while (true) {
        const status = await drain();
        const next = planDeploy({ desired: view.desired, role, current, control: observedControl, attempts, turnRunning: !status.idle, drainStartedAt: start, drainTimeoutMs: config.drainTimeoutMs, now: Date.now() });
        if (next.kind === "install") break;
        if (next.kind === "stop") throw new Error(next.reason);
        await report("waiting-for-idle", desired);
        await sleep(1000);
      }
      renewal = setInterval(() => { void drain().catch(() => { drainLost = true; }); }, 20_000);
    }
    await report("installing", desired);
    const result = await installer.install(step.commit);
    await settled(result);
    if (result.state === "healthy") await promoteWorker(step.commit, repo, prefix, run);
  } catch (error) {
    await report(error instanceof WaitingForControl ? "waiting-for-control" : "failed", desired, String(error).slice(-20_000));
  } finally {
    clearInterval(renewal);
    if (role === "control") await api("drain", { commit: desired!, release: true } satisfies DrainBody).catch(() => {});
  }
}

async function promoteWorker(commit: string, repo: string, prefix: string, run: typeof command): Promise<void> {
  const target = `releases/${commit}`;
  const rejected = await readFile(join(prefix, "deployer", "rejected"), "utf8").catch(() => "");
  if (rejected.trim() === target) return;
  try { await run(process.execPath, [join(prefix, target, "src/deploy/worker.ts"), "--check"], repo); }
  catch { await writeFile(join(prefix, "deployer", "rejected"), target); return; }
  await pointLink(join(prefix, "deployer-current"), target);
}

if (import.meta.main) runWorker(process.argv.includes("--check")).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
