/**
 * Node validation for one thread end to end, run by hand on a home-lab node as the probe's user:
 *   node src/control/thread-on-node.ts [probe.json] [imageId] [holdSeconds]
 *
 * It starts a control plane in this process (registry, loop, harness and API, as src/control/main.ts wires
 * them) over a temporary directory. Its harness uses the scripted model from src/harness/test-fixture.ts, so
 * no model login is needed. It drives the node's running probe only through the control plane's HTTP API:
 * start a thread, run a tool in its pylon, have the agent declare a service with a preview, fetch the preview's
 * https URL from this node, archive the thread so the pylon pauses, unarchive it so the pylon wakes, runs a second
 * tool and serves the preview on the same URL, then delete it. A second thread, on a repository that does not exist,
 * fails setup, which removes its instance, and a human retry boots it fresh and runs a second setup job, which fails again. The probe's auth.controlPlane must be this node's own
 * stable node ID, and its config must set `previews`. With holdSeconds it prints the preview URL and holds that long,
 * so another tailnet device can open it. Deleting the thread must leave `tailscale serve` as the check found it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { artifactDirectory, tarCodec } from "../artifacts.ts";
import { isImageId, probePort, type JobStatus } from "../protocol.ts";
import { scriptedModel, scriptedModels } from "../harness/test-fixture.ts";
import { parseSelfDnsName, readProbeConfig } from "../probe/config.ts";
import { tailscaleCli } from "../probe/serve.ts";
import type { ThreadDetail } from "./api.ts";
import { defaultPreviewPorts, startControlPlane, type ControlPlaneConfig } from "./main.ts";

const probeConfig = await readProbeConfig(process.argv[2] ?? "/etc/nexus/probe.json");
if (probeConfig.backend.kind !== "pylon-vm") throw new Error(`the probe runs the ${probeConfig.backend.kind} backend. This check is for pylon-vm`);
const { stateRoot } = probeConfig.backend;
const store = artifactDirectory(probeConfig.backend.artifacts, tarCodec);
const images = (await store.list()).filter(isImageId);
const image = process.argv[3] ?? (images.length === 1 ? images[0] : undefined);
if (!isImageId(image) || !images.includes(image)) throw new Error(`name one of the images in ${store.root}: ${images.join(", ")}`);
if (probeConfig.listen.port !== probePort) throw new Error(`the probe listens on port ${probeConfig.listen.port}, and the control plane reaches probes on ${probePort} only`);
if (probeConfig.previews === undefined) throw new Error("set previews in the probe's config, then restart the probe. This check opens a preview");
const holdMs = Number(process.argv[4] ?? 0) * 1000;
const tailscale = tailscaleCli();
const statusJson = await tailscale(["status", "--json"], AbortSignal.timeout(30_000));
const self = z.object({ Self: z.object({ ID: z.string() }) }).parse(JSON.parse(statusJson)).Self.ID;
// Preview URLs name the node by its MagicDNS name, because that is the name its tailscale serve certificate is for.
const dnsName = parseSelfDnsName(statusJson);
if (probeConfig.auth.controlPlane !== self) throw new Error(`set auth.controlPlane in the probe's config to this node's ID ${self} (it is ${probeConfig.auth.controlPlane}), then restart the probe`);
const manifest = await store.manifest(image);

const host = probeConfig.listen.host;
const resolved = (await lookup(dnsName, { all: true })).map((a) => a.address);
if (!resolved.includes(host)) throw new Error(`${dnsName} resolves to ${resolved.join(", ")}, not to the probe's address ${host}`);
const serveStatus = async () => JSON.parse(await tailscale(["serve", "status", "--json"], AbortSignal.timeout(30_000))) as unknown;
const serveBefore = await serveStatus();
console.log(`tailscale serve status before: ${JSON.stringify(serveBefore)}`);
// The check's registry is new, so its one preview gets the first port. Taking over an entry there would break whatever owns it.
const firstPort = String(defaultPreviewPorts.first);
if (Object.keys((serveBefore as { TCP?: Record<string, unknown> }).TCP ?? {}).includes(firstPort)) throw new Error(`tailscale serve already serves port ${firstPort}, which this check's preview would get. Free it first`);
const dir = await mkdtemp(join(tmpdir(), "nexus-thread-on-node-"));
const config: ControlPlaneConfig = {
  db: join(dir, "registry.db"),
  listen: { host, port: 0, hostnames: [host] },
  self: { tailnetNodeId: self },
  nodes: [{ name: probeConfig.node, tailnetHost: dnsName, tailnetNodeId: self }],
  callers: [],
  dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
  harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "unused-credentials.json"), model: scriptedModel },
  previewPorts: defaultPreviewPorts,
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
/** The planner deletes a failed pylon all the same, so a deleted thread's wait ignores an earlier failure. */
const reaches = (state: string, timeoutMs: number) => until(`the pylon is ${state}`, timeoutMs, async () => {
  const d = await detail();
  if (d.pylon.failed !== null && d.thread.status !== "deleted") throw new Error(`the planner gave up on the pylon: ${d.pylon.failed}`);
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

/** The dashboard's thread page, which the API serves outside /v1 under the same host check. */
function threadPage(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port: controlPlane.port, method: "GET", path: `/threads/${threadId}`, headers: { host: `${host}:${controlPlane.port}` } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => res.statusCode === 200 ? resolve(text) : reject(new Error(`GET /threads/${threadId}: HTTP ${res.statusCode}: ${text}`)));
    });
    req.on("error", reject);
    req.end();
  });
}
function conversationSection(html: string): string {
  const conversation = html.split('id="convo"')[1]?.split('<div class="dock">')[0];
  if (conversation === undefined) throw new Error(`the thread page has no conversation: ${html}`);
  return conversation;
}

