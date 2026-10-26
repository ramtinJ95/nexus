/**
 * Node validation that a server bound only to ::1 is listed and previewed, run by hand on a home-lab node as the
 * probe's user, whose probe runs this checkout:
 *   node src/control/v6-preview-on-node.ts [probe.json] [imageId] [holdSeconds, default 45]
 *
 * It starts a control plane in this process over a temporary directory, as thread-on-node.ts does, with the scripted
 * model, and drives the node's running probe through it. The agent starts three servers in a pylon: one on ::1 only,
 * one on 127.0.0.1 only, and one that binds `localhost`, whose address the check prints. The real CLI's `ports` must
 * list all three and none of the relay's own ports, and `preview --wait` must publish the first two, whose URLs must
 * answer from this node, and the guest's relay log and status must name both. The ::1 server then moves its port to 0.0.0.0,
 * which it must bind at once, and its preview must answer from the new server. A declared service that listens only
 * on ::1, 8 s after each start, must become ready through its health check, and after `nexus service restart` must
 * stay starting until its listener is back. Another, with the default health, that never listens again after a
 * restart must stay starting until its start timeout fails it, never ready. After an archive and an unarchive, which
 * pause and wake the pylon, the agent starts the servers again and both previews must answer on the same URLs.
 * Deleting the thread must leave `tailscale serve` as the check found it.
 *
 * At each hold it prints `CURL <url> <body>` for each preview, so a Mac can check them through ts-home's SOCKS proxy:
 *   ssh home-<node> 'cd <checkout> && sudo -u nexus node src/control/v6-preview-on-node.ts' | tee v6-preview.log |
 *     while read -r tag url body; do [ "$tag" = CURL ] && echo "MAC $url $(curl -sS --max-time 20 --socks5-hostname localhost:1055 "$url") expected $body"; done
 * It prints PASS v6-preview-on-node last.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { artifactDirectory, tarCodec } from "../artifacts.ts";
import { isImageId, probePort } from "../protocol.ts";
import { scriptedModel, scriptedModels } from "../harness/test-fixture.ts";
import { parseSelfDnsName, readProbeConfig } from "../probe/config.ts";
import { tailscaleCli } from "../probe/serve.ts";
import { relayPorts } from "../project.ts";
import { relayLog, relayStatus } from "../pylon-vm/relay.ts";
import type { ThreadDetail } from "./api.ts";
import { defaultPreviewPorts, startControlPlane, type ControlPlaneConfig } from "./main.ts";
import { openRegistry } from "./registry.ts";

const probeConfig = await readProbeConfig(process.argv[2] ?? "/etc/nexus/probe.json");
if (probeConfig.backend.kind !== "pylon-vm") throw new Error(`the probe runs the ${probeConfig.backend.kind} backend. This check is for pylon-vm`);
const store = artifactDirectory(probeConfig.backend.artifacts, tarCodec);
const images = (await store.list()).filter(isImageId);
const image = process.argv[3] || (images.length === 1 ? images[0] : undefined);
if (!isImageId(image) || !images.includes(image)) throw new Error(`name one of the images in ${store.root}: ${images.join(", ")}`);
if (probeConfig.listen.port !== probePort) throw new Error(`the probe listens on port ${probeConfig.listen.port}, and the control plane reaches probes on ${probePort} only`);
if (probeConfig.previews === undefined) throw new Error("set previews in the probe's config, then restart the probe. This check opens previews");
const holdMs = Number(process.argv[4] ?? 45) * 1000;
const tailscale = tailscaleCli();
const statusJson = await tailscale(["status", "--json"], AbortSignal.timeout(30_000));
const self = z.object({ Self: z.object({ ID: z.string() }) }).parse(JSON.parse(statusJson)).Self.ID;
const dnsName = parseSelfDnsName(statusJson);
if (probeConfig.auth.controlPlane !== self) throw new Error(`set auth.controlPlane in the probe's config to this node's ID ${self} (it is ${probeConfig.auth.controlPlane}), then restart the probe`);
const serveStatus = async () => JSON.parse(await tailscale(["serve", "status", "--json"], AbortSignal.timeout(30_000))) as { TCP?: Record<string, unknown> };
const serveBefore = await serveStatus();
// The check's registry is new, so its previews get the first ports. Taking over an entry there would break whatever owns it.
for (const port of [defaultPreviewPorts.first, defaultPreviewPorts.first + 1]) {
  if (Object.keys(serveBefore.TCP ?? {}).includes(String(port))) throw new Error(`tailscale serve already serves port ${port}, which this check's previews would get. Free it first`);
}

const host = probeConfig.listen.host;
const dir = await mkdtemp(join(tmpdir(), "nexus-v6-preview-"));
const config: ControlPlaneConfig = {
  db: join(dir, "registry.db"),
  listen: { host, port: 0, hostnames: [host] },
  self: { tailnetNodeId: self },
  nodes: [{ name: probeConfig.node, tailnetHost: dnsName, tailnetNodeId: self }],
  callers: [],
  dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
  harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "unused-credentials.json"), model: scriptedModel },
  previewPorts: defaultPreviewPorts,
  resumeAfterUsageLimit: false,
};
// A rollout needs a deployer, which the control plane's own node never is, so the check makes the image current in the registry.
const seed = openRegistry(config.db);
seed.saveImage((await store.manifest(image))!, null);
seed.setCurrentImage(image);
seed.close();
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
const pass = (step: string) => console.log(`PASS ${step} (${Math.round((performance.now() - started) / 1000)} s)`);

let threadId: string | undefined;
let deleted = false;
const detail = async () => await expect(200, "GET", `/threads/${threadId}`) as ThreadDetail;
const reaches = (state: string, timeoutMs: number) => until(`the pylon is ${state}`, timeoutMs, async () => {
  const d = await detail();
  if (d.pylon.failed !== null && d.thread.status !== "deleted") throw new Error(`the planner gave up on the pylon: ${d.pylon.failed}`);
  return d.pylon.actualState === state ? d : undefined;
});

const stepLimitS = 90;
type ToolResult = { kind: string; model?: { content: { type: string; text?: string }[] }[] };
/**
 * Sends `bash: <command>`, which the scripted model turns into one bash call, and returns that call's output as text,
 * so a check can anchor on its lines. The command runs under `timeout`, so one that hangs ends the agent's turn after
 * stepLimitS and fails the check by name.
 */
