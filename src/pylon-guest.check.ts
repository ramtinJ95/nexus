/**
 * Node validation for the pylon VM's Guest, run by hand on a node with the real pylon image:
 *
 *   node src/pylon-guest.check.ts <the image's directory in an artifact store> <state root>
 *
 * The state root must be at most 39 bytes, such as ~/nexus-spikes/pg. One pylon goes through an in-process
 * probe, the way the slice test drives one, with a fake `tailscale`, so the node's serve config is never
 * touched. It checks, in order:
 *
 * 1. pi-env over the probe's raw pipe: the harness's own bridge runs the image's daemon over SSH, and
 *    pi-durable's environment conformance suite passes through it.
 * 2. A declared service with a preview runs as `user` with its https PUBLIC_URL, through the preview gateway,
 *    and the probe's observation reports it ready.
 * 3. The sessions NEXUS_CHECK_SESSIONS names (default shell,claude-code,pi) survive a pause and a wake: each
 *    comes back, its pane runs its agent, and the controller log has one `sessions:` line for each.
 *
 * It deletes the pylon at the end, also after a failure, unless NEXUS_CHECK_KEEP=1. It prints PYLON_GUEST_CHECK_PASS last.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { pylonEnvs } from "./harness/pylon-env.ts";
import { fakeTailscale, nodeHost, viaGateway } from "./probe/fake-tailscale.ts";
import { nodeSecrets } from "./probe/config.ts";
import { startProbe } from "./probe/server.ts";
import { connectProbe, type Job, type JobId, type NodeName, type PylonId, type TailnetNodeId } from "./protocol.ts";
import { createPylonVmBackend } from "./pylon-vm-backend.ts";
import { envelope } from "./reconcile.ts";
import { snapshot } from "./tick.ts";
import { checkoutDir, herdrSession, sessionFacts, sessionsFile } from "./sessions.ts";
import { loginHosts, type BootInputs, type LiveSpec, type OverlayFile, type SessionHarness } from "./project.ts";
import type { ImageId } from "./images.ts";

const [assets, stateRoot] = process.argv.slice(2);
if (assets === undefined || stateRoot === undefined) throw new Error("usage: node src/pylon-guest.check.ts <image dir in an artifact store> <state root>");
const harnesses = (process.env["NEXUS_CHECK_SESSIONS"] ?? "shell,claude-code,pi").split(",").filter(Boolean) as SessionHarness[];
const unknown = harnesses.filter((h) => !["shell", "claude-code", "pi"].includes(h));
if (unknown.length > 0) throw new Error(`NEXUS_CHECK_SESSIONS names no harness ${unknown.join(", ")}`);
const image = basename(assets) as ImageId;
const run = randomUUID().slice(0, 8);
const pylonId = `pylon-check-${run}` as PylonId;
const node = "check-node" as NodeName;
const controlPlaneId = "nCHECKCONTROL" as TailnetNodeId;
const probeId = "nCHECKPROBE" as TailnetNodeId;
const step = (name: string, value: unknown = "ok") => console.log(`${name}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);

const backend = createPylonVmBackend({ stateRoot, artifacts: dirname(assets), secrets: { value: () => undefined, names: () => [] }, previewHost: nodeHost });
const tailscale = fakeTailscale();
const free = createServer().listen(0, "127.0.0.1");
await new Promise((resolve) => free.once("listening", resolve));
const gatewayPort = (free.address() as { port: number }).port;
await new Promise((resolve) => free.close(resolve));
const probe = await startProbe({
  node, host: "127.0.0.1", port: 0,
  auth: { controlPlane: controlPlaneId, peers: [] },
  whois: async () => controlPlaneId,
  backend,
  secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
  log: (message) => console.log(`probe: ${message}`),
  previews: { gatewayPort, routesFile: join(stateRoot, `check-${run}-routes.json`), tailscale: tailscale.cli, get: viaGateway(() => `http://127.0.0.1:${gatewayPort}`).get },
});
const client = connectProbe(node, "127.0.0.1", probeId, { port: probe.port, whois: async () => probeId });
// The bridge verifies the probe through a tailscaled LocalAPI socket, so this one names the probe's node.
const tailscaled = join(stateRoot, `check-${run}.sock`);
const localApi = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: probeId } })));
await new Promise<void>((resolve) => localApi.listen(tailscaled, resolve));

const boot: BootInputs = {
  pylonId, image, source: { kind: "fresh", preSetup: null },
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 8 },
  // The hosts a project with a Claude login gets, which Claude Code needs to start at all.
  network: { allowedHosts: ["github.com", ...harnesses.includes("claude-code") ? loginHosts.claude : []], secrets: [] },
  repo: { kind: "clone", url: "https://github.com/octocat/Hello-World.git", checkout: { branch: "master", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" } },
  dotfiles: { repo: "https://dotfiles.invalid/common.git", ref: "main" },
};
const web = { service: "web", httpsPort: 10100 };

async function job(j: Job): Promise<void> {
  const env = envelope(j, node, Date.now());
  const reply = await client.submit(env);
  assert.ok("accepted" in reply, JSON.stringify(reply));
  for (;;) {
    const status = await client.job(env.jobId as JobId);
    assert.notEqual(status, "unknown");
    if (status !== "unknown" && status.state === "succeeded") return;
    if (status !== "unknown" && status.state === "failed") throw new Error(`${j.kind} failed: ${JSON.stringify(status)}`);
    await sleep(500);
  }
}
const spawn = (source: BootInputs["source"], live: LiveSpec) => job({ kind: "spawn", pylonId, boot: { ...boot, source }, live, liveHash: randomUUID() as never });

function visit(httpsPort: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: gatewayPort, headers: { host: `${nodeHost}:${httpsPort}` } }, async (res) => {
      let body = "";
      for await (const chunk of res) body += chunk;
      resolve({ status: res.statusCode!, body });
    }).on("error", reject).end();
  });
}

const serviceFiles: OverlayFile[] = [
  { path: `${checkoutDir}/.nexus/services.yaml`, mode: 0o644, owner: "user", content: "services:\n  web:\n    command: python3 -u .nexus/check-web.py\n    preview: true\n    health: /\n" },
  {
    path: `${checkoutDir}/.nexus/check-web.py`, mode: 0o644, owner: "user",
    content: 'import http.server, json, os, pwd\nclass H(http.server.BaseHTTPRequestHandler):\n    def do_GET(self):\n        b = json.dumps({"publicUrl": os.environ.get("PUBLIC_URL"), "host": self.headers.get("host"), "user": pwd.getpwuid(os.getuid()).pw_name}).encode()\n        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)\nhttp.server.ThreadingHTTPServer(("", int(os.environ["PORT"])), H).serve_forever()\n',
  },
];
/** The body as JSON when the service answered, so the comparison does not depend on how Python spaces it. */
const answer = ({ status, body }: { status: number; body: string }) => [status, status === 200 ? JSON.parse(body) : body];
const expected = { publicUrl: `https://${nodeHost}:${web.httpsPort}`, host: `${nodeHost}:${web.httpsPort}`, user: "user" };

