/**
 * Node validation for a registry and a node that drift apart, run by hand on a home-lab node as the probe's user:
 *   node src/control/drift-on-node.ts [probe.json] [imageId]
 *
 * Like src/control/thread-on-node.ts, it runs control planes in this process over temporary registries, with the
 * scripted model, and drives the node's running probe through their HTTP API. Each preview needs a pylon booted
 * from the image, so the check takes several minutes.
 *
 * 1. Control plane A starts thread T1, publishes a preview of it on port P1, and archives it, so its pylon pauses
 *    and keeps the preview. A closes.
 * 2. Control plane B opens an empty registry, as if A's were wiped, so T1's pylon is an orphan to it. B starts T2
 *    with a preview. T2 must get a port the node does not route, and P1 must still route to T1. B deletes T2.
 * 3. A reopens its registry. The check removes T1's stopped instance directory by hand, so the probe reports T1's
 *    pylon absent while the node still serves P1. A deletes T1. A delete job must run for the absent pylon, and
 *    `tailscale serve` and the route table must end as the check found them.
 *
 * It refuses to run while anything but the probe's gateway serves a port in the preview range, because a pylon
 * given that port would fail to publish. It touches no pylon it did not start.
 */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { artifactDirectory, tarCodec } from "../artifacts.ts";
import { isImageId, probePort, type JobStatus, type PylonId } from "../protocol.ts";
import { scriptedModel, scriptedModels } from "../harness/test-fixture.ts";
import { parseSelfDnsName, readProbeConfig } from "../probe/config.ts";
import { parseServeStatus, readRoutes, tailscaleCli } from "../probe/serve.ts";
import type { ThreadDetail } from "./api.ts";
import { defaultPreviewPorts, startControlPlane, type ControlPlane } from "./main.ts";

const probeConfig = await readProbeConfig(process.argv[2] ?? "/etc/nexus/probe.json");
if (probeConfig.backend.kind !== "pylon-vm") throw new Error(`the probe runs the ${probeConfig.backend.kind} backend. This check is for pylon-vm`);
const { stateRoot } = probeConfig.backend;
const store = artifactDirectory(probeConfig.backend.artifacts, tarCodec);
const images = (await store.list()).filter(isImageId);
const image = process.argv[3] ?? (images.length === 1 ? images[0] : undefined);
if (!isImageId(image) || !images.includes(image)) throw new Error(`name one of the images in ${store.root}: ${images.join(", ")}`);
if (probeConfig.listen.port !== probePort) throw new Error(`the probe listens on port ${probeConfig.listen.port}, and the control plane reaches probes on ${probePort} only`);
const previews = probeConfig.previews;
if (previews === undefined) throw new Error("set previews in the probe's config, then restart the probe. This check opens previews");
const tailscale = tailscaleCli();
const statusJson = await tailscale(["status", "--json"], AbortSignal.timeout(30_000));
const self = z.object({ Self: z.object({ ID: z.string() }) }).parse(JSON.parse(statusJson)).Self.ID;
const dnsName = parseSelfDnsName(statusJson);
if (probeConfig.auth.controlPlane !== self) throw new Error(`set auth.controlPlane in the probe's config to this node's ID ${self} (it is ${probeConfig.auth.controlPlane}), then restart the probe`);
const manifest = await store.manifest(image);
const host = probeConfig.listen.host;
const resolved = (await lookup(dnsName, { all: true })).map((a) => a.address);
if (!resolved.includes(host)) throw new Error(`${dnsName} resolves to ${resolved.join(", ")}, not to the probe's address ${host}`);

const serveJson = () => tailscale(["serve", "status", "--json"], AbortSignal.timeout(30_000));
const routes = () => readRoutes(previews.routesFile);
const serveBefore = await serveJson();
const routesBefore = await routes();
console.log(`tailscale serve status before: ${serveBefore.trim()}`);
console.log(`route table before: ${JSON.stringify([...routesBefore])}`);
for (const [port, listener] of parseServeStatus(serveBefore, `http://127.0.0.1:${previews.gatewayPort}`)) {
  if (listener.kind === "other" && port >= defaultPreviewPorts.first && port <= defaultPreviewPorts.last) {
    throw new Error(`tailscale serve serves port ${port} with something other than the probe's gateway. Free it first`);
  }
}

