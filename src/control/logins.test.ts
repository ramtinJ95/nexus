import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { loginStore } from "./logins.ts";
import type { Person } from "../ids.ts";

const alice = "alice@example.com" as Person;

test("two logins set at once both land, and a write that fails leaves no copy of the token behind", async (t) => {
  const dir = join(tmpdir(), `nexus-logins-${randomUUID()}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = loginStore(dir);
  await Promise.all([store.set(alice, "claude", "made-up-claude"), store.set(alice, "github", "madeUpGithub")]);
  assert.deepEqual(await store.kinds(alice), { claude: true, github: true });
  const carol = "carol@example.com" as Person;
  // A directory where carol's file goes makes the rename over it fail.
  await mkdir(join(dir, "carol%40example.com.json", "in-the-way"), { recursive: true });
  await assert.rejects(store.set(carol, "claude", "made-up-claude"));
  assert.deepEqual((await readdir(dir)).sort(), ["alice%40example.com.json", "carol%40example.com.json"], "no partial file is left");
  await store.remove(alice, "claude");
  assert.deepEqual(await store.kinds(alice), { claude: false, github: true }, "a write after a failed one still lands");
});
