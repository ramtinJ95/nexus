import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobFailure } from "./backend.ts";
import {
  buildImage, debugfsErrors, debugfsModeCommands, debugfsStatCommands, loadImageRecipe, modeMismatches,
  parseDebugfsModes, parseModeListing, pylonRecipeDir,
} from "./image-build.ts";
import type { ImageRecipe } from "./images.ts";
import type { NodeName } from "./protocol.ts";

const pins: ImageRecipe["pins"] = {
  debianDigest: `sha256:${"a".repeat(64)}`,
  node: "24.22.1",
  nodeSha256: "b".repeat(64),
  claudeCode: "2.1.308",
  pi: "1.4.0",
  herdr: "0.9.5",
  piEnv: "1.4.0",
  piEnvSha256: "c".repeat(64),
  gondolin: "0.13.0",
  alpineKernel: "6.18.58-0-virt",
  dotfilesCommon: "placeholder",
};

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
  for (const path of ["Dockerfile", "gondolin.json", "nexus", "rootfs-init-extra.sh"]) assert.ok(paths.includes(path), `${path} is an image input`);
  assert.ok(!paths.includes("build.sh") && !paths.includes("pins.json"));
});

test("a recipe is every file under its directory, nested ones by posix path, sorted", async (t) => {
  const dir = await recipeDir(t, {
    "pins.json": JSON.stringify(pins),
    "build.sh": "echo runner",
    "nexus": "#!/bin/sh\n",
    "dotfiles-common/pi/AGENTS.md": "pi rules",
    "Dockerfile": "FROM scratch\n",
  });
  assert.deepEqual(await loadImageRecipe(dir), {
    files: [
      { path: "Dockerfile", content: "FROM scratch\n" },
      { path: "dotfiles-common/pi/AGENTS.md", content: "pi rules" },
      { path: "nexus", content: "#!/bin/sh\n" },
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

test("buildImage refuses a recipe from a job whose paths or pins are unsafe, before it writes anything", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nexus-image-out-"));
  t.after(() => rm(root, { recursive: true }));
  const outDir = join(root, "img-000000000000");
  const node = "infra-testbench" as NodeName;
  const bad: readonly ImageRecipe[] = [
    { files: [{ path: "../escape", content: "" }], pins },
    { files: [{ path: "/etc/passwd", content: "" }], pins },
    { files: [{ path: "a//b", content: "" }], pins },
    { files: [], pins: { ...pins, nodeSha256: "not-a-digest" } },
  ];
  for (const recipe of bad) {
    await assert.rejects(buildImage(recipe, node, outDir, AbortSignal.timeout(5_000)), (err) => err instanceof JobFailure && err.code === "invalid");
  }
  assert.ok(!existsSync(`${outDir}.partial`) && !existsSync(join(root, "escape")));
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
