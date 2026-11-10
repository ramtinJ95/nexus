/**
 * Version skew between the CLI and its control plane, and where the CLI keeps its config: the commands that upgrade or
 * diagnose a control plane too old still run against it, a terminal hears about either side being behind, and the
 * config follows XDG_CONFIG_HOME without losing a file already at ~/.config.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { version } from "../version.ts";
import { minControlVersion } from "./config.ts";
import { tempDir } from "../test-support/kit.ts";
import { inProcess, listening, onTerminal } from "../test-support/cli-kit.ts";

const desired = { commit: "a".repeat(40), requestedBy: "nLAPTOP", requestedAt: 0 };
const caller = { node: "nLAPTOP", allowed: true, person: true, deployer: true };
const check = { node: null, name: "backup", status: "ok", text: "the newest backup is 3 h old and verified" };

/** A control plane whose health answers `health`, with what deploy, release, doctor, connect and projects read. */
async function control(t: TestContext, health: unknown) {
  const asked: string[] = [];
  const replies: Record<string, unknown> = {
    "GET /v1/health": health, "GET /v1/release": { desired: null, nodes: [] }, "PUT /v1/release": { desired, nodes: [] },
    "GET /v1/doctor": { at: "2026-11-01T12:00:00.000Z", status: "ok", checks: [check] }, "GET /v1/whoami": caller, "GET /v1/projects": [],
  };
  const server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    asked.push(key);
    req.resume();
    if (key === "GET /v1/health" && health === null) return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "caller is not allowed", code: null, retryable: false }));
    res.writeHead(key in replies ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(replies[key] ?? { error: `no route ${key}` }));
  });
  return { url: `http://127.0.0.1:${await listening(t, server)}`, asked };
}

async function home(t: TestContext) {
  const dir = await tempDir("nexus-skew-", t);
  return { dir, env: { PATH: process.env.PATH!, HOME: dir, NEXUS_SOCKS: "none" } };
}

const pattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const versionLine = (control: string) => `This CLI runs Nexus ${version}, and the control plane ${control}.`;

test("deploy, release, doctor and connect run against a control plane older than the CLI reads, and warn a terminal once", async (t) => {
  for (const [health, runs] of [[{ commit: "a".repeat(40), https: {} }, `older than ${minControlVersion}`], [{ commit: null, version: "0.9.99" }, "0.9.99"]] as const) {
    for (const [args, request] of [[["deploy", "main"], "PUT /v1/release"], [["release"], "GET /v1/release"], [["doctor"], "GET /v1/doctor"], [["connect"], "GET /v1/whoami"]] as const) {
      const old = await control(t, health);
      const { env } = await home(t);
      const run = onTerminal([...args, ...args[0] === "connect" ? [old.url] : []], { ...env, NEXUS_URL: old.url });
      const res = await run.exited;
      assert.equal(res.code, 0, `${args[0]}: ${res.stderr}`);
      assert.equal(res.stderr, `nexus: the control plane at ${old.url} runs Nexus ${runs}, and this CLI needs ${minControlVersion} or later. Upgrade it, as deploy/README.md describes. Until then, only deploy, release, doctor and connect run against it\n`, args[0]);
      assert.ok(old.asked.includes(request), `${args[0]} sent ${request}: ${old.asked.join(", ")}`);
      if (args[0] === "doctor" || args[0] === "connect") assert.ok(res.stdout.includes(versionLine(health.version ?? "reports no version")), `${args[0]} prints both versions: ${res.stdout}`);
    }
  }
});

test("without a terminal, a command that runs against a control plane too old prints no warning, and any other refuses it", async (t) => {
  const old = await control(t, { commit: null, version: "0.9.99" });
  const { env } = await home(t);
  assert.deepEqual(await inProcess(["release"], { ...env, NEXUS_URL: old.url }), { code: 0, stdout: "Desired: none\n", stderr: "" });
  const refused = await inProcess(["projects"], { ...env, NEXUS_URL: old.url });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^nexus: the control plane at .* runs Nexus 0\.9\.99, and this CLI needs .* or later\. Upgrade it, as deploy\/README\.md describes\n$/);
  assert.deepEqual(old.asked, ["GET /v1/health", "GET /v1/release", "GET /v1/health"], "projects sends nothing past health");
});

