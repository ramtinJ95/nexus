/**
 * The control plane's one pi-durable harness. It runs inside the control-plane process, over one SQLite file
 * that only this process opens, because pi-durable has no cross-process locking. Each thread is one
 * ownerless conversation whose `nexus.thread` document names its pylon. The control plane addresses threads
 * by ID and never imports pi-durable itself. A judgment is an ownerless conversation too, with no thread, no
 * pylon, no tools and no extensions, which the control plane addresses by its conversation ID.
 *
 * After a crash, opening the same file resumes every unfinished run. A tool call that was in flight is not
 * rerun: the model gets pi-durable's `interrupted` result instead.
 *
 * pi-durable 1.4.0 cannot delete a conversation, so a deleted thread's conversation is aborted and forgotten,
 * and its transcript stays in the file.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, LiveDoc, type ConversationId, type ConversationWatch, type Cursor, type EntryId, type ModelRef, type Submission } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Models } from "@earendil-works/pi-ai/models";
import { checkoutReader } from "../checkout-files.ts";
import { checkoutDir } from "../sessions.ts";
import { localApiWhois } from "../tailscale.ts";
import { connectProbe, jobDeadlineMs, type PylonId } from "../protocol.ts";
import { trackActivity, type AgentFacts, type HarnessActivity } from "./activity.ts";
import { pylonEnvs, type PylonLocator } from "./pylon-env.ts";
import { latestTurn, turnSnapshots } from "./turn-snapshot.ts";
import { writeThread } from "./thread-doc.ts";
import type { AgentCall } from "../agent-usage.ts";
import { senderNames, type Sender } from "../agent-protocol.ts";

export type { ConversationId };

export interface HarnessHostOptions {
  /** For example /var/lib/nexus/harness.sqlite. Its own file, not the registry's. */
  storagePath: string;
  models: Models;
  /** The model new threads start with. */
  model: ModelRef;
  locator: PylonLocator;
  /** The control plane's tailscaled LocalAPI socket, which each bridge uses to verify the probe it reached. */
  tailscaled: string;
  /** Every thread in the registry with its `Thread.conversationId`, except deleted ones, and its recorded agentTurnRunning. */
  threads: readonly { threadId: string; conversationId: ConversationId; agentTurnRunning: boolean }[];
  /**
   * The conversations of deleted threads whose abort is not recorded. Open aborts each, because a crash during a delete
   * can leave its run unfinished, and opening resumes every unfinished run. pi-durable cannot hold one back, and an abort resumes
   * scheduling itself, so such a run may send one model request before its abort lands. Its tools cannot run,
   * because the control plane's locator refuses a deleted thread's pylon.
   */
  deleted: readonly ConversationId[];
  /** A deleted thread's conversation is aborted, at open or by deleteThread, so no later open needs to abort it again. */
  onAborted?: (conversationId: ConversationId) => void;
  /** A thread's agent facts changed, or differ at open from what `threads` says the registry holds. */
  onReply?: (threadId: string, at: number) => void;
  onParked?: (threadId: string, parked: boolean) => void;
  onActivity(threadId: string, facts: AgentFacts): void;
  log(message: string): void;
}

export interface HarnessHost {
  /**
   * Creates the thread's conversation and returns its ID. Write the registry row with that ID afterwards: a
   * crash in between leaves an empty conversation that nothing points to, which is harmless. A thread that already
   * has one gets it back, so a queued thread's start that failed after this can run again.
   */
  startThread(thread: { threadId: string; pylonId: PylonId }): Promise<ConversationId>;
  /**
   * A human message, or an attributed PR-watch input. A retry with the same `requestId` returns the first submission. A busy
   * conversation queues it as a follow-up, or with `steer` places it after the current tool round.
   */
  send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: Sender): Promise<Submission>;
  latestTurn(threadId: string): Promise<string | null>;
  abort(threadId: string): Promise<void>;
  /** Runs again the tasks the restart limit parked, which otherwise hold the thread's run forever. */
  retry(threadId: string): Promise<void>;
  /** The conversation view, then the exact operations of each commit, for the dashboard to stream. */
  watch(threadId: string): Promise<ConversationWatch>;
  /** Aborts the thread's run and stops its pylon's daemon. Its conversation stays in storage, unreachable. */
  deleteThread(thread: { threadId: string; pylonId: PylonId }): Promise<void>;
  /**
   * The model calls of the conversation's assistant entries after entry `after`, and the last entry read. A deleted
   * thread's conversation is still in storage, so it is read too.
   */
  usage(conversationId: ConversationId, after: number | null): Promise<{ calls: AgentCall[]; last: number | null }>;
  /**
   * Creates a judgment's conversation and returns its ID. It has no tools, no extensions and no cwd, so its model can
   * reach nothing, and no `nexus.thread` document, so it has no pylon. Save the ID once this returns: a crash in between
   * leaves an empty conversation that is never sent a brief, so it never calls a model.
   */
  startJudgment(): Promise<ConversationId>;
  /** A retry with the same `requestId` returns the first submission. */
  sendJudgment(conversationId: ConversationId, brief: string, requestId: string): Promise<void>;
  /** The text of each of the judgment's answers, oldest first, once its run has ended. Null while it runs. */
  judgmentReplies(conversationId: ConversationId): Promise<string[] | null>;
  abortJudgment(conversationId: ConversationId): Promise<void>;
  readonly activity: HarnessActivity;
  close(): Promise<void>;
}

