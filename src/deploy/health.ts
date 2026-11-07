import { readFileSync } from "node:fs";
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
