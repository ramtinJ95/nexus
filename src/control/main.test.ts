import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseConfig } from "./main.ts";

const example = await readFile(new URL("../../deploy/control.example.json", import.meta.url), "utf8");

test("the shipped example config parses", () => {
  const config = parseConfig(example);
  assert.deepEqual(config.harness.model, { provider: "openai", modelId: "gpt-6-astra" });
  assert.deepEqual(config.dotfiles, { repo: "https://github.com/example/dotfiles.git", ref: "main" });
});

test("a config without the harness, or with a relative harness path, is refused", () => {
  const { harness, ...rest } = JSON.parse(example);
  assert.throws(() => parseConfig(JSON.stringify(rest)), /harness/);
  assert.throws(() => parseConfig(JSON.stringify({ ...rest, harness: { ...harness, storage: "harness.sqlite" } })), /absolute path/);
});

test("preview ports default to 10200 to 10999, and a range that ends before it starts is refused", () => {
  const { previewPorts, ...rest } = JSON.parse(example);
  assert.deepEqual(previewPorts, { first: 10200, last: 10999 });
  assert.deepEqual(parseConfig(JSON.stringify(rest)).previewPorts, { first: 10200, last: 10999 });
  assert.throws(() => parseConfig(JSON.stringify({ ...rest, previewPorts: { first: 10300, last: 10200 } })), /first must not be above last/);
});

test("GitHub watching is opt-in and accepts only a token file path, never a token in config", () => {
  const config = JSON.parse(example);
  assert.equal(parseConfig(example).github, undefined);
  assert.deepEqual(parseConfig(JSON.stringify({ ...config, github: { tokenFile: "/etc/nexus/github-token" } })).github, { tokenFile: "/etc/nexus/github-token" });
  assert.throws(() => parseConfig(JSON.stringify({ ...config, github: { tokenFile: "relative" } })), /absolute path/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, github: { token: "secret" } })), /invalid control plane config/);
});


test("HTTPS socket paths are absolute and previews cannot allocate dashboard port 443", () => {
  const config = JSON.parse(example);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, serveSocket: "api.sock" })), /absolute path/);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, previewPorts: { first: 440, last: 450 } })), /443/);
});
