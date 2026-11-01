/**
 * What the node checks run by hand share: thread-on-node.ts, v6-preview-on-node.ts and drift-on-node.ts. Each checks
 * the node's probe config, runs control planes in its own process over temporary registries with the scripted model,
 * and drives the probe through their HTTP API.
 */
import { lookup } from "node:dns/promises";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { artifactDirectory, tarCodec } from "../artifacts.ts";
import { readControlPlane } from "../deploy/control-plane.ts";
import { exit, type Exit } from "../exec.ts";
import { shellQuote } from "../shell.ts";
import { isImageId, type TailnetNodeId } from "../ids.ts";
import { tailnetNodeIdSchema } from "../protocol/fields.ts";
import { probePort } from "../protocol/routes.ts";
import { scriptedModel, scriptedModels } from "../harness/test-fixture.ts";
import { parseSelfDnsName, readProbeConfig } from "../probe/config.ts";
import { parseServeStatus, tailscaleCli } from "../probe/serve.ts";
import { localApiWhois } from "../tailscale.ts";
import { callText } from "../test-kit.ts";
import type { ThreadDetail } from "./wire.ts";
import { defaultPreviewPorts, startControlPlane, type ControlPlaneConfig } from "./main.ts";
import { openRegistry } from "./registry.ts";
import type { PortRange } from "./thread-store.ts";

/**
 * Reads the probe's config named by argv[2] and refuses to go on unless the probe runs pylon-vm, holds `image` (the
 * node's only image when it is undefined), listens where the control plane reaches it, has previews, and trusts this
 * node as its control plane. With `resolvesToProbe`, this node's MagicDNS name must also resolve to the probe.
 */
export async function openNodeCheck(options: { image: string | undefined; opens: string; resolvesToProbe: boolean }) {
  const probeConfig = await readProbeConfig(process.argv[2] ?? "/etc/nexus/probe.json");
  const { backend, previews } = probeConfig;
  if (backend.kind !== "pylon-vm") throw new Error(`the probe runs the ${backend.kind} backend. This check is for pylon-vm`);
  const store = artifactDirectory(backend.artifacts, tarCodec);
  const images = (await store.list()).filter(isImageId);
  const image = options.image ?? (images.length === 1 ? images[0] : undefined);
  if (!isImageId(image) || !images.includes(image)) throw new Error(`name one of the images in ${store.root}: ${images.join(", ")}`);
  if (probeConfig.listen.port !== probePort) throw new Error(`the probe listens on port ${probeConfig.listen.port}, and the control plane reaches probes on ${probePort} only`);
  if (previews === undefined) throw new Error(`set previews in the probe's config, then restart the probe. This check opens ${options.opens}`);
  const tailscale = tailscaleCli();
  const statusJson = await tailscale(["status", "--json"], AbortSignal.timeout(30_000));
  const self = z.object({ Self: z.object({ ID: tailnetNodeIdSchema }) }).parse(JSON.parse(statusJson)).Self.ID;
  // Preview URLs name the node by its MagicDNS name, because that is the name its tailscale serve certificate is for.
  const dnsName = parseSelfDnsName(statusJson);
  const trusted = (await readControlPlane()).tailnetNodeId;
  if (trusted !== self) throw new Error(`/etc/nexus/control-plane.json names ${trusted} as the control plane, not this node's ID ${self}. Point it at this node with sudo deploy/set-control-plane.sh ${self} <url>`);
  const tailscaledSocket = await personWhois(self);
  const manifest = await store.manifest(image);
  const host = probeConfig.listen.host;
  if (options.resolvesToProbe) {
    const resolved = (await lookup(dnsName, { all: true })).map((a) => a.address);
    if (!resolved.includes(host)) throw new Error(`${dnsName} resolves to ${resolved.join(", ")}, not to the probe's address ${host}`);
  }

  /** A control plane over the registry in `dir`, on the probe's address, with this node as its only node. */
  const planeConfig = (dir: string): ControlPlaneConfig => ({
    db: join(dir, "registry.db"),
    listen: { host, port: 0, hostnames: [host] },
    self: { tailnetNodeId: self },
    nodes: [{ name: probeConfig.node, tailnetHost: dnsName, tailnetNodeId: self }],
    callers: [checkPerson],
    tailscaledSocket,
    dotfiles: { repo: "https://github.com/octocat/Spoon-Knife.git", ref: "main" },
    harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "unused-credentials.json"), model: scriptedModel },
    previewPorts: defaultPreviewPorts,
    resumeAfterUsageLimit: false,
  });

  const startPlane = async (config: ControlPlaneConfig) => {
    // A rollout needs a deployer, which the control plane's own node never is, so the check makes the image current in the registry.
    const seed = openRegistry(config.db);
    seed.saveImage(manifest!, null);
    seed.setCurrentImage(image);
    seed.close();
    return await startControlPlane(config, scriptedModels());
  };

  const serveJson = () => tailscale(["serve", "status", "--json"], AbortSignal.timeout(30_000));

  /**
   * Refuses to go on while tailscale serve serves a port in `ports`, which this check's previews would get. Taking over
   * an entry there would break whatever owns it. With `exceptGateway`, the probe's gateway may serve them.
   */
  const refuseServedPorts = async (ports: PortRange, { exceptGateway = false } = {}) => {
    for (const [port, listener] of parseServeStatus(await serveJson(), `http://127.0.0.1:${previews.gatewayPort}`)) {
      if (port < ports.first || port > ports.last) continue;
      if (!exceptGateway) throw new Error(`tailscale serve already serves port ${port}, which this check's previews would get. Free it first`);
      if (listener.kind === "other") throw new Error(`tailscale serve serves port ${port} with something other than the probe's gateway. Free it first`);
    }
  };

  return {
    probeConfig,
    stateRoot: backend.stateRoot,
    image,
    previews,
    dnsName,
    host,
    serveJson,
    serveStatus: async () => JSON.parse(await serveJson()) as { TCP?: Record<string, unknown> },
    refuseServedPorts,
    planeConfig,
    startPlane,
  };
}

