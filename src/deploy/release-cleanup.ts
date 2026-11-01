/**
 * The releases under /opt/nexus/releases, as the deployer reads them for the control plane's cleanup, and deleting the
 * ones the person agreed to. The deployer runs as root under its lock, and a release is root-owned, so the probe can
 * neither delete one nor race an install. A release never changes once installed (deploy/release.sh), so the bytes
 * it takes are read once and kept in `deployer/release-bytes.json`.
 */
import { lstat, readdir, readFile, readlink, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readJson, saveJson } from "../json-file.ts";
import type { DeleteOutcome } from "../protocol/cleanup.ts";
import { fullCommit, type Role } from "./model.ts";

/** Named by its content hash, or by the full commit the deployer installed. */
export const releaseName = /^(?:[0-9a-f]{12}|[0-9a-f]{40})$/;

export interface ReleaseFact { name: string; commit: string | null; bytes: number; installedAt: number }

/** The node's links, and who runs the release each names. */
const links = { current: "the probe", "control-current": "the control plane", "deployer-current": "the deployer's worker" } as const;
type LinkName = keyof typeof links;
const roleLinks: Record<Role, LinkName> = { probe: "current", control: "control-current" };

export interface ReleaseInventory {
  releases: readonly ReleaseFact[];
  /** The release each link names, or null where the link is absent or names no release. */
  links: Readonly<Record<LinkName, string | null>>;
  /** The release each role's last install replaced, from its journal, while its link still names that install's target. */
  replaced: Readonly<Record<Role, string | null>>;
  /** Each release some process runs from, such as a pylon's controller, with the PID of one. */
  running: Readonly<Record<string, number>>;
}

const nameOf = (target: string | null): string | null => {
  const name = target?.match(/^(?:.*\/)?releases\/([^/]+)\/?$/)?.[1] ?? null;
  return name !== null && releaseName.test(name) ? name : null;
};

/**
 * Why each release that stays must stay: a link names it, a process runs from it, or a rollback needs it. A rollback
 * of a role goes back to the release its last install replaced, or, with no such install in its journal, to the
 * newest release installed before the one it runs, which is kept even when nothing uses it.
 */
export function releaseKeeps(inventory: ReleaseInventory): Map<string, string> {
  const keeps = new Map<string, string>();
  const keep = (name: string | null, why: string) => { if (name !== null && !keeps.has(name)) keeps.set(name, why); };
  for (const [link, name] of Object.entries(inventory.links) as [LinkName, string | null][]) keep(name, `${links[link]} runs it, through /opt/nexus/${link}`);
  for (const [name, pid] of Object.entries(inventory.running)) keep(name, `process ${pid} runs from it, as a pylon's controller does from the release it started from`);
  for (const role of ["probe", "control"] as const) {
    const current = inventory.releases.find((r) => r.name === inventory.links[roleLinks[role]]);
    if (current === undefined) continue;
    const before = inventory.replaced[role] ?? inventory.releases.filter((r) => r.installedAt < current.installedAt).sort((a, b) => b.installedAt - a.installedAt)[0]?.name ?? null;
    keep(before, `a rollback of ${links[roleLinks[role]]} needs it, as the release before the one it runs`);
  }
  return keeps;
}

/**
 * The bytes the files under `path` take on disk, links not followed. As src/disk-space.ts's, which the bootstrap worker,
 * holding only src/deploy and the files install-deployer.sh lists, cannot import.
 */
async function diskBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.blocks * 512;
  let total = info.blocks * 512;
  for (const entry of await readdir(path)) total += await diskBytes(join(path, entry));
  return total;
}

/** What each process runs from: its arguments and its working directory. One that ends meanwhile, or that root cannot read, runs nothing. */
async function runningFrom(dir: string, proc: string): Promise<Record<string, number>> {
  const running: Record<string, number> = {};
  const pids = (await readdir(proc).catch(() => [])).filter((entry) => /^\d+$/.test(entry));
  for (const pid of pids) {
    const paths = [
      ...await readFile(join(proc, pid, "cmdline"), "utf8").then((text) => text.split("\0"), () => []),
      ...await readlink(join(proc, pid, "cwd")).then((cwd) => [cwd], () => []),
    ];
    for (const path of paths) {
      if (!path.startsWith(`${dir}/`)) continue;
      const name = path.slice(dir.length + 1).split("/")[0]!;
      if (releaseName.test(name)) running[name] ??= Number(pid);
    }
  }
  return running;
}

export async function readReleases(prefix: string, proc = "/proc"): Promise<ReleaseInventory> {
  const dir = join(prefix, "releases");
  const sizesFile = join(prefix, "deployer", "release-bytes.json");
  const known = await readJson(sizesFile, {}).catch(() => ({})) as Record<string, number>;
  const names = (await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).filter((name) => releaseName.test(name)).sort();
  const releases: ReleaseFact[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    const commit = (await readFile(join(path, "release-commit"), "utf8").catch(() => "")).trim();
    releases.push({ name, commit: fullCommit.test(commit) ? commit : null, bytes: known[name] ?? await diskBytes(path), installedAt: info.mtimeMs });
  }
  const sizes = Object.fromEntries(releases.map((r) => [r.name, r.bytes]));
  if (JSON.stringify(sizes) !== JSON.stringify(Object.fromEntries(Object.entries(known).filter(([name]) => name in sizes)))) await saveJson(sizesFile, sizes, { mkdir: true });
  const linked = async (link: LinkName) => nameOf(await readlink(join(prefix, link)).catch(() => null));
  const replaced = async (role: Role) => {
    const journal = await readJson(join(prefix, `${role}-deploy.json`), null).catch(() => null) as { previous?: string; target?: string } | null;
    return journal !== null && nameOf(journal.target ?? null) !== null && nameOf(journal.target ?? null) === await linked(roleLinks[role]) ? nameOf(journal.previous ?? null) : null;
  };
  return {
    releases,
    links: { current: await linked("current"), "control-current": await linked("control-current"), "deployer-current": await linked("deployer-current") },
    replaced: { probe: await replaced("probe"), control: await replaced("control") },
    running: await runningFrom(dir, proc),
  };
}

/**
 * Deletes each named release that nothing keeps when its turn comes, read again just before, so a release a link or a
 * controller took up since the person agreed stays. A release is renamed aside first, so a crash midway leaves no
 * release with part of its files, and the next run removes what was set aside. A release already gone is `gone`, so
 * running the same delete again changes nothing.
 */
export async function deleteReleases(prefix: string, names: readonly string[], proc = "/proc"): Promise<Record<string, DeleteOutcome>> {
  const dir = join(prefix, "releases");
  for (const left of (await readdir(dir).catch(() => [])).filter((entry) => entry.startsWith(".deleting."))) await rm(join(dir, left), { recursive: true, force: true });
  const outcomes: Record<string, DeleteOutcome> = {};
  for (const name of names) {
    if (!releaseName.test(name)) { outcomes[name] = { state: "skipped", reason: `${JSON.stringify(name)} names no release` }; continue; }
    const inventory = await readReleases(prefix, proc);
    const fact = inventory.releases.find((r) => r.name === name);
    const kept = releaseKeeps(inventory).get(name);
    if (fact === undefined) outcomes[name] = { state: "gone" };
    else if (kept !== undefined) outcomes[name] = { state: "skipped", reason: kept };
    else {
      await rename(join(dir, name), join(dir, `.deleting.${name}`));
      await rm(join(dir, `.deleting.${name}`), { recursive: true, force: true });
      outcomes[name] = { state: "deleted", bytes: fact.bytes };
    }
  }
  return outcomes;
}
