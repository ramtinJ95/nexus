import { copyFile, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { command, checkoutMerged, type Command, type InstallBoundary, pointLink, releaseLink, ReleaseInstaller, type Transaction } from "./install.ts";
import { controlReady, planDeploy, quarantined, schemaStep, type Attempt, type DeployStep, type ReleaseHealth, type SchemaVersions } from "./plan.ts";
import { digestPattern, type DrainBody, type DrainReply, type ReleaseReport, type ReleaseView, type ReportBody, type Role } from "../protocol/deploy.ts";
import { DeployHttpError, jsonRequest, urlHost } from "./http.ts";
import { deleteReleases, readReleases } from "./release-cleanup.ts";
import { checkControlPlaneFile, parseWorkerConfig, readControlPlane, type ControlPlane, type WorkerConfig } from "./control-plane.ts";
import { readJson, saveJson } from "../node-base/json-file.ts";
import { controlFields, listenAddress } from "../node-base/node-config.ts";
import { localApiWhois } from "../node-base/tailscaled.ts";
import type { Whois } from "../protocol/http.ts";
import { backupStatusFile, configFiles, deployerFiles, deployerLink, etc, prefix, readReleaseCommit, releasesDir, stateDirs, unitDir, unitNames } from "../node-base/node-layout.ts";

export async function runWorker(check = false): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("deployer must run as root");
  const mode = await stat(configFiles.deployer);
  if (mode.uid !== 0 || (mode.mode & 0o077) !== 0) throw new Error("deployer.json must be root-owned mode 0600");
  await checkControlPlaneFile();
  const config = parseWorkerConfig(await readJson(configFiles.deployer, null), await readControlPlane());
  const api = controlApi(config, { id: config.controlNodeId, whois: localApiWhois() });
  if (check) { await api("release"); return; }
  const roles: Role[] = [];
  for (const role of ["control", "probe"] as const) {
    try { await stat(join(prefix, deployerFiles.roles, role)); roles.push(role); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await reconcileRoles(roles, config, api, { ...nodeBoundary, worker: await workerName(prefix) });
  if (roles.includes("probe")) await cleanReleases(prefix, api).catch((error: unknown) => {
    if (!(error instanceof ControlCallFailed && error.cause instanceof DeployHttpError && error.cause.status === 404)) console.error(`release cleanup: ${String(error)}`);
  });
}

/** A call to the control plane that did not reach it, timed out, or that it answered with other than 200. */
class ControlCallFailed extends Error {}

/**
 * The worker's exit code for a poll whose call to the control plane failed, which says nothing about the worker, so
 * deploy/supervise-deployer.sh keeps the promoted worker on it. Any other failure exits 1, and the supervisor rejects it.
 */
export const controlCallFailedExit = 75;
export const exitCode = (error: unknown): number => error instanceof ControlCallFailed ? controlCallFailedExit : 1;

export function controlApi(config: WorkerConfig, peer?: { id: string; whois: Whois }): Api {
  return (path, body) => jsonRequest(new URL(`/v1/deployer/${path}`, config.controlUrl), body === undefined ? "GET" : "POST", body, config.token, peer)
    .catch((cause: unknown) => { throw new ControlCallFailed(cause instanceof Error ? cause.message : String(cause), { cause }); });
}

/**
 * `bootstrap`, or the commit of the release the supervisor promoted the worker in `root` from, or undefined when it runs
 * from neither. Node resolves deployer-current to the release it names when it loads the worker.
 */
export async function workerName(prefix: string, root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")): Promise<string | undefined> {
  if (root === join(prefix, deployerFiles.bootstrap)) return "bootstrap";
  return dirname(root) === join(prefix, releasesDir) ? await readReleaseCommit(root) ?? undefined : undefined;
}

class WaitingForControl extends Error {}

/**
 * Tells the control plane which releases the node holds, and deletes those the person agreed to delete, then reports
 * what each delete did. A control plane from before cleanup has no such route, and its 404 asks nothing.
 */
export async function cleanReleases(prefix: string, api: Api, proc = "/proc"): Promise<void> {
  const asked = await api("releases", { inventory: await readReleases(prefix, proc) }) as { delete: string[] };
  // Run with nothing to delete too, so what a delete a crash cut short set aside goes on the next poll.
  const outcomes = await deleteReleases(prefix, asked.delete, proc);
  if (asked.delete.length > 0) await api("releases", { inventory: await readReleases(prefix, proc), outcomes });
}

type Api = (path: string, body?: unknown) => Promise<any>;

/** What a control install reads of the registry, and the backup that undoes a migration. */
export interface RegistrySchema {
  /** The registry's user_version, or null before the control plane has made one. */
  version(): Promise<number | null>;
  /** How many migrations the release at `dir`, relative to the prefix, applies, or null for one from before schema.ts. */
  known(dir: string): Promise<number | null>;
  /** Runs the daily backup's unit now and resolves the backup's name. */
  backUp(): Promise<string>;
}

export interface RegistryPaths {
  /** control.json, whose `db` is the registry. */
  config: string;
  /** nexus-control.service's WorkingDirectory, which a relative `db` is resolved from. */
  home: string;
  prefix: string;
  /** The backup unit's status.json. */
  status: string;
}

/** A backup slower than this fails the install, so a migrating deploy fits inside the supervisor's 900 s with its build. */
export const backupBudgetMs = 240_000;
/** The longest a control install waits for idle in one poll, so it yields below the supervisor's 900 s. */
export const drainYieldMs = 60_000;

export function nodeRegistry(paths: RegistryPaths, run: Command = command, budgetMs = backupBudgetMs): RegistrySchema {
  return {
    async version() {
      const file = controlFields(await readJson(paths.config, null), paths.config).db;
      if (file === undefined) throw new Error(`${paths.config} has no db`);
      const path = resolve(paths.home, file);
      try { await stat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const db = new DatabaseSync(path, { readOnly: true });
      try { return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version; } finally { db.close(); }
    },
    async known(dir) {
      const file = join(resolve(paths.prefix, dir), "src/control/schema.ts");
      try { await stat(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      // schema.ts imports nothing, so a release's own list loads without its node_modules.
      return ((await import(file)) as { migrations: readonly string[] }).migrations.length;
    },
    async backUp() {
      const started = Date.now();
      // A start that joins a daily run already going returns when that run ends, so the second start runs one of its own.
      for (let tries = 0; tries < 2 && Date.now() - started < budgetMs; tries++) {
        await run("systemctl", ["start", unitNames.backup], paths.prefix, Math.max(1, budgetMs - (Date.now() - started)));
        const status = await readJson(paths.status, null) as { ranAt: string; succeeded: boolean; newest: { name: string } | null } | null;
        if (status?.succeeded === true && status.newest !== null && Date.parse(status.ranAt) >= started) return status.newest.name;
      }
      throw new Error("no backup that began after the drain sealed succeeded; see journalctl -u nexus-backup");
    },
  };
}

const nodeBoundary = { prefix, etc, units: unitDir, run: command, checkout: checkoutMerged, registry: nodeRegistry({ config: configFiles.control, home: stateDirs.control, prefix, status: backupStatusFile }) };
/** `worker` is what the role's reports say ran the poll. */
type NodeBoundary = Omit<typeof nodeBoundary, "registry"> & { registry?: RegistrySchema; worker?: string | undefined };

const restoreSteps = `deploy/README.md's "A failed deploy past a registry migration"`;
const applies = ({ release }: SchemaVersions) => release === null ? "has no src/control/schema.ts to say which migrations it applies" : `applies ${release} registry migrations`;

function controlHealth(view: ReleaseView): ReleaseHealth {
  const control = view.nodes.find((r) => r.role === "control");
  return { commit: control?.commit ?? null, healthy: control?.state === "healthy" };
}

/** deploy/'s units, installers and configs keep these names. */
function roleFiles({ prefix, etc, units }: NodeBoundary, role: Role) {
  const service = unitNames[role];
  return {
    service,
    unit: join(units, service),
    savedUnit: join(prefix, `${role}-deploy.unit`),
    report: join(prefix, `${role}-deploy-report.json`),
    config: join(etc, `${role}.json`),
    /** Relative to the deployer's checkout. */
    installer: join("deploy", `install-${role}.sh`),
    link: releaseLink(prefix, role),
  };
}

type Report = (state: ReleaseReport["state"], target: string | null, reason?: string | null) => Promise<void>;

/** What a role's steps share with the poll that runs them. */
interface RolePoll {
  api: Api;
  run: Command;
  prefix: string;
  service: string;
  config: WorkerConfig;
  registry: RegistrySchema | undefined;
  desired(): string | null;
  report: Report;
}

/** What one role does apart from the install every role shares. */
interface RoleSteps extends Required<Pick<InstallBoundary, "beforeSwitch" | "readyData" | "rollbackRefused">> {
  /** Runs once the link names the target, before the role's installer. */
  activate(): Promise<void>;
  /** Runs before a restart that keeps the target. */
  beforeRestart(): Promise<void>;
  /** Resolves true once the role may install, or false to yield this poll and keep what it holds for the next. */
  admit(next: (turnRunning: boolean) => DeployStep, requestedAt: number): Promise<boolean>;
  /** Gives back what the role held for this poll. */
  release(): Promise<void>;
}

const probeSteps = ({ api, desired }: RolePoll): RoleSteps => ({
  async beforeSwitch() {
    let view: ReleaseView;
    try { view = await api("release") as ReleaseView; }
    catch (error) {
      console.error(`probe: could not read the release view before activation: ${String(error)}`);
      throw new WaitingForControl("control readiness could not be read; retrying next poll");
    }
    const commit = desired();
    if (view.desired?.commit !== commit) throw new WaitingForControl("release superseded before activation; retrying next poll");
    if (commit === null || !controlReady(commit, controlHealth(view))) throw new WaitingForControl("control plane is not healthy on the desired release; retrying next poll");
  },
  readyData: async () => null,
  rollbackRefused: async () => null,
  activate: async () => {},
  beforeRestart: async () => {},
  admit: async () => true,
  release: async () => {},
});

/** Control holds the drain from idle through its restart, and only its code opens the registry. */
function controlSteps({ api, run, prefix, service, config, registry, desired, report }: RolePoll): RoleSteps {
  let renewal: NodeJS.Timeout | undefined;
  let drainLost = false;
  let keepDrain = false;
  const drain = async () => {
    const commit = desired();
    if (commit === null) throw new Error("no desired release to drain");
    return api("drain", { commit } satisfies DrainBody) as Promise<DrainReply>;
  };
  const schemaAt = async (dir: string): Promise<SchemaVersions> => ({ registry: await registry!.version(), release: await registry!.known(dir) });
  return {
    async beforeSwitch() {
      if (!(await api("drain", { commit: desired()!, hold: true } satisfies DrainBody)).idle) throw new Error("agent turn entered after the drain lease expired; refusing restart");
    },
    async readyData(target) {
      if (registry === undefined) return null;
      const versions = await schemaAt(target);
      const step = schemaStep(versions);
      if (step === "refuses") {
        throw new Error(`release ${desired()} ${applies(versions)}, but the registry is at schema version ${versions.registry}, so its control plane would refuse to start. Deploy a newer commit, or restore a backup from before the migration as ${restoreSteps} says`);
      }
      return step === "migrates" ? registry.backUp() : null;
    },
    async rollbackRefused(transaction) {
      if (registry === undefined) return null;
      if (schemaStep({ registry: await registry.known(transaction.target), release: await registry.known(transaction.previous) }) === "starts") return null;
      // A target still migrating, or restarted by systemd, could raise the version after it was read.
      await run("systemctl", ["stop", service], prefix, 60_000);
      // Every way on but a rollback keeps the link on the target, so the target must run again.
      const startAgain = () => run("systemctl", ["start", service], prefix, 60_000).then(() => "", (error: unknown) => `. Starting ${service} again failed too: ${String(error)}`);
      let versions: SchemaVersions;
      try { versions = await schemaAt(transaction.previous); }
      catch (error) {
        const failed = await startAgain();
        if (failed === "") throw error;
        throw new Error(`${String(error)}${failed}`);
      }
      if (schemaStep(versions) !== "refuses") return null;
      const failed = await startAgain();
      const backup = transaction.backup === undefined ? "a backup from before it" : `backup ${transaction.backup}, taken just before it,`;
      return `the registry is at schema version ${versions.registry}, and the previous release, ${transaction.previous}, ${applies(versions)}, so its control plane would refuse to start. Control stays on ${transaction.target}. Deploy a fixed commit to keep what control recorded since the migration, or restore ${backup} and point control back at ${transaction.previous}, which discards that, as ${restoreSteps} says${failed}`;
    },
    async activate() {
      const view = await api("release") as ReleaseView;
      if (view.desired?.commit !== desired()) throw new Error("release superseded before activation");
      if (drainLost || !(await drain()).idle) throw new Error("drain barrier lost before restart");
    },
    async beforeRestart() {
      if (drainLost || !(await drain()).idle) throw new Error("drain barrier lost at restart");
    },
    async admit(next, requestedAt) {
      const start = Date.now();
      while (true) {
        const status = await drain();
        const step = next(!status.idle);
        if (step.kind === "install") break;
        if (step.kind === "stop") throw new Error(step.reason);
        await report("waiting-for-idle", desired(), `Waiting for idle ${Math.floor((Date.now() - requestedAt) / 1000)}s since release request; threads: ${status.threads?.join(", ") || "unknown"}${status.entering ? "; submissions entering" : ""}`);
        // Retains the lease for the next 15-second poll.
        if (Date.now() - start >= Math.min(config.drainTimeoutMs, drainYieldMs)) { keepDrain = true; return false; }
        await sleep(1000);
      }
      renewal = setInterval(() => {
        void drain().catch((error: unknown) => { console.error(`control: drain renewal failed, so the restart will refuse: ${String(error)}`); drainLost = true; });
      }, 20_000);
      return true;
    },
    async release() {
      clearInterval(renewal);
      const commit = desired();
      if (keepDrain || commit === null) return;
      await api("drain", { commit, release: true } satisfies DrainBody).catch((error: unknown) => {
        console.error(`control: could not release the drain at ${commit}; its lease expires on its own: ${String(error)}`);
      });
    },
  };
}

const roleSteps: Record<Role, (poll: RolePoll) => RoleSteps> = { probe: probeSteps, control: controlSteps };

/** One poll. Its roles share one read of the release view, read again once control's report would change what it shows. */
export async function reconcileRoles(roles: readonly Role[], config: WorkerConfig, api: Api, boundary: NodeBoundary = nodeBoundary): Promise<void> {
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

export async function reconcileRole(role: Role, config: WorkerConfig, api: Api, boundary: NodeBoundary = nodeBoundary,
  readView: () => Promise<ReleaseView> = () => api("release")): Promise<void> {
  const { prefix, run, checkout } = boundary;
  const files = roleFiles(boundary, role);
  const { link, service } = files;
  const repo = join(prefix, deployerFiles.repo);
  const listen = listenAddress(await readJson(files.config, null), files.config);
  const healthUrl = new URL(`http://${urlHost(listen.host)}:${listen.port}/v1/health`);
  const healthy = async () => {
    const expected = await readReleaseCommit(link);
    const until = Date.now() + config.healthTimeoutMs;
    let last: unknown = null;
    do {
      try {
        await run("systemctl", ["is-active", "--quiet", service], prefix, Math.max(1, Math.min(5000, until - Date.now())));
        const answered = (await jsonRequest(healthUrl, "GET", undefined, null, undefined, Math.max(1, Math.min(10_000, until - Date.now())))).commit;
        if (answered === expected) return true;
        last = `it answered commit ${answered ?? "none"}`;
      } catch (error) { last = error; } // Retry while the service binds and the harness opens.
      await sleep(500);
    } while (Date.now() < until);
    console.error(`${role}: ${service} is not healthy at ${expected}: ${String(last)}`);
    return false;
  };
  const report: Report = async (state, target, reason = null) => {
    const wire: ReportBody = { role, commit: await readReleaseCommit(link), target, state, reason, ...boundary.worker === undefined ? {} : { worker: boundary.worker } };
    const saved = await readJson(files.report, null).catch((error: unknown) => {
      console.error(`${role}: rewriting ${files.report}, which could not be read: ${String(error)}`);
      return null;
    }) as ReleaseReport | null;
    if (saved === null || (Object.keys(wire) as (keyof typeof wire)[]).some((key) => saved[key] !== wire[key])) {
      await saveJson(files.report, { ...wire, observedAt: Date.now() });
    }
    // A control plane from before `worker` refuses a report that has it.
    await api("report", wire).catch((error: unknown) => {
      if (wire.worker === undefined || !(error instanceof ControlCallFailed && error.cause instanceof DeployHttpError && error.cause.status === 400)) throw error;
      const { worker: _, ...older } = wire;
      return api("report", older);
    }).catch((error: unknown) => { console.error(`could not report ${role} release; retained locally for the next poll: ${String(error)}`); });
  };
  const settled = (result: Transaction) => report(result.state === "installing" ? "failed" : result.state, result.commit, result.reason);
  let desired: string | null = null;
  const steps = roleSteps[role]({ api, run, prefix, service, config, registry: boundary.registry, desired: () => desired, report });
  const installer = new ReleaseInstaller(prefix, role, {
    async prepare(commit) {
      await checkout(repo, commit);
      await copyFile(files.unit, files.savedUnit);
      await run("env", [`NEXUS_COMMIT=${commit}`, "bash", "-c", '. "$1/deploy/release.sh"; install_release "$1"', "build", repo], repo);
      return `${releasesDir}/${commit}`;
    },
    beforeSwitch: steps.beforeSwitch,
    async activate() {
      await steps.activate();
      await run("env", [`NEXUS_COMMIT=${desired}`, "NEXUS_PREPARE=1", "bash", join(repo, files.installer)], repo);
    },
    readyData: steps.readyData,
    rollbackRefused: steps.rollbackRefused,
    async restart() {
      const transaction = await installer.observed();
      if (transaction !== null) {
        if (await readlink(link) === transaction.previous) {
          await copyFile(files.savedUnit, files.unit);
          await run("systemctl", ["daemon-reload"], prefix);
        } else await steps.beforeRestart();
      }
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
  const prior = await readJson(files.report, null) as ReleaseReport | null;
  const journal = await installer.observed();
  // The report also holds failures that never reached the journal, such as a failed build or a drain refusal.
  const attempts: Attempt[] = [...prior === null ? [] : [{ commit: prior.target, state: prior.state, reason: prior.reason }], ...journal === null ? [] : [journal]];
  const held = quarantined(view.desired, attempts);
  if (held !== null) {
    await report(held.state, desired, held.reason);
    await steps.release();
    return;
  }
  const current = { commit: await readReleaseCommit(link), healthy: await healthy() };
  const plan = (turnRunning: boolean) => planDeploy({ desired: view.desired, role, current, control: controlHealth(view), attempts, turnRunning });
  const step = plan(false);
  if (step.kind === "idle" || step.kind === "healthy") {
    await report(current.healthy ? "healthy" : "failed", desired, current.healthy ? null : "running release is not healthy");
    await steps.release();
    return;
  }
  if (step.kind !== "install") { await report("waiting-for-control", desired); return; }
  try {
    if (!await steps.admit(plan, view.desired!.requestedAt)) return;
    await report("installing", desired);
    const result = await installer.install(step.commit);
    await settled(result);
    if (result.state === "healthy") await promoteWorker(step.commit, repo, prefix, run);
  } catch (error) {
    await report(error instanceof WaitingForControl ? "waiting-for-control" : "failed", desired, String(error).slice(-20_000));
  } finally {
    await steps.release();
  }
}

async function promoteWorker(commit: string, repo: string, prefix: string, run: typeof command): Promise<void> {
  const target = `${releasesDir}/${commit}`;
  const rejected = join(prefix, deployerFiles.rejected);
  const marked = await readFile(rejected, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") console.error(`could not read ${rejected}, so the worker in ${target} is checked again: ${String(error)}`);
    return "";
  });
  if (marked.trim() === target) return;
  try { await run(process.execPath, [join(prefix, target, "src/deploy/worker.ts"), "--check"], repo); }
  catch (error) {
    console.error(`the worker in ${target} failed its check, so the deployer keeps its own: ${String(error)}`);
    await writeFile(rejected, target);
    return;
  }
  await pointLink(join(prefix, deployerLink), target);
}

if (import.meta.main) runWorker(process.argv.includes("--check")).catch((error: unknown) => { console.error(error); process.exitCode = exitCode(error); });
