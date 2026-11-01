/**
 * Node validation for one thread end to end, run by hand on a home-lab node as the probe's user:
 *   node src/control/thread-on-node.ts [probe.json] [imageId] [holdSeconds]
 *
 * It starts a control plane in this process (registry, loop, harness and API, as src/control/main.ts wires
 * them) over a temporary directory. Its harness uses the scripted model from src/harness/test-fixture.ts, so
 * no model login is needed. It drives the node's running probe only through the control plane's HTTP API:
 * add the thread's project with the real CLI's `nexus project add`, start a thread, run a tool in its pylon, follow a streamed answer with the real CLI's `nexus watch --json` and keep that
 * watch open past the CLI's idle timeout, have the agent declare a service with a preview, fetch the preview's
 * https URL from this node, have the agent start an unsupervised server that the thread's ports list, link that port
 * as a human would and fetch its preview, archive the thread so the pylon pauses, unarchive it so the pylon wakes,
 * runs a second tool and serves both previews on the same URLs once the agent starts the server again, unpublish the
 * linked port with the real CLI and check it stays unpublished across a second pause and wake and a restart of this
 * control plane, publish it again, then delete it. A second thread, on a repository that does not exist,
 * fails setup, which removes its instance, and a human retry boots it fresh and runs a second setup job, which fails again. The node's control-plane.json must name this node's own
 * stable node ID, and the probe's config must set `previews`. With holdSeconds it prints the preview URL and holds that long,
 * so another tailnet device can open it. Deleting the thread must leave `tailscale serve` as the check found it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { PylonId } from "../ids.ts";
import { scriptedModels, streamedAnswer, streamedWordMs } from "../harness/test-fixture.ts";
import { callText } from "../test-kit.ts";
import type { ThreadDetail, ThreadRow } from "./wire.ts";
import { defaultPreviewPorts, startControlPlane } from "./main.ts";
import { apiClient, fetchUntil, openNodeCheck, passLogger, until } from "./on-node-kit.ts";
import { openRegistry } from "./registry.ts";

const { probeConfig, stateRoot, image, dnsName, host, serveStatus, refuseServedPorts, planeConfig, startPlane } = await openNodeCheck({ image: process.argv[3], opens: "a preview", resolvesToProbe: true });
const holdMs = Number(process.argv[4] ?? 0) * 1000;
const serveBefore = await serveStatus();
console.log(`tailscale serve status before: ${JSON.stringify(serveBefore)}`);
// The check's registry is new, so its one preview gets the first port.
await refuseServedPorts({ first: defaultPreviewPorts.first, last: defaultPreviewPorts.first });
const dir = await mkdtemp(join(tmpdir(), "nexus-thread-on-node-"));
const config = planeConfig(dir);
let controlPlane = await startPlane(config);
const api = apiClient(host, () => controlPlane.port);
const { call, expect } = api;
const pass = passLogger();

let threadId: string | undefined;
let deleted = false;
const detail = () => api.detail(threadId!);
const reaches = (state: string, timeoutMs: number) => api.reaches(threadId!, state, timeoutMs);
const runTool = (requestId: string, command: string) => api.runTool(threadId!, requestId, command);

/** The dashboard's thread page, which the API serves outside /v1 under the same host check. */
async function threadPage(): Promise<string> {
  const { status, text } = await callText({ host, port: controlPlane.port, method: "GET", path: `/threads/${threadId}` });
  if (status !== 200) throw new Error(`GET /threads/${threadId}: HTTP ${status}: ${text}`);
  return text;
}
function conversationSection(html: string): string {
  const conversation = html.split('id="convo"')[1]?.split('<div class="dock">')[0];
  if (conversation === undefined) throw new Error(`the thread page has no conversation: ${html}`);
  return conversation;
}

/**
 * Follows the thread with the real CLI's watch over the control plane's tailnet address, as the Claude mod and the
 * pi extension do, and asks for an answer that streams for `seconds`. It must reach the watch as several live events
 * a second. The watch then stays open, quiet, past the CLI's 30 s idle timeout, which the API's ping must hold off.
 */
const cli = fileURLToPath(new URL("../cli/nexus.ts", import.meta.url));

