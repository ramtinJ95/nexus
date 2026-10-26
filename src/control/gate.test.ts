import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { checkScript, parseCheck } from "./gate.ts";
import type { CheckState } from "./review.ts";

/** A checkout with one commit whose `.nexus/check` is `check`, or none, and a HOME of its own, as a pylon has. */
async function checkout(t: import("node:test").TestContext, check: string | null) {
  const root = await mkdtemp(join(tmpdir(), "nexus-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "# repo\n");
  if (check !== null) {
    await execFileSync("mkdir", ["-p", join(repo, ".nexus")]);
    await writeFile(join(repo, ".nexus", "check"), `#!/bin/sh\n${check}\n`);
    await chmod(join(repo, ".nexus", "check"), 0o755);
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  const head = git("rev-parse", "HEAD");
  const run = (): CheckState => {
    const output = execFileSync("sh", ["-c", checkScript, "nexus-check", head], { cwd: repo, env: { ...process.env, HOME: root }, encoding: "utf8" });
    return parseCheck({ kind: "exec", exitCode: 0, output, truncated: false });
  };
  return { run, root, head };
}

async function settle(run: () => CheckState): Promise<CheckState> {
  for (let i = 0; i < 100; i++) {
    const state = run();
    if (state.kind === "done") return state;
    await sleep(50);
  }
  assert.fail("the check never finished");
}

test("a check starts detached, reads running, then keeps its result for the same commit", async (t) => {
  const c = await checkout(t, "echo typecheck ok; sleep 0.3; echo tests ok");
  assert.deepEqual(c.run(), { kind: "running" }, "the first exec starts it");
  assert.deepEqual(await settle(c.run), { kind: "done", passed: true, output: "typecheck ok\ntests ok" });
  assert.deepEqual(c.run(), { kind: "done", passed: true, output: "typecheck ok\ntests ok" }, "a later exec reads the kept result");
});

test("a failing check reports its exit code's failure and the log's tail", async (t) => {
  const c = await checkout(t, "echo 'src/a.ts(1,1): error TS2322'; exit 2");
  c.run();
  assert.deepEqual(await settle(c.run), { kind: "done", passed: false, output: "src/a.ts(1,1): error TS2322" });
});

test("a repository without .nexus/check fails, saying so", async (t) => {
  const c = await checkout(t, null);
  const state = c.run();
  assert.equal(state.kind, "done");
  assert.ok(state.kind === "done" && !state.passed && /no executable \.nexus\/check/.test(state.output));
});

test("a job the pylon's pause killed, which left no result, starts over", async (t) => {
  const c = await checkout(t, "echo ran >> \"$HOME/runs\"; sleep 30");
  c.run();
  const pid = execFileSync("cat", [join(c.root, ".nexus-checks", c.head, "pid")], { encoding: "utf8" }).trim();
  process.kill(-Number(pid), "SIGKILL");
  await sleep(100);
  assert.deepEqual(c.run(), { kind: "running" });
  const restarted = execFileSync("cat", [join(c.root, ".nexus-checks", c.head, "pid")], { encoding: "utf8" }).trim();
  assert.notEqual(restarted, pid);
  process.kill(-Number(restarted), "SIGKILL");
});
