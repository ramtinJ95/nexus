/**
 * The control plane process: `node src/control/main.ts <config.json>`, run by deploy/nexus-control.service.
 * It opens the registry, follows every configured node's probe, runs every thread's agent in the harness, and
 * serves the API until SIGINT or SIGTERM.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { NodeName, TailnetNodeId, ThreadId } from "../ids.ts";
import { nodeNameSchema, tailnetNodeIdSchema } from "../protocol/fields.ts";
import { connectProbe, type ProbeClient } from "../protocol/client.ts";
import { wakesDeployers } from "./releases.ts";
import { isDeployer, threadWaker } from "./api/access.ts";
import { gitIdentitySchema } from "../protocol/spawn.ts";
import { gitUrl } from "./project.ts";
import { ingest } from "./reconcile.ts";
import { linuxTailscaledSocket, localApiWhois, localApiWhoisNode, localApiCertificate } from "../node-base/tailscaled.ts";
import type { Models } from "@earendil-works/pi-ai/models";
import { chatgptToken, harnessModels, loginState, openCredentials, requireModel } from "./harness/credentials.ts";
import { gateTurns, openHarnessHost, type ConversationId } from "./harness/host.ts";
import { startApi } from "./api/server.ts";
import { registryLocator } from "./locator.ts";
import { jobDeadlineMs } from "../protocol/jobs.ts";
import { startLoop } from "./loop.ts";
import { openRegistry, type Registry } from "./registry.ts";
import type { NodeRecord } from "./node-store.ts";
import { peerHandoff } from "./peers.ts";
import { githubClient, githubRepo } from "./github.ts";
import { reviewLoop } from "./review.ts";
import { agentReader } from "./agent-conversation.ts";
import { threadServices } from "./thread-services.ts";
import { projectMirror } from "./mirror.ts";
import { checkRuns, verifyGate } from "./gate.ts";
import { repository } from "../deploy/install.ts";
import { digestPattern, tsNet } from "../protocol/deploy.ts";
import { prWatcher } from "./pr-watch.ts";
import { prWatchMs } from "./pr-watch-model.ts";
import { builderNudger } from "./nudge.ts";
import { judgmentPass } from "./judgment.ts";
import { cleanupEveryMs, cleanupPass } from "./cleanup.ts";
import { agentInbox } from "./inbox.ts";
import { usageLimitResumer } from "./usage-limit.ts";
import { deadTurnResumer } from "./resume.ts";
import { usageCounter } from "./usage-counter.ts";
import { usageBackfill } from "./usage-backfill.ts";
import { startImageRollout } from "./image-rollout.ts";
import { loadImageRecipe } from "../image/recipe.ts";
import { runningCommit } from "../deploy/health.ts";
import { chatgptTokenHandoff } from "./chatgpt-token.ts";
import { isDraining, turnGate } from "./drain.ts";
import { checkEveryMs, healthPasses, runDoctor, servedCertificate } from "./doctor-run.ts";
import { backedUpAt, readBackupStatus } from "./backup-status.ts";
import { backupStatusFile, controlPath, ports } from "../node-base/node-layout.ts";
import { backgroundReadMs, recordingHealth, sampleOf } from "./node-metrics.ts";
import { drainNodeMetrics } from "./node-metrics-store.ts";
import { healthSampling } from "./health-sampling.ts";
import { services as startServices } from "./services.ts";

const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const port = z.int().min(1).max(65_535);

/** Clear of every port in the node layout. */
export const defaultPreviewPorts = { first: 10200, last: 10999 } as const;

/** Where Docker access was first verified. It need not be one of the nodes: its builds then fail as offline. */
export const defaultImageBuildNode = "infra-testbench" as NodeName;

