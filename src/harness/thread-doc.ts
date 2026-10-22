/**
 * The `nexus.thread` document: which Nexus thread and pylon a conversation belongs to. Written in the
 * conversation's creating commit and never changed, so the environment factory can find the pylon from the
 * conversation alone.
 */
import type { Context } from "@earendil-works/chord";
import { defineDocFamily, type ConversationId, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import type { PylonId } from "../protocol.ts";

export type ThreadInfo = { threadId: string; pylonId: PylonId };

/**
 * A family with a single member, so the value is created from its seed. A singleton document would start
 * from a placeholder that every reader would have to reject. A fork starts without it, so a fork has no pylon.
 */
const ThreadDoc = defineDocFamily<ThreadInfo, ThreadInfo>({
  kind: "nexus.thread",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (seed) => seed,
  checkpointWhen: () => true,
});
const key = "thread";

export async function writeThread(tx: Tx, conversationId: ConversationId, thread: ThreadInfo): Promise<void> {
  await tx.doc(ThreadDoc, conversationId, key, thread);
}

export async function readThread(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<ThreadInfo> {
  const thread = await read.snapshot(ThreadDoc, conversationId, key, context);
  if (thread === undefined) throw new Error(`conversation ${conversationId} has no ${ThreadDoc.definition.kind} document, so it has no pylon`);
  return thread;
}
