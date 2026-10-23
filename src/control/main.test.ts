import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseConfig } from "./main.ts";

const example = await readFile(new URL("../../deploy/control.example.json", import.meta.url), "utf8");

test("the shipped example config parses", () => {
  const config = parseConfig(example);
  assert.deepEqual(config.harness.model, { provider: "openai", modelId: "gpt-5.5" });
  assert.deepEqual(config.dotfiles, { repo: "https://github.com/example/dotfiles.git", ref: "main" });
});

test("a config without the harness, or with a relative harness path, is refused", () => {
  const { harness, ...rest } = JSON.parse(example);
  assert.throws(() => parseConfig(JSON.stringify(rest)), /harness/);
  assert.throws(() => parseConfig(JSON.stringify({ ...rest, harness: { ...harness, storage: "harness.sqlite" } })), /absolute path/);
});