function assertIncludes(text: string, ...parts: string[]) {
  for (const part of parts) if (!text.includes(part)) throw new Error(`the tool result lacks ${part}: ${text}`);
}

/** A service the agent declares in .nexus/services.yaml. It answers with a token and the PUBLIC_URL it was given. */
function declarePreview(token: string): string {
  return `mkdir -p .nexus && cat > .nexus/services.yaml <<'YAML'
services:
  web:
    command: python3 -u .nexus/preview-check.py
    preview: true
    health: /
YAML
cat > .nexus/preview-check.py <<'PY'
import http.server, json, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"token": "${token}", "publicUrl": os.environ.get("PUBLIC_URL")}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
http.server.ThreadingHTTPServer(("", int(os.environ["PORT"])), H).serve_forever()
PY
nexus services ensure --json`;
}

/** Waits for the thread's preview of web to be ready, then fetches its URL from this node until the service answers. */
async function openPreview(token: string): Promise<{ url: string; httpsPort: number }> {
  const preview = await until("the preview of web is ready", 3 * 60_000, async () => (await detail()).previews.find((p) => p.service === "web" && p.ready));
  const url = `https://${dnsName}:${preview.httpsPort}/`;
  let last = "no answer yet";
  const body = await until(`${url} answers with the check service`, 2 * 60_000, async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      last = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      // Until the port is assigned the service runs without PUBLIC_URL, and the assignment restarts it.
      const json = res.status === 200 && text.includes(token) ? JSON.parse(text) as { publicUrl: unknown } : undefined;
      return json?.publicUrl === null ? undefined : json;
    } catch (err) {
      last = (err as Error).message;
      return undefined;
    }
  }).catch((err: Error) => { throw new Error(`${err.message}. Last answer: ${last}`); });
  assert.deepEqual(body, { token, publicUrl: url.slice(0, -1) }, "the service answers on its preview URL and knows that URL as PUBLIC_URL");
  return { url, httpsPort: preview.httpsPort };
}

/** Deletes the thread, then waits for its pylon to be absent and its instance directory to be gone. Returns that directory. */
async function deleteThread(pylonId: string): Promise<string> {
  await expect(200, "DELETE", `/threads/${threadId}`);
  deleted = true;
  const instance = join(stateRoot, "instances", pylonId);
  await reaches("absent", 5 * 60_000);
  await until(`${instance} is gone`, 60_000, () => stat(instance).then(() => undefined, (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return true;
    throw err;
  }));
  return instance;
}

/** The registry row's planner state and the last job the probe reported for the pylon, which ThreadDetail does not carry. */
function plannerState(pylonId: string) {
  const db = new DatabaseSync(config.db, { readOnly: true });
  try {
    const pylon = db.prepare("SELECT failed, attempts, retrying FROM pylons WHERE id = ?").get(pylonId) as { failed: string | null; attempts: string; retrying: number };
    const job = db.prepare("SELECT status FROM jobs WHERE subject = ?").get(pylonId) as { status: string } | undefined;
    return {
      failed: pylon.failed,
      attempts: JSON.parse(pylon.attempts) as { count: number; last: { at: number; code: string } | null },
      retrying: pylon.retrying === 1,
      job: job === undefined ? null : JSON.parse(job.status) as JobStatus,
    };
  } finally {
    db.close();
  }
}

