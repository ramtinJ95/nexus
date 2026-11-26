/**
 * Team-mode design, points 2, 3 and 4: only a thread's owner acts on it, and a user's credentials are spent only by
 * that user's pylons.
 *
 * A template is keyed on the project, the image and a hash of `.nexus/setup`'s blob (src/control/templates.ts,
 * setupHashOf). Nothing in the key names who started the thread that built it, or the commit the setup ran at. So a
 * template whose setup ran one engineer's branch is the boot disk of the next engineer's pylon.
 *
 * Everything here is the real code: the API and thread starter (api-kit), the real project mirror reading a real git
 * remote, and the real shell commands a template build and a template boot run (pylon-boot.ts). Only the probe is the
 * kit's fake, so the build's commands are run here, in a directory, as pylon-boot.test.ts does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { image, laptop, node, observeNode, phone, testApi } from "../src/test-support/api-kit.ts";
import { tempDir } from "../src/test-support/kit.ts";
import { projectMirror } from "../src/control/mirror.ts";
import { repoInitCommand, templateCheckout } from "../src/backends/pylon-boot.ts";
import type { Thread } from "../src/control/thread-store.ts";
import type { ImageId, ProjectId } from "../src/ids.ts";
import type { NodeObservation } from "../src/protocol/observations.ts";
import type { CloneRepo } from "../src/protocol/spawn.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args]).then((r) => r.stdout.trim());
const sh = (script: string, cwd?: string) => run("sh", ["-c", script], { cwd });

test("the pylon of one engineer's thread boots from a template whose setup ran another engineer's branch", async (t) => {
  const dir = await tempDir("interrogate-template-", t);
  const [remote, work, disk] = ["remote.git", "work", "template-disk"].map((name) => join(dir, name)) as [string, string, string];
  const url = `file://${remote}`;

  // main: .nexus/setup runs the repository's install script, as a setup that shares its install logic does.
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  await run("git", ["clone", "--quiet", remote, work]);
  await mkdir(join(work, ".nexus"));
  await mkdir(join(work, "scripts"));
  await writeFile(join(work, ".nexus", "setup"), "#!/bin/sh\nexec ./scripts/install.sh\n", { mode: 0o755 });
  await writeFile(join(work, "scripts", "install.sh"), "#!/bin/sh\necho deps > .installed\n", { mode: 0o755 });
  await git(work, "add", "-A");
  await git(work, "commit", "--quiet", "-m", "base");
  await git(work, "push", "--quiet", "origin", "HEAD:main");
  const mainCommit = await git(work, "rev-parse", "HEAD");

  // Alice's branch leaves .nexus/setup byte-identical and changes only the script it runs. The marker is harmless: a
  // git hook that records that it ran. Any code would do.
  await git(work, "checkout", "--quiet", "-b", "alice/wip");
  await writeFile(join(work, "scripts", "install.sh"), [
    "#!/bin/sh", "echo deps > .installed",
    "printf '#!/bin/sh\\necho \"code from alice/wip ran in this checkout\" >> .git/ran-here\\n' > .git/hooks/post-checkout",
    "chmod +x .git/hooks/post-checkout", "",
  ].join("\n"), { mode: 0o755 });
  await git(work, "commit", "--quiet", "-am", "wip");
  await git(work, "push", "--quiet", "origin", "HEAD:alice/wip");
  const aliceCommit = await git(work, "rev-parse", "HEAD");
  assert.equal(await git(work, "rev-parse", `${mainCommit}:.nexus/setup`), await git(work, "rev-parse", `${aliceCommit}:.nexus/setup`), "both commits hold the same .nexus/setup blob");

  const s = await testApi(t);
  const project = {
    id: "acme", repoUrl: url, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: ["registry.npmjs.org"], secrets: [], logins: [], preSetup: null,
  };
  s.registry.projects.createProject(project as never);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  observeNode(s, node, { total: 64, committed: 0 });
  const mirror = projectMirror({ githubToken: null });
  s.remoteReads((p, ref) => mirror.setupInputs(p, ref));

  // Alice, from her device, starts a thread on her branch.
  s.callAs(laptop);
  const alice = await s.call("POST", "/v1/threads", { project: "acme", title: "Alice's work", branch: "alice/wip" });
  assert.equal(alice.status, 201, JSON.stringify(alice.body));
  const [template] = s.registry.images.templates("acme" as ProjectId);
  assert.ok(template?.state === "building", "her start asks the node to build the template of this setup");
  assert.equal(template.inputs.repo.commit, aliceCommit, "and the build checks out her commit");

  // What the node's build runs (templateSetup -> setupCommands): the clone at the build's commit, then .nexus/setup.
  const build: CloneRepo = { kind: "clone", url, checkout: { branch: template.inputs.repo.branch, commit: template.inputs.repo.commit } };
  await sh(repoInitCommand(build, disk));
  await sh("if test -e .nexus/setup; then ./.nexus/setup; fi", disk);
  // The build published: the registry records it ready and the node reports it holds it.
  const builtAt = Date.now() - 60_000;
  s.registry.images.saveTemplate({ id: template.id, key: template.key, state: "ready", builtOn: node, builtAt, commit: aliceCommit });
  observeNode(s, node, { total: 64, committed: 0 }, { artifacts: [image.id, template.id] as NodeObservation["artifacts"] });

  // Bob, another person on another device, starts a thread on main.
  s.callAs(phone);
  const bob = await s.call("POST", "/v1/threads", { project: "acme", title: "Bob's work", branch: "main" });
  assert.equal(bob.status, 201, JSON.stringify(bob.body));
  const bobThread = bob.body as Thread;
  const pylon = s.registry.threads.pylon(bobThread.pylonId)!;
  console.log(`alice thread startedBy=${(alice.body as Thread).startedBy} commit=${aliceCommit.slice(0, 12)} -> builds ${template.id} key=${JSON.stringify(template.key)}`);
  console.log(`bob   thread startedBy=${bobThread.startedBy} commit=${mainCommit.slice(0, 12)} -> setup=${JSON.stringify(bobThread.setup)}`);
  console.log(`bob   pylon firstBoot=${JSON.stringify(pylon.firstBoot)}`);

  // What Bob's pylon runs on that disk at its first boot (diskSetup -> templateCheckout).
  if (pylon.firstBoot.kind === "template") {
    assert.ok(pylon.boot.repo.kind === "clone");
    await sh(templateCheckout(pylon.boot.repo, disk));
    console.log(`bob   checkout HEAD=${(await git(disk, "rev-parse", "HEAD")).slice(0, 12)} (main is ${mainCommit.slice(0, 12)})`);
    const ran = join(disk, ".git", "ran-here");
    console.log(`bob   checkout .git/ran-here: ${existsSync(ran) ? (await readFile(ran, "utf8")).trim() : "(absent)"}`);
    console.log(`bob   checkout scripts/install.sh is main's: ${!(await readFile(join(disk, "scripts", "install.sh"), "utf8")).includes("post-checkout")}`);
  }

  assert.notEqual(pylon.firstBoot.kind, "template", "Bob's pylon, which will be given Bob's credentials at its egress, must not boot from a disk another principal's commit ran code on");
});
