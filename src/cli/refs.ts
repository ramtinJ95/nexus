/**
 * What a person types for a thread or a project, made into the ID the API takes before the command's request: a
 * thread by a prefix of its ID or `@last`, and a start's project by this checkout's `origin`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { threadRoutes } from "../contract/threads.ts";
import { projectRoutes } from "../contract/projects.ts";
import { CliError } from "./transport.ts";
import { request, str, type Api, type Values } from "./kit.ts";

const fullThreadId = /^th-[0-9a-f]{12}$/;
const lastThread = "@last";

interface Named { id: string; title: string; status: string; createdAt: number }

/**
 * A full ID passes as typed, without a request. A prefix that names no thread passes too, so the API answers it
 * as it answers any thread it does not have.
 */
export async function threadOf(api: Api, given: string): Promise<string> {
  if (fullThreadId.test(given)) return given;
  const [threads, queued] = await Promise.all([request(api, threadRoutes.list, { query: {} }), request(api, threadRoutes.queued, { query: {} })]);
  const all: Named[] = [...threads, ...queued.filter((q) => !threads.some((t) => t.id === q.id))];
  if (given === lastThread) {
    const newest = all.filter((t) => t.status !== "deleted").sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest === undefined) throw new CliError("not-found", `${lastThread} names the newest thread that is not deleted, and there is none`);
    return newest.id;
  }
  if (all.some((t) => t.id === given)) return given;
  const matches = all.filter((t) => t.id.startsWith(given) || t.id.startsWith(`th-${given}`));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) return given;
  const named = matches.map((t) => `${t.id} (${t.status}: ${t.title})`);
  throw new CliError("invalid", `${given} is the start of ${matches.length} threads, ${named.join(", ")}. Give more of the ID`);
}

/** `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and `https://github.com/o/r` are all `github.com/o/r`. */
export function repoKey(url: string): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/*$/i.exec(url.trim());
  return m === null ? null : `${m[1]}/${m[2]}`.toLowerCase();
}

async function origin(): Promise<string | null> {
  try {
    return (await promisify(execFile)("git", ["remote", "get-url", "origin"])).stdout.trim();
  } catch {
    return null;
  }
}

/** Without --project, the one project whose repository is this checkout's `origin`, which it names on stderr. */
export async function projectOf(api: Api, v: Values, verb: string): Promise<string> {
  const given = str(v, "project");
  if (given !== undefined) return given;
  const remote = await origin();
  const key = remote === null ? null : repoKey(remote);
  if (key === null) throw new CliError("invalid", `${verb} needs --project`);
  const matching = (await request(api, projectRoutes.list, {})).filter((p) => p.repoUrl !== null && repoKey(p.repoUrl) === key).map((p) => p.id);
  if (matching.length !== 1) {
    throw new CliError("invalid", `${verb} needs --project, since ${matching.length === 0 ? "no project has" : `projects ${matching.join(", ")} all have`} this checkout's origin, ${remote}`);
  }
  process.stderr.write(`nexus: project ${matching[0]}, from this checkout's origin\n`);
  return matching[0]!;
}