test("a control plane newer than the CLI gets a terminal one line to pull the checkout and install again, and doctor and connect print both versions", async (t) => {
  const newer = "99.0.0";
  const ahead = await control(t, { commit: null, version: newer });
  const { env } = await home(t);
  const hint = `nexus: the control plane runs Nexus ${newer}, newer than this CLI's ${version}. Run git pull in the nexus checkout, then deploy/mac/install\n`;
  for (const args of [["projects"], ["doctor"], ["connect", ahead.url]]) {
    const res = await onTerminal(args, { ...env, NEXUS_URL: ahead.url }).exited;
    assert.deepEqual([res.code, res.stderr], [0, hint], args[0]!);
    if (args[0] !== "projects") assert.match(res.stdout, new RegExp(`^${pattern(versionLine(newer))}$`, "m"), args[0]!);
  }
  assert.equal((await inProcess(["projects"], { ...env, NEXUS_URL: ahead.url })).stderr, "", "a pipe gets no hint, since the client extensions read stderr as a failure");
  const same = await control(t, { commit: null, version });
  assert.equal((await onTerminal(["projects"], { ...env, NEXUS_URL: same.url }).exited).stderr, "", "a control plane at the CLI's version gets no line");
  const connected = JSON.parse((await inProcess(["connect", ahead.url, "--json"], env)).stdout);
  assert.deepEqual(connected.versions, { cli: version, control: newer }, "connect --json adds both versions");
  const closed = await control(t, null);
  const unread = await inProcess(["connect", closed.url], env);
  assert.equal(unread.code, 0, unread.stderr);
  assert.match(unread.stdout, new RegExp(`^This CLI runs Nexus ${pattern(version)}\\. The control plane does not tell this device its version until it admits it\\.$`, "m"), "a control plane that refuses health is not asked again");
});

test("the config lives under XDG_CONFIG_HOME, and a file already at ~/.config stays the one read and written", async (t) => {
  const at = await control(t, { commit: null, version });
  const { dir, env } = await home(t);
  const xdg = join(dir, "xdg");
  const xdgFile = join(xdg, "nexus", "cli.json");
  const homeFile = join(dir, ".config", "nexus", "cli.json");

  const fresh = JSON.parse((await inProcess(["connect", at.url, "--json"], { ...env, XDG_CONFIG_HOME: xdg })).stdout);
  assert.equal(fresh.config, xdgFile);
  assert.deepEqual(JSON.parse(await readFile(xdgFile, "utf8")), { url: at.url });
  assert.ok((await inProcess(["--help"], { ...env, XDG_CONFIG_HOME: xdg })).stdout.includes(`then ${xdgFile}, which`), "help names it");
  assert.equal((await inProcess(["projects"], { ...env, XDG_CONFIG_HOME: xdg })).code, 0, "a command reads the URL from it");
  assert.equal(JSON.parse((await inProcess(["connect", at.url, "--json"], { ...env, XDG_CONFIG_HOME: "relative" })).stdout).config, homeFile, "a relative XDG_CONFIG_HOME is ignored, as the spec says");

  const { dir: older, env: olderEnv } = await home(t);
  const kept = join(older, ".config", "nexus", "cli.json");
  await mkdir(join(older, ".config", "nexus"), { recursive: true });
  await writeFile(kept, JSON.stringify({ url: at.url }));
  const otherXdg = join(older, "xdg");
  assert.equal((await inProcess(["projects"], { ...olderEnv, XDG_CONFIG_HOME: otherXdg })).code, 0, "a command reads the file at ~/.config");
  assert.equal(JSON.parse((await inProcess(["connect", at.url, "--json", "--socks", "none"], { ...olderEnv, XDG_CONFIG_HOME: otherXdg })).stdout).config, kept, "connect writes the file it read");
  assert.deepEqual(JSON.parse(await readFile(kept, "utf8")), { url: at.url, socks: "none" });
  await assert.rejects(readFile(join(otherXdg, "nexus", "cli.json")), { code: "ENOENT" });
});
