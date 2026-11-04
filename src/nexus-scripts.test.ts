import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, copyFile, mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "./test-kit.ts";

const repo = new URL("..", import.meta.url).pathname;
const which = (name: string) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
const mv = which("mv");
const changedLock = '{"lockfileVersion":3,"packages":{}}\n';

interface Faults { fail?: boolean; block?: boolean; restoreFails?: boolean; publishFails?: boolean; race?: boolean }

/**
 * A checkout with this repository's .nexus/setup and .nexus/resume, and stubs first on PATH:
 * - `npm` logs each call and acts as `npm ci` does, which removes node_modules first. `block` then touches `started`
 *   and waits up to 60 s for `release`. `fail` exits 1.
 * - `mv` fails each move of .nexus-install/old under `restoreFails`. Under `race` it makes a node_modules of the
 *   agent's own right after the packages in use move aside, as an agent's npm ci between the two moves would.
 * - `node` exits 1 under `publishFails`, which fails the rename that publishes the staged install.
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
  await writeFile(join(bin, "mv"), `#!/bin/sh\n[ -z "\${MV_RESTORE_FAIL:-}" ] || [ "$1" != .nexus-install/old ] || exit 1\n${mv} "$@" || exit\n[ -z "\${MV_RACE:-}" ] || [ "$2" != .nexus-install/old ] || { mkdir node_modules && touch node_modules/agent; }\n`, { mode: 0o755 });
  await writeFile(join(bin, "node"), `#!/bin/sh\n[ -z "\${NODE_FAIL:-}" ] || exit 1\nexec ${process.execPath} "$@"\n`, { mode: 0o755 });
  const run = async (script: "setup" | "resume", faults: Faults = {}) => {
    const { stderr } = await promisify(execFile)(join(root, ".nexus", script), [], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...faults.fail ? { NPM_FAIL: "1" } : {},
        ...faults.block ? { NPM_BLOCK: "1" } : {},
        ...faults.restoreFails ? { MV_RESTORE_FAIL: "1" } : {},
        ...faults.race ? { MV_RACE: "1" } : {},
        ...faults.publishFails ? { NODE_FAIL: "1" } : {},
      },
    });
    return stderr;
  };
  const list = async (path: string) => (await readdir(join(root, path)).catch(() => [])).sort();
  return {
    root,
    dir,
    run,
    calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean),
    modules: () => list("node_modules"),
    backup: () => list(".nexus-install/old"),
    staged: async () => await access(join(root, ".nexus-install")).then(() => true, () => false),
    /** A first install, with a file only the packages in use have, and then a changed lockfile. */
    async installed() {
      await run("resume");
      await writeFile(join(root, "node_modules", "in-use"), "");
      const before = await list("node_modules");
      await writeFile(join(root, "package-lock.json"), changedLock);
      return before;
    },
  };
}

const notInstalled = /^The npm packages are not installed: run npm ci\.\n$/;
const notRestored = /^The packages in use could not be put back from \.nexus-install\/old: move it to node_modules\.\n$/;

test("resume installs on a first run, from the checkout whatever the cwd, and records the lockfile", async (t) => {
  const c = await checkout(t);
  assert.equal(await c.run("resume"), "");
  assert.deepEqual(await c.calls(), [`${c.root}/.nexus-install ci --no-audit --no-fund`]);
  assert.deepEqual(await c.modules(), [".nexus-lockfile-sha256", "installed"]);
  assert.equal(await c.staged(), false);
});

test("resume skips npm while the lockfile is the one it installed, and installs again once it changes", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await c.run("resume");
  assert.equal((await c.calls()).length, 1, "an unchanged lockfile calls no npm");
  await writeFile(join(c.root, "package-lock.json"), changedLock);
  await c.run("resume");
  assert.equal((await c.calls()).length, 2, "a changed lockfile installs again");
  await c.run("resume");
  assert.equal((await c.calls()).length, 2, "and records the new lockfile");
});

