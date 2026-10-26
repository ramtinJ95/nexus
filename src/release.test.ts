import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";

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
 * as the test does not run as root.
 */
async function installRelease(t: TestContext, failing: string | null) {
  const scratch = await mkdtemp(join(tmpdir(), "nexus-release-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
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
  const script = `. "$1/deploy/release.sh"; prefix=$2; service_path=$3:$PATH; install() { mkdir -p "$prefix/releases"; }; chown() { :; }; install_release "$1"`;
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

for (const failing of ["ci --no-audit", "run build", "prune --omit=dev"]) {
  test(`a release whose npm ${failing.split(" ")[0]} fails is not published and leaves nothing for a retry to reuse`, async (t) => {
    const run = await installRelease(t, failing);
    assert.notEqual(run.code, 0, "install_release fails");
    assert.equal(run.calls.at(-1), failing, "no step runs after the failed one");
    assert.deepEqual(run.releases, [], "no release directory and no staging directory are left");
  });
}
