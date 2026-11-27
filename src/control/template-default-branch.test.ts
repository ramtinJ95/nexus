/**
 * A template is keyed on the project, the image and a hash of `.nexus/setup`'s blob (templates.ts, setupHashOf), which
 * names neither who started the thread that built it nor the commit setup ran at. So on a shared install a build runs
 * at the default branch's head, and a thread whose setup differs from the default branch's boots fresh. A solo install
 * builds at the starting thread's commit, as before.
 *
 * Everything here is the real code: the API and thread starter (api-kit), the real project mirror reading a real git
 * remote, and the real shell commands a template build and a template boot run (pylon-boot.ts). Only the probe is the
 * kit's fake, so the build's commands are run here, in a directory, as pylon-boot.test.ts does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { alice, bob, image, node, observeNode, testApi } from "../test-support/api-kit.ts";
import { tailnet } from "../test-support/people.ts";
import { tempDir } from "../test-support/kit.ts";
import { projectMirror } from "./mirror.ts";
import { peopleOf, type People } from "./people.ts";
import { repoInitCommand, templateCheckout } from "../backends/pylon-boot.ts";
import type { Thread } from "./thread-store.ts";
import type { ImageId, Person, ProjectId, TemplateId } from "../ids.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import type { CloneRepo } from "../protocol/spawn.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args]).then((r) => r.stdout.trim());
const sh = (script: string, cwd?: string) => run("sh", ["-c", script], { cwd });
const shared = peopleOf({ [tailnet.alice.UserProfile!.LoginName as Person]: "admin", [tailnet.bob.UserProfile!.LoginName as Person]: "engineer" });

/**
 * A remote whose main runs scripts/install.sh from .nexus/setup, and alice/wip, which changes only that script so it
 * leaves a git hook that records it ran. `setup` also changes .nexus/setup on alice/wip.
 */
async function remote(t: Parameters<typeof tempDir>[1], change: { setup: boolean }) {
  const dir = await tempDir("template-default-branch-", t);
  const [bare, work, disk] = ["remote.git", "work", "template-disk"].map((name) => join(dir, name)) as [string, string, string];
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  await run("git", ["clone", "--quiet", bare, work]);
  await mkdir(join(work, ".nexus"));
  await mkdir(join(work, "scripts"));
  await writeFile(join(work, ".nexus", "setup"), "#!/bin/sh\nexec ./scripts/install.sh\n", { mode: 0o755 });
  await writeFile(join(work, "scripts", "install.sh"), "#!/bin/sh\necho deps > .installed\n", { mode: 0o755 });
  await git(work, "add", "-A");
  await git(work, "commit", "--quiet", "-m", "base");
  await git(work, "push", "--quiet", "origin", "HEAD:main");
  const mainCommit = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "--quiet", "-b", "alice/wip");
  await writeFile(join(work, "scripts", "install.sh"), [
    "#!/bin/sh", "echo deps > .installed",
    "printf '#!/bin/sh\\necho \"code from alice/wip ran in this checkout\" >> .git/ran-here\\n' > .git/hooks/post-checkout",
    "chmod +x .git/hooks/post-checkout", "",
  ].join("\n"), { mode: 0o755 });
  if (change.setup) await writeFile(join(work, ".nexus", "setup"), "#!/bin/sh\nset -e\nexec ./scripts/install.sh\n", { mode: 0o755 });
  await git(work, "commit", "--quiet", "-am", "wip");
  await git(work, "push", "--quiet", "origin", "HEAD:alice/wip");
  return { url: `file://${bare}`, disk, mainCommit, aliceCommit: await git(work, "rev-parse", "HEAD") };
}

async function install(t: Parameters<typeof testApi>[0], url: string, people: People | undefined) {
  const s = await testApi(t, people === undefined ? {} : { people });
  s.registry.projects.createProject({
    id: "acme", repoUrl: url, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: ["registry.npmjs.org"], secrets: [], logins: [], preSetup: null,
  } as never);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
  observeNode(s, node, { total: 64, committed: 0 });
  const mirror = projectMirror({ githubToken: null });
  s.remoteReads((p, ref) => mirror.setupInputs(p, ref));
  return s;
}

