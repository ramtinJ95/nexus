/**
 * Node validation for one thread end to end, run by hand on a home-lab node as the probe's user:
 *   node src/control/thread-on-node.ts [probe.json] [imageId]
 *
 * It starts a control plane in this process (registry, loop, harness and API, as src/control/main.ts wires
 * them) over a temporary directory. Its harness uses the scripted model from src/harness/test-fixture.ts, so
 * no model login is needed. It drives the node's running probe only through the control plane's HTTP API:
 * start a thread, run a tool in its pylon, archive it so the pylon pauses, unarchive it so the pylon wakes and
 * runs a second tool, then delete it. The probe's auth.controlPlane must be this node's own stable node ID.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { artifactDirectory, tarCodec } from "../artifacts.ts";
import { isImageId, probePort } from "../protocol.ts";
import { scriptedModel, scriptedModels } from "../harness/test-fixture.ts";
import { readProbeConfig } from "../probe/config.ts";
import { tailscaleCli } from "../probe/serve.ts";
import type { ThreadDetail } from "./api.ts";
import { startControlPlane, type ControlPlaneConfig } from "./main.ts";

const probeConfig = await readProbeConfig(process.argv[2] ?? "/etc/nexus/probe.json");
if (probeConfig.backend.kind !== "pylon-vm") throw new Error(`the probe runs the ${probeConfig.backend.kind} backend. This check is for pylon-vm`);
const store = artifactDirectory(probeConfig.backend.artifacts, tarCodec);
const images = (await store.list()).filter(isImageId);
const image = process.argv[3] ?? (images.length === 1 ? images[0] : undefined);
if (!isImageId(image) || !images.includes(image)) throw new Error(`name one of the images in ${store.root}: ${images.join(", ")}`);
if (probeConfig.listen.port !== probePort) throw new Error(`the probe listens on port ${probeConfig.listen.port}, and the control plane reaches probes on ${probePort} only`);
const status = z.object({ Self: z.object({ ID: z.string() }) }).parse(JSON.parse(await tailscaleCli()(["status", "--json"], AbortSignal.timeout(30_000))));
const self = status.Self.ID;
if (probeConfig.auth.controlPlane !== self) throw new Error(`set auth.controlPlane in the probe's config to this node's ID ${self} (it is ${probeConfig.auth.controlPlane}), then restart the probe`);
const manifest = await store.manifest(image);

const dir = await mkdtemp(join(tmpdir(), "nexus-thread-on-node-"));
const host = probeConfig.listen.host;
const config: ControlPlaneConfig = {
  db: join(dir, "registry.db"),
  listen: { host, port: 0, hostnames: [host] },
  self: { tailnetNodeId: self },
  nodes: [{ name: probeConfig.node, tailnetHost: host, tailnetNodeId: self }],
  callers: [],
  dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
  harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "unused-credentials.json"), model: scriptedModel },
};
const controlPlane = await startControlPlane(config, scriptedModels());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host, port: controlPlane.port, method, path: `/v1${path}`,
      headers: { host: `${host}:${controlPlane.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text === "" ? null : JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function expect(status: number, method: string, path: string, body?: unknown) {
  const res = await call(method, path, body);
  if (res.status !== status) throw new Error(`${method} ${path}: HTTP ${res.status}, expected ${status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function until<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting until ${what}`);
    await delay(1_000);
  }
}

const started = performance.now();
function pass(step: string) {
  console.log(`PASS ${step} (${Math.round((performance.now() - started) / 1000)} s)`);
}

let threadId: string | undefined;
let deleted = false;
const detail = async () => await expect(200, "GET", `/threads/${threadId}`) as ThreadDetail;
const reaches = (state: string, timeoutMs: number) => until(`the pylon is ${state}`, timeoutMs, async () => {
  const d = await detail();
  if (d.pylon.failed !== null) throw new Error(`the planner gave up on the pylon: ${d.pylon.failed}`);
  return d.pylon.actualState === state ? d : undefined;
});

/** Sends `bash: <command>`, which the scripted model turns into one bash call, and returns that call's result. */
async function runTool(requestId: string, command: string): Promise<string> {
  const seen = toolResults(await expect(200, "GET", `/threads/${threadId}/conversation`)).length;
  await expect(202, "POST", `/threads/${threadId}/messages`, { text: `bash: ${command}`, requestId });
  const result = await until("the tool result is in the conversation", 6 * 60_000, async () => toolResults(await expect(200, "GET", `/threads/${threadId}/conversation`))[seen]);
  await until("the run ends", 60_000, async () => (await detail()).thread.agentTurnRunning ? undefined : true);
  return result;
}
const toolResults = (view: { entries: readonly { kind: string }[] }) => view.entries.filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e));

function assertIncludes(text: string, ...parts: string[]) {
  for (const part of parts) if (!text.includes(part)) throw new Error(`the tool result lacks ${part}: ${text}`);
}

let verdict = "FAIL";
try {
  await expect(201, "POST", "/images", manifest);
  await expect(204, "PUT", "/images/current", { image });
  await expect(201, "POST", "/projects", {
    id: "node-check", repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: probeConfig.node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  const thread = await expect(201, "POST", "/threads", { project: "node-check", title: "thread on node" });
  threadId = thread.id;
  pass(`start thread ${threadId} on ${probeConfig.node} from ${image}`);

  await reaches("running", 10 * 60_000);
  pass("the pylon boots and runs");

  const first = await runTool("msg:node-check-1", "uname -s; pwd; ls; echo kept-across-pause > /home/user/.node-check");
  assertIncludes(first, "Linux", "/home/user/workspace/repo", "README.md");
  pass("the agent runs bash in the pylon: Linux, /home/user/workspace/repo, README.md");

  await expect(200, "POST", `/threads/${threadId}/archive`);
  await reaches("paused", 5 * 60_000);
  pass("archiving pauses the pylon");

  await expect(200, "POST", `/threads/${threadId}/unarchive`);
  await reaches("running", 5 * 60_000);
  pass("unarchiving wakes the pylon");

  const second = await runTool("msg:node-check-2", "cat /home/user/.node-check");
  assertIncludes(second, "kept-across-pause");
  pass("after the wake the agent runs a second tool, and the pylon kept its disk");

  await expect(200, "DELETE", `/threads/${threadId}`);
  deleted = true;
  const instance = join(probeConfig.backend.stateRoot, "instances", thread.pylonId);
  await reaches("absent", 5 * 60_000);
  await until(`${instance} is gone`, 60_000, () => stat(instance).then(() => undefined, (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return true;
    throw err;
  }));
  pass(`deleting the thread removes ${instance}`);
  verdict = "PASS";
} catch (err) {
  console.error(`FAIL ${(err as Error).message}`);
} finally {
  if (threadId !== undefined && !deleted) {
    await call("DELETE", `/threads/${threadId}`).then(() => reaches("absent", 5 * 60_000)).catch((err: unknown) => {
      console.error(`cleanup: could not delete ${threadId}: ${(err as Error).message}. Delete pylon-${threadId} on the probe by hand`);
    });
  }
  await controlPlane.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`${verdict} thread-on-node`);
process.exit(verdict === "PASS" ? 0 : 1);
