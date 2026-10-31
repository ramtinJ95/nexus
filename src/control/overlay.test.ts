import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeName, ProjectId, PylonId } from "../ids.ts";
import { githubTokenGrant } from "../secret-grants.ts";
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

test("the guide's Shell section warns that pkill -f matches its own command and says when a bracket pattern avoids it", () => {
  const shell = section("Shell");
  assert.match(shell, /`pkill -f`.*match the shell that runs them/);
  assert.match(shell, /`pkill -f '\[s\]tack\.ts'`, which cannot match its own text, in a command that names `stack\.ts` nowhere else/);
  assert.match(shell, /Claude Code alone refuses a command that starts with a long `sleep`/);
  assert.ok(guide.indexOf("\n## Shell\n") < guide.indexOf("\n## Services\n"));
});

test("the guide's Repository section tells the agent to push through origin and not to pipe the push into head, for a clone and an empty repository", () => {
  const repos: PylonOverlay["repo"][] = [
    { kind: "clone", url: "https://github.com/example/spoon.git", checkout: { branch: "main", commit: "abc123" } },
    { kind: "empty", branch: "main" },
  ];
  for (const repo of repos) {
    const pylonGuide = renderOverlay({ ...overlay, repo, secrets: [githubTokenGrant] }).find((f) => f.path === "/home/user/.nexus/PYLON.md")!.content;
    const repository = pylonGuide.split("\n## Repository\n")[1]!.split("\n## ")[0]!;
    assert.match(repository, /push through a named remote such as `origin`/, repo.kind);
    assert.match(repository, /A push piped into `head` can die after GitHub takes it and before git writes the record/, repo.kind);
    assert.match(repository, /shorten the output with `tail` instead/, repo.kind);
    assert.match(repository, /If a push was cut short, push the same branch through `origin` again before any fetch, which records it; after a fetch, only a push that moves the branch records it\./, repo.kind);
  }
});