/** Who the check is to its control planes: the person who runs it, since only a person starts or messages a thread. */
const checkPerson = "nNODECHECK" as TailnetNodeId;

/**
 * A LocalAPI socket that answers whois as tailscaled does, but names this node as `checkPerson` on any port but the
 * probe's, so the check's own requests reach its control planes as a person's and the probe is still this node.
 */
async function personWhois(self: TailnetNodeId): Promise<string> {
  const whois = localApiWhois();
  const dir = await mkdtemp(join(tmpdir(), "nexus-node-check-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, "tailscaled.sock");
  const server = createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    const at = addr.lastIndexOf(":");
    const port = Number(addr.slice(at + 1));
    whois(addr.slice(0, at).replace(/^\[(.*)\]$/, "$1"), port).then((id) => {
      if (id === null) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: id === self && port !== probePort ? checkPerson : id } }));
    }, (err: Error) => res.writeHead(502).end(err.message));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
  server.unref();
  return socket;
}

/** A client of a control plane's API. It reads the port at each request, so it follows a control plane the check replaces. */
export function apiClient(host: string, port: () => number) {
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const { status, text } = await callText({ host, port: port(), method, path: `/v1${path}`, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status, body: text === "" ? null : JSON.parse(text) };
  }

  async function expect(status: number, method: string, path: string, body?: unknown) {
    const res = await call(method, path, body);
    if (res.status !== status) throw new Error(`${method} ${path}: HTTP ${res.status}, expected ${status}: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  const detail = async (threadId: string) => await expect(200, "GET", `/threads/${threadId}`) as ThreadDetail;

  /** The planner deletes a failed pylon all the same, so a deleted thread's wait ignores an earlier failure. */
  const reaches = (threadId: string, state: string, timeoutMs: number, pylon = "the pylon") => until(`${pylon} is ${state}`, timeoutMs, async () => {
    const d = await detail(threadId);
    if (d.pylon.failed !== null && d.thread.status !== "deleted") throw new Error(`the planner gave up on the pylon: ${d.pylon.failed}`);
    return d.pylon.actualState === state ? d : undefined;
  });

  /**
   * Sends `bash: <command>`, which the scripted model turns into one bash call, waits for the run to end, and returns
   * that call's result as `read` gives it. With `stepLimitS`, the command runs under `timeout`, so one that hangs ends
   * the agent's turn after that and fails the check by name.
   */
  async function runTool(threadId: string, requestId: string, command: string, { stepLimitS, read = JSON.stringify }: { stepLimitS?: number; read?: (result: ToolResult) => string } = {}): Promise<string> {
    const results = async () => ((await expect(200, "GET", `/threads/${threadId}/conversation`)) as { entries: ToolResult[] }).entries.filter((e) => e.kind === "pi.tool-result").map((e) => read(e));
    const seen = (await results()).length;
    const bounded = stepLimitS === undefined ? command : `timeout ${stepLimitS} bash -c ${shellQuote(command)}; code=$?; if [ $code = 124 ]; then echo "STEP TIMED OUT"; fi`;
    await expect(202, "POST", `/threads/${threadId}/messages`, { text: `bash: ${bounded}`, requestId });
    const result = await until(`the result of ${requestId} is in the conversation`, stepLimitS === undefined ? 6 * 60_000 : (stepLimitS + 60) * 1000, async () => (await results())[seen]);
    await until("the run ends", 60_000, async () => (await detail(threadId)).thread.agentTurnRunning ? undefined : true);
    if (stepLimitS !== undefined && result.includes("STEP TIMED OUT")) throw new Error(`${requestId} ran past ${stepLimitS} s: ${result}`);
    return result;
  }

  /** Runs the real CLI against the control plane, directly on the tailnet. */
  const runCli = (args: readonly string[]): Promise<Exit> => exit(process.execPath, [cli, ...args, "--url", `http://${host}:${port()}`, "--socks", "none"]);

  /** Deletes a thread the check left behind and waits for its pylon to be absent, or says what to delete by hand. */
  const cleanup = (threadId: string) => call("DELETE", `/threads/${threadId}`).then(() => reaches(threadId, "absent", 5 * 60_000)).catch((err: unknown) => {
    console.error(`cleanup: could not delete ${threadId}: ${(err as Error).message}. Delete pylon-${threadId} on the probe by hand`);
  });

  return { call, expect, detail, reaches, runTool, runCli, cleanup };
}

const cli = fileURLToPath(new URL("../cli/nexus.ts", import.meta.url));

export type ToolResult = { kind: string; model?: { content: { type: string; text?: string }[] }[] };

/**
 * A tool result's output as text, so a check can anchor on its lines. A command that prints nothing has a result with
 * no content, which reads as "". A result with no model entry is a shape the checks do not know, so it fails loudly.
 */
export function toolText(result: ToolResult): string {
  if (result.model === undefined || result.model.length === 0) throw new Error(`a tool result has no model entry: ${JSON.stringify(result)}`);
  return result.model.flatMap((m) => m.content).flatMap((c) => c.type === "text" && c.text !== undefined ? [c.text] : []).join("\n");
}

export async function until<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting until ${what}`);
    await delay(1_000);
  }
}

/** Logs `PASS <step>` with the seconds since this was called. */
export function passLogger(): (step: string) => void {
  const started = performance.now();
  return (step) => console.log(`PASS ${step} (${Math.round((performance.now() - started) / 1000)} s)`);
}

/** Fetches the URL from this node until `accept` returns a value for its answer. A timeout names the last answer. */
export async function fetchUntil<T>(url: string, what: string, accept: (status: number, text: string) => T | undefined): Promise<T> {
  let last = "no answer yet";
  return await until(`${url} answers ${what}`, 2 * 60_000, async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      last = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      return accept(res.status, text);
    } catch (err) {
      last = (err as Error).message;
      return undefined;
    }
  }).catch((err: Error) => { throw new Error(`${err.message}. Last answer: ${last}`); });
}
