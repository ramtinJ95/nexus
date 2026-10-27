/**
 * What the node checks run by hand share: thread-on-node.ts, v6-preview-on-node.ts and drift-on-node.ts. Each checks
 * the node's probe config, runs control planes in its own process over temporary registries with the scripted model,
 * and drives the probe through their HTTP API.
 */
import { lookup } from "node:dns/promises";
import { request } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { artifactDirectory, tarCodec } from "../artifacts.ts";
import { isImageId, probePort, tailnetNodeIdSchema } from "../protocol.ts";
import { scriptedModel, scriptedModels } from "../harness/test-fixture.ts";
import { parseSelfDnsName, readProbeConfig } from "../probe/config.ts";
import { tailscaleCli } from "../probe/serve.ts";
import type { ThreadDetail } from "./api.ts";
import { defaultPreviewPorts, startControlPlane, type ControlPlaneConfig } from "./main.ts";
import { openRegistry } from "./registry.ts";

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
  if (probeConfig.auth.controlPlane !== self) throw new Error(`set auth.controlPlane in the probe's config to this node's ID ${self} (it is ${probeConfig.auth.controlPlane}), then restart the probe`);
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
    callers: [],
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

  return {
    probeConfig,
    stateRoot: backend.stateRoot,
    image,
    previews,
    dnsName,
    host,
    serveJson: () => tailscale(["serve", "status", "--json"], AbortSignal.timeout(30_000)),
    planeConfig,
    startPlane,
  };
}

/** A client of a control plane's API. It reads the port at each request, so it follows a control plane the check replaces. */
export function apiClient(host: string, port: () => number) {
  function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host, port: port(), method, path: `/v1${path}`,
        headers: { host: `${host}:${port()}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
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

  /** The planner deletes a failed pylon all the same, so a deleted thread's wait ignores an earlier failure. */
  const reaches = (threadId: string, state: string, timeoutMs: number, pylon = "the pylon") => until(`${pylon} is ${state}`, timeoutMs, async () => {
    const d = await detail(threadId);
    if (d.pylon.failed !== null && d.thread.status !== "deleted") throw new Error(`the planner gave up on the pylon: ${d.pylon.failed}`);
    return d.pylon.actualState === state ? d : undefined;
  });

  /** Sends `bash: <command>`, which the scripted model turns into one bash call, waits for the run to end, and returns that call's result. */
  async function runTool(threadId: string, requestId: string, command: string): Promise<string> {
    const results = async () => ((await expect(200, "GET", `/threads/${threadId}/conversation`)) as { entries: { kind: string }[] }).entries.filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e));
    const seen = (await results()).length;
    await expect(202, "POST", `/threads/${threadId}/messages`, { text: `bash: ${command}`, requestId });
    const result = await until("the tool result is in the conversation", 6 * 60_000, async () => (await results())[seen]);
    await until("the run ends", 60_000, async () => (await detail(threadId)).thread.agentTurnRunning ? undefined : true);
    return result;
  }

  /** Deletes a thread the check left behind and waits for its pylon to be absent, or says what to delete by hand. */
  const cleanup = (threadId: string) => call("DELETE", `/threads/${threadId}`).then(() => reaches(threadId, "absent", 5 * 60_000)).catch((err: unknown) => {
    console.error(`cleanup: could not delete ${threadId}: ${(err as Error).message}. Delete pylon-${threadId} on the probe by hand`);
  });

  return { call, expect, detail, reaches, runTool, cleanup };
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
