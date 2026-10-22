/**
 * The harness slice against the local Docker: pi-durable's harness drives a container through the bridge,
 * the probe's raw pipe and `docker exec -i` into the pi-env daemon baked into a test image. Everything it
 * creates carries the label nexus.test=harness-<run>, and cleanup removes only that.
 *
 * The bridge verifies the probe through a tailscaled LocalAPI socket, so the test serves a fake one that
 * names the probe's node.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, EntryRecord } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { packagedDaemon } from "@earendil-works/pi-env";
import { createDockerBackend } from "../docker-backend.ts";
import { startProbe, type Probe } from "../probe/server.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ImageId } from "../images.ts";
import { openHarnessHost, pylonRepoPath, type HarnessHost } from "./host.ts";
import { pylonEnvs, type PylonLocator } from "./pylon-env.ts";
import { scriptedModel, scriptedModels, type ChildArgs } from "./test-fixture.ts";

const execFileAsync = promisify(execFile);
const docker = async (...args: string[]) => (await execFileAsync("docker", args, { maxBuffer: 64 << 20 })).stdout.trim();

const run = randomUUID().slice(0, 8);
const testLabel = `nexus.test=harness-${run}`;
const tag = `nexus-harness-test:${run}`;
const image: ImageId = "img-harnesstest00";
const node = "harness-node" as NodeName;
const controlPlaneId = "nHARNESSCONTROL" as TailnetNodeId;
const probeId = "nHARNESSPROBE" as TailnetNodeId;
const threadId = `harness-${run}`;
const pylonId = `pylon-${threadId}` as PylonId;
const backend = createDockerBackend({ images: { [image]: tag }, labels: { "nexus.test": `harness-${run}` } });

let dir: string;
let tailscaled: string;
let localApi: Server;
let probe: Probe;
let locator: PylonLocator;
const logs: string[] = [];
const log = (message: string) => { logs.push(message); };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "nexus-harness-"));
  const arch = await docker("info", "--format", "{{.Architecture}}");
  const daemonArch = arch === "aarch64" || arch === "arm64" ? "arm64" : arch === "x86_64" || arch === "amd64" ? "x64" : assert.fail(`no pi-env build for Docker architecture ${arch}`);
  const build = join(dir, "image");
  await mkdir(build);
  await copyFile(packagedDaemon({ platform: "linux", arch: daemonArch }), join(build, "pi-env"));
  await writeFile(join(build, "Dockerfile"), [
    "FROM debian:bookworm-slim",
    "COPY pi-env /usr/local/libexec/nexus/pi-env",
    `RUN chmod 0755 /usr/local/libexec/nexus/pi-env && mkdir -p ${pylonRepoPath}`,
  ].join("\n") + "\n");
  await docker("build", "--quiet", "--label", testLabel, "--tag", tag, build);

  tailscaled = join(dir, "tailscaled.sock");
  localApi = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: probeId } })));
  await new Promise<void>((resolve) => localApi.listen(tailscaled, resolve));

  probe = await startProbe({
    node, host: "127.0.0.1", port: 0,
    auth: { controlPlane: controlPlaneId, peers: [] },
    whois: async () => controlPlaneId,
    backend,
    secrets: { value: () => undefined },
    log,
  });
  locator = { awaitRunning: async () => ({ node, host: "127.0.0.1", port: probe.port, nodeId: probeId }) };
  await backend.ensureRunning({
    pylonId, image, source: { kind: "fresh", preSetup: null },
    resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 },
    network: { allowedHosts: [], secrets: [] },
    repo: { url: "git@example.com:harness.git", checkout: { branch: "main", commit: "0000000" } },
  }, { previews: [], overlay: [] }, AbortSignal.timeout(90_000));
});

after(async () => {
  await probe?.close();
  localApi?.close();
  const containers = (await docker("ps", "-a", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
  if (containers.length > 0) await docker("rm", "--force", ...containers);
  if (await docker("images", "-q", tag) !== "") await docker("rmi", "--force", tag);
  if (dir) await rm(dir, { recursive: true, force: true });
});

const assertions = {
  ok: (value: unknown, message?: string) => message === undefined ? assert.ok(value) : assert.ok(value, message),
  strictEqual: (actual: unknown, expected: unknown) => assert.strictEqual(actual, expected),
  deepEqual: (actual: unknown, expected: unknown) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual: unknown, expected: unknown) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual: number, expected: number) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: (operation: Promise<unknown>, includes: string) => assert.rejects(operation, (err: Error) => String(err?.message).includes(includes)),
};

test("pi-durable's environment conformance suite passes through the bridge, the probe and docker exec", async (t) => {
  const envs = pylonEnvs(locator, { tailscaled, log });
  t.after(() => envs.close());
  // The factory only reads nexus.thread, so a reader that always returns this thread stands in for the harness.
  const read = { snapshot: async () => ({ threadId, pylonId }) } as unknown as DocumentReader;
  const envAt = (cwd: string) => envs.env({ conversationId: 1 as ConversationId, cwd, read }, context) as Promise<ExecutionEnv>;
  const base = await envAt("/tmp");
  const cases = createEnvConformance({
    assertions,
    listFiles: true,
    withEnv: async (use) => {
      const created = await base.createTempDir("conformance-", context);
      if (!created.ok) throw created.error;
      try {
        await use(await envAt(created.value));
      } finally {
        await base.remove(created.value, { recursive: true, force: true }, context);
      }
    },
  });
  for (const c of cases) await t.test(c.name, { timeout: c.timeoutMs ?? 30_000 }, () => c.run());
});

const transcript = async (host: HarnessHost) => {
  const watch = await host.watch(threadId);
  const entries = watch.value.entries;
  await watch.stop();
  return entries;
};
const toolResults = (entries: readonly EntryRecord[]) => entries.filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e));
const inPylon = (script: string) => backend.guest(pylonId).exec(["sh", "-c", script], { cwd: "/", timeoutMs: 10_000 });

async function until(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}. Logs:\n${logs.join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("a thread runs bash in its pylon, and a harness killed mid-tool reports the call as interrupted", async () => {
  const storagePath = join(dir, "harness.sqlite");
  const options = { storagePath, models: scriptedModels(), model: scriptedModel, locator, tailscaled, log };

  const first = await openHarnessHost({ ...options, threads: [] });
  const conversationId = await first.startThread({ threadId, pylonId });
  const submission = await first.send(threadId, "bash: echo hello-from-$(uname -s); pwd", "msg:1", "followUp");
  assert.equal((await submission.wait(context)).status, "done");
  const results = toolResults(await transcript(first));
  assert.equal(results.length, 1);
  assert.match(results[0]!, new RegExp(`hello-from-Linux\\\\n${pylonRepoPath}`));
  assert.equal(first.activity.facts(threadId).agentTurnRunning, false);
  assert.ok(first.activity.facts(threadId).lastAgentActivityAt > 0);
  await first.close();

  const args: ChildArgs = {
    storagePath, tailscaled, threadId, conversationId,
    probe: await locator.awaitRunning(pylonId, Date.now()),
    command: "echo $$ > /tmp/killed-mid-tool.pid; exec sleep 600",
  };
  const child = spawn(process.execPath, [join(import.meta.dirname, "test-fixture.ts"), JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => logs.push(`child: ${chunk.toString().trimEnd()}`));
  child.stderr.on("data", (chunk: Buffer) => logs.push(`child: ${chunk.toString().trimEnd()}`));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await until("the tool's command runs in the pylon", async () => (await inPylon("cat /tmp/killed-mid-tool.pid")).exitCode === 0);
  child.kill("SIGKILL");
  await exited;
  await until("the killed harness's command is gone from the pylon", async () => (await inPylon('kill -0 "$(cat /tmp/killed-mid-tool.pid)"')).exitCode !== 0, 15_000);

  const reopened = await openHarnessHost({ ...options, threads: [{ threadId, conversationId }] });
  try {
    await until("the resumed run ends", () => !reopened.activity.facts(threadId).agentTurnRunning);
    const after = toolResults(await transcript(reopened));
    assert.equal(after.length, 2, after.join("\n"));
    assert.match(after[1]!, /interrupted/);
    assert.doesNotMatch(after[1]!, /connection lost/);
  } finally {
    await reopened.close();
  }
});
