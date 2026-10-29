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
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatus, PylonId } from "../protocol.ts";
import { readRoutes } from "../probe/serve.ts";
import { defaultPreviewPorts } from "./main.ts";
import { apiClient, openNodeCheck, passLogger, until } from "./on-node-kit.ts";
import { openRegistry } from "./registry.ts";

const { probeConfig, stateRoot, previews, host, serveJson, refuseServedPorts, planeConfig, startPlane } = await openNodeCheck({ image: process.argv[3], opens: "previews", resolvesToProbe: true });

const routes = () => readRoutes(previews.routesFile);
const serveBefore = await serveJson();
const routesBefore = await routes();
console.log(`tailscale serve status before: ${serveBefore.trim()}`);
console.log(`route table before: ${JSON.stringify([...routesBefore])}`);
await refuseServedPorts(defaultPreviewPorts, { exceptGateway: true });

/** One control plane over the registry in `dir`, which it creates on first use. */
async function plane(dir: string) {
  const controlPlane = await startPlane(planeConfig(dir));
  const api = apiClient(host, () => controlPlane.port);
  const { call, expect, detail, runTool } = api;
  const reaches = (threadId: string, state: string, timeoutMs: number) => api.reaches(threadId, state, timeoutMs, `${threadId}'s pylon`);

  /** A thread whose pylon runs and publishes a preview of web, and that preview's port once it is ready. */
  async function threadWithPreview(title: string): Promise<{ threadId: string; pylonId: PylonId; httpsPort: number }> {
    if (!(await expect(200, "GET", "/projects") as { id: string }[]).some((p) => p.id === "drift-check")) {
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

const pass = passLogger();

/** The latest job each registry recorded for the pylon. */
function lastJob(dir: string, pylonId: PylonId): JobStatus | undefined {
  const registry = openRegistry(join(dir, "registry.db"));
  try {
    return registry.job(pylonId);
  } finally {
    registry.close();
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