export async function openHarnessHost(options: HarnessHostOptions): Promise<HarnessHost> {
  const { log } = options;
  const activity = trackActivity({ onParked: (id, parked) => options.onParked?.(id, parked), onChange: options.onActivity, onReply: (id, at) => options.onReply?.(id, at) });
  const envs = pylonEnvs(options.locator, { tailscaled: options.tailscaled, log });
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(turnSnapshots(() => harness, async (pylon, turn) => {
    const target = await options.locator.awaitRunning(pylon, Date.now() + jobDeadlineMs.spawn);
    const client = connectProbe(target.node, target.host, target.nodeId, { port: target.port, whois: localApiWhois(options.tailscaled) });
    await checkoutReader((argv) => client.stream(pylon, argv), checkoutDir).snapshot(turn);
  }, log));
  const harness = await Harness.open(await openNodeSqliteStorage(options.storagePath), {
    models: options.models,
    registry,
    env: envs.env,
    onReport(error, info) {
      log(`harness ${info.type}: ${error instanceof Error ? error.message : String(error)}`);
    },
  }, context);

  const conversations = new Map<string, ConversationId>();
  for (const { threadId, conversationId, agentTurnRunning } of options.threads) {
    conversations.set(threadId, conversationId);
    await activity.track(harness, threadId, conversationId, agentTurnRunning, context);
  }
  // A task is parked when its stored restart count reaches the limit. Only open's recovery raises that count,
  // so the tasks inspect shows blocked right after open are every parked task until the next open.
  for (const { record, state } of (await harness.inspect(context)).tasks) {
    if (state.kind === "blocked" && state.reason === "restart_limit") activity.park(record.conversationId, record.id);
  }
  harness.resume();
  for (const id of options.deleted) {
    const deleted = await harness.conversation(id, context);
    if (deleted === undefined) throw new Error(`the harness has no conversation ${id}, which a deleted thread names`);
    await deleted.abort(context);
    options.onAborted?.(id);
  }

  async function conversation(threadId: string) {
    const id = conversations.get(threadId);
    const found = id === undefined ? undefined : await harness.conversation(id, context);
    if (found === undefined) throw new Error(`the harness has no conversation for thread ${threadId}`);
    return found;
  }

  async function judgment(id: ConversationId) {
    const found = await harness.conversation(id, context);
    if (found === undefined) throw new Error(`the harness has no judgment conversation ${id}`);
    return found;
  }

  return {
    activity,
    async startThread({ threadId, pylonId }) {
      const existing = conversations.get(threadId);
      if (existing !== undefined) return existing;
      const created = await harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: options.model, cwd: checkoutDir },
        init: (tx, id) => writeThread(tx, id, { threadId, pylonId }),
      }, context);
      conversations.set(threadId, created.id);
      // A new registry row records no running turn. The row does not exist yet, so nothing may be reported now.
      await activity.track(harness, threadId, created.id, false, context);
      return created.id;
    },
    async send(threadId, text, requestId, mode, sender) {
      return (await conversation(threadId)).submit({ type: "input", content: text, requestId, whenBusy: mode, ...(sender ? { entry: { kind: `nexus.${sender}`, data: { sender: senderNames[sender] } } } : {}) }, context);
    },
    async latestTurn(threadId) {
      const conversationId = conversations.get(threadId);
      if (conversationId === undefined) return null;
      return latestTurn(harness, conversationId, context);
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
    async usage(conversationId, after) {
      const found = await harness.conversation(conversationId, context);
      const calls: AgentCall[] = [];
      let last = after;
      let cursor: Cursor | undefined;
      do {
        if (found === undefined) break;
        const page = await found.entries({ order: "ascending", ...(after === null ? {} : { minEntryId: (after + 1) as EntryId }) }, 500, cursor, context);
        for (const entry of page.items) {
          last = entry.id;
          for (const m of entry.model ?? []) {
            if (m.role !== "assistant") continue;
            const { input, output, cacheWrite, cacheRead } = m.usage;
            if (input + output + cacheWrite + cacheRead > 0) calls.push({ id: `harness:${conversationId}/${entry.id}`, agent: "pi", model: m.model, at: m.timestamp, input, output, cacheWrite, cacheRead });
          }
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return { calls, last };
    },
    async startJudgment() {
      return (await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: options.model, extensions: [], tools: [] } }, context)).id;
    },
    async sendJudgment(id, brief, requestId) {
      await (await judgment(id)).submit({ type: "input", content: brief, requestId }, context);
    },
    async judgmentReplies(id) {
      const found = await judgment(id);
      // A submit starts the run in the commit that admits it, so a run that is gone has ended.
      if (await found.commit(async (tx) => (await tx.doc(LiveDoc, id)).run !== undefined, context)) return null;
      const replies: string[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await found.entries({ order: "ascending" }, 500, cursor, context);
        for (const m of page.items.flatMap((entry) => entry.model ?? [])) {
          if (m.role === "assistant") replies.push(m.content.flatMap((c) => c.type === "text" ? [c.text] : []).join(""));
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return replies;
    },
    async abortJudgment(id) {
      await (await judgment(id)).abort(context);
    },
    async deleteThread({ threadId, pylonId }) {
      const deleting = await conversation(threadId);
      await deleting.abort(context);
      options.onAborted?.(deleting.id);
      conversations.delete(threadId);
      await activity.untrack(threadId);
      envs.forget(pylonId);
    },
    async close() {
      await activity.close();
      await harness.close(context);
      envs.close();
    },
  };
}
