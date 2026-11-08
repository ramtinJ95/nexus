import { execFile } from "node:child_process";
import { mkdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readJson, saveJson } from "../node-base/json-file.ts";
import { deployJournal, roleLinks, rootPath } from "../node-base/node-layout.ts";
import { fullCommit, type Role } from "../protocol/deploy.ts";

const exec = promisify(execFile);
export const repository = "https://github.com/ramtinJ95/nexus.git";

/** No inherited credentials, git configuration or npm configuration crosses the process boundary. */
export async function command(program: string, args: readonly string[], cwd: string, timeoutMs = 300_000): Promise<string> {
  const { stdout } = await exec(program, [...args], {
    cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    env: { PATH: rootPath, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

export type Command = typeof command;

/** The caller supplies a private, root-owned directory, never a person's checkout. */
export async function checkoutMerged(directory: string, commit: string, run: Command = command, remote = repository): Promise<void> {
  if (!fullCommit.test(commit)) throw new Error("release must be a full lower-case commit hash");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await run("git", ["init", "--quiet", directory], directory);
  await run("git", ["fetch", "--no-tags", "--force", remote, "+refs/heads/main:refs/remotes/origin/main"], directory);
  if (await run("git", ["cat-file", "-t", commit], directory) !== "commit") throw new Error("release object must be a commit");
  try {
    await run("git", ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"], directory);
  } catch {
    throw new Error(`release ${commit} is not an ancestor of origin/main`);
  }
  await run("git", ["checkout", "--force", "--detach", commit], directory);
  await run("git", ["clean", "-ffdqx"], directory);
}

export function releaseLink(prefix: string, role: Role): string {
  return join(prefix, roleLinks[role]);
}

/** Points `link` at `target` with one rename, so a reader sees the old target or the new one. */
export async function pointLink(link: string, target: string): Promise<void> {
  await unlink(`${link}.new`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(target, `${link}.new`);
  await rename(`${link}.new`, link);
}

export interface Transaction {
  commit: string;
  previous: string;
  target: string;
  state: "installing" | "healthy" | "rolled-back" | "failed";
  reason: string | null;
  /** The backup taken before the switch, which a restore needs once the target has changed stored data. */
  backup?: string;
}
/** The role's last install, from its journal, or null before its first. */
export async function readJournal(prefix: string, role: Role): Promise<Transaction | null> {
  return await readJson(join(prefix, deployJournal(role)), null) as Transaction | null;
}

export interface InstallBoundary {
  /**
   * Builds and performs upgrade steps without switching links or restarting services. It refuses a commit that is not
   * a full hash before it runs anything, as `checkoutMerged` does.
   */
  prepare(commit: string): Promise<string>;
  beforeSwitch?(): Promise<void>;
  /**
   * Readies stored data for the target's code once nothing else can enter: resolves the backup it took first, or null.
   * Throws when the target cannot start on that data.
   */
  readyData?(target: string): Promise<string | null>;
  /** Why the previous release cannot start on what the target left, or null when it can. */
  rollbackRefused?(transaction: Transaction): Promise<string | null>;
  activate?(): Promise<void>;
  restart(): Promise<void>;
  /** Must bound both the active-service check and API request, including its response body. */
  healthy(): Promise<boolean>;
  journal(): Promise<string>;
}

/** One serialized runner owns a role. Its journal and links must live in a root-owned directory. */
export class ReleaseInstaller {
  private readonly prefix: string;
  private readonly role: Role;
  private readonly link: string;
  private readonly boundary: InstallBoundary;
  constructor(prefix: string, role: Role, boundary: InstallBoundary) {
    this.prefix = prefix;
    this.role = role;
    this.boundary = boundary;
    this.link = releaseLink(prefix, role);
  }

  observed(): Promise<Transaction | null> {
    return readJournal(this.prefix, this.role);
  }

  private async record(value: Transaction): Promise<Transaction> {
    await saveJson(join(this.prefix, deployJournal(this.role)), value);
    return value;
  }

  async install(commit: string): Promise<Transaction> {
    if ((await this.observed())?.state === "installing") throw new Error("an unfinished install must be recovered first");
    // Automatic deployment needs a bootstrapped, recoverable release.
    const previous = await readlink(this.link);
    const target = await this.boundary.prepare(commit);
    await this.boundary.beforeSwitch?.();
    const backup = await this.boundary.readyData?.(target) ?? null;
    const transaction = await this.record({ commit, previous, target, state: "installing", reason: null, ...backup === null ? {} : { backup } });
    try {
      await pointLink(this.link, target);
      await this.boundary.activate?.();
      await this.boundary.restart();
      if (!await this.boundary.healthy()) throw new Error("release health check failed");
      return await this.record({ ...transaction, state: "healthy" });
    } catch (error) {
      return this.rollback(transaction, error instanceof Error ? error.message : String(error));
    }
  }

  /** Rolls back an install a process left unfinished, or resolves null when there is none. */
  async recover(): Promise<Transaction | null> {
    const transaction = await this.observed();
    if (transaction?.state !== "installing") return null;
    return this.rollback(transaction, "deployer interrupted before health was committed");
  }

  private async rollback(transaction: Transaction, reason: string): Promise<Transaction> {
    try { reason += `\n${(await this.boundary.journal()).slice(-16_384)}`; }
    catch (error) { console.error(`could not read the service journal for the rollback reason: ${String(error)}`); reason += "\njournal unavailable"; }
    let refused: string | null;
    try { refused = await this.boundary.rollbackRefused?.(transaction) ?? null; }
    catch (error) { refused = `whether the previous release can start could not be read: ${String(error)}`; }
    // Moving the link back would only crash-loop the previous release, so the target keeps running for the person.
    if (refused !== null) return this.record({ ...transaction, state: "failed", reason: `${reason}\nnot rolled back: ${refused}` });
    try {
      await pointLink(this.link, transaction.previous);
      await this.boundary.restart();
      if (!await this.boundary.healthy()) throw new Error("previous release is not healthy");
    } catch (error) {
      return this.record({ ...transaction, state: "failed", reason: `${reason}\nrollback failed: ${String(error)}` });
    }
    return this.record({ ...transaction, state: "rolled-back", reason });
  }
}
