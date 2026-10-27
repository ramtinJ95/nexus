/**
 * The reconcile loop. It follows every node's observe stream, folds each event into the registry, and ticks
 * every pylon on a node after each event and every 5 seconds. Each pass first moves the node's template builds along
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
 * A deleted thread's pylon that is gone, with nothing left to settle, is skipped, so passes do not grow with every
 * thread ever deleted. It is ticked again if its node lists or routes it again.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { desiredPhase, type RegistryWrite } from "../reconcile.ts";
import { linkedPort, liveHashOf, type GitIdentity } from "../project.ts";
import { tick, type TickContext } from "../tick.ts";
import { isImageId, type NodeName, type NodeObservation, type ProbeClient, type ProbeError, type ProbeEvent, type PylonCommand, type PylonId, type PylonObservation } from "../protocol.ts";
import type { ArtifactId } from "../images.ts";
import { defaultClaudeModel } from "../claude-state.ts";
import { pylonLive } from "./live.ts";
import type { PortRange, Registry, StoredPylon, Thread, ThreadId } from "./registry.ts";
import { tickTemplateBuild } from "./template-builds.ts";

/**
 * reconcile.ts's ingest. `known` maps each registry pylon on the node to its last ingested observation, and `unlisted`
 * names those whose session list this control plane has not written since it started.
 */
export type Ingest = (event: ProbeEvent, node: NodeName, known: ReadonlyMap<PylonId, PylonObservation | "absent">, now: number, unlisted: ReadonlySet<PylonId>) => readonly RegistryWrite[];

export interface LoopOptions {
  registry: Registry;
  gitIdentity?: GitIdentity | undefined;
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
  /** How long a Claude launch that lost its probe connection waits for the probe to come back. Default 3 minutes. */
  claudeLaunchRetryMs?: number;
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
  snapshots: number;
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
  const claudeLaunchRetryMs = options.claudeLaunchRetryMs ?? 3 * 60_000;
  const log = options.log ?? ((message: string) => console.error(message));
  const shutdown = new AbortController();
  const listed = new Set<PylonId>();

  const links = new Map<NodeName, Link>();
  for (const probe of options.probes) {
    if (registry.node(probe.node) === undefined) throw new Error(`probe for ${probe.node}, which the registry does not know`);
    links.set(probe.node, { probe, up: false, snapshots: 0, pass: null, again: false, offline: null });
  }

  const observation = (node: NodeName): NodeObservation | null => links.get(node)?.up ? registry.node(node)?.observation ?? null : null;

  const holders = (from: NodeName) => (artifact: ArtifactId): readonly NodeName[] =>
    [...links.keys()].filter((node) => node !== from && observation(node)?.artifacts.includes(artifact));

  function artifactSha256(artifact: ArtifactId): string {
    const image = isImageId(artifact) ? registry.image(artifact) : undefined;
    if (image === undefined) throw new Error(`the registry has no recorded sha256 for ${artifact}`);
    return image.sha256;
  }

  /**
   * A port, once allocated, stays the pylon's while its thread lives, so its URL survives pauses and restarts. A
   * linked port's preview lasts only while the pylon links the port, so it goes once a read of the pylon's services
   * leaves it out. Only the lists `pylons` read count, never one carried from an earlier read: that could still
   * list a port unlinked since.
   */
  function reconcilePreviews(node: NodeName, pylons: readonly PylonObservation[]) {
    for (const observed of pylons) {
      if (observed.phase !== "running" || observed.services === null) continue;
      const pylon = registry.pylon(observed.pylonId);
      // A pylon reported by a node the registry does not place it on is an orphan there.
      if (pylon?.node !== node || registry.thread(pylon.thread as ThreadId)!.status === "deleted") continue;
      const services = observed.services;
      for (const { service } of registry.previews(pylon.pylonId)) {
        if (linkedPort(service) !== null && !services.some((s) => s.name === service)) registry.releasePreview(pylon.pylonId, service);
      }
      try {
        registry.allocatePreviews(pylon.pylonId, services.filter((s) => s.wantsPreview).map((s) => s.name), previewPorts);
      } catch (err) {
        log(`${pylon.pylonId}: ${(err as Error).message}`);
      }
    }
  }

  /** The pylon with the LiveSpec its records give now, saved if that changed. */
  function withLive(stored: StoredPylon, thread: Thread): StoredPylon {
    const nodeObservation = observation(stored.node);
    const observed = nodeObservation?.pylons.find((p) => p.pylonId === stored.pylonId);
    if (nodeObservation !== null && (observed === undefined || observed.phase === "stopped") && stored.submitted === null) {
      const gitIdentity = registry.project(thread.project)!.gitIdentity ?? options.gitIdentity;
      if (JSON.stringify(gitIdentity) !== JSON.stringify(stored.boot.gitIdentity)) {
        stored = { ...stored, boot: { ...stored.boot, gitIdentity } };
        registry.savePylon(stored);
      }
    }
    const live = pylonLive(stored, registry.project(thread.project)!, registry.previews(stored.pylonId));
    const liveHash = liveHashOf(live);
    if (liveHash === stored.liveHash) return stored;
    const updated = { ...stored, live, liveHash };
    registry.savePylon(updated);
    return updated;
  }

