import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { installedProblems, type ReadDesired } from "./installed.ts";

const root = resolve(import.meta.dirname, "../..");
const commitA = "a".repeat(40), commitB = "b".repeat(40);
const releaseA = "aaaaaaaaaaaa", releaseB = "bbbbbbbbbbbb";

/** An installed control plane and probe: both role links and deployer-current on release A, which runs this checkout's parsers. */
async function machine(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-installed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefix = join(dir, "opt"), etc = join(dir, "etc");
  for (const [name, commit] of [[releaseA, commitA], [releaseB, commitB]] as const) {
    const release = join(prefix, "releases", name);
    await mkdir(release, { recursive: true });
    await symlink(join(root, "src"), join(release, "src"));
    await symlink(join(root, "node_modules"), join(release, "node_modules"));
    await writeFile(join(release, "release-commit"), `${commit}\n`);
  }
  for (const link of ["current", "control-current", "deployer-current"]) await symlink(`releases/${releaseA}`, join(prefix, link));
  await mkdir(join(prefix, "deployer/roles"), { recursive: true });
  for (const role of ["control", "probe"]) await writeFile(join(prefix, "deployer/roles", role), "");
  await mkdir(etc);
  await writeFile(join(etc, "control.json"), await readFile(join(root, "deploy/control.example.json")));
  await writeFile(join(etc, "probe.json"), await readFile(join(root, "deploy/probe.example.json")));
  await writeFile(join(etc, "secrets.env"), "GH_TOKEN=ghp_example\n", { mode: 0o640 });
  await writeFile(join(etc, "control-plane.json"), JSON.stringify({ tailnetNodeId: "nFirebat1CNTRL", url: "http://100.64.0.2:7470/" }), { mode: 0o644 });
  await writeFile(join(etc, "deployer.json"), JSON.stringify({ token: "d".repeat(64), drainTimeoutMs: 300_000, healthTimeoutMs: 60_000 }), { mode: 0o600 });
  return { prefix, etc };
}

const wants = (commit: string | null): ReadDesired => async () => commit;
const lines = async (prefix: string, etc: string, desired: ReadDesired) => (await installedProblems(prefix, etc, desired)).map((p) => p.what);

/** Every path under `dir`, not following links, with its mode and mtime and a file's content or a link's target, to show a check changed nothing. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const { mode, mtimeMs } = await lstat(path);
    out.push(`${path} ${mode} ${mtimeMs} ${entry.isFile() ? await readFile(path, "utf8") : entry.isSymbolicLink() ? await readlink(path) : ""}`);
    if (entry.isDirectory()) out.push(...await tree(path));
  }
  return out.sort();
}

test("an installed machine on the desired release, with configs that parse, has no problem, and the check changes nothing", async (t) => {
  const { prefix, etc } = await machine(t);
  const before = [...await tree(prefix), ...await tree(etc)];
  assert.deepEqual(await lines(prefix, etc, wants(commitA)), []);
  assert.deepEqual(await lines(prefix, etc, wants(null)), [], "no release is desired");
  assert.deepEqual([...await tree(prefix), ...await tree(etc)], before);
});

test("each link that does not hold the desired release is a problem, and so is a desired release that cannot be read", async (t) => {
  const { prefix, etc } = await machine(t);
  assert.deepEqual(await lines(prefix, etc, wants(commitB)), ["control-current", "current", "deployer-current"].map((link) =>
    `${join(prefix, link)} runs ${commitA}, and the desired release is ${commitB}.`));
  await writeFile(join(prefix, "releases", releaseA, "release-commit"), "");
  assert.match((await lines(prefix, etc, wants(commitB)))[0]!, /runs release aaaaaaaaaaaa, which records no commit, and the desired release is b{40}\.$/);
  const read: ReadDesired = async (config) => { throw new Error(`refused ${config.token.slice(0, 4)}`); };
  assert.deepEqual(await lines(prefix, etc, read), ["The desired release could not be read from the control plane at http://100.64.0.2:7470/: refused dddd."]);
});

test("a role link that is missing or names no release is a problem, and a missing deployer-current is not", async (t) => {
  const { prefix, etc } = await machine(t);
  await rm(join(prefix, "control-current"));
  await rm(join(prefix, "deployer-current"));
  await rm(join(prefix, "current"));
  await symlink("releases/cccccccccccc", join(prefix, "current"));
  assert.deepEqual(await lines(prefix, etc, wants(commitA)), [
    `${join(prefix, "control-current")} is missing, so the control plane has no release.`,
    `${join(prefix, "current")} points at releases/cccccccccccc, which is no release in ${join(prefix, "releases")}.`,
  ]);
});

test("each config file that its release would refuse is a problem that names it", async (t) => {
  const { prefix, etc } = await machine(t);
  await writeFile(join(etc, "control.json"), "{");
  await writeFile(join(etc, "probe.json"), "{}");
  await writeFile(join(etc, "secrets.env"), "GH_TOKEN=\"quoted\"\n");
  await chmod(join(etc, "deployer.json"), 0o644);
  const found = await lines(prefix, etc, wants(commitA));
  assert.equal(found.length, 4, found.join("\n"));
  for (const [i, file] of ["deployer.json", "control.json", "probe.json", "secrets.env"].entries()) assert.ok(found[i]!.startsWith(`${join(etc, file)}: `), found[i]!);
  assert.match(found[3]!, /quotes the value of GH_TOKEN/);
  await writeFile(join(etc, "control-plane.json"), JSON.stringify({ tailnetNodeId: "nFirebat1CNTRL", url: "https://x/" }));
  const both = await lines(prefix, etc, wants(commitB));
  assert.match(both[0]!, /control-plane\.json: url must be the control plane's tailnet HTTP origin/);
  assert.ok(both[1]!.startsWith(`${join(etc, "deployer.json")}: `), "a broken control-plane.json hides no problem of deployer.json");
  assert.ok(!both.some((line) => /desired release/.test(line)), "and without both configs no desired release is read");
});

test("a release without the parser a config needs says so, and a machine with no role installed has nothing to check", async (t) => {
  const { prefix, etc } = await machine(t);
  const old = join(prefix, "releases", releaseB);
  await rm(join(old, "src"));
  await mkdir(join(old, "src/control"), { recursive: true });
  await writeFile(join(old, "src/control/main.ts"), "export const version = 1;\n");
  await rm(join(prefix, "deployer/roles/probe"));
  await rm(join(prefix, "control-current"));
  await symlink(`releases/${releaseB}`, join(prefix, "control-current"));
  assert.deepEqual(await lines(prefix, etc, wants(null)), [`${join(etc, "control.json")}: release bbbbbbbbbbbb has no readConfig in src/control/main.ts to check it with.`]);
  await rm(join(prefix, "deployer/roles/control"));
  assert.deepEqual(await lines(prefix, etc, wants(commitB)), []);
});
