/**
 * What keys a project's templates, read by the control plane straight from the project's remote: one commit, fetched
 * shallow and without blobs into a bare repository the call makes for itself and removes after. Concurrent starts
 * share nothing on disk, so one start's FETCH_HEAD can never hand another start its commit. A commit's inputs cannot
 * change, so they are kept by remote and commit, and a branch costs one `ls-remote` once its tip has been read.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exit, type Exit } from "../exec.ts";
import type { ProjectMirror, SetupInputs } from "./templates.ts";

/** A thread's start waits on the read, so a slow remote boots the thread fresh instead of holding its start. */
const readTimeoutMs = 15_000;

/** Each entry is a URL and two object IDs, so the cache stays well under a megabyte. */
const keptCommits = 1024;

/**
 * `githubToken` reaches https://github.com as an HTTP header set through git's environment, so it never shows in a
 * process listing. Only an https:// remote is read, or a file:// one in tests: the control plane holds no SSH key, so any
 * other remote is refused before git runs, and git itself may use no other transport.
 */
export function projectMirror(options: { githubToken: string | null }): ProjectMirror {
  const kept = new Map<string, SetupInputs>();
  // The paths are in the key, so an edit of a project's templateInputs never gets a read made for the old list.
  const keyOf = (url: string, commit: string, paths: readonly string[]) => `${url} ${commit} ${JSON.stringify(paths)}`;
  const keep = (url: string, paths: readonly string[], inputs: SetupInputs) => {
    const key = keyOf(url, inputs.commit, paths);
    kept.delete(key);
    kept.set(key, inputs);
    if (kept.size > keptCommits) kept.delete(kept.keys().next().value!);
    return inputs;
  };
  return {
    async setupInputs(project, ref, signal) {
      if (!/^(?:https|file):\/\//.test(project.repoUrl)) throw new Error(`the control plane reads only https:// remotes, and holds no SSH key for ${project.repoUrl}`);
      const deadline = AbortSignal.timeout(readTimeoutMs);
      const bounded = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
      const env = gitEnv(project.repoUrl, options.githubToken);
      try {
        bounded.throwIfAborted();
        const commit = "commit" in ref ? ref.commit : await tipOf(project.repoUrl, ref.branch, env, bounded);
        if (commit === null) return null;
        const paths = project.templateInputs ?? [];
        const known = kept.get(keyOf(project.repoUrl, commit, paths));
        if (known !== undefined) return keep(project.repoUrl, paths, known);
        const read = await fetchInputs(project.repoUrl, ref, paths, env, bounded);
        return read === null ? null : keep(project.repoUrl, paths, read);
      } catch (err) {
        if (deadline.aborted) throw new Error(`git did not read ${project.repoUrl} within ${readTimeoutMs / 1000} s`);
        throw err;
      }
    },
  };
}

/** Null when the remote has no such branch. */
async function tipOf(url: string, branch: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | null> {
  const name = `refs/heads/${branch}`;
  const args = ["ls-remote", "--heads", url, name];
  const listed = await exit("git", args, { env, signal });
  if (listed.code !== 0) throw failed(args, listed);
  // ls-remote matches a pattern against the end of each ref, so refs/heads/x/refs/heads/main would match main too.
  const line = listed.stdout.split("\n").map((l) => l.split("\t")).find(([, ref]) => ref === name);
  return line === undefined ? null : line[0]!;
}

/** Fetches the branch itself rather than the tip ls-remote saw, so a force-push that drops that tip cannot fail the read. */
async function fetchInputs(url: string, ref: { branch: string } | { commit: string }, paths: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<SetupInputs | null> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-mirror-"));
  const git = (args: readonly string[]) => exit("git", [`--git-dir=${dir}`, ...args], { env, signal });
  const ok = async (args: readonly string[]) => {
    const result = await git(args);
    if (result.code !== 0) throw failed(args, result);
    return result.stdout.trim();
  };
  try {
    await ok(["init", "--quiet", "--bare"]);
    const fetch = ["fetch", "--quiet", "--depth=1", "--filter=blob:none", url, "branch" in ref ? `refs/heads/${ref.branch}` : ref.commit];
    const fetched = await git(fetch);
    if (fetched.code !== 0) {
      if ("branch" in ref && /couldn't find remote ref/.test(fetched.stderr)) return null;
      throw failed(fetch, fetched);
    }
    const commit = await ok(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    // A `<rev>:<path>` name takes no peel suffix, and the ID comes from the tree, so the blob is never fetched.
    const objectAt = async (path: string): Promise<string | null> => {
      const read = ["rev-parse", "-q", "--verify", `FETCH_HEAD:${path}`];
      const found = await git(read);
      if (found.code !== 0 && found.code !== 1) throw failed(read, found);
      return found.code === 0 ? found.stdout.trim() : null;
    };
    const setupBlob = await objectAt(".nexus/setup");
    if (paths.length === 0) return { commit, setupBlob };
    const entries: [string, string | null][] = [];
    for (const path of paths) entries.push([path, await objectAt(path)]);
    // fromEntries defines each key, where assignment would call Object.prototype's setter for a path named __proto__.
    return { commit, setupBlob, inputBlobs: Object.fromEntries(entries) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gitEnv(url: string, githubToken: string | null): NodeJS.ProcessEnv {
  // In the C locale, so a missing branch reads as the `couldn't find remote ref` that setupInputs matches.
  const env = { ...process.env, LC_ALL: "C", LANGUAGE: "", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:file" };
  if (githubToken === null || !url.startsWith("https://github.com/")) return env;
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

/** git's stderr on one line, as a thread's setup reason shows only its first. */
function failed(args: readonly string[], { code, stderr }: Exit): Error {
  const said = stderr.split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" ").slice(-500);
  return new Error(`git ${args[0]} exited ${code}${said === "" ? "" : `: ${said}`}`);
}
