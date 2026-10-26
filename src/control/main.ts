import { turnGate } from "./drain.ts";
/**
 * The control plane process: `node src/control/main.ts <config.json>`, run by deploy/nexus-control.service.
 * It opens the registry, follows every configured node's probe, runs every thread's agent in the harness, and
 * serves the API until SIGINT or SIGTERM.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { connectProbe, type NodeName, type TailnetNodeId } from "../protocol.ts";
import { gitIdentitySchema, gitUrl } from "../project.ts";
import { ingest } from "../reconcile.ts";
import { linuxTailscaledSocket, localApiWhois, localApiCertificate } from "../tailscale.ts";
import type { Models } from "@earendil-works/pi-ai/models";
import { chatgptToken, harnessModels, openCredentials, requireModel } from "../harness/credentials.ts";
import { openHarnessHost, type ConversationId } from "../harness/host.ts";
import { startApi } from "./api.ts";
import { registryLocator } from "./locator.ts";
import { startLoop } from "./loop.ts";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { githubClient, githubRepo } from "./github.ts";
import { agentReplies, reviewLoop } from "./review.ts";
import { threadStarter } from "./threads.ts";
import { projectMirror } from "./mirror.ts";
import { checkRuns } from "./gate.ts";
import { repository } from "../deploy/install.ts";
import { prWatcher } from "./pr-watch.ts";
import { agentInbox } from "./inbox.ts";
import { usageLimitResumer } from "./usage-limit.ts";
import { startImageRollout } from "./image-rollout.ts";
import { loadImageRecipe } from "../image-build.ts";
import { runningCommit } from "../deploy/health.ts";
import { chatgptTokenHandoff } from "./chatgpt-token.ts";

const nodeId = z.string().regex(/^n[A-Za-z0-9]+$/, "a Tailscale stable node ID, such as nAbC123CNTRL");
const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const port = z.int().min(1).max(65_535);

/** Clear of the probe's port and its gateway's, 7480 and 7481 by default. */
export const defaultPreviewPorts = { first: 10200, last: 10999 } as const;

const configSchema = z.strictObject({
  db: z.string().min(1),
  https: z.strictObject({ hostname: z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/) }).optional(),
  gitIdentity: gitIdentitySchema.optional(),
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
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).refine((name) => name !== "auto", "auto is what `start --node auto` asks for, so no node may be named it"),
    tailnetHost: z.string().min(1),
    tailnetNodeId: nodeId,
  })).min(1),
  /** Where `nexus image build` builds: infra-testbench when omitted, where Docker access was first verified. */
  imageBuildNode: z.string().min(1).optional(),
  /** Other tailnet nodes, such as your laptop and phone, whose callers may use the API. */
  callers: z.array(nodeId),
  deployers: z.array(nodeId).optional(),
  deployKeys: z.record(nodeId, z.string().regex(/^[0-9a-f]{64}$/)).optional(),
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
    .refine((range) => range.first <= range.last && !(range.first <= 7443 && range.last >= 7443), "first must not be above last, and port 7443 is reserved for the dashboard")
    .default(defaultPreviewPorts),
  /** Type "continue" into a Claude worker that stopped on its usage limit, once the limit resets. Off unless set. */
  resumeAfterUsageLimit: z.boolean().default(false),
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
  const { imageBuildNode } = result.data;
  if (imageBuildNode !== undefined && !names.includes(imageBuildNode)) throw new Error(`invalid control plane config: imageBuildNode ${imageBuildNode} is not one of the nodes`);
  if (result.data.https && !result.data.listen.hostnames.includes(result.data.https.hostname)) throw new Error("https.hostname must be in listen.hostnames");
  return result.data;
}

