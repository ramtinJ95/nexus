import { readFileSync } from "node:fs";
import { fullCommit } from "./model.ts";

/** The commit a release's `release-commit` file names, or null when it holds no full commit. */
export function parseCommit(text: string): string | null {
  const commit = text.trim();
  return fullCommit.test(commit) ? commit : null;
}

/** Read from this process's immutable release, not from a link a deployer may already have moved. */
export const runningCommit: string | null = (() => {
  try { return parseCommit(readFileSync(new URL("../../release-commit", import.meta.url), "utf8")); }
  catch { return null; }
})();
