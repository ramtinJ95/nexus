/**
 * The control plane's one pi-durable harness. It runs inside the control-plane process, over one SQLite file
 * that only this process opens, because pi-durable has no cross-process locking. Each thread is one
 * ownerless conversation whose `nexus.thread` document names its pylon. The control plane addresses threads
 * by ID and never imports pi-durable itself.
 *
 * After a crash, opening the same file resumes every unfinished run. A tool call that was in flight is not
 * rerun: the model gets pi-durable's `interrupted` result instead.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId, type ConversationWatch, type ModelRef, type Submission } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Models } from "@earendil-works/pi-ai/models";
import type { PylonId } from "../protocol.ts";
import { trackActivity, type HarnessActivity } from "./activity.ts";
import { pylonEnvs, type PylonLocator } from "./pylon-env.ts";
import { writeThread } from "./thread-doc.ts";

/** Where the repository is checked out in every pylon. */
export const pylonRepoPath = "/home/user/workspace/repo";

export interface HarnessHostOptions {
  /** For example /var/lib/nexus/harness.sqlite. Its own file, not the registry's. */
  storagePath: string;
  models: Models;
  /** The model new threads start with. */
  model: ModelRef;
  locator: PylonLocator;
  /** The control plane's tailscaled LocalAPI socket, which each bridge uses to verify the probe it reached. */
  tailscaled: string;
  /** Every thread in the registry with its `Thread.conversationId`. */
  threads: readonly { threadId: string; conversationId: ConversationId }[];
  log(message: string): void;
}

export interface HarnessHost {
  /**
   * Creates the thread's conversation and returns its ID. Write the registry row with that ID afterwards: a
   * crash in between leaves an empty conversation that nothing points to, which is harmless.
   */
  startThread(thread: { threadId: string; pylonId: PylonId }): Promise<ConversationId>;
  /**
   * A message from the dashboard. A retry with the same `requestId` returns the first submission. A busy
   * conversation queues it as a follow-up, or with `steer` places it after the current tool round.
   */
  send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer"): Promise<Submission>;
  abort(threadId: string): Promise<void>;
  /** Runs again the tasks the restart limit parked, which otherwise hold the thread's run forever. */
  retry(threadId: string): Promise<void>;
  /** The conversation view, then the exact operations of each commit, for the dashboard to stream. */
  watch(threadId: string): Promise<ConversationWatch>;
  readonly activity: HarnessActivity;
  close(): Promise<void>;
}

export async function openHarnessHost(options: HarnessHostOptions): Promise<HarnessHost> {
  const { log } = options;
  const activity = trackActivity();
  const envs = pylonEnvs(options.locator, { tailscaled: options.tailscaled, log });
  const registry = createRegistry();
  registry.install(CodingTools);
  const harness = await Harness.open(await openNodeSqliteStorage(options.storagePath), {
    models: options.models,
    registry,
    env: envs.env,
    onReport(error, info) {
      log(`harness ${info.type}: ${error instanceof Error ? error.message : String(error)}`);
    },
  }, context);

  const conversations = new Map<string, ConversationId>();
  for (const { threadId, conversationId } of options.threads) {
    conversations.set(threadId, conversationId);
    await activity.track(harness, threadId, conversationId, context);
  }
  // A task is parked when its stored restart count reaches the limit. Only open's recovery raises that count,
  // so the tasks inspect shows blocked right after open are every parked task until the next open.
  for (const { record, state } of (await harness.inspect(context)).tasks) {
    if (state.kind === "blocked" && state.reason === "restart_limit") activity.park(record.conversationId, record.id);
  }
  harness.resume();

  async function conversation(threadId: string) {
    const id = conversations.get(threadId);
    const found = id === undefined ? undefined : await harness.conversation(id, context);
    if (found === undefined) throw new Error(`the harness has no conversation for thread ${threadId}`);
    return found;
  }

  return {
    activity,
    async startThread({ threadId, pylonId }) {
      if (conversations.has(threadId)) throw new Error(`thread ${threadId} already has conversation ${conversations.get(threadId)}`);
      const created = await harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: options.model, cwd: pylonRepoPath },
        init: (tx, id) => writeThread(tx, id, { threadId, pylonId }),
      }, context);
      conversations.set(threadId, created.id);
      await activity.track(harness, threadId, created.id, context);
      return created.id;
    },
    async send(threadId, text, requestId, mode) {
      return (await conversation(threadId)).submit({ type: "input", content: text, requestId, whenBusy: mode }, context);
    },
    async abort(threadId) {
      await (await conversation(threadId)).abort(context);
    },
    async retry(threadId) {
      for (const taskId of activity.parked(threadId)) await harness.retryTask(taskId, context);
      activity.retried(threadId);
    },
    async watch(threadId) {
      return (await conversation(threadId)).watch(context);
    },
    async close() {
      await activity.close();
      await harness.close(context);
      envs.close();
    },
  };
}