async function runTool(requestId: string, command: string): Promise<string> {
  // A command that prints nothing has a result with no content, which reads as "". A result with no model entry is a
  // shape this check does not know, so it fails loudly.
  const text = (e: ToolResult) => {
    if (e.model === undefined || e.model.length === 0) throw new Error(`a tool result has no model entry: ${JSON.stringify(e)}`);
    return e.model.flatMap((m) => m.content).flatMap((c) => c.type === "text" && c.text !== undefined ? [c.text] : []).join("\n");
  };
  const results = async () => ((await expect(200, "GET", `/threads/${threadId}/conversation`)).entries as ToolResult[]).filter((e) => e.kind === "pi.tool-result").map(text);
  const seen = (await results()).length;
  const bounded = `timeout ${stepLimitS} bash -c '${command.replaceAll("'", "'\\''")}'; code=$?; if [ $code = 124 ]; then echo "STEP TIMED OUT"; fi`;
  await expect(202, "POST", `/threads/${threadId}/messages`, { text: `bash: ${bounded}`, requestId });
  const result = await until(`the result of ${requestId} is in the conversation`, (stepLimitS + 60) * 1000, async () => (await results())[seen]);
  await until("the run ends", 60_000, async () => (await detail()).thread.agentTurnRunning ? undefined : true);
  if (result.includes("STEP TIMED OUT")) throw new Error(`${requestId} ran past ${stepLimitS} s: ${result}`);
  return result;
}

const cli = fileURLToPath(new URL("../cli/nexus.ts", import.meta.url));
/** Runs the real CLI against this check's control plane with --json, and parses what it prints. */
function nexus(...args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--json", "--url", `http://${host}:${controlPlane.port}`, "--socks", "none"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`nexus ${args.join(" ")} exited ${code}: ${stderr}`)));
  });
}

