import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Guest } from "./backend.ts";
import type { DeclaredOutput } from "./protocol.ts";
import { fakeGuest } from "./fake-guest.ts";
import { addOutput, listOutputs, OutputRefused, outputsDir } from "./outputs.ts";

const run = promisify(execFile);
const home = "/home/user";
const repo = `${home}/workspace/repo`;

/** Runs each exec on this machine with /home/user moved to a scratch directory, both ways. */
async function localGuest(t: TestContext): Promise<{ guest: Guest; at(path: string): string }> {
  const scratch = await mkdtemp(join(tmpdir(), "nexus-outputs-"));
  t.after(() => rm(scratch, { recursive: true }));
  const inward = (s: string) => s.replaceAll(home, scratch);
  const guest = fakeGuest(() => { throw new Error("unused"); });
  guest.exec = (argv, { cwd, timeoutMs }) => new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1).map(inward), { cwd: inward(cwd), timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 127;
      resolve({ exitCode: code, output: (stdout + stderr).replaceAll(scratch, home), truncated: false });
    });
  });
  return { guest, at: inward };
}

async function gitRepo(at: (path: string) => string) {
  const dir = at(repo);
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) => run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  await writeFile(join(dir, "app.txt"), "one\n");
  await git("init", "-q");
  await git("add", "app.txt");
  await git("commit", "-q", "-m", "first");
  return { dir, git, head: (await git("rev-parse", "HEAD")).stdout.trim() };
}

test("a file output records the file's path and digest, and lists back", async (t) => {
  const { guest, at } = await localGuest(t);
  await mkdir(at(repo), { recursive: true });
  await writeFile(at(`${repo}/shot.png`), "pixels");
  const output = await addOutput(guest, { kind: "file", path: `${repo}/shot.png`, title: "Checkout page" });
  assert.match(output.id, /^out-/);
  assert.deepEqual(output, { id: output.id, kind: "file", path: `${repo}/shot.png`, title: "Checkout page", sha256: createHash("sha256").update("pixels").digest("hex") });
  assert.deepEqual(await listOutputs(guest), [output]);
});

test("a missing file is refused, and nothing is recorded", async (t) => {
  const { guest } = await localGuest(t);
  await assert.rejects(addOutput(guest, { kind: "file", path: `${repo}/nope.png` }), (err) => err instanceof OutputRefused && /nope.png is not a file/.test(err.message));
  assert.deepEqual(await listOutputs(guest), []);
});

test("a diff output snapshots tracked and untracked changes against HEAD and leaves the index alone", async (t) => {
  const { guest, at } = await localGuest(t);
  const { dir, git, head } = await gitRepo(at);
  await writeFile(join(dir, "app.txt"), "two\n");
  await writeFile(join(dir, "new.txt"), "fresh\n");
  const output = await addOutput(guest, { kind: "diff" });
  assert.ok(output.kind === "diff");
  assert.equal(output.base, head);
  assert.equal(output.title, null);
  const diff = await readFile(at(`${outputsDir}/${output.id}.diff`), "utf8");
  assert.match(diff, /^-one\n\+two$/m);
  assert.match(diff, /^\+\+\+ b\/new.txt\n@@ -0,0 \+1 @@\n\+fresh$/m);
  assert.equal(output.sha256, createHash("sha256").update(diff).digest("hex"));
  assert.equal((await git("status", "--porcelain")).stdout, " M app.txt\n?? new.txt\n", "the agent's index is unchanged");
  assert.deepEqual(await listOutputs(guest), [output]);
});

test("a diff of a clean tree is refused", async (t) => {
  const { guest, at } = await localGuest(t);
  await gitRepo(at);
  await assert.rejects(addOutput(guest, { kind: "diff" }), (err) => err instanceof OutputRefused && /no changes against HEAD/.test(err.message));
  assert.deepEqual(await listOutputs(guest), []);
});

test("a diff output before the first commit is against the empty tree, and applies to an empty directory", async (t) => {
  const { guest, at } = await localGuest(t);
  const dir = at(repo);
  await mkdir(join(dir, "src"), { recursive: true });
  await run("git", ["init", "-q", "--initial-branch=main", dir]);
  await writeFile(join(dir, "README.md"), "# sketch\n");
  await writeFile(join(dir, "src", "main.go"), "package main\n");
  const output = await addOutput(guest, { kind: "diff", title: "First version" });
  assert.ok(output.kind === "diff");
  assert.equal(output.base, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "git's empty tree");
  assert.equal((await run("git", ["-C", dir, "status", "--porcelain"])).stdout, "?? README.md\n?? src/\n", "the agent's index is unchanged");

  const empty = await mkdtemp(join(tmpdir(), "nexus-apply-"));
  t.after(() => rm(empty, { recursive: true }));
  await run("git", ["apply", at(`${outputsDir}/${output.id}.diff`)], { cwd: empty });
  assert.equal(await readFile(join(empty, "README.md"), "utf8"), "# sketch\n");
  assert.equal(await readFile(join(empty, "src", "main.go"), "utf8"), "package main\n");
  assert.deepEqual(await listOutputs(guest), [output]);
});

