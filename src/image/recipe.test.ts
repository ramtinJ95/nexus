import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pylonRecipeDir, recipePaths } from "./recipe.ts";

test("every file under images/pylon is a declared recipe file, build.sh or pins.json", async () => {
  const entries = await readdir(pylonRecipeDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => !e.isDirectory()).map((e) => relative(pylonRecipeDir, join(e.parentPath, e.name)).split(sep).join("/"));
  assert.deepEqual(files.sort(), [...recipePaths, "build.sh", "pins.json"].sort());
});