type Preview = ThreadDetail["previews"][number];
const v6 = { port: 3461, body: "v6-ok" };
const v4 = { port: 3462, body: "v4-ok" };
const named = 3464;
const slow = { name: "slow6", port: 3466, delayS: 8 };
const gone = { name: "gone6", port: 3467, timeoutS: 6 };
/** Detached, because the agent's bash call ends before the servers do. The ::1 server's PID is kept for the move. */
const startServers = [
  `setsid nohup node -e "require('http').createServer((q,r)=>r.end('${v6.body}')).listen(${v6.port},'::1')" </dev/null >/tmp/v6.log 2>&1 & echo $! > /tmp/v6.pid`,
  `setsid nohup node -e "require('http').createServer((q,r)=>r.end('${v4.body}')).listen(${v4.port},'127.0.0.1')" </dev/null >/tmp/v4.log 2>&1 &`,
  `setsid nohup node -e "require('http').createServer((q,r)=>r.end('named')).listen(${named},'localhost')" </dev/null >/tmp/named.log 2>&1 &`,
  "sleep 2; echo started",
].join("\n");
/** Stops the ::1 server and binds its port on 0.0.0.0 as soon as it is gone, printing the bind's outcome. */
/** The kernel's LISTEN entry for [::1]:port in /proc/net/tcp6, as listening.ts reads it. */
const v6Listener = (port: number) => `00000000000000000000000001000000:${port.toString(16).toUpperCase().padStart(4, "0")} [0-9A-F]+:[0-9A-F]{4} 0A `;
/**
 * Stops the ::1 server and binds its port on 0.0.0.0 as soon as its ::1 listener is gone, printing the bind's outcome.
 * It waits on the listener, not the process, which may linger as a zombie nothing reaps.
 */
const moveServer = [
  "kill $(cat /tmp/v6.pid)",
  `for i in $(seq 1 100); do grep -Eq '${v6Listener(v6.port)}' /proc/net/tcp6 || break; sleep 0.1; done`,
  `if grep -Eq '${v6Listener(v6.port)}' /proc/net/tcp6; then echo "the ::1 listener on ${v6.port} is still up 10 s after its kill"; exit 1; fi`,
  `setsid nohup node -e "require('http').createServer((q,r)=>r.end('moved-ok')).listen(${v6.port},'0.0.0.0',()=>console.log('bound 0.0.0.0')).on('error',(e)=>console.log('bind failed '+e.code))" </dev/null >/tmp/moved.log 2>&1 &`,
  "sleep 2; cat /tmp/moved.log",
].join("\n");
/**
 * Two declared services without previews that listen only on ::1. slow6 listens delayS seconds after each start, and
 * has a health path. gone6 listens at its first start only, and has the default health, a connection.
 */
const declareServices = [
  "mkdir -p .nexus",
  `cat > .nexus/slow6.sh <<'SH'\nsleep ${slow.delayS}\nexec node -e "require('http').createServer((q,r)=>r.end('slow6-ok')).listen(Number(process.env.PORT),'::1')"\nSH`,
  `cat > .nexus/gone6.sh <<'SH'\nif [ -e /tmp/gone6-started ]; then exec sleep 3600; fi\ntouch /tmp/gone6-started\nexec node -e "require('http').createServer((q,r)=>r.end('gone6-ok')).listen(Number(process.env.PORT),'::1')"\nSH`,
  "rm -f /tmp/gone6-started",
  `printf 'services:\\n  ${slow.name}:\\n    command: sh .nexus/slow6.sh\\n    port: ${slow.port}\\n    health: /\\n  ${gone.name}:\\n    command: sh .nexus/gone6.sh\\n    port: ${gone.port}\\n    timeoutMs: ${gone.timeoutS * 1000}\\n' > .nexus/services.yaml`,
].join("\n");
/**
 * Prints the state of the service `name` about twice a second for `seconds` seconds, each as
 * `<tag>#<seconds since before the command> <state>`, from before `command` runs and while it does, because
 * `nexus service restart` returns only once the service has settled.
 */
const sample = (name: string, tag: string, command: string, seconds: number) => [
  `state() { nexus services list --json | python3 -c 'import json,sys; print(next(s["state"] for s in json.load(sys.stdin)["services"] if s["name"]=="${name}"))'; }`,
  "t0=$(date +%s)",
  `( while [ $(( $(date +%s) - t0 )) -lt ${seconds} ]; do echo "${tag}#$(( $(date +%s) - t0 )) $(state)"; sleep 0.5; done ) &`,
  "sampler=$!",
  `${command} >/dev/null; echo "the command returned after $(( $(date +%s) - t0 )) s"`,
  "wait $sampler",
].join("\n");
const samples = (result: string, tag: string) => [...result.matchAll(new RegExp(`${tag}#(\\d+) (\\w+)`, "g"))].map((m) => ({ at: Number(m[1]), state: m[2]! }));