/** Whether the path exists, for an instance directory the backend should have removed. */
const exists = (path: string) => stat(path).then(() => true, (err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT") return false;
  throw err;
});

/**
 * A project whose repository does not exist fails its fresh pylon's setup, which the planner does not retry. The
 * node removes the instance, because it holds no work. A human retry must make the planner boot the pylon fresh and
 * run a second setup job, which fails the same way.
 */
async function checkFailedSetupRetry() {
  const repo = `https://github.com/ramtinJ95/nexus-missing-${randomBytes(6).toString("hex")}.git`;
  await expect(201, "POST", "/projects", {
    id: "node-check-missing", repoUrl: repo, defaultBranch: "main", defaultNode: probeConfig.node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  const thread = await expect(201, "POST", "/threads", { project: "node-check-missing", title: "missing repo" });
  threadId = thread.id;
  deleted = false;
  const instance = join(stateRoot, "instances", thread.pylonId);
  pass(`start thread ${threadId} on ${repo}, which does not exist`);
  // While the first boot is on its way, so nothing can have failed yet.
  const early = await call("POST", `/threads/${threadId}/pylon/retry`);
  assert.equal(early.status, 409, `a retry before the pylon failed: ${JSON.stringify(early.body)}`);
  pass("a retry of a pylon that has not failed is refused with 409");

  const first = await until("the planner gives up on the pylon", 10 * 60_000, async () => {
    const state = plannerState(thread.pylonId);
    return state.failed !== null ? state : undefined;
  });
  assert.ok(first.job?.kind === "spawn" && first.job.state === "failed" && first.job.code === "setup-failed", `the first spawn fails setup: ${JSON.stringify(first.job)}`);
  assert.equal(first.attempts.count, 1);
  assert.match(first.failed!, /had no checkpoint, so it was removed, and a retry boots the pylon fresh/);
  assert.equal(await exists(instance), false, `${instance} was removed`);
  assert.equal((await detail()).pylon.actualState, "failed");
  pass(`the planner gives up after spawn ${first.job.jobId} fails setup, and the node removed ${instance}: ${first.failed!.split("\n")[0]}`);

  const page = await threadPage();
  assertIncludes(page, `<button type="button" class="btn" id="retry-pylon" data-action="retry-pylon" data-thread="${threadId}">Retry</button>`, "Start again</button>", "fatal:");
  pass("the thread page shows the setup output, and offers Retry next to Start again");

  await expect(204, "POST", `/threads/${threadId}/pylon/retry`);
  const cleared = plannerState(thread.pylonId);
  assert.deepEqual([cleared.failed, cleared.attempts, cleared.retrying], [null, { count: 0, last: null }, true], "the retry clears the verdict and the attempts");
  const again = await call("POST", `/threads/${threadId}/pylon/retry`);
  assert.equal(again.status, 409, `a retry of a pylon that has not failed since: ${JSON.stringify(again.body)}`);
  pass("the retry clears the verdict and the attempts, and a second retry before a new failure is refused with 409");

  const states = new Set<string>();
  const second = await until("the planner gives up after a second setup job", 10 * 60_000, async () => {
    states.add((await detail()).pylon.actualState);
    const state = plannerState(thread.pylonId);
    return state.failed !== null ? state : undefined;
  });
  assert.ok(states.has("spawning"), `the pylon spawned again after the retry: it was ${[...states].join(", ")}`);
  assert.ok(second.job?.kind === "spawn" && second.job.jobId !== first.job.jobId, `a second spawn ran: ${JSON.stringify(second.job)}`);
  assert.ok(second.job.state === "failed" && second.job.code === "setup-failed", `the second spawn fails setup: ${JSON.stringify(second.job)}`);
  assert.equal(second.attempts.count, 1, "the attempts climb again from 0");
  assert.ok(second.attempts.last!.at > first.attempts.last!.at, "the verdict is the second job's");
  assert.match(second.failed!, /^last job failed with setup-failed/);
  assert.equal(second.retrying, false);
  pass(`after the retry the pylon was ${[...states].join(", then ")}, and spawn ${second.job.jobId} failed setup again: ${second.failed!.split("\n")[0]}`);

  pass(`deleting the failed thread removes ${await deleteThread(thread.pylonId)}`);
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

  const conversation = conversationSection(await threadPage());
  const escapedCommand = "uname -s; pwd; ls; echo kept-across-pause &gt; /home/user/.node-check";
  const tool = conversation.split('<details class="tool')[1]?.split("</details>")[0];
  if (tool === undefined) throw new Error(`the conversation has no tool row: ${conversation}`);
  if (conversation.includes("kept-across-pause > ")) throw new Error(`the conversation shows the command unescaped: ${conversation}`);
  assertIncludes(conversation, `<div class="text">bash: ${escapedCommand}</div>`);
  assertIncludes(tool, '<span class="t-name">bash</span>', `<span class="t-subj">${escapedCommand}</span>`, '<pre class="t-out">', "Linux", "README.md");
  pass("the thread page renders the real conversation: the message, a bash row and its output, escaped");
  const token = `preview-check-${threadId}`;
  await runTool("msg:node-check-preview", declarePreview(token));
  const preview = await openPreview(token);
  pass(`the declared service is served at ${preview.url}, fetched from this node`);
  const info = await runTool("msg:node-check-info", `nexus info --json | python3 -c 'import json, sys; print("info", json.load(sys.stdin)["previews"])'; grep -F web: /home/user/.nexus/PYLON.md`);
  assertIncludes(info, `info [{'service': 'web', 'url': '${preview.url}'}]`, `- web: ${preview.url}`);
  pass("pylon.json and PYLON.md name the preview URL");
  if (holdMs > 0) {
    console.log(`OPEN ${preview.url} from another tailnet device. Holding ${holdMs / 1000} s`);
    await delay(holdMs);
  }

  await expect(200, "POST", `/threads/${threadId}/archive`);
  await reaches("paused", 5 * 60_000);
  pass("archiving pauses the pylon");

  const archivedPage = await threadPage();
  assertIncludes(archivedPage, 'data-action="unarchive"', "An archived thread takes no messages, because its pylon stays paused.");
  if (archivedPage.includes('<form id="prompt"')) throw new Error("the archived thread page still offers the prompt box");
  pass("the archived thread page offers Unarchive and says why it takes no messages");
  // An archived thread stays paused whatever the activity, so this visit cannot wake it.
  const asleep = await fetch(preview.url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(asleep.status, 503, `a paused pylon's preview answers with the waking page: ${await asleep.text()}`);
  assert.ok(Object.keys((await serveStatus() as { TCP?: Record<string, unknown> }).TCP ?? {}).includes(String(preview.httpsPort)), "tailscale serve keeps a paused pylon's preview");
  pass(`while paused, ${preview.url} answers 503 with the waking page`);

  await expect(200, "POST", `/threads/${threadId}/unarchive`);
  await reaches("running", 5 * 60_000);
  pass("unarchiving wakes the pylon");

  const second = await runTool("msg:node-check-2", "cat /home/user/.node-check");
  assertIncludes(second, "kept-across-pause");
  pass("after the wake the agent runs a second tool, and the pylon kept its disk");

  const woken = await openPreview(token);
  assert.equal(woken.url, preview.url, "the preview keeps its URL across the pause");
  pass(`after the wake the service is served again at ${woken.url}`);

  pass(`deleting the thread removes ${await deleteThread(thread.pylonId)}`);

  const serveAfter = await serveStatus();
  console.log(`tailscale serve status after: ${JSON.stringify(serveAfter)}`);
  assert.deepEqual(serveAfter, serveBefore, "deleting the thread leaves tailscale serve as the check found it");
  await until("the deleted thread's port is released", 30_000, async () => (await detail()).previews.length === 0 ? true : undefined);
  pass("tailscale serve is as the check found it, and the port is released");

  await checkFailedSetupRetry();
  verdict = "PASS";
} catch (err) {
  console.error(`FAIL ${(err as Error).message}`);
  if (threadId !== undefined) {
    await detail().then((d) => console.error(`pylon: ${JSON.stringify(d.pylon, null, 2)}`), (detailErr: unknown) => {
      console.error(`could not read the thread detail: ${(detailErr as Error).message}`);
    });
  }
} finally {
  if (threadId !== undefined && !deleted) {
    await call("DELETE", `/threads/${threadId}`).then(() => reaches("absent", 5 * 60_000)).catch((err: unknown) => {
      console.error(`cleanup: could not delete ${threadId}: ${(err as Error).message}. Delete pylon-${threadId} on the probe by hand`);
    });
    console.error(`tailscale serve status after cleanup: ${JSON.stringify(await serveStatus())}`);
  }
  await controlPlane.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`${verdict} thread-on-node`);
process.exit(verdict === "PASS" ? 0 : 1);
