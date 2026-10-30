import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { artifactDirectory, tarCodec } from "./artifacts.ts";
import { JobFailure } from "./backend.ts";
import {
  buildImage, debugfsErrors, debugfsModeCommands, debugfsStatCommands, loadImageRecipe, modeMismatches,
  parseDebugfsModes, parseModeListing, pylonRecipeDir, smokeChecks, smokeFailure,
} from "./image-build.ts";
import { imageIdOf, type ImageRecipe } from "./images.ts";
import { agentSetupManifest, installedLayout, parseAgentSetup } from "../images/pylon/agent-setup/manifest.ts";
import type { NodeName } from "./protocol.ts";

const pins: ImageRecipe["pins"] = {
  debianDigest: `sha256:${"a".repeat(64)}`,
  node: "26.12.1",
  nodeSha256: "b".repeat(64),
  claudeCode: "2.1.308",
  pi: "1.4.0",
  herdr: "0.9.5",
  piEnv: "1.4.0",
  piEnvSha256: "c".repeat(64),
  gondolin: "0.13.0",
  alpineKernel: "6.18.58-0-virt",
  dotfilesCommon: "placeholder",
  gh: "2.103.2",
  ghSha256: "d".repeat(64),
  neovim: "0.12.6",
  neovimSha256: "e".repeat(64),
};
const manifest: ImageRecipe["files"][number] = { path: agentSetupManifest, mode: 0o644, content: await readFile(join(pylonRecipeDir, agentSetupManifest), "utf8") };

