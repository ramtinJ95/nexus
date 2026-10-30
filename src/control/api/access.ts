/**
 * What every route asks of the caller and the thread it names, over the registry: the thread once it has what
 * the route needs, and whether a person or a deployer calls.
 */
import type { NodeName, TailnetNodeId, ThreadId } from "../../ids.ts";
import type { QueuedRecord } from "../queue-store.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadStatus } from "../../reconcile.ts";
import { HttpError } from "../http-error.ts";
import { answerRefusal, type AnswerRefusal, type Question } from "../questions.ts";
import { canDeploy, isPerson, type DeploymentOptions } from "../releases.ts";
import { noConversation } from "../thread-agent.ts";

/**
 * What a route needs of a thread's status: the statuses it refuses, and whether the refusal says the pylon stays
 * paused. A deleted thread's conversation and pylon are gone, and an archived thread's pylon stays paused, so its
 * agent could not run a tool.
 */
const statusNeeds: Readonly<Record<"kept" | "open" | "pylon" | "active", { refuses: readonly ThreadStatus[]; paused: boolean }>> = {
  kept: { refuses: ["deleted"], paused: false },
  open: { refuses: ["archived", "deleted"], paused: false },
  pylon: { refuses: ["archived", "deleted"], paused: true },
  active: { refuses: ["idle", "archived", "deleted"], paused: true },
};
/** What a route needs of a thread: a status, and an agent of one kind. */
interface Need { status?: keyof typeof statusNeeds; agent?: "harness" | "claude" }

export function apiAccess(registry: Registry, wake: (node: NodeName) => void, options: { deployment?: DeploymentOptions | undefined }) {
  /** The thread `id` names, or the queue record of one that has not started, which has no row. */
  function lookup(id: string): { thread: Thread } | { queued: QueuedRecord } {
    const found = registry.thread(id as ThreadId);
    if (found !== undefined) return { thread: found };
    const queued = registry.queuedThread(id as ThreadId);
    if (queued !== undefined && queued.status !== "started") return { queued };
    throw new HttpError(404, `no thread ${id}`);
  }

  /** The thread `id` names, once it has what `need` asks of it. */
  function thread(id: string, need: Need = {}): Thread {
    const found = lookup(id);
    if ("thread" in found) return guard(found.thread, need);
    const { status } = found.queued;
    throw new HttpError(409, status === "queued" ? `thread ${id} is queued, so it has no pylon or conversation yet` : `thread ${id} was ${status === "archived" ? "cancelled" : "deleted"} while queued, so it has no pylon or conversation`);
  }

  /** Why the thread does not have what `need` asks of it, or null when it does. */
  function threadRefusal(t: Thread, need: Need): string | null {
    const status = need.status === undefined ? undefined : statusNeeds[need.status];
    if (status?.refuses.includes(t.status)) return `thread ${t.id} is ${t.status}${status.paused ? ", so its pylon stays paused" : ""}`;
    if (need.agent === undefined || registry.agent(t).kind === need.agent) return null;
    return need.agent === "claude" ? `thread ${t.id} has no Claude worker` : noConversation(t);
  }

  function guard(t: Thread, need: Need): Thread {
    const refused = threadRefusal(t, need);
    if (refused !== null) throw new HttpError(409, refused);
    return t;
  }

  /** The thread with its status now, which a request that waited may have seen change. */
  const current = (t: Thread): Thread => ({ ...t, status: registry.threadStatus(t.id)! });

  /**
   * Threads, projects and items are the person's, so no pylon, harness thread or the control plane itself acts on a
   * thread or its pylon, edits a project, or adds, approves or cancels an item. A thread never drives another. The
   * control plane's own passes start, message, review and archive threads in-process.
   */
  function personOnly(caller: TailnetNodeId, action: string) {
    if (!isPerson(registry, options.deployment, caller)) throw new HttpError(403, `caller may not ${action}: only a person may, never the control plane, infrastructure nodes or pylons`);
  }

  function wakeThread(t: Thread) {
    wake(registry.pylon(t.pylonId)!.node);
  }

  /** Landing merges and may deploy, so it takes the same right as `nexus deploy`, whatever the repository. */
  function mayLand(caller: TailnetNodeId) {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not land a pull request: landing deploys, and only deployers may, never infrastructure nodes or pylons");
  }

  function refusalOf(caller: TailnetNodeId, question: Question): AnswerRefusal | null {
    return answerRefusal(question, { person: isPerson(registry, options.deployment, caller), deployer: canDeploy(registry, options.deployment, caller) });
  }

  return { lookup, thread, threadRefusal, guard, current, wakeThread, personOnly, mayLand, refusalOf };
}
export type Access = ReturnType<typeof apiAccess>;
