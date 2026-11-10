/**
 * `node src/deploy/installed.ts <prefix> <etc>` prints what `deploy/install.sh --check` finds wrong with an installed
 * machine beyond its units, each problem a line and its fix, ended by a NUL. Each link of an installed role must name a
 * release that exists and holds the desired release, and each config file must parse. It changes nothing. It runs from
 * a checkout before npm ci, so it imports only Node's builtins and modules that do too, and it loads the parsers of
 * control.json, probe.json and secrets.env from the installed release that reads each, which holds their dependencies.
 */
import { readdir, readlink, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkControlPlaneFile, parseWorkerConfig, readControlPlane, type WorkerConfig } from "./control-plane.ts";
import { controlApi } from "./worker.ts";
import { readJson } from "../node-base/json-file.ts";
import { localApiWhois } from "../node-base/tailscaled.ts";
import { configFiles, deployerFiles, deployerLink, links, readReleaseCommit, releaseName, releasesDir, roleLinks, type LinkName } from "../node-base/node-layout.ts";
import type { ReleaseView, Role } from "../protocol/deploy.ts";

export interface Problem { what: string; fix: string }

/** The commit the control plane wants installed, or null when it wants none. */
export type ReadDesired = (config: WorkerConfig) => Promise<string | null>;

/** Each config file a release parses, the role whose release reads it, and the module and export that read it. */
const releaseParsers = [
  { file: "control", role: "control", module: "src/control/main.ts", read: "readConfig" },
  { file: "probe", role: "probe", module: "src/probe/config.ts", read: "readProbeConfig" },
  { file: "secrets", role: "probe", module: "src/probe/config.ts", read: "readSecretsFile" },
] as const satisfies readonly { file: keyof typeof configFiles; role: Role; module: string; read: string }[];

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const named = (path: string, error: unknown) => message(error).includes(path) ? message(error) : `${path}: ${message(error)}`;
const correct = (path: string) => `Correct ${path} as deploy/README.md describes it, then run sudo deploy/install.sh --check again`;

export async function installedProblems(prefix: string, etc: string, readDesired: ReadDesired): Promise<Problem[]> {
  const roles = (await readdir(join(prefix, deployerFiles.roles)).catch((): string[] => [])).filter((role): role is Role => role === "control" || role === "probe");
  if (roles.length === 0) return [];
  const problems: Problem[] = [];
  const at = (file: keyof typeof configFiles) => join(etc, basename(configFiles[file]));

  const releases = new Map<LinkName, string>();
  // The supervisor points deployer-current at a release only once its worker passes, so a machine may have none.
  for (const link of [...roles.map((role) => roleLinks[role]), deployerLink]) {
    const path = join(prefix, link);
    const target = await readlink(path).catch(() => null);
    if (target === null) {
      if (link !== deployerLink) problems.push({ what: `${path} is missing, so ${links[link]} has no release.`, fix: "sudo deploy/install.sh installs this checkout's release for it" });
      continue;
    }
    const name = target.startsWith(`${releasesDir}/`) ? target.slice(releasesDir.length + 1) : "";
    const dir = join(prefix, releasesDir, name);
    if (!releaseName.test(name) || !await stat(dir).then((s) => s.isDirectory(), () => false)) {
      problems.push({ what: `${path} points at ${target}, which is no release in ${join(prefix, releasesDir)}.`, fix: "sudo deploy/install.sh --upgrade installs this checkout's release and points the link at it" });
      continue;
    }
    releases.set(link, dir);
  }

  let worker: WorkerConfig | undefined;
  try {
    const control = await readControlPlane(at("controlPlane"));
    await checkControlPlaneFile(at("controlPlane"));
    try {
      const { uid, mode } = await stat(at("deployer"));
      if (uid !== process.getuid?.() || (mode & 0o077) !== 0) throw new Error("must belong to root, mode 0600");
      worker = parseWorkerConfig(await readJson(at("deployer"), null), control);
    } catch (error) {
      problems.push({ what: `${named(at("deployer"), error)}.`, fix: correct(at("deployer")) });
    }
  } catch (error) {
    problems.push({ what: `${named(at("controlPlane"), error)}.`, fix: correct(at("controlPlane")) });
  }

  for (const parser of releaseParsers) {
    const dir = releases.get(roleLinks[parser.role]);
    if (!roles.includes(parser.role) || dir === undefined) continue;
    const path = at(parser.file);
    try {
      const read: unknown = (await import(pathToFileURL(join(dir, parser.module)).href) as Record<string, unknown>)[parser.read];
      if (typeof read !== "function") throw new Error(`release ${basename(dir)} has no ${parser.read} in ${parser.module} to check it with`);
      await read(path);
    } catch (error) {
      problems.push({ what: `${named(path, error)}.`, fix: correct(path) });
    }
  }

  if (worker === undefined || releases.size === 0) return problems;
  let desired: string | null;
  try {
    desired = await readDesired(worker);
  } catch (error) {
    problems.push({ what: `The desired release could not be read from the control plane at ${worker.controlUrl}: ${message(error)}.`, fix: "journalctl -u nexus-deployer -n 50 shows the deployer's polls, which read it the same way" });
    return problems;
  }
  if (desired === null) return problems;
  for (const [link, dir] of releases) {
    const commit = await readReleaseCommit(dir);
    if (commit !== desired) {
      problems.push({
        what: `${join(prefix, link)} runs ${commit ?? `release ${basename(dir)}, which records no commit`}, and the desired release is ${desired}.`,
        fix: "nexus release says where the deploy stands, and sudo systemctl start nexus-deployer.service polls now",
      });
    }
  }
  return problems;
}

export const formatProblem = ({ what, fix }: Problem) => `- ${what}\n    ${fix}`;

const controlDesired: ReadDesired = async (config) => {
  const view = await controlApi(config, { id: config.controlNodeId, whois: localApiWhois() })("release") as ReleaseView;
  return view.desired?.commit ?? null;
};

if (import.meta.main) {
  const [prefix, etc] = process.argv.slice(2);
  if (prefix === undefined || etc === undefined) {
    console.error("usage: node src/deploy/installed.ts <prefix> <etc>");
    process.exitCode = 1;
  } else {
    for (const problem of await installedProblems(prefix, etc, controlDesired)) process.stdout.write(`${formatProblem(problem)}\0`);
  }
}