test("a failed install on a wake exits 0, says to run npm ci, records nothing, and the next run tries again", async (t) => {
  const c = await checkout(t);
  assert.match(await c.run("resume", { fail: true }), notInstalled);
  assert.equal((await c.calls()).length, 1, "a wake tries once");
  assert.deepEqual(await c.modules(), [], "no stamp");
  await c.run("resume");
  assert.equal((await c.calls()).length, 2, "the next run installs");
  assert.deepEqual(await c.modules(), [".nexus-lockfile-sha256", "installed"]);
});

test("setup installs on a first run as resume does", async (t) => {
  const c = await checkout(t);
  assert.equal(await c.run("setup"), "");
  assert.deepEqual(await c.calls(), [`${c.root}/.nexus-install ci --no-audit --no-fund`]);
  await c.run("resume");
  assert.equal((await c.calls()).length, 1, "resume after setup finds the install recorded");
});

test("setup fails after three failed installs, so a fresh boot shows it and no template is published without packages", async (t) => {
  const c = await checkout(t);
  await assert.rejects(c.run("setup", { fail: true }), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, notInstalled);
    return true;
  });
  assert.equal((await c.calls()).length, 3);
  assert.deepEqual(await c.modules(), []);
  assert.equal(await c.staged(), false);
});

/** Resolves once `path` exists, and gives up after 60 s. */
async function appears(path: string) {
  for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((wake) => setTimeout(wake, 20)))
    if (await access(path).then(() => true, () => false)) return;
  throw new Error(`${path} did not appear`);
}