/** Alice starts a thread on her branch, and the build her start asked for runs as the node's build would, then publishes. */
async function aliceBuilds(s: Awaited<ReturnType<typeof install>>, repo: Awaited<ReturnType<typeof remote>>) {
  s.callAs(alice);
  const started = await s.call("POST", "/v1/threads", { project: "acme", claude: "Alice's work", branch: "alice/wip" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const [template] = s.registry.images.templates("acme" as ProjectId);
  assert.ok(template?.state === "building", "her start asks the node to build the template of this setup");
  const build: CloneRepo = { kind: "clone", url: repo.url, checkout: { branch: template.inputs.repo.branch, commit: template.inputs.repo.commit } };
  await sh(repoInitCommand(build, repo.disk));
  await sh("if test -e .nexus/setup; then ./.nexus/setup; fi", repo.disk);
  s.registry.images.saveTemplate({ id: template.id, key: template.key, state: "ready", builtOn: node, builtAt: Date.now() - 60_000, commit: template.inputs.repo.commit, ...template.defaultHead === true ? { defaultHead: true } : {} });
  observeNode(s, node, { total: 64, committed: 0 }, { artifacts: [image.id, template.id] as NodeObservation["artifacts"] });
  return { thread: started.body as Thread, template };
}

/** Bob starts a thread on main, and his pylon's first boot checks out over the template disk when it boots from one. */
async function bobBoots(s: Awaited<ReturnType<typeof install>>, repo: Awaited<ReturnType<typeof remote>>) {
  s.callAs(bob);
  const started = await s.call("POST", "/v1/threads", { project: "acme", claude: "Bob's work", branch: "main" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const pylon = s.registry.threads.pylon((started.body as Thread).pylonId)!;
  if (pylon.firstBoot.kind === "template") {
    assert.ok(pylon.boot.repo.kind === "clone");
    await sh(templateCheckout(pylon.boot.repo, repo.disk));
  }
  return { pylon, ranAlicesCode: existsSync(join(repo.disk, ".git", "ran-here")) };
}

test("on a shared install a template is built at the default branch's head, so bob's pylon boots from a disk only merged code ran on", async (t) => {
  const repo = await remote(t, { setup: false });
  const s = await install(t, repo.url, shared);
  const { thread, template } = await aliceBuilds(s, repo);
  assert.deepEqual(template.inputs.repo, { url: repo.url, branch: "main", commit: repo.mainCommit }, "the build checks out main's head, not alice's commit");
  assert.equal(thread.setup?.how, "fresh");
  const { pylon, ranAlicesCode } = await bobBoots(s, repo);
  assert.deepEqual(pylon.firstBoot, { kind: "template", template: template.id }, "bob still boots from the template of main's setup");
  assert.equal(ranAlicesCode, false, "no code from alice/wip ran on bob's boot disk");
});

test("on a shared install a thread whose setup differs from the default branch's boots fresh and builds nothing", async (t) => {
  const repo = await remote(t, { setup: true });
  const s = await install(t, repo.url, shared);
  s.callAs(alice);
  const started = await s.call("POST", "/v1/threads", { project: "acme", claude: "Alice's work", branch: "alice/wip" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual((started.body as Thread).setup, { how: "fresh", reason: "its setup differs from main's, and on a shared install a template is built only from main" });
  assert.deepEqual(s.registry.images.templates("acme" as ProjectId), []);
});

test("on a shared install a template recorded before the install was shared is neither booted from nor waited on", async (t) => {
  const repo = await remote(t, { setup: false });
  const s = await install(t, repo.url, shared);
  s.callAs(alice);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", claude: "Alice's work", branch: "alice/wip" })).status, 201);
  const [asked] = s.registry.images.templates("acme" as ProjectId);
  assert.ok(asked?.state === "building" && asked.defaultHead === true);
  const legacy = { key: asked.key, on: node, inputs: { ...asked.inputs, repo: { url: repo.url, branch: "alice/wip", commit: repo.aliceCommit } }, submitted: null };
  s.registry.images.deleteTemplate(asked.id);
  s.registry.images.saveTemplate({ id: "tpl-0000000000a1" as TemplateId, key: asked.key, state: "ready", builtOn: node, builtAt: Date.now() - 60_000, commit: repo.aliceCommit });
  s.registry.images.saveTemplate({ id: "tpl-0000000000a2" as TemplateId, state: "building", ...legacy });
  observeNode(s, node, { total: 64, committed: 0 }, { artifacts: [image.id, "tpl-0000000000a1"] as NodeObservation["artifacts"] });
  s.callAs(bob);
  const started = await s.call("POST", "/v1/threads", { project: "acme", claude: "Bob's work", branch: "main" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const setup = (started.body as Thread).setup;
  assert.ok(setup?.how === "fresh" && setup.building !== undefined && !["tpl-0000000000a1", "tpl-0000000000a2"].includes(setup.building), JSON.stringify(setup));
  const build = s.registry.images.templates("acme" as ProjectId).find((r) => r.id === setup.building);
  assert.ok(build?.state === "building");
  assert.deepEqual(build.inputs.repo, { url: repo.url, branch: "main", commit: repo.mainCommit }, "bob's start builds main's head anew");
});

test("a solo install builds a template at the starting thread's commit, as before", async (t) => {
  const repo = await remote(t, { setup: false });
  const s = await install(t, repo.url, undefined);
  const { template } = await aliceBuilds(s, repo);
  assert.deepEqual(template.inputs.repo, { url: repo.url, branch: "alice/wip", commit: repo.aliceCommit });
  const { pylon, ranAlicesCode } = await bobBoots(s, repo);
  assert.equal(pylon.firstBoot.kind, "template");
  assert.equal(ranAlicesCode, true, "one person's install shares one template across that person's branches");
});
