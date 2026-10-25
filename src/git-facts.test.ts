import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fakeGuest } from "./fake-guest.ts";
import { gitFacts } from "./git-facts.ts";
import { checkoutDir } from "./sessions.ts";

const run = promisify(execFile);
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
  await s.git("branch", "topic/nested");
  await s.git("branch", "unpublished");
  await s.git("update-ref", "refs/remotes/origin/main", head);
  await s.git("update-ref", "refs/remotes/origin/renamed", head);
  await s.git("branch", "--set-upstream-to=origin/renamed", "main");
  await s.git("update-ref", "refs/remotes/fork/topic/nested", head);
  const published = async (name: string) => (await gitFacts(s.guest)).branches.find((b) => b.name === name)?.pushedAs;
  assert.equal(await published("main"), "origin/renamed");
  assert.equal(await published("topic/nested"), "fork/topic/nested");
  assert.equal(await published("unpublished"), null, "a shared commit alone never identifies a published branch");
  await s.git("update-ref", "refs/remotes/other/topic/nested", head);
  assert.equal(await published("topic/nested"), null, "ambiguous non-origin names are not guessed");
  await s.git("update-ref", "refs/remotes/origin/topic/nested", head);
  assert.equal(await published("topic/nested"), "origin/topic/nested");
  await s.git("update-ref", "-d", "refs/remotes/origin/renamed");
  assert.equal(await published("main"), "origin/main", "a missing upstream ref does not block fallback");
  await s.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(await published("main"), null);
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