export interface ControlPlane {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Everything but the model login, so src/control/thread-on-node.ts runs this same wiring with a scripted model.
 * `chatgptToken` reads the token every probe is handed for the chatgpt login. Without it, probes get none.
 */
export async function startControlPlane(config: ControlPlaneConfig, models: Models, chatgptToken?: () => Promise<string | undefined>): Promise<ControlPlane> {
  const token = config.github ? (await readFile(config.github.tokenFile, "utf8")).trim() : null;
  if (token !== null && !/^[A-Za-z0-9_]+$/.test(token)) throw new Error("github.tokenFile must contain only a GitHub token");
  const tailscaled = config.tailscaledSocket ?? linuxTailscaledSocket;
  const whois = localApiWhois(tailscaled);
  const registry = openRegistry(config.db);
  for (const node of config.nodes) {
    registry.upsertNode({ name: node.name as NodeName, tailnetHost: node.tailnetHost, tailnetNodeId: node.tailnetNodeId as TailnetNodeId });
  }
  const probes = config.nodes.map((n) => connectProbe(n.name as NodeName, n.tailnetHost, n.tailnetNodeId as TailnetNodeId, { whois }));
  const loop = startLoop({ registry, probes, ingest, previewPorts: config.previewPorts, gitIdentity: config.gitIdentity });
  const wakeThread = (t: Thread) => { void loop.wake(registry.pylon(t.pylonId)!.node); };

  const conversing = registry.threads().filter((t) => t.conversationId !== null);
  const conversationOf = (t: Thread) => Number(t.conversationId) as ConversationId;
  const rawHarness = await openHarnessHost({
    storagePath: config.harness.storage,
    models,
    model: config.harness.model,
    locator: registryLocator(registry),
    tailscaled,
    threads: conversing.filter((t) => t.status !== "deleted").map((t) => ({ threadId: t.id, conversationId: conversationOf(t), agentTurnRunning: t.agentTurnRunning })),
    deleted: conversing.filter((t) => t.status === "deleted").map(conversationOf),
    // The registry row is what the planner and the dashboard read.
    onParked: (id, parked) => registry.recordParked(id as ThreadId, parked),
    onReply: (id, at) => registry.recordReply(id as ThreadId, at),
    onActivity(threadId, facts) {
      const t = registry.thread(threadId as ThreadId)!;
      registry.recordActivity(t.id, { agent: facts.lastAgentActivityAt, agentTurnRunning: facts.agentTurnRunning });
      wakeThread(t);
    },
    log: (message) => console.error(message),
  });

  const gate = turnGate(() => registry.drain()?.locked === true || (registry.drain()?.expiresAt ?? 0) > Date.now());
  const harness: typeof rawHarness = {
    ...rawHarness,
    startThread: (...args) => gate.run(() => rawHarness.startThread(...args)),
    send: (...args) => gate.run(() => rawHarness.send(...args)),
    retry: (...args) => gate.run(() => rawHarness.retry(...args)),
  };
  const probeMap = new Map(probes.map((probe) => [probe.node, probe]));
  const images = startImageRollout({
    registry, probes: probeMap, buildNode: (config.imageBuildNode ?? "infra-testbench") as NodeName, recipe: () => loadImageRecipe(), release: runningCommit,
  });
  const inbox = agentInbox({ registry, harness, probes: probeMap, wake: wakeThread });
  const github = token === null ? null : githubClient(token);
  const watch = prWatcher({ registry, github, inbox });
  const watchTimer = setInterval(() => { void watch.poll(); }, 120_000);
  void watch.poll();
  const handoff = chatgptToken === undefined ? null : chatgptTokenHandoff({ probes, token: chatgptToken });
  const handoffTimer = setInterval(() => { void handoff?.poll(); }, 60_000);
  handoffTimer.unref();
  void handoff?.poll();
  const resumer = config.resumeAfterUsageLimit ? usageLimitResumer({ registry, inbox }) : null;
  const resumeTimer = setInterval(() => { void resumer?.poll(); }, 30_000);
  resumeTimer.unref();
  void resumer?.poll();
  const mirror = projectMirror({ githubToken: token });
  const startThread = threadStarter({ registry, harness, mirror, dotfiles: config.dotfiles, gitIdentity: config.gitIdentity, wake: (node) => { void loop.wake(node); } });
  const reviews = github === null ? null : reviewLoop({
    registry, github, inbox, harnessModel: config.harness.model.modelId, startThread,
    replies: agentReplies(registry, harness),
    checks: checkRuns({ registry, probes: probeMap, startThread, wake: wakeThread }),
    release: { self: config.self.tailnetNodeId, repo: githubRepo(repository)! },
    log: (message) => console.error(message),
  });
  const reviewTimer = setInterval(() => { void reviews?.poll(); }, 15_000);
  void reviews?.poll();
  const api = await startApi({
    ...(config.https ? { https: { port: 7443, certificate: () => localApiCertificate(config.https!.hostname, tailscaled) } } : {}),
    prWatchEnabled: token !== null,
    reviews,
    turnsStarting: gate.busy,
    deployment: { self: config.self.tailnetNodeId as TailnetNodeId, deployers: new Set((config.deployers ?? []) as TailnetNodeId[]), keys: config.deployKeys ?? {} },
    registry, whois, host: config.listen.host, port: config.listen.port,
    allowed: new Set([config.self.tailnetNodeId, ...config.callers] as TailnetNodeId[]),
    hostnames: new Set(config.listen.hostnames),
    dotfiles: config.dotfiles,
    gitIdentity: config.gitIdentity,
    harness,
    mirror,
    wake: (node) => { void loop.wake(node); },
    probes: new Map(probes.map((probe) => [probe.node, probe])),
    previewPorts: config.previewPorts,
    images,
  });
  console.error(`nexus control plane: API on ${config.listen.host}:${api.port}, following ${config.nodes.map((n) => n.name).join(", ")}`);

  return {
    port: api.port,
    async close() {
      clearInterval(watchTimer);
      clearInterval(reviewTimer);
      clearInterval(resumeTimer);
      clearInterval(handoffTimer);
      await watch.close();
      await handoff?.close();
      await resumer?.close();
      await reviews?.close();
      await api.close();
      await harness.close();
      await loop.close();
      await images.close();
      registry.close();
    },
  };
}

async function main(configPath: string) {
  const config = await readConfig(configPath);
  const credentials = await openCredentials(config.harness.credentials);
  const models = harnessModels(credentials);
  await requireModel(models, config.harness.model);
  const controlPlane = await startControlPlane(config, models, () => chatgptToken(models, credentials));
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
