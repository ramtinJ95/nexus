/**
 * The services that start threads (starter, queue, pipeline and planning), wired once for the control plane and the
 * tests that stand in for it.
 */
import type { HarnessHost } from "../harness/host.ts";
import type { TurnGate } from "./drain.ts";
import { pipeline } from "./pipeline.ts";
import { planning } from "./planning.ts";
import { threadQueue } from "./queue.ts";
import type { Thread } from "./thread-store.ts";
import { threadStarter } from "./threads.ts";

export function threadServices(options: Parameters<typeof threadStarter>[0] & {
  harness: Pick<HarnessHost, "startThread" | "send">;
  gate: TurnGate;
  log?: (message: string) => void;
  /** Needs the control plane's GitHub token, which tells it when a predecessor's pull request merged. */
  queue: boolean;
  /** Needs the queue, which starts its items' threads. */
  pipeline: boolean;
  /** Reads a planning thread's replies. Null: no planning pass. */
  planning: { replies(t: Thread): Promise<string[]> } | null;
}) {
  const { registry, harness, gate, log = () => {} } = options;
  const startThread = threadStarter(options);
  // Its starts pass the drain gate, so a deploy's drain refuses them, which leaves them queued, and waits for one in flight.
  const queue = !options.queue ? null : threadQueue({
    registry, startThread, gate, log,
    send: (id, text, requestId) => harness.send(id, text, requestId, "followUp"),
  });
  const items = queue === null || !options.pipeline ? null : pipeline({ registry, queue, log });
  const plans = options.planning === null ? null : planning({ registry, pipeline: items, replies: options.planning.replies, log });
  return {
    api: { startThread, queue, pipeline: items, planning: plans },
    /**
     * Each on its own timer. In one callback, the pipeline's poll of the queue would join the queue's empty pass before
     * it settles, so an item queued then would wait 15 seconds more to start.
     */
    polls: [() => queue?.poll(), () => items?.poll(), () => plans?.poll()],
    async close() {
      await plans?.close();
      await items?.close();
      await queue?.close();
    },
  };
}
