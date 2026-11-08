/**
 * What every route asks of the caller and the thread it names, over the registry: the thread once it has what
 * the route needs, and the roles the caller holds.
 */
import type { NodeName, TailnetNodeId, ThreadId } from "../../ids.ts";
import type { QueuedRecord } from "../queue-store.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadStatus } from "../reconcile.ts";
import { HttpError } from "../http-error.ts";
import { answerRefusal, type AnswerRefusal, type Question } from "../questions.ts";
import { tokenDigest } from "../../protocol/deploy.ts";
import { Refusal } from "../refusal.ts";
import { noConversation } from "../thread-agent.ts";

/**
 * Who may call a route: any machine whois names, or the join's whois names, a caller on the allowlist, a person, a
 * deployer, a node's deployer sending its key, or the control node's. Threads, projects and items are the person's, so no pylon, harness thread or the control plane
 * itself acts on a thread or its pylon, edits a project, or adds, approves or cancels an item. A thread never drives
 * another. The control plane's own passes start, message, review and archive threads in-process.
 */
export type Role = "tailnet" | "joiner" | "allowed" | "person" | "deployer" | "reporter" | "control-node";
/**
 * A route's role, checked before it runs. A refusal names the action a person's, a deployer's or the control node's
 * route takes, and a route any allowed caller changes state with says why it may. A route that starts a turn waits out a
 * deploy's drain.
 */
export type Policy = ({ role: "person" | "deployer" | "control-node"; action: string } | { role: "tailnet" | "joiner" | "allowed" | "reporter"; why?: string }) & { startsTurn?: true };
export const anyAllowed = { role: "allowed" } satisfies Policy;

type AccessRegistry = Pick<Registry, "nodeByTailnetId">;

/** Whom the control plane trusts beyond its allowlist: the control node, the deployers, and control.json's deploy keys. */
export interface Deployment {
  self: TailnetNodeId;
  deployers: ReadonlySet<TailnetNodeId>;
  /** A node that joined keeps its key in the registry. */
  keys: Readonly<Record<string, string>>;
}

/** Whether the caller is a person's device: neither the control node nor a node, whose pylons call as their node. */
function isPerson(registry: AccessRegistry, deployment: Deployment, caller: TailnetNodeId): boolean {
  return caller !== deployment.self && registry.nodeByTailnetId(caller) === undefined;
}
/** A person among the deployers, whatever the allowlist says, so a landing the review loop runs later can ask it. */
export function isDeployer(registry: AccessRegistry, deployment: Deployment, caller: TailnetNodeId): boolean {
  return deployment.deployers.has(caller) && isPerson(registry, deployment, caller);
}
function isReporter(registry: AccessRegistry, deployment: Deployment, caller: TailnetNodeId, authorization: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 256) return false;
  const node = registry.nodeByTailnetId(caller);
  if (node === undefined) return false;
  const key = deployment.keys[caller] ?? node.deployKey;
  return tokenDigest(authorization.slice(7)) === key;
}

/** The role a caller must hold before a route says more than that it does not know the caller. */
const admittedAs: Readonly<Record<Role, Role>> = {
  tailnet: "tailnet", joiner: "joiner", allowed: "allowed", person: "allowed", deployer: "allowed", reporter: "reporter", "control-node": "reporter",
};

const unknown = (role: Role) => new Refusal("forbidden", role === "tailnet" || role === "joiner" ? "caller is not a tailnet node" : "caller is not a tailnet node this control plane allows");

/**
 * Refuses a caller holding `roles` that may not reach `policy`'s route, or, without one, any route: an unknown caller,
 * whom the route's own refusal would tell more than that.
 */
export function admit(roles: ReadonlySet<Role>, policy: Policy | undefined) {
  const role = policy === undefined ? null : admittedAs[policy.role];
  if (role === null ? roles.has("allowed") || roles.has("reporter") : roles.has(role)) return;
  throw unknown(role ?? "allowed");
}

export function refusal(roles: ReadonlySet<Role>, policy: Policy): Refusal | null {
  if (roles.has(policy.role)) return null;
  switch (policy.role) {
    case "person": return new Refusal("forbidden", `caller may not ${policy.action}: only a person may, never the control plane, infrastructure nodes or pylons`);
    case "deployer": return new Refusal("forbidden", `caller may not ${policy.action}: only deployers may, never infrastructure nodes or pylons`);
    case "control-node": return new Refusal("forbidden", `only the control node ${policy.action}`);
    default: return unknown(policy.role);
  }
}

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

export function apiAccess(registry: Registry, wake: (node: NodeName) => void, options: { deployment?: Deployment | undefined; allowed: ReadonlySet<TailnetNodeId> }) {
  /**
   * The roles a caller whois names holds. A person or a deployer is also allowed, and the control node is the reporter
   * the control plane runs as. Without deployment options the control node is unknown, so no caller is a person or a
   * reporter.
   */
  function roleOf(caller: TailnetNodeId, authorization?: string): ReadonlySet<Role> {
    const roles = new Set<Role>(["tailnet"]);
    const { deployment } = options;
    const allowed = options.allowed.has(caller);
    if (allowed) roles.add("allowed");
    if (deployment === undefined) return roles;
    if (allowed && isPerson(registry, deployment, caller)) roles.add("person");
    if (allowed && isDeployer(registry, deployment, caller)) roles.add("deployer");
    if (isReporter(registry, deployment, caller, authorization)) {
      roles.add("reporter");
      if (caller === deployment.self) roles.add("control-node");
    }
    return roles;
  }

  /** The thread `id` names, or the queue record of one that has not started, which has no row. */
  function lookup(id: string): { thread: Thread } | { queued: QueuedRecord } {
    const found = registry.thread(id as ThreadId);
    if (found !== undefined) return { thread: found };
    const queued = registry.queuedThread(id as ThreadId);
    if (queued !== undefined && queued.status !== "started") return { queued };
    throw new HttpError(404, `no thread ${id}`);
  }

  function thread(id: string, need: Need = {}): Thread {
    const found = lookup(id);
    if ("thread" in found) return guard(found.thread, need);
    const { status } = found.queued;
    throw new HttpError(409, status === "queued" ? `thread ${id} is queued, so it has no pylon or conversation yet` : `thread ${id} was ${status === "archived" ? "cancelled" : "deleted"} while queued, so it has no pylon or conversation`, "queued");
  }

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

  function wakeThread(t: Thread) {
    wake(registry.pylon(t.pylonId)!.node);
  }

  return { lookup, thread, threadRefusal, guard, current, wakeThread, roleOf };
}
export type Access = ReturnType<typeof apiAccess>;

/** Landing merges and may deploy, so it takes the same right as `nexus deploy`, whatever the repository. */
export const landing = { role: "deployer", action: "land a pull request, which deploys" } satisfies Policy;

/** Refuses a caller holding `roles` that does not hold `policy`'s role: a route's, or one its body asks for, such as a landing. */
export function demand(roles: ReadonlySet<Role>, policy: Policy) {
  const refused = refusal(roles, policy);
  if (refused !== null) throw refused;
}

export function refusalOf(roles: ReadonlySet<Role>, question: Question): AnswerRefusal | null {
  return answerRefusal(question, { person: roles.has("person"), deployer: roles.has("deployer") });
}
