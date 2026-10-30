import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { projectMirror } from "./mirror.ts";
import type { RemoteProject } from "./project.ts";
import type { NodeName, ProjectId } from "../ids.ts";
import { tempDir } from "../test-kit.ts";

const dir = await tempDir("nexus-mirror-test-");

const origin = join(dir, "origin");
const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args])).stdout.trim();
await mkdir(join(origin, ".nexus"), { recursive: true });
await git("init", "--quiet", "--initial-branch=main");
// As GitHub does, so the fetch leaves blobs out.
await git("config", "uploadpack.allowFilter", "true");
await writeFile(join(origin, ".nexus", "setup"), "#!/bin/sh\nnpm ci\n", { mode: 0o755 });
await git("add", ".");
await git("commit", "--quiet", "-m", "setup");
const first = await git("rev-parse", "HEAD");
await writeFile(join(origin, ".nexus", "setup"), "#!/bin/sh\nnpm ci && npm run build\n", { mode: 0o755 });
await git("commit", "--quiet", "-am", "build in setup");
await git("checkout", "--quiet", "-b", "bare-branch");
await git("rm", "--quiet", "-r", ".nexus");
await git("commit", "--quiet", "-m", "no setup");
await git("checkout", "--quiet", "main");

const project: RemoteProject = {
  id: "acme" as ProjectId, repoUrl: pathToFileURL(origin).href, defaultBranch: "main", defaultNode: "rj-firebat" as NodeName,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const mirror = projectMirror({ githubToken: null });

test("a branch resolves to its tip and the object ID of .nexus/setup there", async () => {
  assert.deepEqual(await mirror.setupInputs(project, { branch: "main" }), { commit: await git("rev-parse", "main"), setupBlob: await git("rev-parse", "main:.nexus/setup") });
});

test("a commit without .nexus/setup has none", async () => {
  assert.deepEqual(await mirror.setupInputs(project, { branch: "bare-branch" }), { commit: await git("rev-parse", "bare-branch"), setupBlob: null });
});

test("a full commit ID resolves to itself, though no branch ends there", async () => {
  assert.deepEqual(await mirror.setupInputs(project, { commit: first }), { commit: first, setupBlob: await git("rev-parse", `${first}:.nexus/setup`) });
});

test("reads that run at once each get their own ref's commit", async () => {
  const refs = ["main", "bare-branch", "main", "bare-branch"];
  const read = await Promise.all(refs.map((branch) => mirror.setupInputs(project, { branch })));
  assert.deepEqual(read.map((r) => r.commit), await Promise.all(refs.map((branch) => git("rev-parse", branch))));
});

test("a branch the remote does not have fails with git's reason", async () => {
  await assert.rejects(mirror.setupInputs(project, { branch: "gone" }), /^Error: git fetch exited 128: .*couldn't find remote ref refs\/heads\/gone/);
});

test("an SSH or other non-HTTPS remote is refused before git runs, whatever keys or agent the control plane's user has", async () => {
  for (const repoUrl of ["git@github.com:ramtin/acme.git", "ssh://git@10.255.255.1/ramtin/acme.git", "git://10.255.255.1/acme.git"]) {
    await assert.rejects(mirror.setupInputs({ ...project, repoUrl }, { branch: "main" }), new RegExp(`^Error: the control plane reads only https:// remotes, and holds no SSH key for ${repoUrl}$`));
  }
});

test("git's stderr over several lines is told on one line, after the subcommand and its exit code", async () => {
  const missing = { ...project, repoUrl: pathToFileURL(join(dir, "missing")).href };
  await assert.rejects(mirror.setupInputs(missing, { branch: "main" }), (err: Error) => {
    assert.match(err.message, /^git fetch exited 128: fatal: .*does not appear to be a git repository fatal: Could not read from remote repository\. Please make sure/);
    assert.doesNotMatch(err.message, /\n/);
    return true;
  });
});

test("an aborted read rejects", async () => {
  await assert.rejects(mirror.setupInputs(project, { branch: "main" }, AbortSignal.abort()), { name: "AbortError" });
});
