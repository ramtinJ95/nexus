import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { loginStore } from "./logins.ts";
import type { Person } from "../ids.ts";

const alice = "alice@example.com" as Person;
const aliceFile = "alice%40example.com.json";

async function store(t: { after(fn: () => Promise<void>): void }) {
  const dir = join(tmpdir(), `nexus-logins-${randomUUID()}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  let fail: "none" | "write" | "rename" = "none";
  const logins = loginStore(dir, {
    async writeFile(path, data, options) {
      if (fail !== "write") return writeFile(path, data, options);
      // Half the file, as a full disk leaves it, then the error.
      await writeFile(path, String(data).slice(0, 20), options);
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    },
    async rename(from, to) {
      if (fail === "rename") throw Object.assign(new Error("input/output error"), { code: "EIO" });
      return rename(from, to);
    },
  });
  return { dir, logins, failing(how: typeof fail) { fail = how; } };
}

test("two logins set at once both land", async (t) => {
  const { logins } = await store(t);
  await Promise.all([logins.set(alice, { kind: "claude", token: "made-up-claude" }), logins.set(alice, { kind: "github", token: "madeUpGithub", identity: { name: "Alice", email: "alice@example.com" } })]);
  assert.deepEqual(await logins.kinds(alice), { claude: true, github: true });
});

for (const how of ["write", "rename"] as const) {
  test(`a ${how} that fails after the temporary file exists leaves no copy of the token, keeps the stored one, and the next write lands`, async (t) => {
    const { dir, logins, failing } = await store(t);
    await logins.set(alice, { kind: "claude", token: "made-up-old" });
    failing(how);
    await assert.rejects(logins.set(alice, { kind: "claude", token: "made-up-new-token" }));
    assert.deepEqual(await readdir(dir), [aliceFile], "no temporary file is left");
    assert.deepEqual(JSON.parse(await readFile(join(dir, aliceFile), "utf8")), { claude: "made-up-old" }, "the stored token survives");
    failing("none");
    await logins.set(alice, { kind: "claude", token: "made-up-retried" });
    assert.deepEqual(JSON.parse(await readFile(join(dir, aliceFile), "utf8")), { claude: "made-up-retried" }, "a retry for the same person lands");
    assert.deepEqual(await readdir(dir), [aliceFile]);
  });
}

test("the control plane reads back a person's own tokens and the git identity of their GitHub login, which goes with that login", async (t) => {
  const { logins } = await store(t);
  const identity = { name: "Alice", email: "1+alice@users.noreply.github.com" };
  assert.deepEqual(await logins.owned(alice), {}, "nothing is set");
  await logins.set(alice, { kind: "claude", token: "made-up-claude" });
  await logins.set(alice, { kind: "github", token: "madeUpGithub", identity });
  assert.deepEqual(await logins.owned(alice), { claude: "made-up-claude", github: { token: "madeUpGithub", identity } });
  await logins.remove(alice, "github");
  assert.deepEqual(await logins.owned(alice), { claude: "made-up-claude" }, "removing GitHub removes its identity too");
});