/** Fetches the URL from this node until it answers with the body. */
async function answers(url: string, body: string): Promise<void> {
  let last = "no answer yet";
  await until(`${url} answers ${body}`, 2 * 60_000, async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      return last === `HTTP 200: ${body}` ? true : undefined;
    } catch (err) {
      last = (err as Error).message;
      return undefined;
    }
  }).catch((err: Error) => { throw new Error(`${err.message}. Last answer: ${last}`); });
}

async function hold(previews: { url: string; body: string }[]) {
  for (const p of previews) console.log(`CURL ${p.url} ${p.body}`);
  console.log(`holding ${holdMs / 1000} s for curls from the Mac`);
  await delay(holdMs);
}

/** Starts the servers, then checks the ports list and the relay's log. */
async function serveAll(step: string) {
  await runTool(`msg:v6-${step}-servers`, startServers);
  const ports = await until(`the ports list ${v6.port}, ${v4.port} and ${named}`, 60_000, async () => {
    const listed = await nexus("ports", threadId!) as ThreadDetail["ports"];
    return [v6.port, v4.port, named].every((port) => listed?.some((l) => l.port === port)) ? listed! : undefined;
  });
  assert.ok(!ports.some((l) => l.port >= relayPorts.first && l.port <= relayPorts.last), `the relay's own ports are left out: ${JSON.stringify(ports)}`);
  pass(`${step}: nexus ports lists the ::1 server's ${v6.port}, the 127.0.0.1 server's ${v4.port} and the localhost server's ${named}, and none of the relay's: ${JSON.stringify(ports)}`);
}

/**
 * The relay's log names a relay port for each previewed port, its status confirms it holds each, which their routes
 * waited for, and where Node binds `localhost` in the guest.
 */
async function relayLogged(step: string) {
  const logs = await runTool(`msg:v6-${step}-logs`, `cat ${relayLog}; echo "status $(cat ${relayStatus})"; node -e "require('dns').lookup('localhost',(e,a)=>console.log('localhost binds '+a))"`);
  for (const port of [v6.port, v4.port]) {
    assert.match(logs, new RegExp(`relaying 127\\.0\\.0\\.1:\\d+ to port ${port}`), `the relay log names ${port}: ${logs}`);
    assert.match(logs, new RegExp(`^status .*"bound": \\{[^}]*"\\d+": ${port}[,}]`, "m"), `the relay's status holds a relay port for ${port}: ${logs}`);
  }
  pass(`${step}: the relay serves both previewed ports: ${logs}`);
}

