import { execFile } from "node:child_process";
import { mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Attempt, Role } from "./plan.ts";

const exec = promisify(execFile);
export const repository = "https://github.com/ramtinJ95/nexus.git";
const fullCommit = /^[0-9a-f]{40}$/;

/** No inherited credentials, git configuration or npm configuration crosses the process boundary. */
export async function command(program: string, args: readonly string[], cwd: string, timeoutMs = 300_000): Promise<string> {
  const { stdout } = await exec(program, [...args], {
    cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
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

export interface Transaction extends Attempt { previous: string; target: string }
export interface InstallBoundary {
  /** Builds and performs upgrade steps without switching links or restarting services. */
  prepare(commit: string): Promise<string>;
  activate?(role: Role): Promise<void>;
  restart(role: Role): Promise<void>;
  /** Must bound both the active-service check and API request, including its response body. */
  healthy(role: Role): Promise<boolean>;
  journal(role: Role): Promise<string>;
}

/** One serialized runner owns a role. Its journal and links must live in a root-owned directory. */
export class ReleaseInstaller {
  private readonly link: string;
  private readonly journal: string;
  private readonly role: Role;
  private readonly boundary: InstallBoundary;
  constructor(prefix: string, role: Role, boundary: InstallBoundary) {
    this.role = role;
    this.boundary = boundary;
    this.link = join(prefix, role === "control" ? "control-current" : "current");
    this.journal = join(prefix, `${role}-deploy.json`);
  }

  async observed(): Promise<Transaction | null> {
    let text: string;
    try { text = await readFile(this.journal, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return JSON.parse(text) as Transaction;
  }

  private async record(value: Transaction): Promise<Transaction> {
    await writeFile(`${this.journal}.new`, JSON.stringify(value) + "\n", { mode: 0o600 });
    await rename(`${this.journal}.new`, this.journal);
    return value;
  }

  private async point(target: string): Promise<void> {
    await unlink(`${this.link}.new`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await symlink(target, `${this.link}.new`);
    await rename(`${this.link}.new`, this.link);
  }

  async install(commit: string): Promise<Transaction> {
    if (!fullCommit.test(commit)) throw new Error("release must be a full lower-case commit hash");
    const unfinished = await this.observed();
    if (unfinished?.state === "installing") return this.recover();
    if (unfinished?.commit === commit && (unfinished.state === "rolled-back" || unfinished.state === "failed")) return unfinished;
    // Automatic deployment needs a bootstrapped, recoverable release.
    const previous = await readlink(this.link);
    const target = await this.boundary.prepare(commit);
    const transaction = await this.record({ commit, previous, target, state: "installing", reason: null });
    try {
      await this.point(target);
      await this.boundary.activate?.(this.role);
      await this.boundary.restart(this.role);
      if (!await this.boundary.healthy(this.role)) throw new Error("release health check failed");
      return await this.record({ ...transaction, state: "healthy" });
    } catch (error) {
      return this.rollback(transaction, error instanceof Error ? error.message : String(error));
    }
  }

  async recover(): Promise<Transaction> {
    const transaction = await this.observed();
    if (transaction === null) throw new Error("no deployment to recover");
    if (transaction.state !== "installing") return transaction;
    return this.rollback(transaction, "deployer interrupted before health was committed");
  }

  private async rollback(transaction: Transaction, reason: string): Promise<Transaction> {
    try { reason += `\n${(await this.boundary.journal(this.role)).slice(-16_384)}`; }
    catch { reason += "\njournal unavailable"; }
    try {
      await this.point(transaction.previous);
      await this.boundary.restart(this.role);
      if (!await this.boundary.healthy(this.role)) throw new Error("previous release is not healthy");
    } catch (error) {
      return this.record({ ...transaction, state: "failed", reason: `${reason}\nrollback failed: ${String(error)}` });
    }
    return this.record({ ...transaction, state: "rolled-back", reason });
  }
}
