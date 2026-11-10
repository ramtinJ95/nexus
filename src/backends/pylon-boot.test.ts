import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "../test-support/kit.ts";
import { bootHooks, commitMissing, setupRemoved, templateCheckout } from "./pylon-boot.ts";
import { bakedDotfilesDir, home } from "../../images/pylon/nexus-contract.ts";
import type { BootInputs } from "../protocol/spawn.ts";
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

test("a boot pulls the dotfiles repository it names, and keeps the image's baked layer without one or when the pull fails", async (t) => {
  const dir = await tempDir("nexus-dotfiles-pull-", t);
  const [baked, remote] = [join(dir, "baked"), join(dir, "remote")];
  for (const [repo, layer] of [[baked, "baked"], [remote, "pulled"]] as const) {
    await run("git", ["init", "--quiet", "--initial-branch=main", repo]);
    await writeFile(join(repo, "install"), `#!/bin/sh\necho ${layer} > ../layer\n`, { mode: 0o755 });
    await git(repo, "add", "install");
    await git(repo, "commit", "--quiet", "-m", layer);
  }
  const [bakedAt, remoteAt] = [await git(baked, "rev-parse", "--short", "HEAD"), await git(remote, "rev-parse", "--short", "HEAD")];
  let boots = 0;
  const boot = async (dotfiles: BootInputs["dotfiles"]) => {
    const user = join(dir, `home-${boots++}`);
    await mkdir(join(user, ".nexus"), { recursive: true });
    const hook = bootHooks({ network: { allowedHosts: [], secrets: [] }, ...dotfiles === undefined ? {} : { dotfiles } })[0]!
      .replaceAll(bakedDotfilesDir, baked).replaceAll(home, user);
    const { stdout } = await run("bash", ["-c", `runuser() { bash -c "$4"; }; ${hook}`]);
    return { log: stdout.trim().split("\n").filter((line) => line.startsWith("dotfiles:")), layer: await run("cat", [join(user, ".nexus/layer")]).then((r) => r.stdout.trim()) };
  };
  assert.deepEqual(await boot(undefined), { log: [`dotfiles: no repository is set, keeping ${bakedAt}`, "dotfiles: installed"], layer: "baked" });
  assert.deepEqual(await boot({ repo: remote, ref: "main" }), { log: [`dotfiles: pulled ${remote} main at ${remoteAt}`, "dotfiles: installed"], layer: "pulled" });
  const typo = join(dir, "typo");
  assert.deepEqual(await boot({ repo: typo, ref: "main" }), { log: [`dotfiles: the pull of ${typo} main failed, keeping ${bakedAt}`, "dotfiles: installed"], layer: "baked" });
});

test("every boot starts Herdr Core last, as user and detached, unless one runs", async (t) => {
  const dir = await tempDir("nexus-pylon-boot-core-", t);
  const bin = join(dir, "bin");
  await mkdir(bin);
  // A core runs once setsid has started one, or from the start when `running` exists.
  await writeFile(join(bin, "pgrep"), `#!/bin/sh\ntest -e ${dir}/started || test -e ${dir}/running\n`, { mode: 0o755 });
  await writeFile(join(bin, "setsid"), `#!/bin/sh\necho "$*" >> ${dir}/setsid\ntouch ${dir}/started\n`, { mode: 0o755 });
  const hooks = bootHooks({ network: { allowedHosts: [], secrets: [] } });
  const boot = () => run("bash", ["-c", `runuser() { echo "$1 $2 $3" > ${dir}/as; PATH=${bin}:$PATH bash -c "$4"; }; ${hooks.at(-1)!.replaceAll(home, dir)}`]).then((r) => r.stdout.trim());
  assert.equal(await boot(), "herdr-core: running");
  assert.equal(await run("cat", [join(dir, "setsid"), join(dir, "as")]).then((r) => r.stdout), "-f tini -s -- herdr-core serve\n-l user -c\n");
  await run("rm", [join(dir, "started"), join(dir, "setsid")]);
  await writeFile(join(dir, "running"), "");
  assert.equal(await boot(), "herdr-core: running");
  assert.equal(await sh(`test -e ${dir}/setsid`), 1, "a core that runs is not started again");
});
