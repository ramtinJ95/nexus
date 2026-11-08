import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { imageIdOf } from "../protocol/images.ts";
import { loadImageRecipe, pylonRecipeDir, recipePaths } from "./recipe.ts";

const repo = join(import.meta.dirname, "../..");

test("every file under images/pylon is a declared recipe file, build.sh or pins.json", async () => {
  const entries = await readdir(pylonRecipeDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => !e.isDirectory()).map((e) => relative(pylonRecipeDir, join(e.parentPath, e.name)).split(sep).join("/"));
  assert.deepEqual(files.sort(), [...recipePaths, "build.sh", "pins.json"].sort());
});

test("the checked-in recipe is every file git tracks under images/pylon but build.sh and pins.json, with git's mode", async () => {
  const tracked = execFileSync("git", ["ls-files", "-s", "--", "images/pylon"], { cwd: repo, encoding: "utf8" }).trim().split("\n").map((line) => {
    const [meta, path] = line.split("\t") as [string, string];
    return { path: path.slice("images/pylon/".length), mode: meta.startsWith("100755") ? 0o755 : 0o644 } as const;
  }).filter((f) => f.path !== "build.sh" && f.path !== "pins.json");
  const expected = {
    files: await Promise.all(tracked.map(async (f) => ({
      ...f, content: await readFile(join(repo, "images/pylon", f.path), "utf8"),
    }))),
    pins: JSON.parse(await readFile(join(pylonRecipeDir, "pins.json"), "utf8")),
  };
  const recipe = await loadImageRecipe();
  assert.deepEqual(recipe, { ...expected, files: expected.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) });
  assert.equal(imageIdOf(recipe), imageIdOf(expected));
});
