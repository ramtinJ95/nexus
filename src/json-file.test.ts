import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, saveJson } from "./json-file.ts";
import { tempDir } from "./test-kit.ts";

async function dir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const path = await tempDir("nexus-json-file-", t);
  return path;
}

test("a save makes the parent when asked and sets the exact mode whatever the umask", async (t) => {
  const path = join(await dir(t), "etc", "nexus", "control.json");
  const umask = process.umask(0o077);
  try {
    await saveJson(path, { a: 1 }, { mode: 0o644, mkdir: true });
  } finally {
    process.umask(umask);
  }
  assert.deepEqual(await readJson(path), { a: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  await saveJson(path, { a: 2 });
  assert.equal((await stat(path)).mode & 0o777, 0o600, "the default is readable by its owner only");
  await assert.rejects(saveJson(join(path, "..", "missing", "x.json"), {}), { code: "ENOENT" });
});

test("a save replaces a stale file or a symlink at its temp name rather than writing through it", async (t) => {
  const root = await dir(t);
  const path = join(root, "state.json");
  const victim = join(root, "victim");
  await writeFile(victim, "untouched");
  const planted = Array.from({ length: 50 }, (_, i) => `state.json.${process.pid}.${i + 1}.tmp`);
  for (const [i, name] of planted.entries()) {
    if (i % 2 === 0) await symlink(victim, join(root, name));
    else await writeFile(join(root, name), "{ stale");
  }
  await saveJson(path, { ok: true });
  await saveJson(path, { ok: "again" });
  assert.equal(await readFile(victim, "utf8"), "untouched");
  assert.deepEqual(await readJson(path), { ok: "again" });
  assert.equal((await readdir(root)).filter((name) => planted.includes(name)).length, planted.length - 2, "each save took one name a stale file or symlink held");
});

test("concurrent saves of one path both succeed and leave one complete value", async (t) => {
  const path = join(await dir(t), "services.json");
  const values = Array.from({ length: 8 }, (_, i) => ({ i, filler: "x".repeat(64 * 1024) }));
  await Promise.all(values.map((value) => saveJson(path, value)));
  const saved = await readJson(path) as { i: number };
  assert.deepEqual(saved, values[saved.i]);
});

test("a failed save leaves no temp file behind", async (t) => {
  const root = await dir(t);
  const path = join(root, "routes.json");
  await mkdir(join(path, "held"), { recursive: true });
  for (let i = 0; i < 3; i++) await assert.rejects(saveJson(path, { i }), { code: "EISDIR" });
  await rm(path, { recursive: true });
  await saveJson(path, { i: 3 });
  assert.deepEqual(await readdir(root), ["routes.json"]);
});