const configSchema = z.strictObject({
  db: z.string().min(1).transform(controlPath),
  https: z.strictObject({ hostname: z.string().regex(tsNet) }).optional(),
  gitIdentity: gitIdentitySchema.optional(),
  github: z.strictObject({ tokenFile: absolutePath }).optional(),
  listen: z.strictObject({
    host: z.string().min(1),
    port: z.int().min(0).max(65_535),
    /** Every name callers use for the API, such as the MagicDNS name, the full ts.net name and the tailnet IP. */
    hostnames: z.array(z.string().min(1)).min(1),
  }),
  /** The control plane's own tailnet node. The CLI on the same machine calls the API as this node. */
  self: z.strictObject({ tailnetNodeId: tailnetNodeIdSchema }),
  nodes: z.array(z.strictObject({
    name: nodeNameSchema,
    tailnetHost: z.string().min(1),
    tailnetNodeId: tailnetNodeIdSchema,
  })).min(1),
  /** Where `nexus image build` builds. */
  imageBuildNode: nodeNameSchema.default(defaultImageBuildNode),
  /** Other tailnet nodes, such as your laptop and phone, whose callers may use the API. */
  callers: z.array(tailnetNodeIdSchema),
  deployers: z.array(tailnetNodeIdSchema).optional(),
  deployKeys: z.record(tailnetNodeIdSchema, z.string().regex(digestPattern)).optional(),
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
    .refine((range) => range.first <= range.last && !(range.first <= ports.dashboard && range.last >= ports.dashboard), `first must not be above last, and port ${ports.dashboard} is reserved for the dashboard`)
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
  if (imageBuildNode !== defaultImageBuildNode && !names.includes(imageBuildNode)) throw new Error(`invalid control plane config: imageBuildNode ${imageBuildNode} is not one of the nodes`);
  if (result.data.https && !result.data.listen.hostnames.includes(result.data.https.hostname)) throw new Error("https.hostname must be in listen.hostnames");
  return result.data;
}

export interface ControlPlane {
  readonly port: number;
  /** The plane's own registry. Its event followers see only the events appended through it, never another connection's. */
  readonly registry: Registry;
  close(): Promise<void>;
}

/** How often a service with no interval of its own polls. */
const passMs = 15_000;

type NodeAddress = Pick<NodeRecord, "name" | "tailnetHost" | "tailnetNodeId">;

export interface ControlPlaneOptions {
  /** Reads the token every probe is handed for the chatgpt login. Without it, probes get none. */
  chatgptToken?: () => Promise<string | undefined>;
  /** Stands in for each node's probe in tests. */
  probe?: (node: NodeAddress) => ProbeClient;
}

/** Everything but the model login, so src/checks/control/thread-on-node.ts runs this same wiring with a scripted model. */
export async function startControlPlane(config: ControlPlaneConfig, models: Models, { chatgptToken, probe }: ControlPlaneOptions = {}): Promise<ControlPlane> {
  const token = config.github ? (await readFile(config.github.tokenFile, "utf8")).trim() : null;
  if (token !== null && !/^[A-Za-z0-9_]+$/.test(token)) throw new Error("github.tokenFile must contain only a GitHub token");
  const tailscaled = config.tailscaledSocket ?? linuxTailscaledSocket;
  const whois = localApiWhois(tailscaled);
  const registry = openRegistry(config.db);
  for (const node of config.nodes) {
    registry.nodes.upsertNode({ name: node.name, tailnetHost: node.tailnetHost, tailnetNodeId: node.tailnetNodeId });
  }
  // It grows when a node joins, and everything handed it reads it when it acts.
  const probeMap = new Map<NodeName, ProbeClient>();
  const log = (message: string) => console.error(message);
  /** Every health read, the node page's, the API's and a judgment's, goes through the client, so each is recorded here. */
  const connect = (node: NodeAddress) => {
    const client = recordingHealth(probe?.(node) ?? connectProbe(node.name, node.tailnetHost, node.tailnetNodeId, { whois }),
      (h) => registry.nodeMetrics.recordHealthSample(node.name, sampleOf(h, Date.now(), (p) => registry.threads.pylon(p)?.thread ?? null)), log);
    probeMap.set(node.name, client);
    return client;
  };
  for (const node of [...config.nodes, ...registry.nodes.joinedNodes()]) if (!probeMap.has(node.name)) connect(node);
  const services = startServices();
  const handoff = services.start(chatgptToken === undefined ? null : { everyMs: 60_000, ...chatgptTokenHandoff({ probes: () => [...probeMap.values()], token: chatgptToken }) });
  const peers = services.start(peerHandoff({ registry, probes: probeMap, log }));
  const loop = services.start(startLoop({
    registry, probes: [...probeMap.values()], previewPorts: config.previewPorts, gitIdentity: config.gitIdentity, ingest,
    onSnapshot(node, observation) {
      handoff?.observed(observation);
      peers.observed(node, observation.probeBootId);
    },
  }));
  const wake = (node: NodeName) => { void loop.wake(node); };
  const wakeThread = threadWaker(registry, wake);

  const conversations = registry.threads.harnessThreads().map((thread) => ({ thread, id: Number(thread.conversationId) as ConversationId }));
  const rawHarness = services.start(await openHarnessHost({
    storagePath: config.harness.storage,
    models,
    model: config.harness.model,
    locator: registryLocator({ registry, probes: probeMap, woken: loop.woken, waitMs: jobDeadlineMs.spawn }),
    tailscaled,
    threads: conversations.filter(({ thread }) => thread.status !== "deleted").map(({ thread, id }) => ({ threadId: thread.id, conversationId: id, agentTurnRunning: thread.agentTurnRunning })),
    deleted: conversations.filter(({ thread }) => thread.status === "deleted").map(({ id }) => id),
    onAborted: (id) => registry.threads.recordAborted(String(id)),
    // The registry row is what the planner and the dashboard read.
    onParked: (id, parked) => registry.threads.recordParked(id as ThreadId, parked),
    onReply: (id, at) => registry.threads.recordReply(id as ThreadId, at),
    onActivity(threadId, facts) {
      const t = registry.threads.thread(threadId as ThreadId)!;
      registry.threads.recordActivity(t.id, { agent: facts.lastAgentActivityAt, agentTurnRunning: facts.agentTurnRunning });
      wakeThread(t);
    },
    log,
  }));

  const gate = turnGate(() => isDraining(registry.releases.drain(), registry.now()));
  const harness = gateTurns(rawHarness, gate);
  const images = services.start(startImageRollout({
    registry, probes: probeMap, buildNode: config.imageBuildNode, recipe: () => loadImageRecipe(), release: runningCommit,
  }));
  const inbox = agentInbox({ registry, harness, probes: probeMap, wake: wakeThread, log });
  const agents = agentReader(registry, harness);
  const usage = services.start(usageCounter({ registry, probes: probeMap, harness }));
  const github = token === null ? null : githubClient(token);
  services.start(config.resumeAfterUsageLimit ? { everyMs: 30_000, ...usageLimitResumer({ registry, inbox, log }) } : null);
  const mirror = projectMirror({ githubToken: token });
  const backfill = services.start(usageBackfill({ registry, counter: usage, wake }));
  const threads = services.start(threadServices({
    registry, harness, mirror, dotfiles: config.dotfiles, gitIdentity: config.gitIdentity, wake, gate, log,
    queue: github !== null, planning: { replies: agents.replies },
  }));
  const { startThread, queue, pipeline, planning } = threads.api;
  const deployment = { self: config.self.tailnetNodeId, deployers: new Set(config.deployers ?? []), keys: config.deployKeys ?? {} };
  const checkRunDeps = { registry, probes: probeMap, startThread, wake: wakeThread };
  const reviews = services.start(github === null ? null : { everyMs: passMs, ...reviewLoop({
    registry, github, inbox, harnessModel: config.harness.model.modelId, startThread,
    agentState: agents.state,
    brief: agents.brief,
    runs: (ended) => ({ checks: checkRuns({ ...checkRunDeps, ended }), live: checkRuns({ ...checkRunDeps, gate: verifyGate, ended }) }),
    release: { self: config.self.tailnetNodeId, repo: githubRepo(repository)! },
    mayLand: (caller) => isDeployer(registry, deployment, caller as TailnetNodeId),
    wake: wakeThread,
    log,
  }) });
  const watch = services.start({ everyMs: prWatchMs, ...prWatcher({ registry, github, inbox, linked: reviews?.auto, fresh: (t) => loop.readGit(registry.threads.pylon(t.pylonId)!.node, t.pylonId) }) });
  // The events only run a step sooner: each poll above stays its fallback.
  services.start({ close: registry.threads.followEvents(["session.turn-ended", "thread.turn-ended", "release.changed"], (events) => {
    for (const id of new Set(events.flatMap((e) => e.kind === "release.changed" ? [] : e.thread ?? []))) {
      void watch.turnEnded(id as ThreadId);
      void reviews?.wake(id as ThreadId);
    }
    if (!events.some((e) => wakesDeployers(registry, e))) return;
    for (const probe of probeMap.values()) probe.wakeDeployer().catch((err: unknown) => log(`${probe.node}: waking its deployer failed: ${(err as Error).message}`));
  }) });
  services.start({ everyMs: passMs, poll: () => registry.threads.retainEvents() });
  for (const polled of threads.polls) services.start(polled && { everyMs: passMs, poll: () => polled.poll() });
  services.start(github === null ? null : { everyMs: passMs, ...builderNudger({ registry, github, inbox, personWroteTo: agents.personWrote, replies: agents.replies, wake: wakeThread, watch }) });
  services.start({ everyMs: passMs, ...deadTurnResumer({ registry, inbox, personWroteTo: agents.personWrote }) });
  // Judgments need no GitHub, so they run without a token too.
  services.start({ everyMs: passMs, ...judgmentPass({ registry, harness, probes: probeMap, wake }) });
  const cleanup = services.start({ everyMs: cleanupEveryMs, ...cleanupPass({ registry, probes: probeMap, log }) });
  const startedAt = Date.now();
  const doctor = () => runDoctor({
    registry, self: config.self.tailnetNodeId, startedAt,
    backupStatus: () => readBackupStatus(backupStatusFile),
    login: () => loginState(models, config.harness.model),
    // The API listens on one address, or on every one, where the loopback reaches it too.
    certificate: async () => config.https ? servedCertificate(config.listen.host === "0.0.0.0" ? "127.0.0.1" : config.listen.host === "::" ? "::1" : config.listen.host, ports.dashboard, config.https.hostname) : { kind: "none" },
  });
  // An archived disk kept for its usage goes once a backup that began after its read verified.
  services.start({ everyMs: 60_000, poll: () => readBackupStatus(backupStatusFile).then((s) => {
    const at = backedUpAt(s);
    if (at !== null) registry.threads.recordBackedUp(at);
  }).catch((err: unknown) => log(`recording the newest backup failed: ${(err as Error).message}`)) });
  const health = services.start({ everyMs: checkEveryMs, ...healthPasses({ registry, run: doctor, startedAt }) });
  services.start({ everyMs: backgroundReadMs, ...healthSampling({ registry, probes: probeMap, log }) });
  services.start({ everyMs: 60_000, poll: () => drainNodeMetrics(registry.nodeMetrics.pruneNodeMetrics, Date.now()).catch((err: unknown) => log(`pruning node metrics failed: ${(err as Error).message}`)) });
  const api = services.start(await startApi({
    ...(config.https ? { https: { port: ports.dashboard, certificate: () => localApiCertificate(config.https!.hostname, tailscaled) } } : {}),
    prWatchEnabled: token !== null,
    features: { reviews, queue, pipeline, planning, cleanup, images, usageBackfill: backfill, doctor },
    startThread,
    gate,
    deployment,
    registry, whois, host: config.listen.host, port: config.listen.port,
    allowed: new Set([config.self.tailnetNodeId, ...config.callers]),
    joins: {
      whois: localApiWhoisNode(tailscaled),
      configured: new Set(config.nodes.map((n) => n.tailnetNodeId)),
      joined(node) {
        if (!probeMap.has(node.name)) loop.follow(connect(node));
        void peers.all();
        console.error(`nexus control plane: ${node.name} joined as tailnet node ${node.tailnetNodeId}, following it`);
      },
    },
    hostnames: new Set(config.listen.hostnames),
    harness,
    wake,
    probes: probeMap,
    previewPorts: config.previewPorts,
    health: health.latest,
    log,
  }));
  console.error(`nexus control plane: API on ${config.listen.host}:${api.port}, following ${[...probeMap.keys()].join(", ")}`);

  return {
    port: api.port,
    registry,
    async close() {
      try {
        await services.close();
      } finally {
        registry.close();
      }
    },
  };
}

async function main(configPath: string) {
  const config = await readConfig(configPath);
  const credentials = await openCredentials(config.harness.credentials);
  const models = harnessModels(credentials);
  await requireModel(models, config.harness.model);
  const controlPlane = await startControlPlane(config, models, { chatgptToken: () => chatgptToken(models, credentials) });
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
