import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "./test-kit.ts";

const repo = new URL("..", import.meta.url).pathname;

/** A checkout with this repository's .nexus/setup and .nexus/resume, and an `npm` first on PATH that logs each call and acts as `npm ci` does. */
async function checkout(t: { after(fn: () => Promise<void>): void }) {
  const dir = await tempDir("nexus-scripts-", t);
  const root = join(dir, "repo");
  const bin = join(dir, "bin");
  await mkdir(join(root, ".nexus"), { recursive: true });
  await mkdir(bin);
  for (const name of ["setup", "resume"]) await copyFile(join(repo, ".nexus", name), join(root, ".nexus", name));
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  const calls = join(dir, "npm-calls");
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$PWD $*" >> ${calls}\n[ -z "\${NPM_FAIL:-}" ] || exit 1\nrm -rf node_modules && mkdir node_modules && touch node_modules/installed\n`, { mode: 0o755 });
  const run = async (script: "setup" | "resume", fail = false) => {
    const { stderr } = await promisify(execFile)(join(root, ".nexus", script), [], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...fail ? { NPM_FAIL: "1" } : {} },
    });
    return stderr;
  };
  return {
    root,
    run,
    calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean),
    modules: async () => (await readdir(join(root, "node_modules")).catch(() => [])).sort(),
  };
}

test("resume installs on a first run, from the checkout whatever the cwd, and records the lockfile", async (t) => {
  const c = await checkout(t);
  assert.equal(await c.run("resume"), "");
  assert.deepEqual(await c.calls(), [`${c.root} ci --no-audit --no-fund`]);
  assert.equal((await c.modules()).length, 2, "the install and a stamp of its lockfile");
});

test("resume skips npm while the lockfile is the one it installed, and installs again once it changes", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await c.run("resume");
  assert.equal((await c.calls()).length, 1, "an unchanged lockfile calls no npm");
  await writeFile(join(c.root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  await c.run("resume");
  assert.equal((await c.calls()).length, 2, "a changed lockfile installs again");
  await c.run("resume");
  assert.equal((await c.calls()).length, 2, "and records the new lockfile");
});

test("a failed install exits 0, says to run npm ci, records nothing, and the next run tries again", async (t) => {
  const c = await checkout(t);
  const stderr = await c.run("resume", true);
  assert.equal(stderr.trim().split("\n").length, 1);
  assert.match(stderr, /not installed.*npm ci/);
  assert.deepEqual(await c.modules(), [], "no stamp");
  await c.run("resume");
  assert.equal((await c.calls()).length, 2, "the next run installs");
  assert.equal((await c.modules()).length, 2);
});

test("setup installs on a first run as resume does", async (t) => {
  const c = await checkout(t);
  assert.equal(await c.run("setup"), "");
  assert.deepEqual(await c.calls(), [`${c.root} ci --no-audit --no-fund`]);
  await c.run("resume");
  assert.equal((await c.calls()).length, 1, "resume after setup finds the install recorded");
});
