import { readFileSync } from "node:fs";
import { fullCommit } from "./model.ts";

/** Read from this process's immutable release, not from a link a deployer may already have moved. */
export const runningCommit: string | null = (() => {
  try {
    const commit = readFileSync(new URL("../../release-commit", import.meta.url), "utf8").trim();
    return fullCommit.test(commit) ? commit : null;
  } catch { return null; }
})();
