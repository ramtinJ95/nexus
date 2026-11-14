import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../../test-support/kit.ts";
import { keepLogs, pruneKeptLogs } from "./kept-logs.ts";

test("a kept log holds the end of each log that exists and why, at most the bounds' bytes of each", async (t) => {
  const dir = await tempDir("nexus-kept-logs-", t);
  await writeFile(join(dir, "controller.log"), "boot hook 1\nherdr-core: running\n");
  const kept = await keepLogs(join(dir, "kept"), "pylon-a", [join(dir, "controller.log"), join(dir, "serial.log")], "its controller was starting when it was deleted", Date.parse("2026-11-14T02:31:00Z"), { bytes: 20, keeps: 20, ageMs: 60_000 });
  assert.deepEqual((await readdir(kept)).toSorted(), ["controller.log", "why.txt"], "a log that does not exist is left out");
  assert.equal(await readFile(join(kept, "controller.log"), "utf8"), "herdr-core: running\n");
  assert.equal(await readFile(join(kept, "why.txt"), "utf8"), "its controller was starting when it was deleted\n");
});

test("keeps past the bounds' count or age are dropped, oldest first", async (t) => {
  const root = join(await tempDir("nexus-kept-logs-", t), "kept");
  const now = Date.parse("2026-11-14T12:00:00Z");
  for (const [name, ageMs] of [["old", 90_000], ["second", 30_000], ["first", 20_000]] as const) {
    await mkdir(join(root, name), { recursive: true });
    const at = new Date(now - ageMs);
    await utimes(join(root, name), at, at);
  }
  await keepLogs(root, "pylon-b", [], "why", now, { bytes: 10, keeps: 2, ageMs: 60_000 });
  assert.deepEqual((await readdir(root)).toSorted(), ["first", (await readdir(root)).find((n) => n.startsWith("pylon-b-"))!].toSorted(), "the one past the age goes, and the oldest past the count");
});

test("a prune drops keeps past their age with no new keep", async (t) => {
  const root = join(await tempDir("nexus-kept-logs-", t), "kept");
  const now = Date.parse("2026-11-28T12:00:00Z");
  for (const [name, ageMs] of [["stale", 15 * 86_400_000], ["fresh", 86_400_000]] as const) {
    await mkdir(join(root, name), { recursive: true });
    const at = new Date(now - ageMs);
    await utimes(join(root, name), at, at);
  }
  await pruneKeptLogs(root, now);
  assert.deepEqual(await readdir(root), ["fresh"], "14 days is the most a keep stays");
});