/** Runs the real CLI against this check's control plane, directly on the tailnet. */
const nexus = (...args: string[]) => api.runCli(args);

async function checkStreamedAnswer(seconds: number, quietMs: number) {
  const words = Math.round((seconds * 1000) / streamedWordMs);
  const watch = spawn(process.execPath, [cli, "watch", threadId!, "--json", "--url", `http://${host}:${controlPlane.port}`, "--socks", "none"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  watch.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => watch.on("exit", resolve));
  const lines: { at: number; event: any }[] = [];
  createInterface({ input: watch.stdout }).on("line", (line) => lines.push({ at: performance.now(), event: JSON.parse(line) }));
  let code: number | null;
  try {
    await until("the watch prints its first live event", 30_000, async () => lines.some((l) => l.event.type === "live") || undefined);
    const sent = performance.now();
    await expect(202, "POST", `/threads/${threadId}/messages`, { text: `stream: ${words}`, requestId: "msg:node-check-stream" });
    const entry = await until("the streamed answer's entry is printed", seconds * 1000 + 60_000, async () => lines.find((l) => l.event.type === "entry" && l.event.entry.kind === "pi.assistant"));
    const cleared = await until("the live event that drops the partial is printed", 30_000, async () => lines.find((l) => l.at >= entry.at && l.event.type === "live" && l.event.partial === null));
    assert.equal(entry.event.text, streamedAnswer(words), "the entry holds the whole answer");
    assert.ok(lines.indexOf(entry) < lines.indexOf(cleared), "the answer's entry comes before the live event that drops its partial");
    const lives = lines.filter((l) => l.event.type === "live" && l.event.partial !== null);
    for (const [i, l] of lives.entries()) assert.ok(streamedAnswer(words).startsWith(l.event.partial) && l.event.partial.length > (lives[i - 1]?.event.partial.length ?? 0), "each partial is a longer prefix of the answer");
    const span = (lives.at(-1)!.at - lives[0]!.at) / 1000;
    const gaps = lives.slice(1).map((l, i) => l.at - lives[i]!.at);
    const rate = (lives.length - 1) / span;
    const median = Math.round(gaps.toSorted((a, b) => a - b)[gaps.length >> 1]!);
    const first = Math.round(lives[0]!.at - sent);
    // An answer held back until it ends would also come as many close events, all at its end.
    assert.ok(first < 2000, `the first partial comes soon after the send: ${first} ms`);
    assert.ok(span >= 0.8 * seconds, `the partials span most of the answer's ${seconds} s: ${span.toFixed(1)} s`);
    assert.ok(rate >= 3, `several live events a second: ${rate.toFixed(1)}`);
    assert.ok(Math.max(...gaps) < 1000, `no gap of a poll's length: ${Math.round(Math.max(...gaps))} ms`);
    pass(`the watch printed the answer of ${words} words as ${lives.length} live events over ${span.toFixed(1)} s from ${first} ms after the send, ${rate.toFixed(1)} a second, gaps median ${median} ms and max ${Math.round(Math.max(...gaps))} ms, then its entry`);

    const quiet = lines.length;
    const held = await Promise.race([delay(quietMs, true), exited.then(() => false)]);
    assert.ok(held, `the watch exited while quiet: ${stderr}`);
    const errors = lines.slice(quiet).filter((l) => l.event.type === "error");
    assert.deepEqual(errors, [], "a quiet watch keeps its stream");
    pass(`the quiet watch stayed open ${quietMs / 1000} s with no error, past the CLI's 30 s idle timeout`);
  } finally {
    watch.kill("SIGTERM");
    code = await exited;
  }
  assert.equal(code, 0, `the watch exits 0 at SIGTERM: ${stderr}`);
}

function assertIncludes(text: string, ...parts: string[]) {
  for (const part of parts) if (!text.includes(part)) throw new Error(`the tool result lacks ${part}: ${text}`);
}

/**
 * Services the agent declares in .nexus/services.yaml, which Nexus starts with no command: web, which answers with a
 * token and the PUBLIC_URL it was given, and worker, which has no preview.
 */
function declarePreview(token: string): string {
  return `mkdir -p .nexus && cat > .nexus/services.yaml <<'YAML'
services:
  web:
    command: python3 -u .nexus/preview-check.py
    preview: true
    health: /
  worker:
    command: python3 -u -m http.server ${workerPort} --directory .nexus
    port: ${workerPort}
YAML
cat > .nexus/preview-check.py <<'PY'
import http.server, json, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"token": "${token}", "publicUrl": os.environ.get("PUBLIC_URL")}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
http.server.ThreadingHTTPServer(("", int(os.environ["PORT"])), H).serve_forever()
PY`;
}
const workerPort = 3458;

/** Waits for the thread's preview of web to be ready, then fetches its URL from this node until the service answers. */
async function openPreview(token: string): Promise<{ url: string; httpsPort: number }> {
  const preview = await until("the preview of web is ready", 3 * 60_000, async () => (await detail()).previews.find((p) => p.service === "web" && p.ready));
  const url = `https://${dnsName}:${preview.httpsPort}/`;
  const body = await fetchUntil(url, "with the check service", (status, text) => {
    // A service started before its port was assigned runs without PUBLIC_URL, and the assignment restarts it.
    const json = status === 200 && text.includes(token) ? JSON.parse(text) as { publicUrl: unknown } : undefined;
    return json?.publicUrl === null ? undefined : json;
  });
  assert.deepEqual(body, { token, publicUrl: url.slice(0, -1) }, "the service answers on its preview URL and knows that URL as PUBLIC_URL");
  return { url, httpsPort: preview.httpsPort };
}

const linkedPort = 3456;
/** Unique to this run, so an answer holding it came from the server this check started, whatever the repo holds. */
const marker = `nexus-proof-${randomBytes(6).toString("hex")}`;
/**
 * Serves a directory that holds only the marker file, written again at each start because /tmp may not outlive
 * a pause. Detached, because the agent's bash call ends before the server does.
 */
const startServer = `mkdir -p /tmp/node-check-http && echo ${marker} > /tmp/node-check-http/nexus-proof.txt && cd /tmp/node-check-http && setsid nohup python3 -m http.server ${linkedPort} </dev/null >/tmp/node-check-http.log 2>&1 & sleep 1; echo started`;

/** Fetches the marker through a linked port's preview URL from this node until the server answers with it. */
async function fetchMarker(url: string): Promise<void> {
  await fetchUntil(new URL("nexus-proof.txt", url).href, "with the marker", (status, text) => status === 200 && text.trim() === marker ? true : undefined);
}

/**
 * One GET over a new connection, as `HTTP <status>: <body>` or `no connection: <error>`. fetch reuses kept-alive
 * connections, and one tailscaled accepted while it served the port can outlive serve's entry for it.
 */
function dial(url: string): Promise<string> {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { agent: false, timeout: 15_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      res.on("error", (err) => resolve(`HTTP ${res.statusCode}, then ${err.message}`));
    });
    req.on("timeout", () => req.destroy(new Error("no answer within 15 s")));
    req.on("error", (err: NodeJS.ErrnoException) => resolve(`no connection: ${err.code === undefined ? "" : `${err.code} `}${err.message}`));
    req.end();
  });
}