test("a diff of a repository with no commits and no files is refused", async (t) => {
  const { guest, at } = await localGuest(t);
  await mkdir(at(repo), { recursive: true });
  await run("git", ["init", "-q", at(repo)]);
  await assert.rejects(addOutput(guest, { kind: "diff" }), (err) => err instanceof OutputRefused && /the repository has no commits and no files/.test(err.message));
  assert.deepEqual(await listOutputs(guest), []);
});

test("a diff output shows a rename as a rename, whatever the agent's config, and applies to its base", async (t) => {
  const { guest, at } = await localGuest(t);
  const { dir, git } = await gitRepo(at);
  await git("config", "diff.renames", "false");
  await writeFile(join(dir, "app.txt"), "one\n".repeat(20));
  await git("commit", "-q", "-am", "longer");
  await git("mv", "app.txt", "main.txt");
  await writeFile(join(dir, "main.txt"), "one\n".repeat(19) + "two\n");
  const output = await addOutput(guest, { kind: "diff" });
  assert.ok(output.kind === "diff");
  const file = at(`${outputsDir}/${output.id}.diff`);
  assert.match(await readFile(file, "utf8"), /^rename from app.txt\nrename to main.txt$/m);

  const base = await mkdtemp(join(tmpdir(), "nexus-apply-"));
  t.after(() => rm(base, { recursive: true }));
  await run("git", ["-C", dir, "worktree", "add", "-q", "--detach", base, output.base]);
  await run("git", ["apply", file], { cwd: base });
  await assert.rejects(readFile(join(base, "app.txt")));
  assert.equal(await readFile(join(base, "main.txt"), "utf8"), "one\n".repeat(19) + "two\n");
});

test("a diff output holds an ignored file the agent force-added, as the Changes view does", async (t) => {
  const { guest, at } = await localGuest(t);
  const { dir, git } = await gitRepo(at);
  await writeFile(join(dir, ".git", "info", "exclude"), "*.log\n");
  await writeFile(join(dir, "kept.log"), "kept\n");
  await writeFile(join(dir, "skipped.log"), "skipped\n");
  await git("add", "-f", "kept.log");
  const output = await addOutput(guest, { kind: "diff" });
  const diff = await readFile(at(`${outputsDir}/${output.id}.diff`), "utf8");
  assert.match(diff, /^diff --git a\/kept.log b\/kept.log$/m);
  assert.doesNotMatch(diff, /skipped.log/);
});

test("a diff of a checkout that is not a git repository is refused", async (t) => {
  const { guest, at } = await localGuest(t);
  await mkdir(at(repo), { recursive: true });
  await assert.rejects(addOutput(guest, { kind: "diff" }), (err) => err instanceof OutputRefused && /the checkout is not a git repository/.test(err.message));
  assert.deepEqual(await listOutputs(guest), []);
});

test("outputs list in the order they were declared", async (t) => {
  const { guest, at } = await localGuest(t);
  await mkdir(at(repo), { recursive: true });
  const declared = [];
  for (const name of ["a", "b", "c"]) {
    await writeFile(at(`${repo}/${name}`), name);
    declared.push(await addOutput(guest, { kind: "file", path: `${repo}/${name}` }));
    await new Promise((resolve) => setTimeout(resolve, 2)); // IDs start with the millisecond
  }
  assert.deepEqual(await listOutputs(guest), declared);
});

test("a record Nexus did not write fails the listing and names its file", async (t) => {
  const { guest, at } = await localGuest(t);
  await mkdir(at(outputsDir), { recursive: true });
  await writeFile(at(`${outputsDir}/out-x.json`), "{\"id\":\"out-x\"}\n");
  await assert.rejects(listOutputs(guest), /out-x.json is not an output record Nexus wrote/);
});

test("an output that would take the listing past what the probe reads back is refused", async (t) => {
  const { guest, at } = await localGuest(t);
  await mkdir(at(repo), { recursive: true });
  await writeFile(at(`${repo}/shot.png`), "pixels");
  // Written directly, because a local shell given 30 KB of arguments stalled each command it started by 10 s on the Mac these tests run on.
  const kept: DeclaredOutput = { id: "out-1-00000000", kind: "file", path: `${repo}/shot.png`, title: "x".repeat(30_000), sha256: "0".repeat(64) };
  await mkdir(at(outputsDir), { recursive: true });
  await writeFile(at(`${outputsDir}/${kept.id}.json`), `${JSON.stringify(kept)}\n`);
  await assert.rejects(addOutput(guest, { kind: "file", path: `${repo}/shot.png`, title: "y".repeat(30_000) }), (err) => err instanceof OutputRefused && /would pass the 60000 bytes/.test(err.message));
  assert.deepEqual(await listOutputs(guest), [kept]);
});

test("a listing the guest cut short fails instead of dropping records", async () => {
  const guest = fakeGuest(() => ({ exitCode: 0, output: "out-1-00000000.json\t{", truncated: true }));
  await assert.rejects(listOutputs(guest), /passed the guest's output limit/);
});