/** One control plane over the registry in `dir`, which it creates on first use. */
async function plane(dir: string) {
  const controlPlane: ControlPlane = await startControlPlane({
    db: join(dir, "registry.db"),
    listen: { host, port: 0, hostnames: [host] },
    self: { tailnetNodeId: self },
    nodes: [{ name: probeConfig.node, tailnetHost: dnsName, tailnetNodeId: self }],
    callers: [],
    dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
    harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "unused-credentials.json"), model: scriptedModel },
    previewPorts: defaultPreviewPorts,
    resumeAfterUsageLimit: false,
  }, scriptedModels());

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
  const detail = async (threadId: string) => await expect(200, "GET", `/threads/${threadId}`) as ThreadDetail;
  const reaches = (threadId: string, state: string, timeoutMs: number) => until(`${threadId}'s pylon is ${state}`, timeoutMs, async () => {
    const d = await detail(threadId);
    if (d.pylon.failed !== null && d.thread.status !== "deleted") throw new Error(`the planner gave up on the pylon: ${d.pylon.failed}`);
    return d.pylon.actualState === state ? d : undefined;
  });

  /** Sends `bash: <command>`, which the scripted model turns into one bash call, and waits for the run to end. */
  async function runTool(threadId: string, requestId: string, command: string) {
    const results = async () => ((await expect(200, "GET", `/threads/${threadId}/conversation`)) as { entries: { kind: string }[] }).entries.filter((e) => e.kind === "pi.tool-result");
    const seen = (await results()).length;
    await expect(202, "POST", `/threads/${threadId}/messages`, { text: `bash: ${command}`, requestId });
    await until("the tool result is in the conversation", 6 * 60_000, async () => (await results())[seen]);
    await until("the run ends", 60_000, async () => (await detail(threadId)).thread.agentTurnRunning ? undefined : true);
  }

  /** A thread whose pylon runs and publishes a preview of web, and that preview's port once it is ready. */
  async function threadWithPreview(title: string): Promise<{ threadId: string; pylonId: PylonId; httpsPort: number }> {
    if (!(await expect(200, "GET", "/projects") as { id: string }[]).some((p) => p.id === "drift-check")) {
      await expect(201, "POST", "/images", manifest);
      await expect(204, "PUT", "/images/current", { image });
      await expect(201, "POST", "/projects", {
        id: "drift-check", repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: probeConfig.node,
        resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
      });
    }
    const thread = await expect(201, "POST", "/threads", { project: "drift-check", title });
    started.push({ threadId: thread.id, pylonId: thread.pylonId, dir });
    await reaches(thread.id, "running", 10 * 60_000);
    await runTool(thread.id, `msg:${title}-preview`, declarePreview);
    const preview = await until(`${thread.id}'s preview of web is ready`, 3 * 60_000, async () => (await detail(thread.id)).previews.find((p) => p.service === "web" && p.ready));
    return { threadId: thread.id, pylonId: thread.pylonId, httpsPort: preview.httpsPort };
  }

  /** Deletes the thread, if it is not deleted yet, and waits until the node has neither its pylon nor a route to it. */
  async function remove(threadId: string) {
    const res = await call("DELETE", `/threads/${threadId}`);
    if (res.status !== 200 && res.status !== 409) throw new Error(`DELETE /threads/${threadId}: HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    const s = started.find((s) => s.threadId === threadId)!;
    await reaches(threadId, "absent", 5 * 60_000);
    await until(`no port routes to ${s.pylonId}`, 2 * 60_000, async () => [...(await routes()).values()].some((r) => r.pylonId === s.pylonId) ? undefined : true);
    s.gone = true;
  }

  return { controlPlane, expect, detail, reaches, threadWithPreview, remove, close: () => controlPlane.close() };
}

const declarePreview = `mkdir -p .nexus && cat > .nexus/services.yaml <<'YAML'
services:
  web:
    command: python3 -u .nexus/drift-check.py
    preview: true
    health: /
YAML
cat > .nexus/drift-check.py <<'PY'
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()
http.server.ThreadingHTTPServer(("", int(os.environ["PORT"])), H).serve_forever()
PY`;

async function until<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting until ${what}`);
    await delay(1_000);
  }
}

const startedAt = performance.now();
function pass(step: string) {
  console.log(`PASS ${step} (${Math.round((performance.now() - startedAt) / 1000)} s)`);
}

/** The latest job each registry recorded for the pylon. */
function lastJob(dir: string, pylonId: PylonId): JobStatus | undefined {
  const db = new DatabaseSync(join(dir, "registry.db"));
  try {
    const row = db.prepare("SELECT status FROM jobs WHERE subject = ?").get(pylonId) as { status: string } | undefined;
    return row && JSON.parse(row.status) as JobStatus;
  } finally {
    db.close();
  }
}

const dirA = await mkdtemp(join(tmpdir(), "nexus-drift-a-"));
const dirB = await mkdtemp(join(tmpdir(), "nexus-drift-b-"));
/** Every thread the check started, and whether the node is rid of its pylon. A registry is kept until all of its threads are gone. */
const started: { threadId: string; pylonId: PylonId; dir: string; gone?: true }[] = [];
/** The control plane running now. One at a time, as a registry that replaces a wiped one would run. */
const current: { plane: Awaited<ReturnType<typeof plane>> | null; dir: string | null } = { plane: null, dir: null };
async function reopen(dir: string) {
  await current.plane?.close();
  current.plane = null;
  current.plane = await plane(dir);
  current.dir = dir;
  return current.plane;
}

