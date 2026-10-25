import type { Context } from "@earendil-works/chord";
import { GenerationTask, LiveDoc, defineDoc, hook, type ConversationId, type Extension, type Harness } from "@earendil-works/pi-durable";
import { readThread } from "./thread-doc.ts";
import type { PylonId } from "../protocol.ts";

const TurnSnapshotDoc = defineDoc<{ turn: string | null }>({
  kind: "nexus.turn-snapshot",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ turn: null }),
  checkpointWhen: () => true,
});

const turnId = (input: number) => `input:${input}`;

export async function latestTurn(harness: Harness, conversationId: ConversationId, context: Context): Promise<string | null> {
  return harness.commit(async (tx) => {
    const input = (await tx.doc(LiveDoc, conversationId)).run?.inputs[0];
    return input === undefined ? (await tx.doc(TurnSnapshotDoc, conversationId)).turn : turnId(input);
  }, context);
}

/** Generation tasks change after each tool round; the first input stays with the whole reply. */
export function turnSnapshots(harness: () => Harness, snapshot: (pylon: PylonId, turn: string) => Promise<void>, log: (message: string) => void): Extension {
  return {
    name: "nexus.turn-snapshot",
    hooks: [hook(GenerationTask, {
      async beforeRequest(_request, api, context) {
        try {
          const input = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs[0];
          if (input === undefined) return;
          const turn = turnId(input);
          const { pylonId } = await readThread(api, api.conversationId, context);
          const claimed = await harness().commit(async (tx) => {
            const state = await tx.doc(TurnSnapshotDoc, api.conversationId);
            if (state.turn === turn) return false;
            state.turn = turn;
            return true;
          }, context);
          if (claimed) await snapshot(pylonId, turn);
        } catch (error) {
          log(`latest-turn snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    })],
  };
}
