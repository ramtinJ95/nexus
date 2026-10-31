import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, ProjectId, PylonId } from "../ids.ts";
import { renderOverlay, type PylonOverlay } from "./overlay.ts";

const overlay: PylonOverlay = {
  pylonId: "pylon-th-1" as PylonId,
  threadId: "th-1",
  project: "spoon" as ProjectId,
  node: "rj-firebat" as NodeName,
  allowedHosts: ["github.com"],
  previews: [],
  logins: [],
  dotfiles: { repo: "https://github.com/example/dotfiles.git", ref: "main" },
  repo: { kind: "empty", branch: "main" },
  secrets: [],
};
const guide = renderOverlay(overlay).find((f) => f.path === "/home/user/.nexus/PYLON.md")!.content;
const section = (heading: string) => guide.split(`\n## ${heading}\n`)[1]!.split("\n## ")[0]!;

test("the guide's reviewer spawn names every field shepherdr requires for it", () => {
  const review = section("Review before a pull request");
  assert.match(review, /`agent_type: "reviewer"`/);
  assert.match(review, /`label`/);
  assert.match(review, /`base`/);
});

test("the guide's Shell section warns that pkill -f matches its own command and shows a pattern that cannot", () => {
  const shell = section("Shell");
  assert.match(shell, /`pkill -f`.*match the shell that runs them/);
  assert.match(shell, /`pkill -f '\[s\]tack\.ts'`/);
  assert.match(shell, /Claude Code alone refuses a command that starts with a long `sleep`/);
  assert.ok(guide.indexOf("\n## Shell\n") < guide.indexOf("\n## Services\n"));
});
