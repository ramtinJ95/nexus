import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "./test-kit.ts";

const repo = new URL("..", import.meta.url).pathname;
const mv = execFileSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).trim();

/**
 * A checkout with this repository's .nexus/setup and .nexus/resume, and an `npm` first on PATH that logs each call and
 * acts as `npm ci` does, which removes node_modules first. With NPM_BLOCK set it then touches `started` and waits up to 60 s for `release`.
 * An `mv` beside it fails the rename of the staged install when MV_FAIL is set.
 */
async function checkout(t: { after(fn: () => Promise<void>): void }) {
  const dir = await tempDir("nexus-scripts-", t);
  const root = join(dir, "repo");
  const bin = join(dir, "bin");
  await mkdir(join(root, ".nexus"), { recursive: true });
  await mkdir(bin);
  for (const name of ["setup", "resume"]) await copyFile(join(repo, ".nexus", name), join(root, ".nexus", name));
  await writeFile(join(root, "package.json"), '{"name":"x"}\n');
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  const calls = join(dir, "npm-calls");
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$PWD $*" >> ${calls}\nrm -rf node_modules\n[ -z "\${NPM_BLOCK:-}" ] || { touch ${join(dir, "started")}; i=0; while [ ! -e ${join(dir, "release")} ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i + 1)); done; }\n[ -z "\${NPM_FAIL:-}" ] || exit 1\nmkdir node_modules && touch node_modules/installed\n`, { mode: 0o755 });
  await writeFile(join(bin, "mv"), `#!/bin/sh\n[ -z "\${MV_FAIL:-}" ] || [ "$1" != .nexus-install/node_modules ] || exit 1\nexec ${mv} "$@"\n`, { mode: 0o755 });
  const run = async (script: "setup" | "resume", { fail = false, block = false, mvFail = false } = {}) => {
    const { stderr } = await promisify(execFile)(join(root, ".nexus", script), [], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...fail ? { NPM_FAIL: "1" } : {}, ...block ? { NPM_BLOCK: "1" } : {}, ...mvFail ? { MV_FAIL: "1" } : {} },
    });
    return stderr;
  };
  return {
    root,
    dir,
    run,
    calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean),
    modules: async () => (await readdir(join(root, "node_modules")).catch(() => [])).sort(),
    staged: async () => await access(join(root, ".nexus-install")).then(() => true, () => false),
  };
}

test("resume installs on a first run, from the checkout whatever the cwd, and records the lockfile", async (t) => {
  const c = await checkout(t);
  assert.equal(await c.run("resume"), "");
  assert.deepEqual(await c.calls(), [`${c.root}/.nexus-install ci --no-audit --no-fund`]);
  assert.equal((await c.modules()).length, 2, "the install and a stamp of its lockfile");
  assert.equal(await c.staged(), false);
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
  const stderr = await c.run("resume", { fail: true });
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
  assert.deepEqual(await c.calls(), [`${c.root}/.nexus-install ci --no-audit --no-fund`]);
  await c.run("resume");
  assert.equal((await c.calls()).length, 1, "resume after setup finds the install recorded");
});

/** Resolves once `path` exists, and gives up after 60 s. */
async function appears(path: string) {
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((wake) => setTimeout(wake, 20)))
    if (await access(path).then(() => true, () => false)) return;
  throw new Error(`${path} did not appear`);
}

test("the packages in use stay in place while a new install runs, and the new ones replace them whole", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await writeFile(join(c.root, "node_modules", "in-use"), "");
  const before = await c.modules();
  await writeFile(join(c.root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  const install = c.run("resume", { block: true });
  try {
    await appears(join(c.dir, "started"));
    assert.deepEqual(await c.modules(), before, "the old packages are untouched while npm runs");
  } finally {
    await writeFile(join(c.dir, "release"), "");
    await install.catch(() => {});
  }
  assert.equal(await install, "");
  assert.deepEqual(await c.modules(), [".nexus-lockfile-sha256", "installed"], "the new install, without the old one's files");
  assert.equal(await c.staged(), false);
});

test("a failed install leaves the packages in use untouched", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  const stamp = await readFile(join(c.root, "node_modules", ".nexus-lockfile-sha256"), "utf8");
  await writeFile(join(c.root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  assert.match(await c.run("resume", { fail: true }), /not installed.*npm ci/);
  assert.deepEqual(await c.modules(), [".nexus-lockfile-sha256", "installed"]);
  assert.equal(await readFile(join(c.root, "node_modules", ".nexus-lockfile-sha256"), "utf8"), stamp, "the old stamp, so the next run tries again");
  assert.equal(await c.staged(), false);
});

test("a staging directory left by an interrupted run is removed, even when nothing needs installing", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await mkdir(join(c.root, ".nexus-install", "node_modules"), { recursive: true });
  await c.run("resume");
  assert.equal(await c.staged(), false);
  assert.equal((await c.calls()).length, 1);
});

test("a swap whose second rename fails puts the packages in use back and says so", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await writeFile(join(c.root, "node_modules", "in-use"), "");
  const before = await c.modules();
  await writeFile(join(c.root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  assert.match(await c.run("resume", { mvFail: true }), /not installed.*npm ci/);
  assert.deepEqual(await c.modules(), before);
  assert.equal(await c.staged(), false);
});

test("a swap cut off between its renames gets the packages in use back on the next run", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await mkdir(join(c.root, ".nexus-install"));
  await rename(join(c.root, "node_modules"), join(c.root, ".nexus-install", "old"));
  assert.equal(await c.run("resume"), "");
  assert.deepEqual(await c.modules(), [".nexus-lockfile-sha256", "installed"]);
  assert.equal((await c.calls()).length, 1, "their stamp still matches, so nothing installs");
  assert.equal(await c.staged(), false);
});
