import { copyFile, readFile, readlink, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { command, checkoutMerged, ReleaseInstaller } from "./install.ts";
import { planDeploy, type Role } from "./plan.ts";
import { fullCommit, type ReleaseReport, type ReleaseView } from "./model.ts";
import { jsonRequest } from "./http.ts";
import { readJson, saveJson } from "../json-file.ts";
import { localApiWhois } from "../tailscale.ts";
import { tailnetNodeIdSchema } from "../protocol.ts";

export interface WorkerConfig {
  controlUrl: string;
  controlNodeId: string;
  token: string;
  drainTimeoutMs: number;
  healthTimeoutMs: number;
}
export function parseWorkerConfig(value: unknown): WorkerConfig {
  const v = value as WorkerConfig;
  if (typeof v !== "object" || v === null || typeof v.controlUrl !== "string" ||
      !tailnetNodeIdSchema.safeParse(v.controlNodeId).success || !/^[0-9a-f]{64}$/.test(v.token) ||
      !Number.isInteger(v.drainTimeoutMs) || v.drainTimeoutMs < 0 || v.drainTimeoutMs > 600_000 ||
      !Number.isInteger(v.healthTimeoutMs) || v.healthTimeoutMs < 1000 || v.healthTimeoutMs > 60_000) throw new Error("invalid deployer.json");
  const url = new URL(v.controlUrl);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("controlUrl must be a tailnet HTTP origin");
  return v;
}

const prefix = "/opt/nexus";
const configPath = "/etc/nexus/deployer.json";
async function commitAt(link: string): Promise<string | null> {
  try {
    const commit = (await readFile(join(link, "release-commit"), "utf8")).trim();
    return fullCommit.test(commit) ? commit : null;
  } catch { return null; }
}

export async function runWorker(check = false): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("deployer must run as root");
  const mode = await stat(configPath);
  if (mode.uid !== 0 || (mode.mode & 0o077) !== 0) throw new Error("deployer.json must be root-owned mode 0600");
  const config = parseWorkerConfig(await readJson(configPath, null));
  const peer = { id: config.controlNodeId, whois: localApiWhois() };
  const api = (path: string, body?: unknown) => jsonRequest(new URL(`/v1/deployer/${path}`, config.controlUrl), body === undefined ? "GET" : "POST", body, config.token, peer);
  if (check) { await api("release"); return; }
  const roles: Role[] = [];
  for (const role of ["control", "probe"] as const) {
    try { await stat(join(prefix, "deployer", "roles", role)); roles.push(role); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const role of roles) await reconcileRole(role, config, api);
}

class WaitingForControl extends Error {}

type Api = (path: string, body?: unknown) => Promise<any>;
export async function reconcileRole(role: Role, config: WorkerConfig, api: Api, boundary = {
  prefix, etc: "/etc/nexus", units: "/etc/systemd/system", run: command, checkout: checkoutMerged,
}): Promise<void> {
  const { prefix, etc, units, run, checkout } = boundary;
  const link = join(prefix, role === "control" ? "control-current" : "current");
  const service = `nexus-${role}.service`;
  const unit = join(units, service);
  const savedUnit = join(prefix, `${role}-deploy.unit`);
  const reportPath = join(prefix, `${role}-deploy-report.json`);
  const repo = join(prefix, "deployer", "repo");
  const local = await readJson(join(etc, `${role}.json`), null) as { listen: { host: string; port: number } };
  const healthUrl = new URL(`http://${local.listen.host.includes(":") ? `[${local.listen.host}]` : local.listen.host}:${local.listen.port}/v1/health`);
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
    const value = { role, commit: await commitAt(link), target, state, reason, observedAt: Date.now() };
    await saveJson(reportPath, value);
    const { observedAt: _, ...wire } = value;
    await api("report", wire).catch(() => { console.error(`could not report ${role} release; retained locally for the next poll`); });
  };
  let desired: string | null = null;
  let renewal: NodeJS.Timeout | undefined;
  let drainLost = false;
  const drain = async () => {
    if (desired === null) throw new Error("no desired release to drain");
    return api("drain", { commit: desired }) as Promise<{ idle: boolean; expiresAt: number }>;
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
        if (!view.nodes.some((r) => r.role === "control" && r.commit === desired && r.state === "healthy" && Date.now() - r.observedAt < 90_000)) {
          throw new WaitingForControl("control plane is not freshly healthy on the desired release; retrying next poll");
        }
      }
      if (role === "control" && !(await api("drain", { commit: desired, hold: true })).idle) throw new Error("agent turn entered after the drain lease expired; refusing restart");
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
  const attempt = await installer.observed();
  if (attempt?.state === "installing") {
    const result = await installer.recover();
    await report(result.state === "healthy" ? "healthy" : result.state === "rolled-back" ? "rolled-back" : "failed", result.commit, result.reason);
  }
  const view = await api("release") as ReleaseView;
  desired = view.desired?.commit ?? null;
  const prior = await readJson(reportPath, null) as ReleaseReport | null;
  if (desired !== null && prior?.target === desired && (prior.state === "failed" || prior.state === "rolled-back")) {
    await report(prior.state, desired, prior.reason);
    if (role === "control") await api("drain", { commit: desired, release: true }).catch(() => {});
    return;
  }
  const current = { commit: await commitAt(link), healthy: await healthy() };
  const control = view.nodes.find((r) => r.role === "control");
  const observedControl = { commit: control?.commit ?? null, healthy: control?.state === "healthy" && Date.now() - control.observedAt < 90_000 };
  const step = planDeploy({ desired: view.desired, role, current, control: observedControl, attempt: null, turnRunning: false, drainStartedAt: null, drainTimeoutMs: config.drainTimeoutMs, now: Date.now() });
  if (step.kind === "idle" || step.kind === "healthy") {
    await report(current.healthy ? "healthy" : "failed", desired, current.healthy ? null : "running release is not healthy");
    if (role === "control" && desired !== null) await api("drain", { commit: desired, release: true }).catch(() => {});
    return;
  }
  if (step.kind !== "install") { await report("waiting-for-control", desired); return; }
  try {
    if (role === "control") {
      const start = Date.now();
      while (true) {
        const status = await drain();
        const next = planDeploy({ desired: view.desired, role, current, control: observedControl, attempt: null, turnRunning: !status.idle, drainStartedAt: start, drainTimeoutMs: config.drainTimeoutMs, now: Date.now() });
        if (next.kind === "install") break;
        if (next.kind === "stop") throw new Error(next.reason);
        await report("waiting-for-idle", desired);
        await sleep(1000);
      }
      renewal = setInterval(() => { void drain().catch(() => { drainLost = true; }); }, 20_000);
    }
    await report("installing", desired);
    const result = await installer.install(step.commit);
    await report(result.state === "healthy" ? "healthy" : result.state === "rolled-back" ? "rolled-back" : "failed", result.commit, result.reason);
    if (result.state === "healthy") await promoteWorker(step.commit, repo, prefix, run);
  } catch (error) {
    await report(error instanceof WaitingForControl ? "waiting-for-control" : "failed", desired, String(error).slice(-20_000));
  } finally {
    clearInterval(renewal);
    if (role === "control") await api("drain", { commit: desired, release: true }).catch(() => {});
  }
}

async function promoteWorker(commit: string, repo: string, prefix: string, run: typeof command): Promise<void> {
  const target = `releases/${commit}`;
  const rejected = await readFile(join(prefix, "deployer", "rejected"), "utf8").catch(() => "");
  if (rejected.trim() === target) return;
  try { await run(process.execPath, [join(prefix, target, "src/deploy/worker.ts"), "--check"], repo); }
  catch { await writeFile(join(prefix, "deployer", "rejected"), target); return; }
  await symlink(target, join(prefix, "deployer-current.new")).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const { unlink } = await import("node:fs/promises");
    await unlink(join(prefix, "deployer-current.new"));
    await symlink(target, join(prefix, "deployer-current.new"));
  });
  await rename(join(prefix, "deployer-current.new"), join(prefix, "deployer-current"));
}

if (import.meta.main) runWorker(process.argv.includes("--check")).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
