/**
 * The reconcile loop. It follows every node's observe stream, folds each event into the registry, and ticks
 * every pylon on a node after each event and every 5 seconds.
 *
 * Each node has one pass at a time. A pass that is asked for while one runs is coalesced into a single
 * pass after it, so no two ticks of the same pylon overlap and a slow probe holds up only its own node.
 *
 * Previews: each ingested event gives every service a running pylon wants previewed a port from `previewPorts`.
 * Each pass renders the pylon's LiveSpec from its records before its tick, so a new port changes the liveHash and
 * the planner sends it in a spawn. The ports go back once its node neither has the pylon of a deleted thread nor routes
 * a preview to it.
 */
import { setTimeout as delay } from "node:timers/promises";
import { desiredPhase, type RegistryWrite } from "../reconcile.ts";
import { liveHashOf } from "../project.ts";
import { tick, type TickContext } from "../tick.ts";
import type { NodeName, NodeObservation, ProbeClient, ProbeError, ProbeEvent, PylonId, PylonObservation } from "../protocol.ts";
import type { ArtifactId } from "../images.ts";
import { pylonLive } from "./live.ts";
import type { PortRange, Registry, StoredPylon, Thread, ThreadId } from "./registry.ts";

/** reconcile.ts's ingest. `known` maps each registry pylon on the node to its last ingested observation. */
export type Ingest = (event: ProbeEvent, node: NodeName, known: ReadonlyMap<PylonId, PylonObservation | "absent">, now: number) => readonly RegistryWrite[];

export interface LoopOptions {
  registry: Registry;
  /** One client per registry node. */
  probes: readonly ProbeClient[];
  ingest: Ingest;
  /** The https ports each node's previews are allocated from. */
  previewPorts: PortRange;
  intervalMs?: number;
  /** How long an observe link stays down before the node is recorded offline. */
  offlineAfterMs?: number;
  /**
   * The probe sends a snapshot every 60 s, so a link quiet for longer is dead. A node that went to sleep
   * sends no reset, and without this its stream would look open forever.
   */
  silenceMs?: number;
  reconnectMs?: number;
  log?: (message: string) => void;
}

export interface Loop {
  /** Ticks every pylon on the node. Resolves once a pass that began after this call has finished. */
  wake(node: NodeName): Promise<void>;
  close(): Promise<void>;
}

interface Link {
  probe: ProbeClient;
  /** The planner acts on a node only while its observe stream is open. */
  up: boolean;
  pass: Promise<void> | null;
  again: boolean;
  offline: NodeJS.Timeout | null;
}

