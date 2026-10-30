import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { loadImageRecipe } from "./image-build.ts";
import { imageIdOf } from "./images.ts";
import { tempDir } from "./test-kit.ts";

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
 * Runs install_release on this checkout into a scratch prefix, as the deployer does, through `bash -c` without
 * errexit. npm is a fake that records each call and fails the one named by `failing`, and root ownership is skipped,
 * as the test does not run as root. `stubs` defines shell functions that stand in for commands, to make one fail.
 */
async function installRelease(t: TestContext, failing: string | null, stubs = "") {
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
  const commit = "c".repeat(40);
  const script = `. "$1/deploy/release.sh"; prefix=$2; service_path=$3:$PATH; install() { mkdir -p "$prefix/releases"; }; chown() { :; }; ${stubs} install_release "$1"`;
  const done = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    execFile("bash", ["-c", script, "build", root, join(scratch, "opt"), bin], { env: { ...process.env, NEXUS_COMMIT: commit } }, (err, _stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err.code as number), stderr });
    });
  });
  const calls = (await readFile(join(scratch, "npm.log"), "utf8").catch(() => "")).trim().split("\n").map((line) => line.split(" ").slice(0, 2).join(" "));
  return { ...done, calls, releases: await readdir(join(scratch, "opt", "releases")), release: join(scratch, "opt", "releases", commit) };
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
  const released = (await import(pathToFileURL(join(run.release, "src/image-build.ts")).href)) as typeof import("./image-build.ts");
  const recipe = await released.loadImageRecipe();
  const checkout = await loadImageRecipe();
  assert.deepEqual(recipe.files.map((f) => f.path), checkout.files.map((f) => f.path));
  assert.equal(imageIdOf(recipe), imageIdOf(checkout));
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
