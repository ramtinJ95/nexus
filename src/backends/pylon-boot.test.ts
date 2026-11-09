import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "../test-support/kit.ts";
import { commitMissing, setupRemoved, templateCheckout } from "./pylon-boot.ts";
import type { PylonId } from "../ids.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args]).then((r) => r.stdout.trim());
const sh = (script: string) => run("sh", ["-c", script]).then(() => 0, (err: { code: number }) => err.code);

test("a template boot's checkout of a commit a force-push took off its remote fails at once as final", async (t) => {
  const dir = await tempDir("nexus-pylon-boot-", t);
  const [remote, work, template] = ["remote.git", "work", "template"].map((name) => join(dir, name)) as [string, string, string];
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  await run("git", ["clone", "--quiet", remote, work]);
  await git(work, "commit", "--quiet", "--allow-empty", "-m", "base");
  await git(work, "push", "--quiet", "origin", "HEAD:main", "HEAD:feature");
  await run("git", ["clone", "--quiet", remote, template]);
  await git(work, "commit", "--quiet", "--allow-empty", "-m", "round head");
  await git(work, "push", "--quiet", "origin", "HEAD:feature");
  const roundHead = await git(work, "rev-parse", "HEAD");
  await git(work, "commit", "--quiet", "--amend", "--allow-empty", "-m", "rebased");
  await git(work, "push", "--quiet", "--force", "origin", "HEAD:feature");
  await git(remote, "reflog", "expire", "--expire=now", "--all");
  await git(remote, "gc", "--quiet", "--prune=now");
  const newHead = await git(work, "rev-parse", "HEAD");

  const checkout = (commit: string) => sh(templateCheckout({ kind: "clone", url: remote, checkout: { branch: "feature", commit } }, template));
  const outage = join(dir, "upload-pack");
  await writeFile(outage, `#!/bin/sh\nif [ -e "$0.used" ]; then echo 'The requested URL returned error: 503' >&2; exit 128; fi\ntouch "$0.used"; exec git-upload-pack "$@"\n`, { mode: 0o755 });
  await git(template, "config", "remote.origin.uploadpack", outage);
  assert.equal(await checkout(roundHead), 1, "a fetch of the commit that failed in an outage may pass");
  await git(template, "config", "--unset", "remote.origin.uploadpack");
  assert.equal(await checkout(roundHead), commitMissing, "the round's head is on no ref of the remote");
  assert.equal(setupRemoved("pylon-th-check" as PylonId, true, `Setup exited ${commitMissing}`, "", commitMissing).code, "setup-failed", "no retry boots it again");
  assert.equal(setupRemoved("pylon-th-check" as PylonId, true, "Setup exited 128", "", 128).code, "backend", "a fetch that failed is retried");
  assert.equal(await checkout(newHead), 0);
  assert.equal(await git(template, "rev-parse", "HEAD"), newHead);
});