async function piEnv(): Promise<void> {
  const envs = pylonEnvs({ awaitRunning: async () => ({ node, host: "127.0.0.1", port: probe.port, nodeId: probeId }) }, { tailscaled, log: (m) => console.log(m) });
  try {
    const read = { snapshot: async () => ({ threadId: `check-${run}`, pylonId }) } as unknown as DocumentReader;
    const envAt = (cwd: string) => envs.env({ conversationId: 1 as ConversationId, cwd, read }, context) as Promise<ExecutionEnv>;
    const base = await envAt(checkoutDir);
    const started = performance.now();
    let output = "";
    const hello = await base.exec(["sh", "-c", "echo hello; id -un; pwd"], { onOutput: (text) => { output += text; } }, context);
    step("PI_ENV_FIRST_EXEC_MS", String(Math.round(performance.now() - started)));
    assert.ok(hello.ok && hello.value.exitCode === 0, JSON.stringify(hello));
    assert.equal(output, `hello\nuser\n${checkoutDir}\n`, "the daemon runs as user in the checkout");
    const cases = createEnvConformance({
      assertions: {
        ok: (value: unknown, message?: string) => message === undefined ? assert.ok(value) : assert.ok(value, message),
        strictEqual: (a: unknown, b: unknown) => assert.strictEqual(a, b),
        deepEqual: (a: unknown, b: unknown) => assert.deepStrictEqual(a, b),
        partialDeepEqual: (a: unknown, b: unknown) => assert.partialDeepStrictEqual(a, b),
        greaterThan: (a: number, b: number) => assert.ok(a > b, `${a} > ${b}`),
        rejects: (operation: Promise<unknown>, includes: string) => assert.rejects(operation, (err: Error) => String(err?.message).includes(includes)),
      },
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
    const failed: string[] = [];
    for (const c of cases) {
      try {
        await Promise.race([c.run(), sleep(c.timeoutMs ?? 30_000).then(() => { throw new Error("timed out"); })]);
      } catch (err) {
        failed.push(`${c.name}: ${(err as Error).message}`);
      }
    }
    step("CONFORMANCE", `passed=${cases.length - failed.length}/${cases.length}`);
    assert.deepEqual(failed, [], "pi-durable's environment conformance passes over the pylon's SSH stream");
  } finally {
    envs.close();
  }
}

async function agentRuns(pane: string, kind: string): Promise<boolean> {
  const { output } = await backend.guest(pylonId).exec(["herdr", "--session", herdrSession, "pane", "process-info", "--pane", pane], { cwd: "/home/user", timeoutMs: 10_000 });
  const info = JSON.parse(output.trim().split("\n").findLast((l) => l.startsWith("{"))!).result.process_info;
  return (info.foreground_processes as { argv?: string[]; name?: string }[]).some((p) => (p.argv ?? [p.name ?? ""]).slice(0, 2).some((a) => a.split("/").at(-1) === kind));
}

let failure: unknown = null;
try {
  await spawn({ kind: "fresh", preSetup: null }, { previews: [], overlay: [] });
  step("FRESH_SPAWN");
  await piEnv();
  step("PI_ENV");

  await backend.guest(pylonId).writeFiles(serviceFiles);
  await spawn({ kind: "fresh", preSetup: null }, { previews: [web], overlay: [] });
  step("SERVICES_ENSURE", await client.command(pylonId, { kind: "service", op: "ensure" }));
  const served = await visit(web.httpsPort);
  step("PREVIEW", served);
  assert.deepEqual(answer(served), [200, expected], "the service answers through the gateway with its https PUBLIC_URL, as user");
  const observed = (await snapshot(client))?.pylons.find((p) => p.pylonId === pylonId);
  step("OBSERVED_SERVICES", observed?.phase === "running" ? observed.services : observed);
  assert.ok(observed?.phase === "running" && observed.services?.some((f) => f.name === "web" && f.state === "ready" && f.wantsPreview), "the observation reports web as ready with a preview");

  for (const harness of harnesses) step(`OPEN_${harness}`, await client.command(pylonId, { kind: "open-session", harness, title: `check ${harness}` }));
  await sleep(5_000); // the agents report their session IDs through Herdr's hooks
  step("FACTS_BEFORE_PAUSE", await sessionFacts(backend.guest(pylonId)));

  await job({ kind: "pause", pylonId, checkpoint: `ckpt-check-${run}-1` as never });
  step("PAUSED");
  assert.equal((await visit(web.httpsPort)).status, 503, "a paused pylon's preview shows the waking page");
  await spawn({ kind: "resume", checkpoint: `ckpt-check-${run}-1` as never }, { previews: [web], overlay: [] });
  step("WOKEN");

  const log = await readFile(join(stateRoot, "instances", pylonId, "controller.log"), "utf8");
  const lines = log.split("\n").filter((l) => l.startsWith("sessions: "));
  step("SESSION_LOG_LINES", lines);
  assert.ok(lines.includes(`sessions: recorded ${harnesses.length} for the wake`), "the pause recorded every session");
  const outcomes = harnesses.map((h) => lines.find((l) => l.includes(`"check ${h}" (${h})`)));
  assert.ok(outcomes.every((l) => l !== undefined && !l.includes("did not come back")), "each session came back");
  const file = JSON.parse((await backend.guest(pylonId).exec(["cat", sessionsFile], { cwd: "/home/user", timeoutMs: 10_000 })).output);
  step("SESSIONS_FILE", file);
  assert.deepEqual(file.failed, []);
  const facts = await sessionFacts(backend.guest(pylonId));
  step("FACTS_AFTER_WAKE", facts);
  assert.deepEqual(facts.map((f) => f.harness).sort(), [...harnesses].sort());
  for (const record of file.sessions as { herdrPane: string; harness: SessionHarness }[]) {
    if (record.harness === "shell") continue;
    assert.ok(await agentRuns(record.herdrPane, record.harness === "pi" ? "pi" : "claude"), `${record.harness}'s pane ${record.herdrPane} runs its agent`);
  }
  const again = await visit(web.httpsPort);
  assert.deepEqual(answer(again), [200, expected], "the wake started the service again");
  step("WAKE_SERVICE");
} catch (err) {
  failure = err;
  console.error(err);
  try {
    console.error((await readFile(join(stateRoot, "instances", pylonId, "controller.log"), "utf8")).split("\n").slice(-80).join("\n"));
  } catch {
    // The instance never got as far as a log.
  }
} finally {
  if (process.env["NEXUS_CHECK_KEEP"] !== "1") await job({ kind: "delete", pylonId });
  await probe.close();
  localApi.close();
  await rm(tailscaled, { force: true });
  await rm(join(stateRoot, `check-${run}-routes.json`), { force: true });
}
if (failure !== null) process.exit(1);
console.log("PYLON_GUEST_CHECK_PASS");
