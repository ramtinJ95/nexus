import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { loadImageRecipe } from "./image/recipe.ts";
import { imageIdOf } from "./protocol/images.ts";
import { tempDir } from "./test-support/kit.ts";

const root = resolve(import.meta.dirname, "..");

test("every file the services import is in the release that deploy/release.sh packages", async () => {
  const script = await readFile(join(root, "deploy/release.sh"), "utf8");
  const packaged = /tar -C "\$repo" -cf - ([^|]+)\|/.exec(script)?.[1]?.trim().split(/\s+/);
  assert.ok(packaged !== undefined, "release.sh's tar line was not found");

  const sources = (await readdir(join(root, "src"), { recursive: true }))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => join(root, "src", path));
  const outside: string[] = [];
  for (const source of sources) {
    for (const [, specifier] of (await readFile(source, "utf8")).matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      const target = relative(root, resolve(dirname(source), specifier!));
      if (!packaged.some((entry) => target === entry || target.startsWith(`${entry}/`))) outside.push(`${relative(root, source)} imports ${target}`);
    }
  }
  assert.deepEqual(outside, []);
});

/**
 * Runs install_release on the checkout `from.repo`, this one by default, into a scratch prefix, as the deployer does
 * with NEXUS_COMMIT set to `from.commit`, through `bash -c` without errexit. npm is a fake that records each call and fails the one named by `failing`, and root ownership is skipped,
 * as the test does not run as root. `stubs` defines shell functions that stand in for commands, to make one fail.
 */
async function installRelease(t: TestContext, failing: string | null, stubs = "", from: { repo: string; commit?: string } = { repo: root, commit: "c".repeat(40) }) {
  const scratch = await tempDir("nexus-release-", t);
  const bin = join(scratch, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!/bin/sh
echo "$*" >> "${join(scratch, "npm.log")}"
[ "$1 $2" = "${failing ?? ""}" ] && exit 42
[ "$1 $2" = "run build" ] && mkdir -p dist/dashboard && : > dist/dashboard/client.js
exit 0
`);
  await chmod(join(bin, "npm"), 0o755);
  const script = `. "$4/deploy/release.sh"; prefix=$2; service_path=$3:$PATH; install() { mkdir -p "$prefix/releases"; }; chown() { :; }; ${stubs} install_release "$1"`;
  const done = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    execFile("bash", ["-c", script, "build", from.repo, join(scratch, "opt"), bin, root], { env: { ...process.env, NEXUS_COMMIT: from.commit ?? "" } }, (err, _stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err.code as number), stderr });
    });
  });
  const calls = (await readFile(join(scratch, "npm.log"), "utf8").catch(() => "")).trim().split("\n").map((line) => line.split(" ").slice(0, 2).join(" "));
  const releases = await readdir(join(scratch, "opt", "releases"));
  return { ...done, calls, releases, release: join(scratch, "opt", "releases", releases[0] ?? "none") };
}

test("a release is installed with dev dependencies, built, then pruned, and published with the dashboard client", async (t) => {
  const run = await installRelease(t, null);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.calls, ["ci --no-audit", "run build", "prune --omit=dev"]);
  assert.deepEqual(run.releases, ["c".repeat(40)]);
  await readFile(join(run.release, "dist/dashboard/client.js"));
});

test("a release carries the image recipe the control plane builds, the same recipe as the checkout's", async (t) => {
  const run = await installRelease(t, null);
  assert.equal(run.code, 0, run.stderr);
  await symlink(join(root, "node_modules"), join(run.release, "node_modules"));
  const released = (await import(pathToFileURL(join(run.release, "src/image/recipe.ts")).href)) as typeof import("./image/recipe.ts");
  const recipe = await released.loadImageRecipe();
  const checkout = await loadImageRecipe();
  assert.deepEqual(recipe.files.map((f) => f.path), checkout.files.map((f) => f.path));
  assert.equal(imageIdOf(recipe), imageIdOf(checkout));
});

/** A git checkout of the paths release.sh packages, at one commit with no changes. */
async function checkout(t: TestContext) {
  const repo = await tempDir("nexus-checkout-", t);
  const git = (...args: string[]) => new Promise<string>((done, failed) => {
    execFile("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], (err, stdout) => err === null ? done(stdout.trim()) : failed(err));
  });
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "src/a.ts", "deploy/a.sh", "images/pylon/a"]) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), "{}\n");
  }
  await git("init", "--quiet");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "a");
  return { repo, git, head: await git("rev-parse", "HEAD") };
}

test("a release cut from a checkout records its commit only while the checkout has no changes, since one with changes is named by its content alone", async (t) => {
  const { repo, git, head } = await checkout(t);
  const recorded = async () => {
    const run = await installRelease(t, null, "", { repo });
    assert.equal(run.code, 0, run.stderr);
    return (await readFile(join(run.release, "release-commit"), "utf8")).trim();
  };
  assert.equal(await recorded(), head);
  await writeFile(join(repo, "src/a.ts"), "export {};\n");
  assert.equal(await recorded(), "", "a changed file");
  await git("checkout", "--quiet", "--", "src/a.ts");
  await writeFile(join(repo, "src/b.ts"), "export {};\n");
  assert.equal(await recorded(), "", "a new file the release packages");
});

test("a role installer keeps the release its link runs, even one cut from the checkout's own commit, and installs only when there is none yet or with --upgrade", async (t) => {
  const { repo, head } = await checkout(t);
  const opt = await tempDir("nexus-links-", t);
  const deployed = "d".repeat(40);
  await mkdir(join(opt, "releases", deployed), { recursive: true });
  await writeFile(join(opt, "releases", deployed, "release-commit"), `${deployed}\n`);
  await symlink(`releases/${deployed}`, join(opt, "control-current"));
  const keeps = (...flag: string[]) => new Promise<{ code: number; stdout: string }>((done) => {
    execFile("bash", ["-c", `. "$1/deploy/release.sh"; keeps_release "$2" "$3" "\${@:4}" && echo "release=$release"`, "keeps", root, join(opt, "control-current"), repo, ...flag], (err, stdout) => {
      done({ code: err === null ? 0 : err.code as number, stdout });
    });
  });
  assert.deepEqual(await keeps(), {
    code: 0,
    stdout: `control-current runs ${deployed}, and this checkout holds ${head}. This run changes the config and keeps that release. nexus deploy installs another, or --upgrade installs this checkout's\nrelease=${deployed}\n`,
  });
  assert.equal((await keeps("--upgrade")).code, 1, "--upgrade installs");
  await writeFile(join(opt, "releases", deployed, "release-commit"), `${head}\n`);
  assert.match((await keeps()).stdout, new RegExp(`^control-current runs ${head}, and this checkout holds ${head}\\.[^\\n]*\\nrelease=${deployed}\\n$`), "the deployer's release of the checkout's commit, named by that commit, is kept rather than rebuilt under its content hash");
  await writeFile(join(repo, "src/a.ts"), "export {};\n");
  assert.match((await keeps()).stdout, new RegExp(`^control-current runs ${head}, and this checkout holds uncommitted changes or no commit git can read\\.`));
  await writeFile(join(opt, "releases", deployed, "release-commit"), "");
  assert.match((await keeps()).stdout, new RegExp(`^control-current runs release ${deployed}, which records no commit, and this`));
  assert.equal((await keeps("--upgrade")).code, 1);
  assert.equal((await new Promise<number>((done) => {
    execFile("bash", ["-c", `. "$1/deploy/release.sh"; keeps_release "$2" "$3"`, "keeps", root, join(opt, "current"), repo], (err) => done(err === null ? 0 : err.code as number));
  })), 1, "a first install, with no link, installs");
});

