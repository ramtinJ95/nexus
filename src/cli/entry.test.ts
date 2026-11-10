/**
 * What nexus.ts does before the CLI loads: a reader that closes the pipe early ends any command quietly, and Node's
 * compile cache is on.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../test-support/kit.ts";
import { version } from "../version.ts";

const cli = fileURLToPath(new URL("./nexus.ts", import.meta.url));

/** A control plane that lists 20,000 projects, so `nexus projects` prints megabytes, far past what a pipe holds. */
async function manyProjects(t: TestContext): Promise<string> {
  const projects = Array.from({ length: 20_000 }, (_, i) => ({
    id: `project-${i}`, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: "rj-firebat",
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  }));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/health" ? { commit: null, version } : projects));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Runs the CLI with its stdout read by `read`, and resolves with its exit and its stderr. */
async function run(t: TestContext, args: readonly string[], env: Record<string, string>, read: (stdout: NodeJS.ReadableStream & { destroy(): void }) => void) {
  const home = await tempDir("nexus-entry-", t);
  const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH!, HOME: home, NEXUS_SOCKS: "none", ...env } });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  read(child.stdout);
  const [code, signal] = await once(child, "close");
  return { code, signal, stderr };
}

test("a reader that closes the pipe early ends a command with exit 0 and nothing on stderr", async (t) => {
  const url = await manyProjects(t);
  const midway = await run(t, ["projects"], { NEXUS_URL: url }, (stdout) => stdout.once("data", () => stdout.destroy()));
  assert.deepEqual(midway, { code: 0, signal: null, stderr: "" }, "a reader that took the first chunk, as head does");
  const before = await run(t, ["--version"], {}, (stdout) => stdout.destroy());
  assert.deepEqual(before, { code: 0, signal: null, stderr: "" }, "a reader gone before the first write");
});

test("the CLI keeps its compiled modules in ~/.cache/nexus/compile-cache, and runs as before where it cannot write there", async (t) => {
  const home = await tempDir("nexus-entry-home-", t);
  const cached = await run(t, ["--version"], { HOME: home }, (stdout) => stdout.resume());
  assert.deepEqual(cached, { code: 0, signal: null, stderr: "" });
  assert.notDeepEqual(await readdir(join(home, ".cache", "nexus", "compile-cache"), { recursive: true }), [], "the cache holds the CLI's modules");

  const blocked = await tempDir("nexus-entry-home-", t);
  await writeFile(join(blocked, ".cache"), "");
  let stdout = "";
  const uncached = await run(t, ["--version"], { HOME: blocked }, (out) => out.on("data", (chunk) => { stdout += chunk; }));
  assert.deepEqual([uncached, stdout], [{ code: 0, signal: null, stderr: "" }, `nexus ${version}\n`], "a ~/.cache that is a file");
});
