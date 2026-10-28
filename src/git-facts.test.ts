import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, type ExecFileOptions } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fakeGuest } from "./fake-guest.ts";
import { gitFacts } from "./git-facts.ts";
import { checkoutDir } from "./sessions.ts";

const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const run = (file: string, args: readonly string[], options: ExecFileOptions = {}) => exec(file, args, { ...options, env: { ...gitEnv, ...options.env }, encoding: "utf8" });
async function checkout(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-git-facts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => run("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args]);
  await git("init", "-q", "--initial-branch=main");
  const guest = fakeGuest(() => { throw new Error("unused"); });
  let reads = 0;
  guest.exec = async (argv, opts) => {
    reads++;
    assert.equal(opts.cwd, checkoutDir);
    assert.equal(opts.timeoutMs, 3000);
    try {
      const result = await run(argv[0]!, argv.slice(1), { cwd: dir, timeout: opts.timeoutMs });
      return { exitCode: 0, output: result.stdout, truncated: false };
    } catch (error) {
      return { exitCode: 1, output: (error as { stderr: string }).stderr, truncated: false };
    }
  };
  const commit = async () => { await git("add", "-A"); await git("commit", "--allow-empty", "-qm", "commit"); return (await git("rev-parse", "HEAD")).stdout.trim(); };
  return { dir, git, guest, commit, reads: () => reads };
}

test("a scratch checkout reports its unborn branch, empty-tree head and untracked dirt", async (t) => {
  const s = await checkout(t);
  const empty = (await s.git("hash-object", "-t", "tree", "/dev/null")).stdout.trim();
  assert.deepEqual(await gitFacts(s.guest), { head: empty, branch: "main", dirty: false, branches: [] });
  await writeFile(join(s.dir, "new.txt"), "untracked");
  assert.deepEqual(await gitFacts(s.guest), { head: empty, branch: "main", dirty: true, branches: [] });
  assert.equal(s.reads(), 2);
});

test("current and detached HEAD, staged, unstaged and ignored files leave the real index unchanged", async (t) => {
  const s = await checkout(t);
  await writeFile(join(s.dir, "file"), "original");
  await writeFile(join(s.dir, ".gitignore"), "ignored\n");
  const head = await s.commit();
  await writeFile(join(s.dir, "ignored"), "not dirty");
  const before = await readFile(join(s.dir, ".git/index"));
  assert.deepEqual(await gitFacts(s.guest), { head, branch: "main", dirty: false, branches: [{ name: "main", head, pushedAs: null }] });
  assert.deepEqual(await readFile(join(s.dir, ".git/index")), before);
  await writeFile(join(s.dir, "file"), "changed");
  assert.equal((await gitFacts(s.guest)).dirty, true);
  await s.git("add", "file");
  const staged = await readFile(join(s.dir, ".git/index"));
  assert.equal((await gitFacts(s.guest)).dirty, true);
  assert.deepEqual(await readFile(join(s.dir, ".git/index")), staged);
  await s.git("reset", "--hard", "HEAD");
  await s.git("checkout", "--detach", "-q");
  assert.deepEqual(await gitFacts(s.guest), { head, branch: null, dirty: false, branches: [{ name: "main", head, pushedAs: null }] });
});

test("a real push.default=current push with no upstream is discovered from its remote-tracking ref", async (t) => {
  const s = await checkout(t);
  const remote = await mkdtemp(join(tmpdir(), "nexus-git-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await run("git", ["init", "--bare", "-q", remote]);
  await s.git("remote", "add", "origin", remote);
  await s.git("checkout", "-qb", "agent-deploys");
  const head = await s.commit();
  assert.equal((await gitFacts(s.guest)).branches[0]?.pushedAs, null);
  await s.git("-c", "push.default=current", "push", "origin");
  await assert.rejects(s.git("rev-parse", "@{upstream}"));
  // Remove the remote repository so the observation cannot depend on contacting it.
  await rm(remote, { recursive: true, force: true });
  assert.deepEqual((await gitFacts(s.guest)).branches, [{ name: "agent-deploys", head, pushedAs: "origin/agent-deploys" }]);
  const ahead = await s.commit();
  assert.deepEqual((await gitFacts(s.guest)).branches, [{ name: "agent-deploys", head: ahead, pushedAs: "origin/agent-deploys" }], "published name survives unpushed local commits");
});

test("existing upstreams, same-named remote refs and ambiguity have deterministic precedence", async (t) => {
  const s = await checkout(t);
  const head = await s.commit();
  for (const remote of ["origin", "fork", "other"]) await s.git("remote", "add", remote, `https://example.com/${remote}.git`);
  // As a push records a remote-tracking ref it updates.
  const push = (ref: string) => s.git("update-ref", "-m", "update by push", ref, head);
  await s.git("branch", "topic/nested");
  await s.git("branch", "unpublished");
  await push("refs/remotes/origin/main");
  await push("refs/remotes/origin/renamed");
  await s.git("branch", "--set-upstream-to=origin/renamed", "main");
  await push("refs/remotes/fork/topic/nested");
  const published = async (name: string) => (await gitFacts(s.guest)).branches.find((b) => b.name === name)?.pushedAs;
  assert.equal(await published("main"), "origin/renamed");
  assert.equal(await published("topic/nested"), "fork/topic/nested");
  assert.equal(await published("unpublished"), null, "a shared commit alone never identifies a published branch");
  await push("refs/remotes/other/topic/nested");
  assert.equal(await published("topic/nested"), null, "ambiguous non-origin names are not guessed");
  await push("refs/remotes/origin/topic/nested");
  assert.equal(await published("topic/nested"), "origin/topic/nested");
  await s.git("update-ref", "-d", "refs/remotes/origin/renamed");
  assert.equal(await published("main"), "origin/main", "a missing upstream ref does not block fallback");
  await s.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(await published("main"), null);
});

test("a branch cloned, fetched or checked out from a remote is pushed only once this checkout pushes it", async (t) => {
  const s = await checkout(t);
  const remote = await mkdtemp(join(tmpdir(), "nexus-git-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await run("git", ["init", "--bare", "-q", "--initial-branch=main", remote]);
  await s.git("remote", "add", "origin", remote);
  await s.commit();
  await s.git("push", "-q", "origin", "main:main", "main:merged", "main:later");
  await rm(s.dir, { recursive: true, force: true });
  await run("git", ["clone", "-q", remote, s.dir]);
  await s.git("checkout", "-q", "merged");
  await s.git("fetch", "-q", "origin");
  await s.git("checkout", "-q", "later");
  assert.deepEqual((await gitFacts(s.guest)).branches.map((b) => [b.name, b.pushedAs]), [["later", null], ["main", null], ["merged", null]]);
  await s.commit();
  await s.git("push", "-q", "origin", "later");
  await s.git("fetch", "-q", "origin");
  assert.equal((await gitFacts(s.guest)).branches.find((b) => b.name === "later")?.pushedAs, "origin/later", "a push stays recorded across later fetches");
});

test("symbolic remote HEAD and local tracking branches do not imply a pushed branch", async (t) => {
  const s = await checkout(t);
  const head = await s.commit();
  await s.git("remote", "add", "origin", "https://example.com/repo.git");
  await s.git("update-ref", "refs/remotes/origin/default", head);
  await s.git("symbolic-ref", "refs/remotes/origin/main", "refs/remotes/origin/default");
  await s.git("branch", "local", "--track", "main");
  assert.ok((await gitFacts(s.guest)).branches.every((b) => b.pushedAs === null));
});

test("too many refs and missing repositories fail rather than emitting partial facts", async (t) => {
  const s = await checkout(t);
  const head = await s.commit();
  const updates = Array.from({ length: 1001 }, (_, i) => `create refs/heads/branch-${i} ${head}\n`).join("");
  const file = join(s.dir, "refs-input");
  await writeFile(file, updates);
  await run("sh", ["-c", 'git update-ref --stdin < "$1"', "sh", file], { cwd: s.dir });
  await assert.rejects(gitFacts(s.guest), /could not be read/);
  await rm(join(s.dir, ".git"), { recursive: true });
  await assert.rejects(gitFacts(s.guest), /could not be read/);
});

test("failed, timed out, truncated and invalid guest replies are rejected", async () => {
  for (const reply of [{ exitCode: null, output: "" }, { exitCode: 1, output: "" }, { exitCode: 0, output: "{}" }, { exitCode: 0, output: "bad JSON" }, { exitCode: 0, output: "", truncated: true }, { exitCode: 0, output: "x".repeat(65536) }]) {
    await assert.rejects(gitFacts(fakeGuest(() => reply)));
  }
});

test("branch names are unambiguous beside a same-named tag and preserve Unicode line separators", async (t) => {
  const s = await checkout(t);
  const head = await s.commit();
  await s.git("tag", "main");
  assert.equal((await gitFacts(s.guest)).branch, "main");
  const branch = "topic/line\u2028separator";
  const remote = "remote\u2028name";
  await s.git("checkout", "-qb", branch);
  await s.git("remote", "add", remote, "https://example.com/repo.git");
  await s.git("update-ref", "-m", "update by push", `refs/remotes/${remote}/${branch}`, head);
  const facts = await gitFacts(s.guest);
  assert.equal(facts.branch, branch);
  assert.deepEqual(facts.branches.find((b) => b.name === branch), { name: branch, head, pushedAs: `${remote}/${branch}` });
});

test("a missing promisor tree cannot trigger a lazy fetch during observation", async (t) => {
  const s = await checkout(t);
  await writeFile(join(s.dir, "file"), "content");
  await s.commit();
  const marker = join(s.dir, "fetched");
  await s.git("remote", "add", "origin", `ext::sh -c touch% ${marker}`);
  await s.git("config", "remote.origin.promisor", "true");
  await s.git("config", "remote.origin.partialclonefilter", "blob:none");
  await s.git("config", "protocol.ext.allow", "always");
  const tree = (await s.git("rev-parse", "HEAD^{tree}")).stdout.trim();
  await rm(join(s.dir, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  await assert.rejects(s.git("status", "--porcelain"));
  assert.equal(await readFile(marker, "utf8"), "", "ordinary status attempted the promisor transport");
  await rm(marker);
  await assert.rejects(gitFacts(s.guest), /could not be read/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("the helper deadline kills a slow clean filter and its children on every poll", async (t) => {
  const s = await checkout(t);
  await writeFile(join(s.dir, "file.txt"), "initial\n");
  await writeFile(join(s.dir, ".gitattributes"), "*.txt filter=slow\n");
  await s.commit();
  const script = join(s.dir, ".git", "slow-filter");
  const pids = join(s.dir, ".git", "filter-pids");
  await writeFile(script, `#!/bin/sh\necho $$ >> '${pids}'\nsleep 120 &\necho $! >> '${pids}'\nwait\n`);
  await chmod(script, 0o700);
  await s.git("config", "filter.slow.clean", script);
  await s.git("config", "filter.slow.required", "true");
  await writeFile(join(s.dir, "file.txt"), "changed\n");
  const running = async (pid: number) => {
    try {
      process.kill(pid, 0);
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return !/[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3));
    } catch { return false; }
  };
  t.after(async () => {
    for (const pid of (await readFile(pids, "utf8").catch(() => "")).trim().split("\n").map(Number)) {
      if (pid > 0 && await running(pid)) process.kill(pid, "SIGKILL");
    }
  });
  for (let i = 1; i <= 2; i++) {
    await assert.rejects(gitFacts(s.guest), /could not be read/);
    const ids = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
    assert.equal(ids.length, i * 2, "the clean filter really ran and spawned a child");
    // The deadline only ends a hang: a loaded suite can take seconds to reap what dies at once alone, and the child sleeps for longer.
    for (const deadline = Date.now() + 60_000; (await Promise.all(ids.map(running))).some(Boolean);) {
      assert.ok(Date.now() < deadline, "no filter process may outlive the helper");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});
