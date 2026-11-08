import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseReleaseCommit, releaseCommitFile } from "../node-layout.ts";

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