export function startLoop(options: LoopOptions): Loop {
  const { registry, ingest, previewPorts } = options;
  const intervalMs = options.intervalMs ?? 5_000;
  const offlineAfterMs = options.offlineAfterMs ?? 30_000;
  const reconnectMs = options.reconnectMs ?? 2_000;
  const silenceMs = options.silenceMs ?? 90_000;
  const log = options.log ?? ((message: string) => console.error(message));
  const shutdown = new AbortController();

  const links = new Map<NodeName, Link>();
  for (const probe of options.probes) {
    if (registry.node(probe.node) === undefined) throw new Error(`probe for ${probe.node}, which the registry does not know`);
    links.set(probe.node, { probe, up: false, pass: null, again: false, offline: null });
  }

  const observation = (node: NodeName): NodeObservation | null => links.get(node)?.up ? registry.node(node)?.observation ?? null : null;

  const holders = (from: NodeName) => (artifact: ArtifactId): readonly NodeName[] =>
    [...links.keys()].filter((node) => node !== from && observation(node)?.artifacts.includes(artifact));

  function artifactSha256(artifact: ArtifactId): string {
    const image = artifact.startsWith("img-") ? registry.image(artifact as `img-${string}`) : undefined;
    if (image === undefined) throw new Error(`the registry has no recorded sha256 for ${artifact}`);
    return image.sha256;
  }

  /** A port, once allocated, stays the pylon's while its thread lives, so its URL survives pauses and restarts. */
  function allocatePreviews(observation: NodeObservation) {
    for (const observed of observation.pylons) {
      if (observed.phase !== "running" || observed.services === null) continue;
      const pylon = registry.pylon(observed.pylonId);
      // A pylon reported by a node the registry does not place it on is an orphan there.
      if (pylon?.node !== observation.node || registry.thread(pylon.thread as ThreadId)!.status === "deleted") continue;
      try {
        registry.allocatePreviews(pylon.pylonId, observed.services.filter((s) => s.wantsPreview).map((s) => s.name), previewPorts);
      } catch (err) {
        log(`${pylon.pylonId}: ${(err as Error).message}`);
      }
    }
  }

  /** The pylon with the LiveSpec its records give now, saved if that changed. */
  function withLive(stored: StoredPylon, thread: Thread): StoredPylon {
    const live = pylonLive(stored, registry.project(thread.project)!, registry.node(stored.node)!, registry.previews(stored.pylonId));
    const liveHash = liveHashOf(live);
    if (liveHash === stored.liveHash) return stored;
    const updated = { ...stored, live, liveHash };
    registry.savePylon(updated);
    return updated;
  }

  async function pass(node: NodeName, link: Link) {
    for (const found of registry.pylonsOn(node)) {
      const thread = registry.thread(found.thread as ThreadId)!;
      const stored = withLive(found, thread);
      const pylon = { ...stored, desired: desiredPhase(thread, Date.now()) };
      const ctx: TickContext = {
        probe: link.probe,
        observation: observation(node),
        holders: holders(node),
        artifactSha256,
        save: (p) => registry.savePylon(p),
      };
      try {
        const step = await tick(pylon, ctx);
        if (step.kind === "fail" && stored.failed === null) log(`${pylon.pylonId}: the planner gave up: ${step.reason}`);
        // Done for a deleted thread means its node neither has the pylon nor routes a port to it, so nothing serves the ports.
        if (pylon.desired === "deleted" && step.kind === "done") registry.releasePreviews(pylon.pylonId);
      } catch (err) {
        log(`${pylon.pylonId}: tick failed: ${(err as Error).message}`);
      }
    }
  }

  function wake(node: NodeName): Promise<void> {
    const link = links.get(node);
    if (link === undefined || shutdown.signal.aborted) return Promise.resolve();
    link.again = true;
    link.pass ??= (async () => {
      try {
        while (link.again && !shutdown.signal.aborted) {
          link.again = false;
          await pass(node, link);
        }
      } finally {
        link.pass = null;
      }
    })();
    return link.pass;
  }

  function linkDown(node: NodeName, link: Link) {
    link.up = false;
    link.offline ??= setTimeout(() => { link.offline = null; registry.markOffline(node); }, offlineAfterMs);
  }

  function linkUp(link: Link) {
    link.up = true;
    if (link.offline !== null) clearTimeout(link.offline);
    link.offline = null;
  }

  async function follow(node: NodeName, link: Link) {
    while (!shutdown.signal.aborted) {
      const connection = new AbortController();
      let silence = setTimeout(() => connection.abort(), silenceMs);
      try {
        for await (const event of link.probe.observe(AbortSignal.any([shutdown.signal, connection.signal]))) {
          clearTimeout(silence);
          silence = setTimeout(() => connection.abort(), silenceMs);
          // The stored observation is the last one ingested, including the one from before a reconnect or a restart.
          const last = registry.node(node)!.observation;
          const known = new Map(registry.pylonsOn(node).map((p) => [p.pylonId, last?.pylons.find((o) => o.pylonId === p.pylonId) ?? "absent" as const]));
          const current = merge(last, event);
          registry.ingested(current, ingest(event, node, known, Date.now()));
          allocatePreviews(current);
          if (event.type === "snapshot") linkUp(link);
          void wake(node);
        }
      } catch (err) {
        if (!shutdown.signal.aborted && !connection.signal.aborted && (err as ProbeError).code !== "unreachable") log(`${node}: observe failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(silence);
      }
      if (shutdown.signal.aborted) return;
      linkDown(node, link);
      await delay(reconnectMs, undefined, { signal: shutdown.signal }).catch(() => undefined);
    }
  }

  for (const [node, link] of links) linkDown(node, link);
  const followers = [...links].map(([node, link]) => follow(node, link));
  const timer = setInterval(() => { for (const node of links.keys()) void wake(node); }, intervalMs);

  return {
    wake,
    async close() {
      shutdown.abort();
      clearInterval(timer);
      for (const link of links.values()) if (link.offline !== null) clearTimeout(link.offline);
      await Promise.all([...followers, ...[...links.values()].map((link) => link.pass)]);
    },
  };
}

/**
 * The node's current state: a snapshot replaces it, and a pylon event updates its pylon. Job events stay out,
 * because a job listed as finished promises that the pylons already show its result. ingest records them.
 */
function merge(last: NodeObservation | null, event: ProbeEvent): NodeObservation {
  if (event.type === "snapshot") return { ...event.observation, pylons: event.observation.pylons.map((p) => keepLastRead(last, p)) };
  if (last === null) throw new Error(`observe sent a ${event.type} event before its first snapshot`);
  if (event.type !== "pylon") return last;
  return { ...last, pylons: [...last.pylons.filter((p) => p.pylonId !== event.pylon.pylonId), keepLastRead(last, event.pylon)] };
}

/**
 * Sessions or services the probe could not read have not changed as far as the registry knows, and the next
 * diff needs the last list read. Only the stored copy is filled in. ingest gets the event as read, so a
 * carried session list is never agent activity. Services with no earlier read stay null, because a pylon
 * whose services were never read has not shown that it has none.
 */
function keepLastRead(last: NodeObservation | null, pylon: PylonObservation): PylonObservation {
  if (pylon.phase !== "running" || (pylon.sessions !== null && pylon.services !== null)) return pylon;
  const previous = last?.pylons.find((p) => p.pylonId === pylon.pylonId);
  const before = previous?.phase === "running" ? previous : null;
  return { ...pylon, sessions: pylon.sessions ?? before?.sessions ?? [], services: pylon.services ?? before?.services ?? null };
}