const served = async (httpsPort: number) => Object.keys((await serveStatus()).TCP ?? {}).includes(String(httpsPort));

/**
 * Unpublishes the linked port with the real CLI while its server answers, and checks what the CLI's contract promises:
 * the app stops answering on its URL at once, tailscale stops serving the URL within seconds, the port is listed
 * again without a preview, a second unpublish succeeds, and web's port is refused. The port then stays unpublished
 * across a pause and wake and a restart of the control plane, and publishing it again serves it.
 */
async function checkUnpublish(pylonId: string, linked: { url: string; httpsPort: number }, webPort: number) {
  const service = `port-${linkedPort}`;
  // The server started again a moment ago, and the node reports a new listener within its 10 s poll. Until then the
  // ports list leaves the port out, published or not.
  await until(`the thread's ports list ${linkedPort} with its preview`, 60_000, async () => (await detail()).ports?.find((l) => l.port === linkedPort && l.preview?.service === service));
  const unpublished = await nexus("unpreview", threadId!, String(linkedPort), "--json");
  const returned = performance.now();
  assert.deepEqual([unpublished.code, unpublished.stdout.trim()], [0, "null"], `unpreview exits 0 and prints null: ${unpublished.stderr}`);
  const after = await detail();
  assert.equal(after.previews.find((p) => p.service === service), undefined, "the thread's previews leave the port out at once");
  const listed = after.ports?.find((l) => l.port === linkedPort);
  assert.ok(listed !== undefined && listed.preview === null, `the port is listed again without a preview: ${JSON.stringify(after.ports)}`);
  const file = new URL("nexus-proof.txt", linked.url).href;
  const right = await dial(file);
  // The gateway's own 404, or no connection once serve has already dropped the port.
  assert.match(right, /^HTTP 404: no preview is published on |^no connection/, `the gateway stops routing the URL before unpreview returns: ${right}`);
  pass(`unpreview exits 0 and prints null, the port is listed again with preview null, and ${file} answers right after with ${right}`);

  // Every poll's https ports, so a failure shows whether serve dropped the port at all.
  const polls: string[] = [];
  const dropped = await until(`tailscale serve no longer serves ${linked.httpsPort}`, 60_000, async () => {
    const ports = Object.keys((await serveStatus()).TCP ?? {});
    const at = Math.round(performance.now() - returned);
    polls.push(`${at} ms: ${ports.join(",") || "none"}`);
    return ports.includes(String(linked.httpsPort)) ? undefined : at;
  }).catch((err: Error) => { throw new Error(`${err.message}. tailscale serve's https ports at each poll: ${polls.join("; ")}`); });
  console.log(`tailscale serve's https ports at each poll after unpreview: ${polls.join("; ")}`);
  const gone = await dial(file);
  const pooled = await fetch(file, { signal: AbortSignal.timeout(15_000) }).then(async (res) => `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, (err: Error) => `no connection: ${(err.cause as Error | undefined)?.message ?? err.message}`);
  assert.match(gone, /^no connection/, `a new connection to a URL tailscale no longer serves is refused, but it got ${gone}, and fetch, which may reuse a connection, got ${pooled}`);
  pass(`tailscale serve dropped ${linked.httpsPort} ${dropped} ms after unpreview returned. A new connection to ${file} then gets ${gone}, and fetch, which may reuse a connection, gets ${pooled}`);

  const again = await nexus("unpreview", threadId!, String(linkedPort), "--json");
  assert.deepEqual([again.code, again.stdout.trim()], [0, "null"], `a second unpreview succeeds: ${again.stderr}`);
  const owned = await nexus("unpreview", threadId!, String(webPort));
  assert.equal(owned.code, 1, `unpreview of web's port exits 1: ${owned.stderr}`);
  assert.match(owned.stderr, new RegExp(`^nexus: Port ${webPort} is the preview of service web, not a linked port\\. Remove the preview from \\S+ to unpublish it\\n$`), "the refusal is the pylon's reason alone, naming the service");
  assert.ok((await detail()).previews.some((p) => p.service === "web"), "the refused unpreview keeps web's preview");
  pass(`a second unpreview exits 0, and unpreview of web's port ${webPort} exits 1 with: ${owned.stderr.trim()}`);

  const linkedFile = join(stateRoot, "instances", pylonId, "linked.json");
  await expect(200, "POST", `/threads/${threadId}/archive`);
  await reaches("paused", 5 * 60_000);
  await expect(200, "POST", `/threads/${threadId}/unarchive`);
  await reaches("running", 5 * 60_000);
  await controlPlane.close();
  controlPlane = await startControlPlane(config, scriptedModels());
  await runTool("msg:node-check-server-unpublished", startServer);
  await until(`the woken pylon's ports list ${linkedPort}`, 60_000, async () => (await detail()).ports?.find((l) => l.port === linkedPort));
  // Long enough for several of the loop's passes and the probe's reads of the pylon's services.
  await delay(30_000);
  const woken = await detail();
  assert.equal(woken.previews.find((p) => p.service === service), undefined, `the port stays unpublished across the pause and the restart: ${JSON.stringify(woken.previews)}`);
  assert.deepEqual(woken.ports?.find((l) => l.port === linkedPort), { port: linkedPort, service: null, preview: null });
  assert.equal(await served(linked.httpsPort), false, `tailscale serve does not serve ${linked.httpsPort} again`);
  const saved = JSON.parse(await readFile(linkedFile, "utf8")) as unknown;
  assert.deepEqual(saved, [], `${linkedFile} holds no linked port`);
  pass(`after a pause, a wake and a control-plane restart, ${linkedPort} listens with preview null, tailscale serve leaves ${linked.httpsPort} out, and ${linkedFile} is ${JSON.stringify(saved)}`);

  const republished = await nexus("preview", threadId!, String(linkedPort), "--wait", "--json");
  assert.equal(republished.code, 0, `preview --wait publishes the port again: ${republished.stderr}`);
  const preview = JSON.parse(republished.stdout) as ThreadDetail["previews"][number];
  assert.deepEqual([preview.service, preview.ready], [service, true]);
  await fetchMarker(preview.url);
  pass(`publishing ${linkedPort} again serves it at ${preview.url}${preview.url === linked.url ? ", its old URL" : `, not its old ${linked.url}`}`);
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
function plannerState(pylonId: PylonId) {
  const registry = openRegistry(config.db);
  try {
    const { failed, attempts, retrying, submitted } = registry.pylon(pylonId)!;
    return { failed, attempts, retrying, job: registry.job(pylonId) ?? null, submitted };
  } finally {
    registry.close();
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

/**
 * The thread's project comes from the real CLI's `project add`, as the Claude mod and the pi extension add one, with
 * the CLI's defaults. Adding it again is a conflict, and leaving out --node defaults to auto.
 */
async function addProject() {
  const repoUrl = "https://github.com/octocat/Spoon-Knife.git";
  const added = await nexus("project", "add", "node-check", repoUrl, "--node", probeConfig.node, "--json");
  assert.equal(added.code, 0, added.stderr);
  const expected = {
    id: "node-check", repoUrl, defaultBranch: "main", defaultNode: probeConfig.node,
    resources: { cpus: 2, memoryGiB: 6, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  };
  assert.deepEqual(JSON.parse(added.stdout), expected);
  assert.deepEqual(await expect(200, "GET", "/projects"), [expected]);
  pass(`nexus project add created node-check on ${probeConfig.node} with the CLI's defaults: ${added.stdout.replace(/\s+/g, " ")}`);
  const again = await nexus("project", "add", "node-check", repoUrl, "--node", probeConfig.node, "--json");
  assert.deepEqual([again.code, JSON.parse(again.stderr)], [5, { error: "project node-check exists", kind: "conflict", status: 409 }]);
  const unnamed = await nexus("project", "add", "node-check-auto", repoUrl, "--json");
  assert.deepEqual([unnamed.code, JSON.parse(unnamed.stdout).defaultNode], [0, "auto"], unnamed.stderr);
  pass(`adding node-check again exits 5, and leaving out --node adds a project whose default node is auto`);
}

let verdict = "FAIL";
try {
  await addProject();
  const thread = await expect(201, "POST", "/threads", { project: "node-check", title: "thread on node" });
  threadId = thread.id;
  pass(`start thread ${threadId} on ${probeConfig.node} from ${image}`);

  const booted = await reaches("running", 10 * 60_000);
  pass("the pylon boots and runs");
  const quiet = await until("the node reports the pylon's ports", 60_000, async () => (await detail()).ports ?? undefined);
  pass(`a fresh pylon lists these ports, which should be none of Nexus's own: ${JSON.stringify(quiet)} (observed ${booted.pylon.observedAt})`);

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
  await checkStreamedAnswer(30, 45_000);
  const token = `preview-check-${threadId}`;
  await runTool("msg:node-check-preview", declarePreview(token));
  const preview = await openPreview(token);
  pass(`the declared service is served at ${preview.url}, fetched from this node`);
  const worker = await until(`the declared worker listens on ${workerPort}`, 2 * 60_000, async () => (await detail()).ports?.find((l) => l.port === workerPort && l.service === "worker"));
  assert.deepEqual(worker, { port: workerPort, service: "worker", preview: null }, "a declared service without a preview runs with no preview");
  pass(`the declared service without a preview started with no command, listening on ${workerPort}`);
  const info = await runTool("msg:node-check-info", `nexus info --json | python3 -c 'import json, sys; print("info", json.load(sys.stdin)["previews"])'; grep -F web: /home/user/.nexus/PYLON.md`);
  assertIncludes(info, `info [{'service': 'web', 'url': '${preview.url}'}]`, `- web: ${preview.url}`);
  pass("pylon.json and PYLON.md name the preview URL");

  await runTool("msg:node-check-server", startServer);
  const listed = await until(`the thread's ports list ${linkedPort}`, 60_000, async () => (await detail()).ports?.find((l) => l.port === linkedPort));
  assert.deepEqual(listed, { port: linkedPort, service: null, preview: null }, "an unpublished listening port has no service and no preview");
  const ports = (await detail()).ports!;
  assert.ok(ports.some((l) => l.service === "web" && l.preview?.url === preview.url), `the declared service's port carries its preview: ${JSON.stringify(ports)}`);
  pass(`the thread's ports list ${linkedPort} unpublished, and web's port with its preview: ${JSON.stringify(ports)}`);
  const linked = await expect(200, "POST", `/threads/${threadId}/previews`, { port: linkedPort }) as ThreadDetail["previews"][number];
  assert.equal(linked.service, `port-${linkedPort}`);
  assert.equal(linked.url, `https://${dnsName}:${linked.httpsPort}/`, "the reply names the URL at once");
  const again = await expect(200, "POST", `/threads/${threadId}/previews`, { port: linkedPort }) as ThreadDetail["previews"][number];
  // The first link's spawn may have published the preview by now, so only ready may differ.
  assert.deepEqual({ ...again, ready: linked.ready }, linked, "linking again answers the same preview");
  pass(`linking ${linkedPort} answers ${linked.url} at once, and again the same`);
  await until(`the preview of ${linkedPort} is ready`, 3 * 60_000, async () => (await detail()).ports?.find((l) => l.port === linkedPort)?.preview?.ready || undefined);
  await fetchMarker(linked.url);
  pass(`the linked port is served at ${linked.url}, fetched from this node`);
  if (holdMs > 0) {
    console.log(`OPEN ${preview.url} and ${linked.url} from another tailnet device. Holding ${holdMs / 1000} s`);
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
  assert.ok(Object.keys((await serveStatus()).TCP ?? {}).includes(String(preview.httpsPort)), "tailscale serve keeps a paused pylon's preview");
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

  // The wake lost the unsupervised server with the VM's memory, and the pylon must still route its preview.
  await runTool("msg:node-check-server-again", startServer);
  await fetchMarker(linked.url);
  assert.deepEqual((await detail()).previews.find((p) => p.service === `port-${linkedPort}`)?.url, linked.url, "the linked preview keeps its URL across the pause");
  pass(`after the wake and a restart of the server, the linked port is served again at ${linked.url}`);

  const webPort = (await detail()).ports?.find((l) => l.service === "web")?.port;
  assert.ok(webPort !== undefined, "web's port is listed");
  await checkUnpublish(thread.pylonId, linked, webPort);

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
    await detail().then(async (d) => {
      console.error(`pylon: ${JSON.stringify(d.pylon, null, 2)}`);
      const row = (await expect(200, "GET", "/threads") as ThreadRow[]).find((r) => r.id === threadId);
      console.error(`planner: ${JSON.stringify({ status: row?.status, desired: row?.desired, ...plannerState(d.pylon.id) }, null, 2)}`);
    }, (detailErr: unknown) => {
      console.error(`could not read the thread detail: ${(detailErr as Error).message}`);
    });
  }
} finally {
  if (threadId !== undefined && !deleted) {
    await api.cleanup(threadId);
    console.error(`tailscale serve status after cleanup: ${JSON.stringify(await serveStatus())}`);
  }
  await controlPlane.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`${verdict} thread-on-node`);
process.exit(verdict === "PASS" ? 0 : 1);
