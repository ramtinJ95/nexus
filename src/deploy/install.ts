import { execFile } from "node:child_process";
import { mkdir, readFile, readlink, rename, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readJson, saveJson } from "../json-file.ts";
import { parseCommit } from "./health.ts";
import { fullCommit, type Role } from "./model.ts";

const exec = promisify(execFile);
export const repository = "https://github.com/ramtinJ95/nexus.git";

/** No inherited credentials, git configuration or npm configuration crosses the process boundary. */
export async function command(program: string, args: readonly string[], cwd: string, timeoutMs = 300_000): Promise<string> {
  const { stdout } = await exec(program, [...args], {
    cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
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
  return join(prefix, role === "control" ? "control-current" : "current");
}

export async function commitAt(dir: string): Promise<string | null> {
  try { return parseCommit(await readFile(join(dir, "release-commit"), "utf8")); }
  catch { return null; }
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
}
export interface InstallBoundary {
  /** Builds and performs upgrade steps without switching links or restarting services. */
  prepare(commit: string): Promise<string>;
  beforeSwitch?(): Promise<void>;
  activate?(): Promise<void>;
  restart(): Promise<void>;
  /** Must bound both the active-service check and API request, including its response body. */
  healthy(): Promise<boolean>;
  journal(): Promise<string>;
}

/** One serialized runner owns a role. Its journal and links must live in a root-owned directory. */
export class ReleaseInstaller {
  private readonly link: string;
  private readonly journal: string;
  private readonly boundary: InstallBoundary;
  constructor(prefix: string, role: Role, boundary: InstallBoundary) {
    this.boundary = boundary;
    this.link = releaseLink(prefix, role);
    this.journal = join(prefix, `${role}-deploy.json`);
  }

  async observed(): Promise<Transaction | null> {
    return await readJson(this.journal, null) as Transaction | null;
  }

  private async record(value: Transaction): Promise<Transaction> {
    await saveJson(this.journal, value);
    return value;
  }

  async install(commit: string): Promise<Transaction> {
    if (!fullCommit.test(commit)) throw new Error("release must be a full lower-case commit hash");
    if ((await this.observed())?.state === "installing") throw new Error("an unfinished install must be recovered first");
    // Automatic deployment needs a bootstrapped, recoverable release.
    const previous = await readlink(this.link);
    const target = await this.boundary.prepare(commit);
    await this.boundary.beforeSwitch?.();
    const transaction = await this.record({ commit, previous, target, state: "installing", reason: null });
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
    catch { reason += "\njournal unavailable"; }
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
