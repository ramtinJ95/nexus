import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { openCredentials } from "./credentials.ts";

async function credentialsPath(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-credentials-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "harness-credentials.json");
}

const oauth = (access: string): Credential => ({ type: "oauth", access, refresh: `refresh-${access}`, expires: 1 });

test("a new file gets a device ID that every later open returns", async (t) => {
  const path = await credentialsPath(t);
  const first = await openCredentials(path);
  assert.match(first.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal((await openCredentials(path)).deviceId, first.deviceId);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a stored credential survives a reopen, and list shows only provider and type", async (t) => {
  const path = await credentialsPath(t);
  const { store } = await openCredentials(path);
  assert.deepEqual(await store.modify("openai", async () => oauth("a1")), oauth("a1"));
  const reopened = (await openCredentials(path)).store;
  assert.deepEqual(await reopened.read("openai"), oauth("a1"));
  assert.deepEqual(await reopened.list(), [{ providerId: "openai", type: "oauth" }]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(path, ".."))).sort(), ["harness-credentials.json"], "no temporary file is left behind");
});

test("modify runs one at a time per provider, each seeing the previous result", async (t) => {
  const { store } = await openCredentials(await credentialsPath(t));
  const seen: (string | undefined)[] = [];
  await Promise.all(Array.from({ length: 5 }, (_, i) => store.modify("openai", async (current) => {
    seen.push(current?.type === "oauth" ? current.access : undefined);
    await new Promise((r) => setTimeout(r, 5));
    return oauth(`a${i}`);
  })));
  assert.deepEqual(seen, [undefined, "a0", "a1", "a2", "a3"]);
});

test("concurrent writes for two providers both persist", async (t) => {
  const path = await credentialsPath(t);
  const { store } = await openCredentials(path);
  await Promise.all([
    store.modify("openai", async () => { await new Promise((r) => setTimeout(r, 10)); return oauth("o"); }),
    store.modify("anthropic", async () => ({ type: "api_key", key: "k" })),
  ]);
  const reopened = (await openCredentials(path)).store;
  assert.deepEqual(await reopened.read("openai"), oauth("o"));
  assert.deepEqual(await reopened.read("anthropic"), { type: "api_key", key: "k" });
});

test("a modify that returns undefined or throws leaves the credential as it was", async (t) => {
  const path = await credentialsPath(t);
  const { store } = await openCredentials(path);
  await store.modify("openai", async () => oauth("kept"));
  assert.deepEqual(await store.modify("openai", async () => undefined), oauth("kept"));
  await assert.rejects(store.modify("openai", async () => { throw new Error("refresh failed"); }), /refresh failed/);
  assert.deepEqual(await (await openCredentials(path)).store.read("openai"), oauth("kept"));
});

test("delete removes the credential from the file", async (t) => {
  const path = await credentialsPath(t);
  const { store } = await openCredentials(path);
  await store.modify("openai", async () => oauth("gone"));
  await store.delete("openai");
  assert.equal(await (await openCredentials(path)).store.read("openai"), undefined);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).credentials, {});
});

test("an aborted modify does not run", async (t) => {
  const { store } = await openCredentials(await credentialsPath(t));
  let ran = false;
  await assert.rejects(store.modify("openai", async () => { ran = true; return oauth("x"); }, { signal: AbortSignal.abort() }));
  assert.equal(ran, false);
});

test("a file that does not parse fails the open instead of minting a new device ID", async (t) => {
  const path = await credentialsPath(t);
  await writeFile(path, JSON.stringify({ deviceId: "not-a-uuid", credentials: {} }));
  await assert.rejects(openCredentials(path), /harness-credentials\.json/);
});
