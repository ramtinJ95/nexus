import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseReleaseCommit, releaseCommitFile } from "../node-base/node-layout.ts";
import { jsonRequest } from "./http.ts";

/**
 * Read from this process's immutable release, not from a link a deployer may already have moved. A checkout has no
 * release-commit file, and runs as no commit.
 */
export const runningCommit: string | null = (() => {
  try { return parseReleaseCommit(readFileSync(releaseCommitFile(fileURLToPath(new URL("../..", import.meta.url))), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`the running release's commit could not be read, so /v1/health reports none: ${String(error)}`);
    return null;
  }
})();

/**
 * Answers GET /v1/health with `body()` when it comes from this host, before any caller check, as the deployer on the node
 * reads `commit` there to see the release it started. Returns whether it answered.
 */
export function answerLocalHealth(req: IncomingMessage, res: ServerResponse, body: () => { commit: string | null }): boolean {
  const { remoteAddress, localAddress } = req.socket;
  if (req.method !== "GET" || req.url !== "/v1/health" || remoteAddress === undefined || remoteAddress !== localAddress) return false;
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body()));
  return true;
}

/**
 * Waits until `active` resolves, as `systemctl is-active` does for a running unit, and the service at `url` answers
 * /v1/health with the commit `expected`, retrying while it binds and opens. Returns null once it does, or what the last
 * try saw once `timeoutMs` has passed.
 */
export async function awaitHealthy(url: URL, expected: string | null, timeoutMs: number, active: (timeoutMs: number) => Promise<unknown>): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  do {
    try {
      await active(Math.max(1, Math.min(5000, until - Date.now())));
      const answered = (await jsonRequest(url, "GET", undefined, null, undefined, Math.max(1, Math.min(10_000, until - Date.now())))).commit;
      if (answered === expected) return null;
      last = `it answered commit ${answered ?? "none"}`;
    } catch (error) { last = error; }
    await sleep(500);
  } while (Date.now() < until);
  return String(last);
}
