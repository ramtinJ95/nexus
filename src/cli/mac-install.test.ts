/**
 * deploy/mac/install and the deploy/mac/nexus shim it links, run from a copy of their checkout whose CLI entry echoes
 * its arguments, with stand-ins for npm, for uname and for a node older than the CLI's.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "../test-support/kit.ts";

const real = resolve(import.meta.dirname, "../..");
const node = dirname(process.execPath);

async function checkout(t: TestContext) {
  const dir = await tempDir("nexus-mac-", t);
  const repo = join(dir, "nexus");
  const shims = join(dir, "shims");
  await mkdir(join(repo, "deploy", "mac"), { recursive: true });
  await mkdir(join(repo, "src", "cli"), { recursive: true });
  await mkdir(shims);
  for (const name of ["install", "nexus"]) await copyFile(join(real, "deploy", "mac", name), join(repo, "deploy", "mac", name));
  await writeFile(join(repo, "package.json"), '{"name":"nexus"}\n');
  await writeFile(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(join(repo, "src", "cli", "nexus.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  await writeFile(join(shims, "npm"), '#!/bin/sh\nmkdir -p node_modules\n', { mode: 0o755 });
  const shim = async (name: string, body: string) => writeFile(join(shims, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const run = (file: string, args: string[], env: Record<string, string> = {}, path = `${shims}:${node}:/usr/bin:/bin`) =>
    promisify(execFile)(file, args, { env: { HOME: dir, SHELL: "/bin/bash", PATH: path, ...env } })
      .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (error: { code: number; stdout: string; stderr: string }) => error);
  const stamp = createHash("sha256").update('{"name":"nexus"}\n{"lockfileVersion":3}\n').digest("hex");
  return { dir, repo, shims, shim, run, stamp };
}

test("the shim runs the CLI through its symlink with the arguments as given once the packages match the lockfile", async (t) => {
  const c = await checkout(t);
  await mkdir(join(c.repo, "node_modules"));
  await writeFile(join(c.repo, "node_modules", ".nexus-lockfile-sha256"), `${c.stamp}\n`);
  await symlink(join(c.repo, "deploy", "mac", "nexus"), join(c.shims, "nexus"));
  const ran = await c.run(join(c.shims, "nexus"), ["start", "--message", "two words"]);
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), ["start", "--message", "two words"]);
});

test("the shim says in one line that the node on PATH is too old, as in a project that pins one", async (t) => {
  const c = await checkout(t);
  await c.shim("node", '[ "$1" = --version ] && echo v22.11.0 && exit 0\necho "SyntaxError: Unexpected token" >&2\nexit 1');
  const ran = await c.run(join(c.repo, "deploy", "mac", "nexus"), ["list"]);
  assert.equal(ran.code, 1);
  assert.equal(ran.stderr, "nexus: the CLI needs Node 26 or newer, and the node on PATH here is v22.11.0\n");
  await c.shim("node", "exit 127");
  const none = await c.run(join(c.repo, "deploy", "mac", "nexus"), ["list"]);
  assert.equal(none.stderr, "nexus: the CLI needs Node 26 or newer, and the node on PATH here is missing\n");
});

test("the shim says to run deploy/mac/install when the packages were installed for another lockfile, or by no install of it", async (t) => {
  const c = await checkout(t);
  const nexus = join(c.repo, "deploy", "mac", "nexus");
  const hint = `nexus: the checkout's packages are not installed for its package-lock.json, as after a git pull that changed it: run ${c.repo}/deploy/mac/install\n`;
  await mkdir(join(c.repo, "node_modules"));
  assert.equal((await c.run(nexus, ["list"])).stderr, hint, "no stamp");
  await writeFile(join(c.repo, "node_modules", ".nexus-lockfile-sha256"), `${c.stamp}\n`);
  await writeFile(join(c.repo, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  const pulled = await c.run(nexus, ["list"]);
  assert.equal(pulled.code, 1);
  assert.equal(pulled.stderr, hint, "a lockfile a pull changed");
});

test("install stamps the packages it installed, so the shim it links runs, and its PATH hint names the shell's profile", async (t) => {
  const cases = [["Darwin", "/bin/zsh", "~/.zprofile"], ["Linux", "/bin/bash", "~/.bashrc"], ["Darwin", "/bin/bash", "~/.bash_profile"], ["Linux", "/bin/sh", "~/.profile"]] as const;
  for (const [system, shell, profile] of cases) {
    const c = await checkout(t);
    await c.shim("uname", `echo ${system}`);
    const bin = join(c.dir, "bin");
    const ran = await c.run(join(c.repo, "deploy", "mac", "install"), [bin], { SHELL: shell });
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(await readFile(join(c.repo, "node_modules", ".nexus-lockfile-sha256"), "utf8"), `${c.stamp}\n`);
    assert.match(ran.stdout, /^\["--version"\]$/m, "the linked shim ran the CLI");
    assert.ok(ran.stdout.includes(`is not on PATH. Add it to your shell's profile, such as with: echo 'export PATH="${bin}:$PATH"' >> ${profile}\n`), `${system} ${shell}: ${ran.stdout}`);
  }
  const unset = await checkout(t);
  const bare = await unset.run("/usr/bin/env", ["-u", "SHELL", join(unset.repo, "deploy", "mac", "install"), join(unset.dir, "bin")]);
  assert.equal(bare.code, 0, bare.stderr);
  assert.match(bare.stdout, /> ~\/\.profile\nNext: nexus connect/, "no SHELL gets the POSIX profile");
  const c = await checkout(t);
  const fish = await c.run(join(c.repo, "deploy", "mac", "install"), [join(c.dir, "bin")], { SHELL: "/usr/bin/fish" });
  assert.match(fish.stdout, new RegExp(`such as with: fish_add_path ${join(c.dir, "bin")}\n`));
});

test("install names a way to get Node that fits the platform", async (t) => {
  for (const [system, from, not] of [["Darwin", /`brew install node`/, /nodejs\.org/], ["Linux", /your distribution's packages, https:\/\/nodejs\.org or mise/, /brew/]] as const) {
    const c = await checkout(t);
    await c.shim("uname", `echo ${system}`);
    await c.shim("node", "echo 22");
    const ran = await c.run(join(c.repo, "deploy", "mac", "install"), []);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, from);
    assert.doesNotMatch(ran.stderr, not);
    assert.match(ran.stderr, /\.node-version and \.nvmrc/);
  }
});

test(".node-version and .nvmrc name the major Node version package.json's engines asks for", async () => {
  const engines = JSON.parse(await readFile(join(real, "package.json"), "utf8")).engines.node as string;
  for (const file of [".node-version", ".nvmrc"]) assert.equal(`>=${(await readFile(join(real, file), "utf8")).trim()}`, engines, file);
});
