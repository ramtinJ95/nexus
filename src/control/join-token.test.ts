import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempDir } from "../test-support/kit.ts";
import { openRegistry } from "./registry.ts";

const sudo = (() => { try { execFileSync("sudo", ["-n", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("a join token is minted with only the registry owner's access, none of root's groups", { skip: !sudo && "needs passwordless sudo" }, async (t) => {
  const dir = await tempDir("nexus-join-token-", t);
  const state = join(dir, "state");
  await mkdir(state);
  const db = join(state, "registry.db");
  openRegistry(db).close();
  const config = join(dir, "control.json");
  await writeFile(config, JSON.stringify({
    db,
    listen: { host: "127.0.0.1", port: 0, hostnames: ["localhost"] },
    self: { tailnetNodeId: "nSelf" },
    nodes: [{ name: "node-a", tailnetHost: "node-a.example.ts.net", tailnetNodeId: "nSelf" }],
    callers: [],
    dotfiles: { repo: "https://github.com/acme/repo.git", ref: "main" },
    harness: { storage: join(state, "harness.sqlite"), credentials: join(state, "harness-credentials.json"), model: { provider: "openai", modelId: "gpt-6-astra" } },
  }));
  const mint = () => spawnSync("sudo", ["-n", process.execPath, resolve(import.meta.dirname, "join-token.ts"), config], { encoding: "utf8" });

  const minted = mint();
  assert.equal(minted.status, 0, minted.stderr);
  assert.match(minted.stdout, /--join \S+ --node node-a/);

  // Only root's group may enter the directory now, so a process that kept root's groups would still open the registry.
  execFileSync("sudo", ["-n", "chown", "root:root", state]);
  execFileSync("sudo", ["-n", "chmod", "0770", state]);
  let refused;
  try {
    refused = mint();
  } finally {
    execFileSync("sudo", ["-n", "chown", `${process.getuid!()}:${process.getgid!()}`, state]);
  }
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.doesNotMatch(refused.stdout, /--join/);
});
