/**
 * The reconcile loop. It follows every node's observe stream, folds each event into the registry, and ticks
 * every pylon on a node after each event and at each poll, every 5 seconds. Each pass first moves the node's template builds along
 * (template-builds.ts).
 *
 * Each node has one pass at a time. A pass that is asked for while one runs is coalesced into a single
 * pass after it, so no two ticks of the same pylon overlap and a slow probe holds up only its own node.
 *
 * Previews: each ingested event gives every service a running pylon wants previewed a port from `previewPorts`,
 * and drops the preview of each port the pylon no longer links.
 * Each pass renders the pylon's LiveSpec from its records before its tick, so a new port changes the liveHash and
 * the planner sends it in a spawn. The ports go back once its node neither has the pylon of a deleted thread nor routes
 * a preview to it.
 *
 * A deleted or archived thread's pylon that is gone, with nothing left to settle, is skipped, so passes do not grow with
 * every thread ever archived or deleted (pylonIdsToTick). It is ticked again once its node lists or routes it again, or
 * once a job, preview, disk delete, retry, Claude launch, wake for reading, failure to record or unarchive gives it
 * something to settle.
 */
import { setTimeout as delay } from "node:timers/promises";
import { desiredPhase, type RegistryWrite } from "./reconcile.ts";
import { linkedPort } from "../services-file.ts";
import { liveHashOf, type GitIdentity } from "../protocol/spawn.ts";
import { singleFlight, type SingleFlight } from "../single-flight.ts";
import { tick, type TickContext } from "./tick.ts";
import { type ArtifactId, isImageId, type NodeName, type PylonId } from "../ids.ts";
import type { NodeObservation, ProbeEvent, PylonObservation } from "../protocol/observations.ts";
import type { ProbeError } from "../protocol/http.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { pylonLive } from "./live.ts";
import { gitIdentityOf } from "./project.ts";
import { freeHeldRoom } from "./placement.ts";
import { claudeLaunch } from "./claude-launch.ts";
import type { Registry } from "./registry.ts";
import type { PortRange, StoredPylon, Thread } from "./thread-store.ts";
import { tickTemplateBuild } from "./template-builds.ts";

type LoopRegistry = Pick<Registry, "threads" | "images" | "nodeMetrics" | "nodes" | "projects" | "placement" | "usage" | "now">;

/**
 * reconcile.ts's ingest. `known` maps each registry pylon on the node that the pass would tick, given what the event and
 * the last observation say the node has, to its last ingested observation. `unlisted` names those whose session list
 * this control plane has not written since it started or since they were last left out of `known`.
 */
export type Ingest = (event: ProbeEvent, node: NodeName, known: ReadonlyMap<PylonId, PylonObservation | "absent">, now: number, unlisted: ReadonlySet<PylonId>) => readonly RegistryWrite[];

/** How often the loop polls unless its options say otherwise. */
export const tickMs = 5_000;

export interface LoopOptions {
  registry: LoopRegistry;
  gitIdentity?: GitIdentity | undefined;
  /** One client per registry node. */
  probes: readonly ProbeClient[];
  ingest: Ingest;
  /** Hears each snapshot a node sends, before it is ingested. */
  onSnapshot?: (node: NodeName, observation: NodeObservation) => void;
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
  /** How long a Claude launch that lost its probe connection waits for the probe to come back. Default 3 minutes. */
  claudeLaunchRetryMs?: number;
  log?: (message: string) => void;
}

export interface Loop {
  /** Ticks every pylon on the node. Resolves once a pass that began after this call has finished. */
  wake(node: NodeName): Promise<void>;
  /**
   * Has the node's probe read the pylon's git again, past its reuse of the last read, and settles once the registry
   * holds that read, or after `waitMs` without it.
   */
  readGit(node: NodeName, pylonId: PylonId, waitMs?: number): Promise<void>;
  /** Follows one more node's probe, such as a node that joined. A node already followed keeps its probe. */
  follow(probe: ProbeClient): void;
  /** Resolves at the next wake of any node: after each event the loop ingests, each wake asked for, and each poll. */
  woken(): Promise<void>;
  readonly everyMs: number;
  /** Wakes every node. */
  poll(): void;
  close(): Promise<void>;
}

interface Link {
  probe: ProbeClient;
  /** The planner acts on a node only while its observe stream is open. */
  up: boolean;
  /** The node's latest observation, as the registry stores it. Only this link's follow() stores one. */
  last: NodeObservation | null;
  passes: SingleFlight;
  offline: NodeJS.Timeout | null;
  waiters: Set<{ ready: (o: NodeObservation) => boolean; done: (seen: boolean) => void }>;
}

