import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { command } from "../deploy/install.ts";
import { resolveMain } from "./releases.ts";

test("deploy main resolves the tip of exactly the release branch, and names a branch the repository lacks", async (t) => {
  const remote = await mkdtemp(join(tmpdir(), "nexus-releases-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const git = (...args: string[]) => command("git", args, remote);
  await git("init", "-q", "-b", "main");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "on main");
  const main = await git("rev-parse", "HEAD");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "on multiplayer");
  const multiplayer = await git("rev-parse", "HEAD");
  await git("branch", "multiplayer");
  await git("branch", "aaa/refs/heads/main");
  await git("reset", "-q", "--hard", main);
  assert.equal(await resolveMain("main", remote), main, "a branch whose name ends in refs/heads/main is not main");
  assert.equal(await resolveMain("multiplayer", remote), multiplayer);
  await assert.rejects(resolveMain("release", remote), /has no branch release/);
});