test("the packages in use stay in place while a new install runs, and the new ones replace them whole", async (t) => {
  const c = await checkout(t);
  const before = await c.installed();
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
  const before = await c.installed();
  const stamp = await readFile(join(c.root, "node_modules", ".nexus-lockfile-sha256"), "utf8");
  assert.match(await c.run("resume", { fail: true }), notInstalled);
  assert.deepEqual(await c.modules(), before);
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

test("a publish that fails puts the packages in use back and says so", async (t) => {
  const c = await checkout(t);
  const before = await c.installed();
  assert.match(await c.run("resume", { publishFails: true }), notInstalled);
  assert.deepEqual(await c.modules(), before);
  assert.equal(await c.staged(), false);
});

test("a swap cut off between its moves gets the packages in use back on the next run", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await mkdir(join(c.root, ".nexus-install"));
  await rename(join(c.root, "node_modules"), join(c.root, ".nexus-install", "old"));
  assert.equal(await c.run("resume"), "");
  assert.deepEqual(await c.modules(), [".nexus-lockfile-sha256", "installed"]);
  assert.equal((await c.calls()).length, 1, "their stamp still matches, so nothing installs");
  assert.equal(await c.staged(), false);
});

test("a recovery that fails keeps the backup, names it, and installs nothing", async (t) => {
  const c = await checkout(t);
  await c.run("resume");
  await mkdir(join(c.root, ".nexus-install"));
  await rename(join(c.root, "node_modules"), join(c.root, ".nexus-install", "old"));
  assert.match(await c.run("resume", { restoreFails: true }), notRestored);
  assert.deepEqual(await c.backup(), [".nexus-lockfile-sha256", "installed"]);
  assert.equal((await c.calls()).length, 1);
  assert.equal(await c.run("resume"), "", "the next run recovers it");
  assert.deepEqual(await c.modules(), [".nexus-lockfile-sha256", "installed"]);
});

test("a rollback that fails keeps the backup and names it", async (t) => {
  const c = await checkout(t);
  const before = await c.installed();
  assert.match(await c.run("resume", { publishFails: true, restoreFails: true }), notRestored);
  assert.deepEqual(await c.backup(), before);
  assert.deepEqual(await c.modules(), []);
});

test("a node_modules made between the two moves is neither nested into nor replaced", async (t) => {
  const c = await checkout(t);
  await c.installed();
  assert.match(await c.run("resume", { race: true }), notInstalled);
  assert.deepEqual(await c.modules(), ["agent"], "the agent's own install, with no staged tree inside it");
  assert.equal(await c.staged(), false);
});

/**
 * A checkout with this repository's .nexus/verify, a live check that logs the base it was given and exits $LIVE_EXIT, and stubs on PATH:
 * `docker image` exits $DOCKER_IMAGE_EXIT and every other `docker` call $DOCKER_EXIT, and `npm` logs each call. `path` is all of PATH when given, else the stubs come first.
 */
async function verifyCheckout(t: { after(fn: () => Promise<void>): void }) {
  const dir = await tempDir("nexus-verify-", t);
  const root = join(dir, "repo");
  const bin = join(dir, "bin");
  const scripts = join(root, ".claude", "skills", "verify-nexus", "scripts");
  await mkdir(join(root, ".nexus"), { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(bin);
  await copyFile(join(repo, ".nexus", "verify"), join(root, ".nexus", "verify"));
  const calls = join(dir, "calls");
  await writeFile(join(scripts, "live-check"), `#!/bin/sh\necho "live-check \${NEXUS_VERIFY_BASE:-}" >> ${calls}\nexit "$LIVE_EXIT"\n`, { mode: 0o755 });
  await writeFile(join(bin, "docker"), `#!/bin/sh\n[ "$1" != image ] || exit "$DOCKER_IMAGE_EXIT"\nexit "$DOCKER_EXIT"\n`, { mode: 0o755 });
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> ${calls}\n`, { mode: 0o755 });
  const run = async (env: { docker: number; base?: boolean; live?: number; path?: string }) => {
    try {
      const { stderr } = await promisify(execFile)(join(root, ".nexus", "verify"), [], {
        cwd: tmpdir(),
        env: { ...process.env, PATH: env.path ?? `${bin}:${process.env.PATH}`, DOCKER_EXIT: String(env.docker), DOCKER_IMAGE_EXIT: env.base ? "0" : "1", LIVE_EXIT: String(env.live ?? 0) },
      });
      return { code: 0, stderr };
    } catch (error) {
      const { code, stderr } = error as { code: number; stderr: string };
      return { code, stderr };
    }
  };
  return { bin, run, calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean) };
}

test("verify exits 127 and names docker.io when no Docker answers and the image has no dockerd", async (t) => {
  const v = await verifyCheckout(t);
  await symlink(which("dirname"), join(v.bin, "dirname"));
  const { code, stderr } = await v.run({ docker: 1, path: v.bin });
  assert.equal(code, 127, "the gate's cannot-run code, which goes to the person");
  assert.match(stderr, /no dockerd.*docker\.io/);
  assert.deepEqual(await v.calls(), [], "neither the build nor the live check ran");
});

test("verify builds the dashboard where Docker answers, then hands back the live check's exit status", async (t) => {
  const v = await verifyCheckout(t);
  assert.equal((await v.run({ docker: 0, live: 0 })).code, 0);
  assert.deepEqual(await v.calls(), ["npm run build", "live-check "]);
  assert.equal((await v.run({ docker: 0, live: 3 })).code, 3, "a failed live check fails verify with its code");
  assert.deepEqual((await v.calls()).slice(2), ["npm run build", "live-check "]);
});

test("verify gives the live check the imported base whenever the pylon holds it, as on a second run", async (t) => {
  const v = await verifyCheckout(t);
  assert.equal((await v.run({ docker: 0, base: true })).code, 0);
  assert.deepEqual(await v.calls(), ["npm run build", "live-check nexus-verify-base:pylon"]);
});

/**
 * A checkout with this repository's .nexus/check, setup and resume, and an `npm` stub first on PATH that logs each call.
 * `npm ci` acts as the checkout's does, and exits 1 under $NPM_FAIL. `npm run typecheck` and `npm test` each mark that
 * they started, wait up to 10 s for the other to start, print a line, and exit $TYPECHECK_EXIT or $TEST_EXIT, or 3 when
 * the other never started, so a check that runs them one after the other fails.
 */
async function checkCheckout(t: { after(fn: () => Promise<void>): void }) {
  const dir = await tempDir("nexus-check-", t);
  const root = join(dir, "repo");
  const bin = join(dir, "bin");
  await mkdir(join(root, ".nexus"), { recursive: true });
  await mkdir(bin);
  for (const name of ["check", "setup", "resume"]) await copyFile(join(repo, ".nexus", name), join(root, ".nexus", name));
  await writeFile(join(root, "package.json"), '{"name":"x"}\n');
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  const calls = join(dir, "npm-calls");
  const step = (name: string, other: string, code: string) =>
    `touch ${join(dir, name)}; i=0; while [ ! -e ${join(dir, other)} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done\n    [ -e ${join(dir, other)} ] || { echo "${name} ran alone"; exit 3; }\n    echo "${name} printed"; exit "\${${code}:-0}"`;
  await writeFile(join(bin, "npm"), `#!/bin/sh
echo "$*" >> ${calls}
case "$1" in
  ci) rm -rf node_modules; [ -z "\${NPM_FAIL:-}" ] || exit 1; mkdir node_modules && touch node_modules/installed ;;
  run) ${step("typecheck", "test", "TYPECHECK_EXIT")} ;;
  test) ${step("test", "typecheck", "TEST_EXIT")} ;;
esac
`, { mode: 0o755 });
  const run = async (env: { npmFails?: boolean; typecheck?: number; test?: number } = {}) => {
    try {
      const { stdout } = await promisify(execFile)(join(root, ".nexus", "check"), [], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TYPECHECK_EXIT: String(env.typecheck ?? 0), TEST_EXIT: String(env.test ?? 0), ...env.npmFails ? { NPM_FAIL: "1" } : {} },
      });
      return { code: 0, stdout };
    } catch (error) {
      const { code, stdout } = error as { code: number; stdout: string };
      return { code, stdout };
    }
  };
  return { root, run, calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean) };
}

test("check installs nothing while node_modules records an install of this package-lock.json, and installs once it changes", async (t) => {
  const c = await checkCheckout(t);
  assert.equal((await c.run()).code, 0);
  const first = await c.calls();
  assert.deepEqual([first[0], ...first.slice(1).sort()], ["ci --no-audit --no-fund", "run typecheck", "test"], "a first check installs");
  assert.equal((await c.run()).code, 0);
  assert.deepEqual((await c.calls()).slice(3).sort(), ["run typecheck", "test"], "the install it recorded is not repeated");
  await writeFile(join(c.root, "package-lock.json"), changedLock);
  assert.equal((await c.run()).code, 0);
  assert.equal((await c.calls())[5], "ci --no-audit --no-fund", "a changed lockfile installs again");
});

test("check exits 75, a transient failure, when the install fails, and runs neither the typecheck nor the tests", async (t) => {
  const c = await checkCheckout(t);
  assert.equal((await c.run({ npmFails: true })).code, 75);
  assert.ok((await c.calls()).every((call) => call.startsWith("ci ")), "only installs ran");
});

test("check runs the typecheck and the tests at once, and prints a failed one last, with its exit code", async (t) => {
  const c = await checkCheckout(t);
  const passed = await c.run();
  assert.equal(passed.code, 0, passed.stdout);
  assert.match(passed.stdout, /^==> npm run typecheck exited 0\ntypecheck printed\n==> npm test exited 0\ntest printed\n$/);
  const typecheck = await c.run({ typecheck: 2 });
  assert.equal(typecheck.code, 2);
  assert.match(typecheck.stdout, /==> npm test exited 0\ntest printed\n==> npm run typecheck exited 2\ntypecheck printed\n$/);
  const tests = await c.run({ test: 1 });
  assert.equal(tests.code, 1);
  assert.match(tests.stdout, /==> npm run typecheck exited 0\ntypecheck printed\n==> npm test exited 1\ntest printed\n$/);
  const both = await c.run({ typecheck: 2, test: 1 });
  assert.equal(both.code, 1, "the tests' code, whose output is last");
  assert.match(both.stdout, /==> npm run typecheck exited 2\ntypecheck printed\n==> npm test exited 1\ntest printed\n$/);
});
