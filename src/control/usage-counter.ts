/**
 * Reads what every thread's agents spent into the registry: the Nexus agent's calls from the harness, and the calls of
 * the agents in its pylon from their transcripts there. A turn's end reads the thread it ended in, a deleted one's too,
 * and a sweep reads every thread but the deleted ones, once at start and then every `sweepMs`, which catches what no
 * event announces, such as a pi session someone runs in a pylon's terminal. As with Claude's transcripts, a pylon is
 * read only while its node's last observation reports it running, so reading never wakes one, and a failed read keeps
 * what is recorded.
 */
import { readAgentUsage, agentLogs, type FileCursor } from "../agent-usage.ts";
import type { HarnessHost } from "../harness/host.ts";
import type { ConversationId } from "../harness/host.ts";
import type { NodeName, ProbeClient, PylonId } from "../protocol.ts";
import { singleFlight, type SingleFlight } from "../single-flight.ts";
import type { EventKind } from "../events.ts";
import { runningProbe } from "./observed.ts";
import type { Registry, ThreadId } from "./registry.ts";

export interface UsageCounter {
  /** Reads every thread but the deleted ones now. */
  sweep(): Promise<void>;
  /**
   * Reads every transcript of the thread's running pylon from its start, as the usage backfill does, and records each
   * read as a sweep would, adding what each recovered to the thread's backfill row with it, so a read cut short keeps
   * what it recorded. Returns the calls no read had counted and the tokens they added. Throws when the pylon is
   * not running, a read fails, or `signal` aborts it between reads. No other read of the pylon starts until it is done.
   */
  readWhole(id: ThreadId, signal?: AbortSignal): Promise<{ calls: number; tokens: number }>;
  close(): Promise<void>;
}

/** The events that end a turn: a pylon session's, which its transcripts record, and the Nexus agent's. */
const pylonKinds: readonly EventKind[] = ["session.turn-ended", "session.ended"];
const harnessKinds: readonly EventKind[] = ["thread.turn-ended"];
/** One read of a pylon takes about a megabyte of calls. One with more goes on in the read after it. */
const maxReadsPerPylon = 16;
/** A whole read stops past this many, roughly a gigabyte of calls. */
const maxWholeReads = 1_000;

export function usageCounter(options: {
  registry: Registry;
  probes: ReadonlyMap<NodeName, Pick<ProbeClient, "stream">>;
  harness: Pick<HarnessHost, "usage">;
  sweepMs?: number;
  followMs?: number;
  logs?: typeof agentLogs;
  log?: (message: string) => void;
}): UsageCounter {
  const { registry, probes, harness, sweepMs = 600_000, followMs = 1_000, logs = agentLogs, log = (message) => console.error(message) } = options;
  let closed = false;
  const reads = new Map<string, SingleFlight>();
  const failures = new Map<string, string>();
  const held = new Set<string>();

  /** Runs `read` once at a time per key, and logs a failure once until the key reads again. */
  function once(key: string, read: () => Promise<void>): Promise<void> {
    let flight = reads.get(key);
    if (flight === undefined) {
      reads.set(key, flight = singleFlight(async () => {
        try {
          await read();
          failures.delete(key);
        } catch (err) {
          const message = (err as Error).message;
          if (failures.get(key) !== message) log(`${key}: reading token usage failed, so the counts keep what was read before: ${message}`);
          failures.set(key, message);
        }
      }, () => closed || held.has(key)));
    }
    return flight.rerun();
  }

  const readHarness = (id: ThreadId) => once(`${id}/harness`, async () => {
    const t = registry.thread(id);
    const agent = t === undefined ? undefined : registry.agent(t);
    if (agent?.kind !== "harness") return;
    const conversation = agent.conversationId;
    const after = registry.usageCursor("harness", conversation)?.position ?? null;
    const { calls, last } = await harness.usage(Number(conversation) as ConversationId, after);
    if (last !== null && last !== after) registry.recordUsage(id, calls, [{ source: "harness", key: conversation, position: last, before: "" }]);
  });

  async function readOn(id: ThreadId, cursors: (pylon: PylonId) => ReadonlyMap<string, FileCursor>, backfill = false) {
    const t = registry.thread(id);
    if (t === undefined || t.status === "deleted") return null;
    const probe = runningProbe(registry, probes, t);
    if (probe === null) return null;
    const read = await readAgentUsage((argv) => probe.stream(t.pylonId, argv), cursors(t.pylonId), logs);
    const added = registry.recordUsage(id, read.calls, [...read.offsets].map(([key, [position, before]]) => ({ source: t.pylonId, key, position, before })), backfill);
    return { ...added, offsets: read.offsets, more: read.more };
  }

  const recorded = (pylon: PylonId) => new Map([...registry.usageCursors(pylon)].map(([path, c]): [string, FileCursor] => [path, [c.position, c.before]]));
  const readPylon = (id: ThreadId) => once(`${id}/pylon`, async () => {
    for (let n = 0; n < maxReadsPerPylon && !closed; n++) {
      if ((await readOn(id, recorded))?.more !== true) return;
    }
  });

  async function readWhole(id: ThreadId, signal?: AbortSignal) {
    const key = `${id}/pylon`;
    if (held.has(key)) throw new Error(`${id}'s pylon is already being read whole`);
    held.add(key);
    try {
      await reads.get(key)?.settled();
      let cursors = new Map<string, FileCursor>();
      const added = { calls: 0, tokens: 0 };
      for (let n = 0; n < maxWholeReads; n++) {
        signal?.throwIfAborted();
        if (closed) throw new Error("the control plane is stopping");
        const read = await readOn(id, () => cursors, true);
        if (read === null) throw new Error("its pylon is not running");
        added.calls += read.calls;
        added.tokens += read.tokens;
        if (!read.more) return added;
        cursors = new Map([...cursors, ...read.offsets]);
      }
      throw new Error(`its transcripts were not read to their end in ${maxWholeReads} reads`);
    } finally {
      held.delete(key);
    }
  }

  async function sweep() {
    const swept = registry.storedThreads({ status: ["active", "idle", "archived"] }).map((t) => t.id);
    await Promise.all(swept.flatMap((id) => [readHarness(id), readPylon(id)]));
    const keys = new Set(swept.flatMap((id) => [`${id}/harness`, `${id}/pylon`]));
    for (const [key, flight] of reads) {
      if (keys.has(key) || held.has(key) || flight.busy()) continue;
      reads.delete(key);
      failures.delete(key);
    }
  }

  // From the newest event, as the sweep at start reads what came before.
  const kinds = [...pylonKinds, ...harnessKinds];
  let cursor = registry.eventBatch("0", { kinds }).watermark;
  const follow = setInterval(() => {
    let batch: ReturnType<Registry["eventBatch"]>;
    try {
      batch = registry.eventBatch(cursor, { kinds });
    } catch (err) {
      log(`following turn ends for token usage: ${(err as Error).message}. Reading every thread and following from the newest`);
      cursor = registry.eventBatch("0", { kinds }).watermark;
      void sweep();
      return;
    }
    cursor = batch.watermark;
    for (const e of batch.events) {
      if (e.thread === null) continue;
      void (pylonKinds.includes(e.kind) ? readPylon : readHarness)(e.thread as ThreadId);
    }
  }, followMs);
  follow.unref();
  const timer = setInterval(() => void sweep(), sweepMs);
  timer.unref();
  void sweep();

  return {
    sweep,
    readWhole,
    async close() {
      closed = true;
      clearInterval(follow);
      clearInterval(timer);
      await Promise.all([...reads.values()].map((r) => r.settled()));
    },
  };
}
