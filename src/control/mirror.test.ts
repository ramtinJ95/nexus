import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { projectMirror } from "./mirror.ts";
import type { RemoteProject } from "./project.ts";
import type { NodeName, ProjectId } from "../ids.ts";
import { tempDir } from "../test-support/kit.ts";

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
  assert.deepEqual(read.map((r) => r?.commit), await Promise.all(refs.map((branch) => git("rev-parse", branch))));
});

test("a branch the remote does not have reads as none, and a commit it does not have still fails with git's reason", async () => {
  assert.equal(await mirror.setupInputs(project, { branch: "gone" }), null);
  await assert.rejects(mirror.setupInputs(project, { commit: "0".repeat(40) }), /^Error: git fetch exited 128: /);
});

test("an SSH or other non-HTTPS remote is refused before git runs, whatever keys or agent the control plane's user has", async () => {
  for (const repoUrl of ["git@github.com:ramtin/acme.git", "ssh://git@10.255.255.1/ramtin/acme.git", "git://10.255.255.1/acme.git"]) {
    await assert.rejects(mirror.setupInputs({ ...project, repoUrl }, { branch: "main" }), new RegExp(`^Error: the control plane reads only https:// remotes, and holds no SSH key for ${repoUrl}$`));
  }
});

test("git's stderr over several lines is told on one line, after the subcommand and its exit code", async () => {
  const missing = { ...project, repoUrl: pathToFileURL(join(dir, "missing")).href };
  await assert.rejects(mirror.setupInputs(missing, { branch: "main" }), (err: Error) => {
    assert.match(err.message, /^git ls-remote exited 128: fatal: .*does not appear to be a git repository fatal: Could not read from remote repository\. Please make sure/);
    assert.doesNotMatch(err.message, /\n/);
    return true;
  });
});

test("an aborted read rejects", async () => {
  await assert.rejects(mirror.setupInputs(project, { branch: "main" }, AbortSignal.abort()), { name: "AbortError" });
});

/** Runs `read` with git tracing each process into a directory of its own, and counts the fetches git ran. */
async function fetchesDuring(read: () => Promise<unknown>): Promise<number> {
  const traces = await tempDir("nexus-mirror-trace-");
  const before = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = traces;
  try {
    await read();
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = before;
  }
  let fetches = 0;
  for (const file of await readdir(traces)) {
    const events = (await readFile(join(traces, file), "utf8")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { event: string; name?: string });
    if (events.some((e) => e.event === "cmd_name" && e.name === "fetch")) fetches++;
  }
  return fetches;
}

test("two reads of one commit fetch it once, and a branch fetches again only once its tip moves", async () => {
  const fresh = projectMirror({ githubToken: null });
  const atFirst = { commit: first, setupBlob: await git("rev-parse", `${first}:.nexus/setup`) };
  assert.equal(await fetchesDuring(async () => assert.deepEqual(await fresh.setupInputs(project, { commit: first }), atFirst)), 1);
  assert.equal(await fetchesDuring(async () => assert.deepEqual(await fresh.setupInputs(project, { commit: first }), atFirst)), 0);

  await git("checkout", "--quiet", "-b", "moving", first);
  assert.equal(await fetchesDuring(async () => assert.deepEqual(await fresh.setupInputs(project, { branch: "moving" }), atFirst)), 0, "a branch at a commit already read only lists the remote");
  await writeFile(join(origin, ".nexus", "setup"), "#!/bin/sh\nnpm ci --moved\n", { mode: 0o755 });
  await git("commit", "--quiet", "-am", "move the branch");
  await git("checkout", "--quiet", "main");
  const moved = { commit: await git("rev-parse", "moving"), setupBlob: await git("rev-parse", "moving:.nexus/setup") };
  assert.equal(await fetchesDuring(async () => assert.deepEqual(await fresh.setupInputs(project, { branch: "moving" }), moved)), 1);
  assert.equal(await fetchesDuring(async () => assert.deepEqual(await fresh.setupInputs(project, { branch: "moving" }), moved)), 0);
});

test("a branch is matched by its whole name, not by a longer ref that ends in it", async () => {
  await git("branch", "nested/refs/heads/solo", "bare-branch");
  assert.equal(await mirror.setupInputs(project, { branch: "solo" }), null);
});
