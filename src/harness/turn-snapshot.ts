import { GenerationTask, LiveDoc, hook, type Extension } from "@earendil-works/pi-durable";
import { readThread } from "./thread-doc.ts";
import type { PylonId } from "../protocol.ts";

/** A run is one reply, including all its tool rounds and any steering inputs. */
export function turnSnapshots(snapshot: (pylon: PylonId, turn: string) => Promise<void>, log: (message: string) => void): Extension {
  return {
    name: "nexus.turn-snapshot",
    hooks: [hook(GenerationTask, {
      async beforeRequest(_request, api, context) {
        try {
          const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
          if (run === undefined) return;
          if (await api.memo("nexus.snapshot", context) === true) return;
          const { pylonId } = await readThread(api, api.conversationId, context);
          await api.memo("nexus.snapshot", true, context);
          await snapshot(pylonId, String(run.taskId));
        } catch (error) {
          log(`latest-turn snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    })],
  };
}