let verdict = "FAIL";
try {
  await expect(201, "POST", "/projects", {
    id: "v6-check", repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: probeConfig.node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  threadId = (await expect(201, "POST", "/threads", { project: "v6-check", title: "v6 preview" })).id;
  await reaches("running", 10 * 60_000);
  pass(`thread ${threadId} runs on ${probeConfig.node} from ${image}`);

  await serveAll("boot");
  const v6Preview = await nexus("preview", threadId!, String(v6.port), "--wait") as Preview;
  const v4Preview = await nexus("preview", threadId!, String(v4.port), "--wait") as Preview;
  await answers(v6Preview.url, v6.body);
  await answers(v4Preview.url, v4.body);
  pass(`nexus preview publishes ${v6.port} at ${v6Preview.url}, which answers ${v6.body}, and ${v4.port} at ${v4Preview.url}, which answers ${v4.body}, fetched from this node`);
  await relayLogged("boot");
  await hold([{ url: v6Preview.url, body: v6.body }, { url: v4Preview.url, body: v4.body }]);

  const moved = await runTool("msg:v6-move", moveServer);
  assert.ok(moved.includes("bound 0.0.0.0") && !moved.includes("bind failed"), `the server's port is free for it to bind on 0.0.0.0 once its ::1 server stops: ${moved}`);
  await answers(v6Preview.url, "moved-ok");
  pass(`a server that moves ${v6.port} from ::1 to 0.0.0.0 binds it at once, and ${v6Preview.url} answers it: ${moved}`);

  await runTool("msg:v6-declare", declareServices);
  const ensured = await runTool("msg:v6-ensure", sample(slow.name, "ensure", "nexus services ensure", slow.delayS + 12));
  assert.ok(samples(ensured, "ensure").some((s) => s.state === "ready"), `the declared ::1 service becomes ready: ${ensured}`);
  pass(`the declared service ${slow.name}, which listens only on ::1, becomes ready through its health check: ${ensured}`);
  const restarted = await runTool("msg:v6-restart", sample(slow.name, "restart", `nexus service restart ${slow.name}`, slow.delayS + 12));
  // The samples begin before the restart, so the first may still read the old start's ready.
  const states = samples(restarted, "restart");
  const firstStarting = states.findIndex((s) => s.state === "starting");
  // Whole seconds on both ends, so the listener, delayS after the restart began, can read up to a second early.
  assert.ok(firstStarting >= 0 && states[firstStarting]!.at < slow.delayS - 1, `the restart reads starting before its ::1 listener is back, ${slow.delayS} s after: ${restarted}`);
  const firstReady = states.slice(firstStarting).find((s) => s.state === "ready");
  assert.ok(firstReady !== undefined, `the restarted service becomes ready again: ${restarted}`);
  assert.ok(firstReady.at >= slow.delayS - 1, `it is not ready until its ::1 listener is back, ${slow.delayS} s after the restart, but was ${firstReady.at} s after: ${restarted}`);
  assert.ok(states.slice(firstStarting).filter((s) => s.at < firstReady.at).every((s) => s.state === "starting"), `between them it is starting: ${restarted}`);
  pass(`after a restart, ${slow.name} stays starting until its ::1 listener is back, and is ready ${firstReady.at} s after: ${restarted}`);

  const goneUp = await runTool("msg:v6-gone-up", sample(gone.name, "up", "true", 5));
  assert.ok(samples(goneUp, "up").some((s) => s.state === "ready"), `${gone.name} becomes ready once it listens on ::1: ${goneUp}`);
  const goneRestart = await runTool("msg:v6-gone-restart", sample(gone.name, "gone", `nexus service restart ${gone.name}`, gone.timeoutS + 8));
  const goneSampled = samples(goneRestart, "gone");
  const goneStarting = goneSampled.findIndex((s) => s.state === "starting");
  assert.ok(goneStarting >= 0 && goneSampled[goneStarting]!.at < gone.timeoutS - 1, `the restart reads starting before its ${gone.timeoutS} s timeout: ${goneRestart}`);
  const goneStates = goneSampled.slice(goneStarting);
  assert.ok(goneStates.every((s) => s.state !== "ready"), `restarted, ${gone.name} never listens again and is never ready: ${goneRestart}`);
  assert.ok(goneStates.some((s) => s.state === "failed" && s.at >= gone.timeoutS - 1), `it fails once its ${gone.timeoutS} s start timeout passes: ${goneRestart}`);
  pass(`after a restart that never listens again, ${gone.name} stays starting until its ${gone.timeoutS} s timeout fails it, never ready: ${goneRestart}`);

  await expect(200, "POST", `/threads/${threadId}/archive`);
  await reaches("paused", 5 * 60_000);
  await expect(200, "POST", `/threads/${threadId}/unarchive`);
  await reaches("running", 5 * 60_000);
  pass("archiving pauses the pylon and unarchiving wakes it");

  // The wake lost the servers with the VM's memory, and the relay with them, which the boot starts again.
  await serveAll("wake");
  await answers(v6Preview.url, v6.body);
  await answers(v4Preview.url, v4.body);
  await relayLogged("wake");
  const previews = (await detail()).previews;
  for (const p of [v6Preview, v4Preview]) assert.equal(previews.find((q) => q.service === p.service)?.url, p.url, `${p.service} keeps its URL across the pause`);
  pass(`after the wake ${v6Preview.url} answers ${v6.body} and ${v4Preview.url} answers ${v4.body}, on the same URLs`);
  await hold([{ url: v6Preview.url, body: v6.body }, { url: v4Preview.url, body: v4.body }]);

  await expect(200, "DELETE", `/threads/${threadId}`);
  deleted = true;
  await reaches("absent", 5 * 60_000);
  await until("tailscale serve is as the check found it", 60_000, async () => JSON.stringify(await serveStatus()) === JSON.stringify(serveBefore) || undefined);
  pass("deleting the thread leaves tailscale serve as the check found it");
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
console.log(`${verdict} v6-preview-on-node`);
process.exit(verdict === "PASS" ? 0 : 1);
