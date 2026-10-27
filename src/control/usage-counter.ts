/**
 * Reads what every thread's agents spent into the registry: the Nexus agent's calls from the harness, and the calls of
 * the agents in its pylon from their transcripts there. A turn's end reads the thread it ended in, and a sweep reads
 * every thread, once at start and then every `sweepMs`, which catches what no event announces, such as a pi session
 * someone runs in a pylon's terminal. As with Claude's transcripts, a pylon is read only while its node's last
 * observation reports it running, so reading never wakes one, and a failed read keeps what is recorded.
 */
import { readAgentUsage, agentLogs, type FileCursor } from "../agent-usage.ts";
import type { HarnessHost } from "../harness/host.ts";
import type { ConversationId } from "../harness/host.ts";
import type { NodeName, ProbeClient } from "../protocol.ts";
import { singleFlight, type SingleFlight } from "../single-flight.ts";
import type { EventKind } from "../events.ts";
import type { Registry, ThreadId } from "./registry.ts";

export interface UsageCounter {
  /** Reads every thread now. */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

/** The events that end a turn: a pylon session's, which its transcripts record, and the Nexus agent's. */
const pylonKinds: readonly EventKind[] = ["session.turn-ended", "session.ended"];
const harnessKinds: readonly EventKind[] = ["thread.turn-ended"];
/** One read of a pylon takes about a megabyte of calls. One with more goes on in the read after it. */
const maxReadsPerPylon = 16;

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
      }, () => closed));
    }
    return flight.rerun();
  }

  const readHarness = (id: ThreadId) => once(`${id}/harness`, async () => {
    const conversation = registry.thread(id)?.conversationId;
    if (conversation == null) return;
    const after = registry.usageCursors("harness").get(conversation)?.position ?? null;
    const { calls, last } = await harness.usage(Number(conversation) as ConversationId, after);
    if (last !== null && last !== after) registry.recordUsage(id, calls, [{ source: "harness", key: conversation, position: last, before: "" }]);
  });

  const readPylon = (id: ThreadId) => once(`${id}/pylon`, async () => {
    for (let n = 0; n < maxReadsPerPylon && !closed; n++) {
      const t = registry.thread(id);
      const pylon = t === undefined ? undefined : registry.pylon(t.pylonId);
      const node = pylon === undefined ? undefined : registry.node(pylon.node);
      const running = node?.state === "online" && node.observation?.pylons.some((p) => p.pylonId === pylon!.pylonId && p.phase === "running") === true;
      const probe = running ? probes.get(pylon!.node) : undefined;
      if (t === undefined || t.status === "deleted" || probe === undefined) return;
      const cursors = new Map([...registry.usageCursors(t.pylonId)].map(([path, c]): [string, FileCursor] => [path, [c.position, c.before]]));
      const read = await readAgentUsage((argv) => probe.stream(t.pylonId, argv), cursors, logs);
      registry.recordUsage(id, read.calls, [...read.offsets].map(([key, [position, before]]) => ({ source: t.pylonId, key, position, before })));
      if (!read.more) return;
    }
  });

  async function sweep() {
    await Promise.all(registry.threads().flatMap((t) => [readHarness(t.id), readPylon(t.id)]));
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
    async close() {
      closed = true;
      clearInterval(follow);
      clearInterval(timer);
      await Promise.all([...reads.values()].map((r) => r.settled()));
    },
  };
}
