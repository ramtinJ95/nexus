/**
 * What keys a project's templates, read by the control plane straight from the project's remote: one commit, fetched
 * shallow and without blobs into a bare repository the call makes for itself and removes after. Concurrent starts
 * share nothing, so one start's FETCH_HEAD can never hand another start its commit.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectMirror } from "../images.ts";

/** A thread's start waits on the read, so a slow remote boots the thread fresh instead of holding its start. */
const readTimeoutMs = 15_000;

/**
 * `githubToken` reaches https://github.com as an HTTP header set through git's environment, so it never shows in a
 * process listing. Only an https:// remote is read, or a file:// one in tests: the control plane holds no SSH key, so any
 * other remote is refused before git runs, and git itself may use no other transport.
 */
export function projectMirror(options: { githubToken: string | null }): ProjectMirror {
  return {
    async setupInputs(project, ref, signal) {
      if (!/^(?:https|file):\/\//.test(project.repoUrl)) throw new Error(`the control plane reads only https:// remotes, and holds no SSH key for ${project.repoUrl}`);
      const deadline = AbortSignal.timeout(readTimeoutMs);
      const bounded = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
      const env = gitEnv(project.repoUrl, options.githubToken);
      const dir = await mkdtemp(join(tmpdir(), "nexus-mirror-"));
      const git = (args: readonly string[]) => run([`--git-dir=${dir}`, ...args], env, bounded);
      const ok = async (args: readonly string[]) => {
        const result = await git(args);
        if (result.code !== 0) throw failed(args, result);
        return result.stdout.trim();
      };
      try {
        await ok(["init", "--quiet", "--bare"]);
        await ok(["fetch", "--quiet", "--depth=1", "--filter=blob:none", project.repoUrl, "branch" in ref ? `refs/heads/${ref.branch}` : ref.commit]);
        const commit = await ok(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
        // A `<rev>:<path>` name takes no peel suffix, and the ID comes from the tree, so the blob is never fetched.
        const setup = ["rev-parse", "-q", "--verify", "FETCH_HEAD:.nexus/setup"];
        const found = await git(setup);
        if (found.code !== 0 && found.code !== 1) throw failed(setup, found);
        return { commit, setupBlob: found.code === 0 ? found.stdout.trim() : null };
      } catch (err) {
        if (deadline.aborted) throw new Error(`git did not read ${project.repoUrl} within ${readTimeoutMs / 1000} s`);
        throw err;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function gitEnv(url: string, githubToken: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:file" };
  if (githubToken === null || !url.startsWith("https://github.com/")) return env;
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

interface Run { code: number; stdout: string; stderr: string }

/** Resolves with git's exit code, and rejects only when git could not run to an exit, as on an abort. */
function run(args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { env, signal, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err === null) return resolve({ code: 0, stdout, stderr });
      if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
      reject(err);
    });
  });
}

/** git's stderr on one line, as a thread's setup reason shows only its first. */
function failed(args: readonly string[], { code, stderr }: Run): Error {
  const said = stderr.split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" ").slice(-500);
  return new Error(`git ${args[0]} exited ${code}${said === "" ? "" : `: ${said}`}`);
}