let verdict = "FAIL";
try {
  let a = await reopen(dirA);
  const t1 = await a.threadWithPreview("drift-t1");
  assert.ok(!routesBefore.has(t1.httpsPort), `T1 got port ${t1.httpsPort}, which the node already routed`);
  assert.deepEqual((await routes()).get(t1.httpsPort), { pylonId: t1.pylonId, service: "web" });
  await a.expect(200, "POST", `/threads/${t1.threadId}/archive`);
  await a.reaches(t1.threadId, "paused", 5 * 60_000);
  assert.deepEqual((await routes()).get(t1.httpsPort), { pylonId: t1.pylonId, service: "web" }, "a paused pylon keeps its route");
  pass(`T1 ${t1.threadId} published port ${t1.httpsPort} and paused, keeping it`);

  const b = await reopen(dirB);
  const routedBeforeT2 = new Set((await routes()).keys());
  const t2 = await b.threadWithPreview("drift-t2");
  assert.ok(!routedBeforeT2.has(t2.httpsPort), `T2 got port ${t2.httpsPort}, which the node already routed: ${[...routedBeforeT2].join(", ")}`);
  assert.deepEqual((await routes()).get(t1.httpsPort), { pylonId: t1.pylonId, service: "web" }, "the orphan's route is left alone");
  pass(`with an empty registry T2 ${t2.threadId} got port ${t2.httpsPort}, and T1's port ${t1.httpsPort} still routes to T1`);
  await b.remove(t2.threadId);
  assert.deepEqual((await routes()).get(t1.httpsPort), { pylonId: t1.pylonId, service: "web" }, "deleting T2 leaves the orphan's route");
  pass(`deleting T2 unpublished port ${t2.httpsPort} and left T1's`);

  a = await reopen(dirA);
  await a.reaches(t1.threadId, "paused", 60_000);
  const instance = join(stateRoot, "instances", t1.pylonId);
  await stat(instance);
  await rm(instance, { recursive: true });
  console.log(`removed ${instance} by hand`);
  await a.reaches(t1.threadId, "absent", 2 * 60_000);
  assert.deepEqual((await routes()).get(t1.httpsPort), { pylonId: t1.pylonId, service: "web" }, "the node still routes the absent pylon's port");
  assert.deepEqual((await a.detail(t1.threadId)).previews.map((p) => p.httpsPort), [t1.httpsPort]);
  pass(`T1's pylon is absent while the node still routes port ${t1.httpsPort}`);

  await a.remove(t1.threadId);
  await until("the deleted thread's port is released", 60_000, async () => (await a.detail(t1.threadId)).previews.length === 0 ? true : undefined);
  const job = lastJob(dirA, t1.pylonId);
  assert.ok(job?.kind === "delete" && job.state === "succeeded", `the last job for ${t1.pylonId} is a succeeded delete: ${JSON.stringify(job)}`);
  pass(`deleting T1 sent a delete for the absent pylon, which unpublished port ${t1.httpsPort}, and the port was released`);

  const serveAfter = await serveJson();
  console.log(`tailscale serve status after: ${serveAfter.trim()}`);
  assert.deepEqual(JSON.parse(serveAfter), JSON.parse(serveBefore), "tailscale serve is as the check found it");
  assert.deepEqual(await routes(), routesBefore, "the route table is as the check found it");
  pass("tailscale serve and the route table are as the check found them");
  verdict = "PASS";
} catch (err) {
  console.error(`FAIL ${(err as Error).message}`);
} finally {
  for (const s of started.filter((s) => s.gone === undefined)) {
    try {
      const p = current.dir === s.dir && current.plane !== null ? current.plane : await reopen(s.dir);
      await p.remove(s.threadId);
    } catch (err) {
      console.error(`cleanup: could not delete ${s.threadId}: ${(err as Error).message}. Delete pylon-${s.threadId} on the probe by hand`);
    }
  }
  await current.plane?.close();
  console.log(`tailscale serve status at exit: ${(await serveJson()).trim()}`);
  for (const dir of [dirA, dirB]) {
    if (started.some((s) => s.dir === dir && s.gone === undefined)) console.error(`kept ${dir}, whose registry still holds a pylon the node may have`);
    else await rm(dir, { recursive: true, force: true });
  }
}
console.log(`${verdict} drift-on-node`);
process.exit(verdict === "PASS" ? 0 : 1);