for (const failing of ["ci --no-audit", "run build", "prune --omit=dev"]) {
  test(`a release whose npm ${failing.split(" ")[0]} fails is not published and leaves nothing for a retry to reuse`, async (t) => {
    const run = await installRelease(t, failing);
    assert.notEqual(run.code, 0, "install_release fails");
    assert.equal(run.calls.at(-1), failing, "no step runs after the failed one");
    assert.deepEqual(run.releases, [], "no release directory and no staging directory are left");
  });
}

// Each stub fails one step before npm runs, after doing what a real failure might have done first.
const earlyFailures = {
  "the archive cannot read a file": `tar() { if [ "$3" = -cf ]; then command tar --exclude=images/pylon/nexus-turn.ts "$@"; return 2; fi; command tar "$@"; };`,
  "the archive cannot be unpacked": `tar() { if [ "$4" = -xf ]; then cat > /dev/null; return 2; fi; command tar "$@"; };`,
  "the hash fails": `sha256sum() { command sha256sum "$@"; return 1; };`,
  "the staging directory cannot be made": `mktemp() { return 1; };`,
};
for (const [failure, stub] of Object.entries(earlyFailures)) {
  test(`a release is not published, and npm never runs, when ${failure}`, async (t) => {
    const run = await installRelease(t, null, stub);
    assert.notEqual(run.code, 0, "install_release fails");
    assert.deepEqual(run.calls, [""], "npm never runs");
    assert.deepEqual(run.releases, [], "no release directory and no staging directory are left");
  });
}