async function recipeDir(t: { after(fn: () => Promise<void>): void }, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-recipe-"));
  t.after(() => rm(dir, { recursive: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test("the checked-in recipe loads, with pins.json as its pins and build.sh left out", async () => {
  const recipe = await loadImageRecipe();
  const paths = recipe.files.map((f) => f.path);
  assert.deepEqual(recipe.pins, JSON.parse(await readFile(join(pylonRecipeDir, "pins.json"), "utf8")));
  for (const path of ["Dockerfile", "gondolin.json", "nexus", "nexus-turn.ts", "checkout-files.py", "rootfs-init-extra.sh"]) assert.ok(paths.includes(path), `${path} is an image input`);
  assert.ok(!paths.includes("build.sh") && !paths.includes("pins.json"));
  const modes = Object.fromEntries(recipe.files.map((f) => [f.path, f.mode.toString(8)]));
  assert.deepEqual([modes["nexus"], modes["nexus-claude-hook"], modes["nexus-kvm"], modes["nexus-turn.ts"], modes["checkout-files.py"]], ["755", "755", "755", "644", "644"]);
});

test("a recipe is every file under its directory and the shared checkout helper, nested ones by posix path, sorted", async (t) => {
  const dir = await recipeDir(t, {
    "pins.json": JSON.stringify(pins),
    "build.sh": "echo runner",
    "nexus": "#!/bin/sh\n",
    "dotfiles-common/pi/AGENTS.md": "pi rules",
    "Dockerfile": "FROM scratch\n",
  });
  await chmod(join(dir, "nexus"), 0o700);
  assert.deepEqual(await loadImageRecipe(dir), {
    files: [
      { path: "Dockerfile", mode: 0o644, content: "FROM scratch\n" },
      { path: "checkout-files.py", mode: 0o644, content: await readFile(new URL("./checkout-files.py", import.meta.url), "utf8") },
      { path: "dotfiles-common/pi/AGENTS.md", mode: 0o644, content: "pi rules" },
      { path: "nexus", mode: 0o755, content: "#!/bin/sh\n" },
    ],
    pins,
  });
});

test("loading refuses pins with a missing or unknown field, a bad digest, and a symlink in the recipe", async (t) => {
  const { herdr: _, ...missing } = pins;
  for (const bad of [missing, { ...pins, extra: "1" }, { ...pins, debianDigest: "bookworm-slim" }]) {
    await assert.rejects(loadImageRecipe(await recipeDir(t, { "pins.json": JSON.stringify(bad) })));
  }
  const dir = await recipeDir(t, { "pins.json": JSON.stringify(pins), "Dockerfile": "" });
  await symlink("Dockerfile", join(dir, "Containerfile"));
  await assert.rejects(loadImageRecipe(dir), /Containerfile .* is not a regular file/);
});

test("buildImage refuses a recipe from a job whose paths, modes, pins, nexus script or agent setup manifest are unsafe, before it writes anything", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-image-out-"));
  t.after(() => rm(root, { recursive: true }));
  const store = artifactDirectory(root, tarCodec);
  const node = "infra-testbench" as NodeName;
  const bad: readonly ImageRecipe[] = [
    { files: [{ path: "../escape", mode: 0o644, content: "" }], pins },
    { files: [{ path: "/etc/passwd", mode: 0o644, content: "" }], pins },
    { files: [{ path: "a//b", mode: 0o644, content: "" }], pins },
    { files: [{ ...manifest, mode: 0o600 as 0o644 }], pins },
    { files: [{ path: manifest.path, content: manifest.content } as ImageRecipe["files"][number]], pins },
    { files: [], pins: { ...pins, nodeSha256: "not-a-digest" } },
    { files: [manifest], pins: { ...pins, gh: "latest" } },
    { files: [manifest], pins: { ...pins, neovim: "stable" } },
    { files: [manifest, { path: "nexus", mode: 0o644, content: '#!/usr/bin/env node\nconst version = "dev";\n' }], pins },
    { files: [{ path: "nexus", mode: 0o644, content: 'const version = "0.7.3";\n' }], pins },
    { files: [{ ...manifest, content: manifest.content.replace(/"commit":"([0-9a-f]{7})[0-9a-f]+"/, '"commit":"$1"') }], pins },
  ];
  for (const recipe of bad) {
    await assert.rejects(buildImage(recipe, node, store, AbortSignal.timeout(5_000)), (err) => err instanceof JobFailure && err.code === "invalid");
  }
  assert.deepEqual(await readdir(root), []);
});

test("a build job under the probe's 077 umask gives Docker each recipe file with its own mode, and directories 0755", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-image-modes-"));
  t.after(() => rm(root, { recursive: true }));
  const docker = join(root, "bin", "docker");
  await mkdir(join(root, "bin"));
  // The failed build's .partial is removed, so the context is copied out first.
  await writeFile(docker, `#!/bin/sh\n[ "$1" = build ] || exit 0\nfor context; do :; done\ncp -a "$context" ${root}/context\nexit 1\n`);
  await chmod(docker, 0o755);
  const recipe = await loadImageRecipe();
  const path = process.env.PATH;
  const umask = process.umask(0o077);
  process.env.PATH = `${join(root, "bin")}:${path}`;
  try {
    await assert.rejects(buildImage(recipe, "infra-testbench" as NodeName, artifactDirectory(join(root, "out"), tarCodec), AbortSignal.timeout(30_000)), /docker build exited 1/);
  } finally {
    process.umask(umask);
    process.env.PATH = path;
  }
  const context = join(root, "context");
  const modes = new Map<string, string>();
  for (const entry of await readdir(context, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    modes.set(relative(context, path), ((await stat(path)).mode & 0o7777).toString(8));
  }
  assert.deepEqual([modes.get("nexus"), modes.get("nexus-turn.ts"), modes.get("checkout-files.py")], ["755", "644", "644"]);
  for (const file of recipe.files) assert.equal(modes.get(file.path), file.mode.toString(8), file.path);
  for (const dir of ["agent-setup", "dotfiles"]) assert.equal(modes.get(dir), "755", dir);
  assert.equal(modes.size, recipe.files.length + 2);
});

test("an image.json in the store that names the recipe's image but is no manifest fails the build before any docker call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-image-held-"));
  t.after(() => rm(root, { recursive: true }));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), `#!/bin/sh\necho "$@" >> ${root}/calls\n`, { mode: 0o755 });
  const recipe = await loadImageRecipe();
  const store = artifactDirectory(join(root, "artifacts"), tarCodec);
  await mkdir(store.path(imageIdOf(recipe)), { recursive: true });
  await writeFile(join(store.path(imageIdOf(recipe)), "image.json"), JSON.stringify({ id: imageIdOf(recipe), builtOn: "infra-testbench" }));
  const path = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${path}`;
  try {
    await assert.rejects(buildImage(recipe, "infra-testbench" as NodeName, store, AbortSignal.timeout(30_000)));
  } finally {
    process.env.PATH = path;
  }
  assert.equal(existsSync(join(root, "calls")), false, "no docker call");
});

test("the smoke boot expects each tool's exact pinned version, and whatever the recipe's nexus CLI prints", async () => {
  const recipe = await loadImageRecipe();
  const versions = Object.fromEntries(smokeChecks(recipe).filter((c) => c.name.endsWith(" version")).map((c) => [c.name, c.expect]));
  assert.deepEqual(versions, {
    "node version": `v${recipe.pins.node}\n`,
    "claude version": `${recipe.pins.claudeCode} (Claude Code)\n`,
    "pi version": `${recipe.pins.pi}\n`,
    "herdr version": `herdr ${recipe.pins.herdr}\n`,
    "pi-env version": `pi-env ${recipe.pins.piEnv}\n`,
    "nexus version": execFileSync(process.execPath, [join(pylonRecipeDir, "nexus"), "--version"], { encoding: "utf8" }),
    "nvim version": `NVIM v${recipe.pins.neovim}\n`,
  });
});

test("a version check fails on any other version, naming the expected and actual output", () => {
  const checks = smokeChecks({ files: [{ path: "nexus", mode: 0o644, content: 'const version = "0.7.3";\n' }, manifest], pins });
  const check = (name: string) => checks.find((c) => c.name === name)!;
  assert.equal(smokeFailure(check("claude version"), 0, "2.1.308 (Claude Code)\n"), undefined);
  assert.equal(smokeFailure(check("claude version"), 0, "2.1.309 (Claude Code)\n"), 'expected "2.1.308 (Claude Code)\\n", got "2.1.309 (Claude Code)\\n"');
  assert.equal(smokeFailure(check("nexus version"), 0, "nexus 0.7.3\n"), undefined);
  assert.equal(smokeFailure(check("nexus version"), 0, "nexus 0.1.0\n"), 'expected "nexus 0.7.3\\n", got "nexus 0.1.0\\n"');
  assert.equal(smokeFailure(check("node version"), 0, "v26.12.10\n"), 'expected "v26.12.1\\n", got "v26.12.10\\n"');
  assert.equal(smokeFailure(check("pi version"), 127, "-bash: pi: command not found\n"), "exited 127");
  assert.equal(smokeFailure(check("nvim version"), 0, "NVIM v0.12.6\n"), undefined);
  assert.equal(smokeFailure(check("nvim version"), 0, "NVIM v0.7.2\n"), 'expected "NVIM v0.12.6\\n", got "NVIM v0.7.2\\n"');
});

test("the smoke boot checks the agent setup against the layout derived from the recipe's own manifest", async () => {
  const recipe = await loadImageRecipe();
  const check = smokeChecks(recipe).find((c) => c.name === "agent setup")!;
  const expected = installedLayout(parseAgentSetup(manifest.content));
  assert.ok(check.argv.at(-1)!.includes(` check '${JSON.stringify(expected)}'`), "the installer's check gets the derived layout");
  assert.equal(check.expect, "ok\n");
  assert.ok(expected.plugins.length > 0 && expected.claudeSkills.length > 0 && expected.piPackages.length > 0, "the checked-in setup ships something");

  const changed = { ...manifest, content: manifest.content.replace('"version":"0.2.11"', '"version":"0.2.12"') };
  const other = smokeChecks({ ...recipe, files: [...recipe.files.filter((f) => f.path !== agentSetupManifest), changed] }).find((c) => c.name === "agent setup")!;
  assert.ok(other.argv.at(-1)!.includes("notes-compaction@claude-mods 0.2.12 enabled") && !other.argv.at(-1)!.includes("0.2.11"));
});

test("a recipe without an agent setup manifest has no smoke checks", () => {
  assert.throws(() => smokeChecks({ files: [{ path: "nexus", mode: 0o644, content: 'const version = "0.7.3";\n' }], pins }), (err) => err instanceof JobFailure && err.code === "invalid");
});

test("the smoke boot expects the offline switches in every exec, and the PYLON.md import and link", async () => {
  const checks = smokeChecks({ ...(await loadImageRecipe()), pins });
  const check = (name: string) => checks.find((c) => c.name === name)!;
  assert.equal(smokeFailure(check("exec environment"), 0, "v26.12.1 /run/gondolin/ca-certificates.crt 1 1\n"), undefined);
  assert.notEqual(smokeFailure(check("exec environment"), 0, "v26.12.1 /run/gondolin/ca-certificates.crt undefined 1\n"), undefined);
  assert.equal(smokeFailure(check("pylon guide"), 0, "@~/.nexus/PYLON.md\n/home/user/.nexus/PYLON.md\n"), undefined);
  assert.notEqual(smokeFailure(check("pylon guide"), 0, "@~/.nexus/PYLON.md\n"), undefined);
});

test("the smoke boot expects gh at its pin, answering git's credential request with GH_TOKEN", async () => {
  const gh = smokeChecks({ ...(await loadImageRecipe()), pins }).find((c) => c.name === "gh and git credentials")!;
  const credential = "protocol=https\nhost=github.com\nusername=x-access-token\npassword=nexus-smoke\n";
  assert.equal(smokeFailure(gh, 0, `gh version 2.103.2 (2026-10-23)\n${credential}`), undefined);
  assert.notEqual(smokeFailure(gh, 0, `gh version 2.103.1 (2026-10-01)\n${credential}`), undefined);
  assert.notEqual(smokeFailure(gh, 0, "gh version 2.103.2 (2026-10-23)\nprotocol=https\nhost=github.com\n"), undefined);
});

test("the smoke boot expects PID 1 to be tini and to reap an exec's orphan, which sandboxd leaves a zombie", async () => {
  const reaps = smokeChecks({ ...(await loadImageRecipe()), pins }).find((c) => c.name === "PID 1 reaps orphans")!;
  assert.equal(smokeFailure(reaps, 0, "tini\nreaped\n"), undefined);
  assert.notEqual(smokeFailure(reaps, 0, "sandboxd\nZ\n"), undefined);
  assert.notEqual(smokeFailure(reaps, 0, "tini\nZ\n"), undefined);
});

test("the smoke boot expects no KVM in an ordinary boot, then has nexus-kvm load it for user as its last check", async () => {
  const checks = smokeChecks({ ...(await loadImageRecipe()), pins });
  const ordinary = checks.find((c) => c.name === "no KVM without nested virtualization")!;
  const load = checks.find((c) => c.name === "nexus-kvm loads KVM for user")!;
  assert.equal(checks.at(-1), load, "no later check sees a guest with KVM loaded");
  assert.equal(smokeFailure(ordinary, 0, "unloaded\n"), undefined);
  assert.equal(smokeFailure(ordinary, 1, ""), "exited 1");
  assert.equal(smokeFailure(load, 0, "irqbypass\nkvm\nkvm_intel\noverlay\nuser opens /dev/kvm\n"), undefined);
  assert.equal(smokeFailure(load, 0, "irqbypass\nkvm\nkvm_amd\noverlay\nuser opens /dev/kvm\n"), undefined);
  assert.notEqual(smokeFailure(load, 0, "irqbypass\nkvm\nkvm_intel\noverlay\n"), undefined, "a /dev/kvm only root can open");
  assert.equal(smokeFailure(load, 1, "insmod: ERROR: could not insert module /tmp/tmp.x/kvm_intel.ko: Operation not supported\n"), "exited 1");
});

test("the smoke boot refuses a home that carries a hook outbox or an agent session from the build, before any check starts an agent", async (t) => {
  const checks = smokeChecks({ ...(await loadImageRecipe()), pins });
  const clean = checks.find((c) => c.name === "no build sessions")!;
  assert.ok(checks.indexOf(clean) < checks.findIndex((c) => c.name === "agent setup"), "pi, which starts Claude, runs in the agent setup check");
  const home = await mkdtemp(join(tmpdir(), "nexus-smoke-home-"));
  t.after(() => rm(home, { recursive: true }));
  const run = () => execFileSync("sh", ["-c", clean.argv.at(-1)!], { cwd: home, encoding: "utf8" });
  assert.equal(smokeFailure(clean, 0, run()), undefined);
  await mkdir(join(home, ".nexus", "outbox"), { recursive: true });
  await writeFile(join(home, ".nexus", "outbox", "0001793089661334-433-000000-8b97cd5c.json"), '{"kind":"session.turn-started"}');
  await mkdir(join(home, ".claude", "projects", "-"), { recursive: true });
  assert.equal(smokeFailure(clean, 0, run()), 'expected "clean\\n", got ".claude/projects\\n.nexus\\nclean\\n"');
});

test("the mode listing parses into sorted fixes, and one without a setuid or setgid file is refused", () => {
  const listing = 'd 1777 /tmp\nf 4755 /usr/bin/sudo\nf 2755 /usr/bin/ssh-agent\nf 755 /usr/bin/odd "name"\n';
  assert.deepEqual(parseModeListing(listing), [
    { type: "d", mode: 0o1777, path: "/tmp" },
    { type: "f", mode: 0o755, path: '/usr/bin/odd "name"' },
    { type: "f", mode: 0o2755, path: "/usr/bin/ssh-agent" },
    { type: "f", mode: 0o4755, path: "/usr/bin/sudo" },
  ]);
  assert.throws(() => parseModeListing("d 1777 /tmp\n"), /no setuid or setgid file/);
  assert.throws(() => parseModeListing(""), /no setuid or setgid file/);
  assert.throws(() => parseModeListing("l 777 /bin/sh\n"), /unexpected mode listing line/);
  assert.throws(() => parseModeListing("f 4755 relative\n"), /unexpected mode listing line/);
  assert.throws(() => parseModeListing("f 4755 /a\tb\n"), /unexpected mode listing line/);
});

test("debugfs commands set the whole i_mode, quote paths as its parser reads them, and their stat read-back parses", () => {
  const fixes = parseModeListing('d 1777 /tmp\nf 4755 /usr/bin/sudo\nf 755 /odd "q" \\x\n');
  assert.equal(debugfsModeCommands(fixes), [
    'sif "/odd ""q"" \\x" mode 0100755',
    'sif "/tmp" mode 041777',
    'sif "/usr/bin/sudo" mode 0104755',
    "",
  ].join("\n"));
  const stats = debugfsStatCommands(fixes);
  assert.equal(stats, 'stat "/odd ""q"" \\x"\nstat "/tmp"\nstat "/usr/bin/sudo"\n');

  // As debugfs -f prints it: each command echoed, then stat's inode block.
  const output = [
    'debugfs: stat "/odd ""q"" \\x"',
    "Inode: 12   Type: regular    Mode:  0755   Flags: 0x80000",
    'debugfs: stat "/tmp"',
    "Inode: 13   Type: directory    Mode:  1777   Flags: 0x80000",
    "Generation: 0    Version: 0x00000000:00000000",
    'debugfs: stat "/usr/bin/sudo"',
    "Inode: 14   Type: regular    Mode:  0755   Flags: 0x80000",
    "",
  ].join("\n");
  const modes = parseDebugfsModes(output);
  assert.deepEqual([...modes], [['/odd "q" \\x', 0o755], ["/tmp", 0o1777], ["/usr/bin/sudo", 0o755]]);
  assert.deepEqual(modeMismatches(fixes, modes), ["/usr/bin/sudo: want 4755, got 755"]);
  assert.deepEqual(modeMismatches(fixes, new Map()), [
    '/odd "q" \\x: want 755, got nothing',
    "/tmp: want 1777, got nothing",
    "/usr/bin/sudo: want 4755, got nothing",
  ]);
  assert.deepEqual(modeMismatches(fixes, new Map([...modes, ["/usr/bin/sudo", 0o4755]])), []);
});

test("debugfs errors are its stderr without the version banner", () => {
  assert.deepEqual(debugfsErrors("debugfs 1.47.0 (5-Feb-2023)\n"), []);
  assert.deepEqual(debugfsErrors('debugfs 1.47.0 (5-Feb-2023)\nsif: File not found by ext2_lookup while resolving "/x"\n'), [
    'sif: File not found by ext2_lookup while resolving "/x"',
  ]);
});