export function startLoop(options: LoopOptions): Loop {
  const { registry, ingest, previewPorts } = options;
  const offlineAfterMs = options.offlineAfterMs ?? 30_000;
  const reconnectMs = options.reconnectMs ?? 2_000;
  const silenceMs = options.silenceMs ?? 90_000;
  const claudeLaunchRetryMs = options.claudeLaunchRetryMs ?? 3 * 60_000;
  const log = options.log ?? ((message: string) => console.error(message));
  const shutdown = new AbortController();
  const launches = claudeLaunch({ registry, log, retryMs: claudeLaunchRetryMs, shutdown: shutdown.signal });

  const links = new Map<NodeName, Link>();
  const followers: Promise<void>[] = [];
  function followProbe(probe: ProbeClient) {
    const stored = registry.nodes.node(probe.node);
    if (stored === undefined) throw new Error(`probe for ${probe.node}, which the registry does not know`);
    if (links.has(probe.node) || shutdown.signal.aborted) return;
    const link: Link = { probe, up: false, last: stored.observation, passes: singleFlight(() => pass(probe.node, link), () => shutdown.signal.aborted), offline: null, waiters: new Set() };
    links.set(probe.node, link);
    linkDown(probe.node, link);
    followers.push(follow(probe.node, link));
  }

  const observation = (node: NodeName): NodeObservation | null => {
    const link = links.get(node);
    return link?.up === true ? link.last : null;
  };

  const holders = (from: NodeName) => (artifact: ArtifactId): readonly NodeName[] =>
    [...links.keys()].filter((node) => node !== from && observation(node)?.artifacts.includes(artifact));

  function artifactSha256(artifact: ArtifactId): string {
    const image = isImageId(artifact) ? registry.images.image(artifact) : undefined;
    if (image === undefined) throw new Error(`the registry has no recorded sha256 for ${artifact}`);
    return image.sha256;
  }

  /**
   * A port, once allocated, stays the pylon's while its thread lives, so its URL survives pauses and restarts. A
   * linked port's preview lasts only while the pylon links the port, so it goes once a read of the pylon's services
   * leaves it out. Only the lists `pylons` read count, never one carried from an earlier read: that could still
   * list a port unlinked since.
   */
  function reconcilePreviews(node: NodeName, observation: NodeObservation, pylons: readonly PylonObservation[]) {
    for (const observed of pylons) {
      if (observed.phase !== "running" || observed.services === null) continue;
      const pylon = registry.threads.pylon(observed.pylonId);
      // A pylon reported by a node the registry does not place it on is an orphan there.
      if (pylon?.node !== node || registry.threads.threadStatus(pylon.thread) === "deleted") continue;
      const services = observed.services;
      for (const { service } of registry.threads.previews(pylon.pylonId, observation)) {
        if (linkedPort(service) !== null && !services.some((s) => s.name === service)) registry.threads.releasePreview(pylon.pylonId, service);
      }
      try {
        registry.threads.allocatePreviews(pylon.pylonId, services.filter((s) => s.wantsPreview).map((s) => s.name), previewPorts, observation);
      } catch (err) {
        log(`${pylon.pylonId}: ${(err as Error).message}`);
      }
    }
  }

  /** The pylon with the LiveSpec its records give now, saved if that changed. */
  function withLive(stored: StoredPylon, thread: Thread, link: Link): StoredPylon {
    const nodeObservation = observation(stored.node);
    const observed = nodeObservation?.pylons.find((p) => p.pylonId === stored.pylonId);
    if (nodeObservation !== null && (observed === undefined || observed.phase === "stopped") && stored.submitted === null) {
      const gitIdentity = gitIdentityOf(registry.projects.project(thread.project)!, options.gitIdentity);
      if (JSON.stringify(gitIdentity) !== JSON.stringify(stored.boot.gitIdentity)) {
        stored = { ...stored, boot: { ...stored.boot, gitIdentity } };
        registry.threads.savePylon(stored);
      }
    }
    // Not observation(node), which is null while the link is down: a preview's state stays as the node last reported it.
    const live = pylonLive(stored, registry.projects.project(thread.project)!, registry.threads.previews(stored.pylonId, link.last));
    const liveHash = liveHashOf(live);
    if (liveHash === stored.liveHash) return stored;
    const updated = { ...stored, live, liveHash };
    registry.threads.savePylon(updated);
    return updated;
  }

  async function pass(node: NodeName, link: Link) {
    registry.threads.pruneSessions();
    for (const template of registry.images.buildingTemplates(node)) {
      try {
        await tickTemplateBuild(template, { probe: link.probe, observation: observation(node), registry, log });
      } catch (err) {
        log(`${template.id}: template build tick failed: ${(err as Error).message}`);
      }
    }
    for (const thread of freeHeldRoom(registry, node)) log(`${thread}: its review no longer holds its pylon up, since ${node} needs the room`);
    const seen = observation(node);
    const present = [...seen?.pylons.map((p) => p.pylonId) ?? [], ...seen?.previewRoutes.map((r) => r.pylonId) ?? []];
    // Each record is read just before its tick, because an API retry may change it while earlier ticks wait on
    // the probe, and saving an older copy would undo it.
    for (const pylonId of registry.threads.pylonIdsToTick(node, present)) {
      const found = registry.threads.pylon(pylonId);
      // A failed pylon a judgment moved meanwhile is its new node's to tick, and one retention purged meanwhile is gone.
      if (found === undefined || found.node !== node) continue;
      const thread = registry.threads.thread(found.thread)!;
      let stored = withLive(found, thread, link);
      const nodeObservation = observation(node);
      const seen = nodeObservation?.pylons.find((p) => p.pylonId === pylonId);
      const present = seen !== undefined;
      const deleteAt = registry.threads.diskDeleteRequestedAt(pylonId);
      if (nodeObservation !== null && deleteAt !== undefined) {
        if (seen === undefined) {
          registry.threads.finishDiskDelete(pylonId);
          stored = withLive(registry.threads.pylon(pylonId)!, thread, link);
        }
        // A listing may predate a delete the probe has since forgotten, so only a boot after the request proves the disk stayed.
        else if (seen.phase === "running" && Date.parse(seen.bootedAt) > deleteAt && stored.submitted?.job.kind !== "delete" && desiredPhase(thread, registry.now()) !== "deleted") {
          registry.threads.dropDiskDelete(pylonId);
        }
      }
      const pylon = { ...stored, desired: desiredPhase(thread, registry.now()) };
      const ctx: TickContext = {
        probe: link.probe,
        observation: nodeObservation,
        holders: holders(node),
        artifactSha256,
        save: (p) => {
          // Only an archive's settle deletes the pylon of a thread that is not deleted, once its disk may go. Recorded before
          // its delete goes out, so the delete ends on the node's report of the disk, whatever the probe forgets of the job.
          if (p.submitted?.job.kind === "delete" && p.desired === "deleted" && present && registry.threads.threadStatus(thread.id) !== "deleted") {
            registry.threads.requestDiskDelete(pylonId, thread.id);
          }
          registry.threads.savePylon(p);
        },
        desired: () => desiredPhase(registry.threads.thread(found.thread)!, registry.now()),
        sealedBoot: () => registry.threads.sealedBoot(pylonId),
        uncountedFailed: (failure) => {
          registry.usage.failUsageRead(thread.id, failure);
          void wake(node);
        },
      };
      try {
        if (launches.step(thread, pylonId, nodeObservation, { probe: link.probe, snapshot: (waitMs) => snapshot(link, () => true, waitMs), wake: () => void wake(node) }) === "skip") continue;
        const step = await tick(pylon, ctx);
        if (step.kind === "fail" && stored.failed === null) log(`${pylon.pylonId}: the planner gave up: ${step.reason}`);
        // Done for a deleted thread means its node neither has the pylon nor routes a port to it, so nothing serves the ports.
        if (pylon.desired === "deleted" && step.kind === "done") registry.threads.releasePreviews(pylon.pylonId);
      } catch (err) {
        log(`${pylon.pylonId}: tick failed: ${(err as Error).message}`);
      }
    }
  }

  const wakes = new Set<() => void>();
  function woken(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    wakes.add(resolve);
    return promise;
  }

  function wake(node: NodeName): Promise<void> {
    for (const resolve of wakes) resolve();
    wakes.clear();
    return links.get(node)?.passes.rerun() ?? Promise.resolve();
  }

  async function readGit(node: NodeName, pylonId: PylonId, waitMs = 10_000): Promise<void> {
    const link = links.get(node);
    if (link === undefined) return;
    const since = await link.probe.readGit(pylonId);
    if (link.last === null || link.last.observedAt < since) await snapshot(link, (o) => since <= o.observedAt, waitMs);
  }

  /** Settles true once the link ingests a snapshot `ready` accepts, and false after `waitMs` without one or at shutdown. */
  function snapshot(link: Link, ready: (o: NodeObservation) => boolean, waitMs: number): Promise<boolean> {
    if (shutdown.signal.aborted) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const waiter = { ready, done: (seen: boolean) => { clearTimeout(giveUp); link.waiters.delete(waiter); resolve(seen); } };
    const giveUp = setTimeout(() => waiter.done(false), waitMs).unref();
    link.waiters.add(waiter);
    return promise;
  }

  function linkDown(node: NodeName, link: Link) {
    link.up = false;
    link.offline ??= setTimeout(() => { link.offline = null; registry.nodes.markOffline(node); }, offlineAfterMs);
  }

  function linkUp(link: Link) {
    link.up = true;
    if (link.offline !== null) clearTimeout(link.offline);
    link.offline = null;
  }

  async function follow(node: NodeName, link: Link) {
    const listed = new Set<PylonId>();
    while (!shutdown.signal.aborted) {
      const connection = new AbortController();
      let silence = setTimeout(() => connection.abort(), silenceMs);
      try {
        for await (const event of link.probe.observe(AbortSignal.any([shutdown.signal, connection.signal]))) {
          clearTimeout(silence);
          silence = setTimeout(() => connection.abort(), silenceMs);
          // The last one ingested, including the one from before a reconnect or a restart.
          const last = link.last;
          const current = merge(last, event);
          // A pylon the last observation lists stays present for this event, so ingest clears its sessions when its node drops it.
          const present = [...last?.pylons ?? [], ...current.pylons, ...current.previewRoutes, ...event.type === "preview-hit" ? [event] : []].map((p) => p.pylonId);
          const known = readsKnown[event.type]
            ? new Map(registry.threads.pylonIdsToTick(node, present).map((id) => [id, last?.pylons.find((o) => o.pylonId === id) ?? "absent" as const]))
            : new Map<PylonId, PylonObservation | "absent">();
          if (readsKnown[event.type]) for (const id of listed) if (!known.has(id)) listed.delete(id);
          if (event.type === "snapshot") {
            // The journal replays reports the node already sent, and the receipt only grows, so reportSession would drop these.
            const receipt = registry.threads.eventReceipt(node);
            for (const report of event.observation.events) if (receipt === null || report.sequence > receipt) registry.threads.reportSession(node, report);
            options.onSnapshot?.(node, event.observation);
          }
          if (event.type === "session-event") registry.threads.reportSession(node, event.report);
          const writes = ingest(event, node, known, registry.now(), new Set([...known.keys()].filter((id) => !listed.has(id))));
          registry.threads.ingested(current === last ? null : current, writes);
          link.last = current;
          for (const w of writes) if (w.record === "sessions" || w.record === "sessions-paused") listed.add(w.pylonId);
          reconcilePreviews(node, current, event.type === "snapshot" ? event.observation.pylons : event.type === "pylon" ? [event.pylon] : []);
          if (event.type === "snapshot") {
            linkUp(link);
            for (const w of link.waiters) if (w.ready(event.observation)) w.done(true);
          }
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

  for (const probe of options.probes) followProbe(probe);

  return {
    wake,
    readGit,
    follow: followProbe,
    woken,
    everyMs: options.intervalMs ?? tickMs,
    poll() { for (const node of links.keys()) void wake(node); },
    async close() {
      shutdown.abort();
      for (const link of links.values()) {
        if (link.offline !== null) clearTimeout(link.offline);
        for (const w of link.waiters) w.done(false);
      }
      await Promise.all([...followers, ...[...links.values()].map((link) => link.passes.settled())]);
      // A pass that was still running may have started a launch.
      await launches.settled();
    },
  };
}

/** The events ingest reads `known` and `unlisted` for. */
const readsKnown: Record<ProbeEvent["type"], boolean> = { snapshot: true, pylon: true, "preview-hit": true, job: false, "session-event": false };

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
 * Sessions or services the probe could not read have not changed as far as the registry knows, and the next diff
 * needs the last list read. Only the stored copy is filled in. ingest gets the event as read, so a carried session
 * list is never agent activity. Either with no earlier read since the pylon last ran stays null: a pylon whose services
 * were never read has not shown that it has none, and sessions not yet read after a wake are the ones ingest resumed,
 * which the first list read replaces. Listening ports are stored as read: nothing diffs them, and a port seen
 * once may have closed since, so an unread list is reported as unknown.
 */
function keepLastRead(last: NodeObservation | null, pylon: PylonObservation): PylonObservation {
  if (pylon.phase !== "running" || (pylon.sessions !== null && pylon.services !== null)) return pylon;
  const previous = last?.pylons.find((p) => p.pylonId === pylon.pylonId);
  const before = previous?.phase === "running" ? previous : null;
  return { ...pylon, sessions: pylon.sessions ?? before?.sessions ?? null, services: pylon.services ?? before?.services ?? null };
}