  async function pass(node: NodeName, link: Link) {
    registry.pruneSessions();
    for (const template of registry.buildingTemplates(node)) {
      try {
        await tickTemplateBuild(template, { probe: link.probe, observation: observation(node), registry, log });
      } catch (err) {
        log(`${template.id}: template build tick failed: ${(err as Error).message}`);
      }
    }
    const seen = observation(node);
    const present = [...seen?.pylons.map((p) => p.pylonId) ?? [], ...seen?.previewRoutes?.map((r) => r.pylonId) ?? []];
    // Each record is read just before its tick, because an API retry may change it while earlier ticks wait on
    // the probe, and saving an older copy would undo it.
    for (const pylonId of registry.pylonIdsToTick(node, present)) {
      const found = registry.pylon(pylonId)!;
      const thread = registry.thread(found.thread as ThreadId)!;
      const stored = withLive(found, thread);
      const pylon = { ...stored, desired: desiredPhase(thread, Date.now()) };
      const nodeObservation = observation(node);
      const ctx: TickContext = {
        probe: link.probe,
        observation: nodeObservation,
        holders: holders(node),
        artifactSha256,
        save: (p) => registry.savePylon(p),
      };
      try {
        const worker = registry.claudeWorker(thread.id);
        const running = nodeObservation?.pylons.some((p) => p.pylonId === pylonId && p.phase === "running") === true;
        // A launch this process did not finish, as one a control plane restart cut off, goes again only where it is safe to.
        if (worker?.state === "starting" && nodeObservation !== null && (nodeObservation.claudeLaunchRepeatable !== true || worker.session === null)) {
          const message = "Claude launch was interrupted; attach to check before starting another session";
          registry.setClaudeWorker(thread.id, worker.prompt, "failed", message);
          registry.appendEvent("thread.failed", thread.id, { message });
        } else if ((worker?.state === "pending" || worker?.state === "starting") && thread.status === "active" && running) {
          // Fence the launch under its session before sending: a launch sent again must name the same session, or it could submit the task twice.
          const session = worker.state === "starting" ? worker.session! : randomUUID();
          registry.setClaudeWorker(thread.id, worker.prompt, "starting", undefined, session);
          try {
            await launchClaude(node, link, pylonId, { kind: "open-session", harness: "claude-code", title: thread.title.slice(0, 80), resume: session, prompt: worker.prompt, model: worker.model ?? defaultClaudeModel });
            registry.setClaudeWorker(thread.id, worker.prompt, "started");
          } catch (err) {
            if (registry.claudeWorker(thread.id)?.state === "started" || shutdown.signal.aborted) continue;
            const message = `Claude launch did not complete; attach to check before starting another session: ${(err as Error).message}`;
            registry.setClaudeWorker(thread.id, worker.prompt, message.includes("Claude launch stalled") ? "stalled" : "failed", message);
            registry.appendEvent("thread.failed", thread.id, { message });
            throw err;
          }
        }
        const step = await tick(pylon, ctx);
        if (step.kind === "fail" && stored.failed === null) log(`${pylon.pylonId}: the planner gave up: ${step.reason}`);
        // Done for a deleted thread means its node neither has the pylon nor routes a port to it, so nothing serves the ports.
        if (pylon.desired === "deleted" && step.kind === "done") registry.releasePreviews(pylon.pylonId);
      } catch (err) {
        log(`${pylon.pylonId}: tick failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Sends a prompted Claude launch, and sends it again, under the same session ID, each time the probe connection is
   * lost before it answers, as when a deploy restarts the probe. It waits for a snapshot from after the loss, so the
   * probe that answers it is one that came back, and sends again only if that probe says the launch is safe to repeat
   * (sessions.ts openSession), which reads from the pylon how far the launch got.
   */
  async function launchClaude(node: NodeName, link: Link, pylonId: PylonId, command: Extract<PylonCommand, { kind: "open-session" }>): Promise<void> {
    const until = Date.now() + claudeLaunchRetryMs;
    for (;;) {
      try {
        await link.probe.command(pylonId, command);
        return;
      } catch (err) {
        if ((err as Partial<ProbeError>).code !== "unreachable") throw err;
        const seen = link.snapshots;
        while (!link.up || link.snapshots === seen) {
          if (Date.now() >= until) throw new Error(`${(err as Error).message}, and the probe did not come back within ${claudeLaunchRetryMs / 1000} seconds`);
          await delay(250, undefined, { signal: shutdown.signal });
        }
        if (observation(node)?.claudeLaunchRepeatable !== true) throw new Error(`${(err as Error).message}, and the probe that came back cannot take a launch again`);
        log(`${pylonId}: the Claude launch lost its probe (${(err as Error).message}). Sending it again`);
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
          const known = readsKnown[event.type]
            ? new Map(registry.pylonIdsOn(node).map((id) => [id, last?.pylons.find((o) => o.pylonId === id) ?? "absent" as const]))
            : new Map<PylonId, PylonObservation | "absent">();
          if (event.type === "snapshot") {
            // The journal replays reports the node already sent, and the receipt only grows, so reportSession would drop these.
            const receipt = registry.eventReceipt(node);
            for (const report of event.observation.events ?? []) if (receipt === null || report.sequence > receipt) registry.reportSession(node, report);
          }
          if (event.type === "session-event") registry.reportSession(node, event.report);
          const current = merge(last, event);
          const writes = ingest(event, node, known, Date.now(), new Set([...known.keys()].filter((id) => !listed.has(id))));
          registry.ingested(current === last ? null : current, writes);
          for (const w of writes) if (w.record === "sessions" || w.record === "sessions-paused") listed.add(w.pylonId);
          reconcilePreviews(node, event.type === "snapshot" ? event.observation.pylons : event.type === "pylon" ? [event.pylon] : []);
          if (event.type === "snapshot") {
            link.snapshots++;
            linkUp(link);
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
/** The events ingest reads `known` and `unlisted` for. */
const readsKnown: Record<ProbeEvent["type"], boolean> = { snapshot: true, pylon: true, "preview-hit": true, job: false, "session-event": false };

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
