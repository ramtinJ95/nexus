/**
 * The control plane process: `node src/control/main.ts <config.json>`, run by deploy/nexus-control.service.
 * It opens the registry, follows every configured node's probe, runs every thread's agent in the harness, and
 * serves the API until SIGINT or SIGTERM.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { connectProbe, type NodeName, type TailnetNodeId } from "../protocol.ts";
import { gitUrl } from "../project.ts";
import { ingest } from "../reconcile.ts";
import { linuxTailscaledSocket, localApiWhois } from "../tailscale.ts";
import type { Models } from "@earendil-works/pi-ai/models";
import { harnessModels, openCredentials, requireModel } from "../harness/credentials.ts";
import { openHarnessHost, type ConversationId } from "../harness/host.ts";
import { startApi } from "./api.ts";
import { registryLocator } from "./locator.ts";
import { startLoop } from "./loop.ts";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { githubClient } from "./github.ts";
import { prWatcher } from "./pr-watch.ts";

const nodeId = z.string().regex(/^n[A-Za-z0-9]+$/, "a Tailscale stable node ID, such as nAbC123CNTRL");
const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const port = z.int().min(1).max(65_535);

/** Clear of the probe's port and its gateway's, 7480 and 7481 by default. */
export const defaultPreviewPorts = { first: 10200, last: 10999 } as const;

const configSchema = z.strictObject({
  db: z.string().min(1),
  github: z.strictObject({ tokenFile: absolutePath }).optional(),
  listen: z.strictObject({
    host: z.string().min(1),
    port: z.int().min(0).max(65_535),
    /** Every name callers use for the API, such as the MagicDNS name, the full ts.net name and the tailnet IP. */
    hostnames: z.array(z.string().min(1)).min(1),
  }),
  /** The control plane's own tailnet node. The CLI on the same machine calls the API as this node. */
  self: z.strictObject({ tailnetNodeId: nodeId }),
  nodes: z.array(z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    tailnetHost: z.string().min(1),
    tailnetNodeId: nodeId,
  })).min(1),
  /** Other tailnet nodes, such as your laptop and phone, whose callers may use the API. */
  callers: z.array(nodeId),
  /** The common dotfiles layer every new pylon pulls on boot. */
  dotfiles: z.strictObject({ repo: gitUrl, ref: z.string().min(1) }),
  harness: z.strictObject({
    /** pi-durable's storage, such as /var/lib/nexus-control/harness.sqlite. Only this process may open it. */
    storage: absolutePath,
    /** The model login and the device ID, such as /var/lib/nexus-control/harness-credentials.json. */
    credentials: absolutePath,
    /** The model new threads start with, such as { "provider": "openai", "modelId": "gpt-6-astra" }. */
    model: z.strictObject({ provider: z.string().min(1), modelId: z.string().min(1) }),
  }),
  tailscaledSocket: z.string().min(1).optional(),
  /** The https ports previews are published on. Each node gives a port to one pylon at a time. */
  previewPorts: z.strictObject({ first: port, last: port })
    .refine((range) => range.first <= range.last, "first must not be above last")
    .default(defaultPreviewPorts),
});
export type ControlPlaneConfig = z.infer<typeof configSchema>;

export async function readConfig(path: string): Promise<ControlPlaneConfig> {
  try {
    return parseConfig(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export function parseConfig(text: string): ControlPlaneConfig {
  const result = configSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error(`invalid control plane config:\n${z.prettifyError(result.error)}`);
  const names = result.data.nodes.map((n) => n.name);
  if (new Set(names).size !== names.length) throw new Error(`invalid control plane config: node names repeat: ${names.join(", ")}`);
  return result.data;
}

export interface ControlPlane {
  readonly port: number;
  close(): Promise<void>;
}

/** Everything but the model login, so src/control/thread-on-node.ts runs this same wiring with a scripted model. */
export async function startControlPlane(config: ControlPlaneConfig, models: Models): Promise<ControlPlane> {
  const token = config.github ? (await readFile(config.github.tokenFile, "utf8")).trim() : null;
  if (token !== null && !/^[A-Za-z0-9_]+$/.test(token)) throw new Error("github.tokenFile must contain only a GitHub token");
  const tailscaled = config.tailscaledSocket ?? linuxTailscaledSocket;
  const whois = localApiWhois(tailscaled);
  const registry = openRegistry(config.db);
  for (const node of config.nodes) {
    registry.upsertNode({ name: node.name as NodeName, tailnetHost: node.tailnetHost, tailnetNodeId: node.tailnetNodeId as TailnetNodeId });
  }
  const probes = config.nodes.map((n) => connectProbe(n.name as NodeName, n.tailnetHost, n.tailnetNodeId as TailnetNodeId, { whois }));
  const loop = startLoop({ registry, probes, ingest, previewPorts: config.previewPorts });
  const wakeThread = (t: Thread) => { void loop.wake(registry.pylon(t.pylonId)!.node); };

  const conversing = registry.threads().filter((t) => t.conversationId !== null);
  const conversationOf = (t: Thread) => Number(t.conversationId) as ConversationId;
  const harness = await openHarnessHost({
    storagePath: config.harness.storage,
    models,
    model: config.harness.model,
    locator: registryLocator(registry),
    tailscaled,
    threads: conversing.filter((t) => t.status !== "deleted").map((t) => ({ threadId: t.id, conversationId: conversationOf(t), agentTurnRunning: t.agentTurnRunning })),
    deleted: conversing.filter((t) => t.status === "deleted").map(conversationOf),
    // The registry row is what the planner and the dashboard read.
    onReply: (id, at) => registry.recordReply(id as ThreadId, at),
    onActivity(threadId, facts) {
      const t = registry.thread(threadId as ThreadId)!;
      registry.recordActivity(t.id, { agent: facts.lastAgentActivityAt, agentTurnRunning: facts.agentTurnRunning });
      wakeThread(t);
    },
    log: (message) => console.error(message),
  });

  const watch = prWatcher({ registry, github: token === null ? null : githubClient(token), harness, wake: wakeThread });
  const watchTimer = setInterval(() => { void watch.poll(); }, 120_000);
  void watch.poll();
  const api = await startApi({
    prWatchEnabled: token !== null,
    registry, whois, host: config.listen.host, port: config.listen.port,
    allowed: new Set([config.self.tailnetNodeId, ...config.callers] as TailnetNodeId[]),
    hostnames: new Set(config.listen.hostnames),
    dotfiles: config.dotfiles,
    harness,
    wake: (node) => { void loop.wake(node); },
    probes: new Map(probes.map((probe) => [probe.node, probe])),
    previewPorts: config.previewPorts,
  });
  console.error(`nexus control plane: API on ${config.listen.host}:${api.port}, following ${config.nodes.map((n) => n.name).join(", ")}`);

  return {
    port: api.port,
    async close() {
      clearInterval(watchTimer);
      await watch.close();
      await api.close();
      await harness.close();
      await loop.close();
      registry.close();
    },
  };
}

async function main(configPath: string) {
  const config = await readConfig(configPath);
  const models = harnessModels(await openCredentials(config.harness.credentials));
  await requireModel(models, config.harness.model);
  const controlPlane = await startControlPlane(config, models);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { controlPlane.close().then(() => process.exit(0), (err: unknown) => { console.error(err); process.exit(1); }); });
  }
}

if (import.meta.main) {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    console.error("usage: node src/control/main.ts <config.json>");
    process.exit(2);
  }
  await main(configPath);
}
