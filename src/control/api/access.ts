/**
 * What every route asks of the caller and the thread it names, over the registry: the thread once it has what
 * the route needs, and the roles the caller holds.
 */
import type { NodeName, Person, TailnetNodeId, ThreadId } from "../../ids.ts";
import type { TailnetIdentity } from "../../node-base/tailscaled.ts";
import type { QueuedRecord } from "../queue-store.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadStatus } from "../reconcile.ts";
import { HttpError } from "../http-error.ts";
import { answerRefusal, type AnswerRefusal, type Question } from "../questions.ts";
import { tokenDigest } from "../../protocol/deploy.ts";
import { Refusal } from "../refusal.ts";
import { noConversation } from "../thread-agent.ts";
import { landingOff, operator, personOf, solo, type People, type Starter } from "../people.ts";

/**
 * Who may call a route: any machine whois names, or the join's whois names, a caller on the allowlist, a person, a
 * deployer, a node's deployer sending its key, or the control node's. Threads, projects and items are the person's, so no pylon, harness thread or the control plane
 * itself acts on a thread or its pylon, edits a project, or adds, approves or cancels an item. A thread never drives
 * another. The control plane's own passes start, message, review and archive threads in-process.
 */
export type Role = "tailnet" | "joiner" | "allowed" | "person" | "deployer" | "reporter" | "control-node";
/** The role a policy asks of the caller. Whether the caller owns the thread is a fact of the thread, not a role. */
const roleNeeded = (policy: RolePolicy | OwnerPolicy): Role => policy.role === "owner" ? "person" : policy.role;
/**
 * A route's role, checked before it runs. A refusal names the action a person's, a deployer's or the control node's
 * route takes, and a route any allowed caller changes state with says why it may. A route that starts a turn waits out a
 * deploy's drain. A route that lands is refused to everyone on a shared install.
 */
export type Policy = (RolePolicy | OwnerPolicy | AdminPolicy) & { startsTurn?: true; lands?: true };
type RolePolicy = { role: "person" | "deployer" | "control-node"; action: string } | { role: "tailnet" | "joiner" | "allowed" | "reporter"; why?: string };
/**
 * A person's route that acts on the thread its path names, which on a shared install only that thread's owner may take,
 * and an admin too where `admin` says so. A solo install's one person owns every thread.
 */
export interface OwnerPolicy { role: "owner"; action: string; admin?: true }
/** A route that on a shared install only an admin may take. A solo install checks `solo`, the route's policy before people. */
export interface AdminPolicy { role: "admin"; action: string; solo: RolePolicy }
export const anyAllowed = { role: "allowed" } satisfies Policy;

type AccessRegistry = Pick<Registry, "nodes">;
/** Who whois names a request's device as, and the roles roleOf gives it. */
export interface Caller { identity: TailnetIdentity; roles: ReadonlySet<Role> }

/** Whom the control plane trusts beyond its allowlist: the control node, the deployers, and control.json's deploy keys. */
export interface Deployment {
  self: TailnetNodeId;
  deployers: ReadonlySet<TailnetNodeId>;
  /** A node that joined keeps its key in the registry. */
  keys: Readonly<Record<string, string>>;
}

/** Whether the caller is a person's device: neither the control node nor a node, whose pylons call as their node. */
function isPerson(registry: AccessRegistry, deployment: Deployment, caller: TailnetNodeId): boolean {
  return caller !== deployment.self && registry.nodes.nodeByTailnetId(caller) === undefined;
}
/** A person among the deployers, whatever the allowlist says, so a landing the review loop runs later can ask it. */
export function isDeployer(registry: AccessRegistry, deployment: Deployment, caller: TailnetNodeId): boolean {
  return deployment.deployers.has(caller) && isPerson(registry, deployment, caller);
}
function isReporter(registry: AccessRegistry, deployment: Deployment, caller: TailnetNodeId, authorization: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 256) return false;
  const node = registry.nodes.nodeByTailnetId(caller);
  if (node === undefined) return false;
  const key = deployment.keys[caller] ?? node.deployKey;
  return tokenDigest(authorization.slice(7)) === key;
}

/** The role a caller must hold before a route says more than that it does not know the caller. */
const admittedAs: Readonly<Record<Exclude<Policy["role"], "admin">, Role>> = {
  tailnet: "tailnet", joiner: "joiner", allowed: "allowed", person: "allowed", owner: "allowed", deployer: "allowed", reporter: "reporter", "control-node": "reporter",
};

/** The step that lets `caller` do what it asked, which only the control plane's machine takes. */
const admitting = (caller: TailnetNodeId, what: string) => `. If it is your own device, run this on the control plane's machine, in its nexus checkout after git pull, to let it ${what}: sudo deploy/install.sh --admit ${caller}`;

const unknown = (role: Role, caller: TailnetNodeId | null) => new Refusal("forbidden", role === "tailnet" || role === "joiner" ? "caller is not a tailnet node"
  : `caller is not a tailnet node this control plane allows${role === "allowed" && caller !== null ? admitting(caller, "use Nexus and deploy") : ""}`);

/**
 * Refuses a caller holding `roles` that may not reach `policy`'s route, or, without one, any route: an unknown caller,
 * whom the route's own refusal would tell more than that.
 */
export function admit(roles: ReadonlySet<Role>, policy: Policy | undefined, caller: TailnetNodeId | null): void {
  if (policy?.role === "admin") return admit(roles, policy.solo, caller);
  const role = policy === undefined ? null : admittedAs[policy.role];
  if (role === null ? roles.has("allowed") || roles.has("reporter") : roles.has(role)) return;
  throw unknown(role ?? "allowed", caller);
}

/** A person who is no deployer is told how to become one. A node never may, so it is not. */
export function refusal(roles: ReadonlySet<Role>, policy: Policy, caller: TailnetNodeId | null = null): Refusal | null {
  if (policy.role === "admin") return refusal(roles, policy.solo, caller);
  if (roles.has(roleNeeded(policy))) return null;
  switch (policy.role) {
    case "person": case "owner": return new Refusal("forbidden", `caller may not ${policy.action}: only a person may, never the control plane, infrastructure nodes or pylons`);
    case "deployer": return new Refusal("forbidden", `caller may not ${policy.action}: only deployers may, never infrastructure nodes or pylons${roles.has("person") && caller !== null ? admitting(caller, "deploy") : ""}`);
    case "control-node": return new Refusal("forbidden", `only the control node ${policy.action}`);
    default: return unknown(policy.role, caller);
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
interface Need { status?: keyof typeof statusNeeds; agent?: "harness" | "claude" }

export const threadWaker = (registry: Pick<Registry, "threads">, wake: (node: NodeName) => void) => (t: Pick<Thread, "pylonId">) => wake(registry.threads.pylon(t.pylonId)!.node);

export function apiAccess(registry: Registry, wake: (node: NodeName) => void, options: { deployment?: Deployment | undefined; allowed: ReadonlySet<TailnetNodeId>; people?: People | undefined }) {
  const { people = solo } = options;
  /**
   * The roles a caller whois names holds. A person or a deployer is also allowed, and the control node is the reporter
   * the control plane runs as. Without deployment options the control node is unknown, so no caller is a person or a
   * reporter. On a shared install a person is a login in `people` on a device that is neither the control node nor a
   * node, and an admin holds what a deployer holds.
   */
  function roleOf(caller: TailnetNodeId, identity: TailnetIdentity, authorization?: string): ReadonlySet<Role> {
    const roles = new Set<Role>(["tailnet"]);
    const { deployment } = options;
    const named = people.shared && deployment !== undefined && isPerson(registry, deployment, caller) ? personOf(people, identity) : null;
    const allowed = options.allowed.has(caller) || named !== null;
    if (allowed) roles.add("allowed");
    if (deployment === undefined) return roles;
    if (people.shared ? named !== null : allowed && isPerson(registry, deployment, caller)) roles.add("person");
    if (people.shared ? named?.role === "admin" : allowed && isDeployer(registry, deployment, caller)) roles.add("deployer");
    if (isReporter(registry, deployment, caller, authorization)) {
      roles.add("reporter");
      if (caller === deployment.self) roles.add("control-node");
    }
    return roles;
  }

  /** The thread `id` names, or the queue record of one that has not started, which has no row. */
  function lookup(id: string): { thread: Thread } | { queued: QueuedRecord } {
    const found = registry.threads.thread(id as ThreadId);
    if (found !== undefined) return { thread: found };
    const queued = registry.queue.queuedThread(id as ThreadId);
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
    if (status?.refuses.includes(t.status)) return `thread ${t.id} is ${t.status}${status.paused ? ", so its pylon stays paused" : ""}${t.status === "archived" ? `. \`nexus unarchive ${t.id}\` opens it again` : ""}`;
    if (need.agent === undefined || registry.threads.agent(t).kind === need.agent) return null;
    return need.agent === "claude" ? `thread ${t.id} has no Claude worker` : noConversation(t);
  }

  function guard(t: Thread, need: Need): Thread {
    const refused = threadRefusal(t, need);
    if (refused !== null) throw new HttpError(409, refused);
    return t;
  }

  /** The thread with its status now, which a request that waited may have seen change. */
  const current = (t: Thread): Thread => ({ ...t, status: registry.threads.threadStatus(t.id)! });

  /**
   * A caller the installer's --admit may admit: neither the control node nor one of its nodes. A shared install admits
   * by login, which --admit does not write.
   */
  const admittable = (caller: TailnetNodeId) => !people.shared && (options.deployment === undefined ? registry.nodes.nodeByTailnetId(caller) === undefined : isPerson(registry, options.deployment, caller));

  /**
   * The person a caller is: a solo install's operator, or on a shared install the login of a caller roleOf names a
   * person, never the control node or a node, whatever user whois names for it.
   */
  const personAs = ({ identity, roles }: Caller): Person | null => !people.shared ? operator : roles.has("person") ? personOf(people, identity)?.person ?? null : null;

  /** Who a person's request starts or queues a thread as. On a shared install its owner is the login the person route admitted. */
  function starter(r: Caller & { caller: TailnetNodeId }): Starter {
    const owner = personAs(r);
    if (owner === null) throw new Refusal("forbidden", "only a person in control.json's people may start a thread");
    return { caller: r.caller, owner };
  }

  /**
   * Thread `id`'s owner when the caller is someone else on a shared install, or null: the caller owns it, or the
   * thread has no row and no queue record, which the route's own lookup refuses.
   */
  function ownerOtherThan(id: string, caller: Caller): Person | null {
    if (!people.shared) return null;
    const found = registry.threads.thread(id as ThreadId) ?? registry.queue.queuedThread(id as ThreadId);
    const owner = found === undefined ? null : found.owner ?? operator;
    return owner === personAs(caller) ? null : owner;
  }

  /** Refuses a person who may not take `policy`'s route on thread `id`: anyone but its owner, unless the route admits an admin and the caller is one. */
  function actsOn(id: string, caller: Caller, policy: OwnerPolicy) {
    const owner = ownerOtherThan(id, caller);
    if (owner === null || (policy.admin === true && caller.roles.has("deployer"))) return;
    throw new Refusal("forbidden", `thread ${id} is ${owner}'s, so only ${owner}${policy.admin === true ? " or an admin" : ""} may ${policy.action}`);
  }

  /** Refuses anyone but an admin `policy`'s route on a shared install, where an admin holds what a deployer holds. */
  function administers(caller: Pick<Caller, "roles">, policy: AdminPolicy) {
    if (people.shared && !caller.roles.has("deployer")) throw new Refusal("forbidden", `caller may not ${policy.action}: only an admin may`);
  }

  /** Refuses every landing on a shared install, which never merges, before any role is checked. */
  function refuseLanding() {
    if (people.shared) throw landingOff();
  }
  /** Refuses a landing a route's body asks for: on a shared install to everyone, and on a solo one to a caller who may not deploy. */
  function lands(r: { roles: ReadonlySet<Role>; caller: TailnetNodeId }) {
    refuseLanding();
    demand(r.roles, landing, r.caller);
  }

  const answerRefusalOf = (caller: Caller, question: Question): AnswerRefusal | null =>
    answerRefusal(question, { person: caller.roles.has("person"), deployer: caller.roles.has("deployer"), owner: !("thread" in question) || ownerOtherThan(question.thread, caller) === null });

  return { shared: people.shared, lookup, thread, threadRefusal, guard, current, wakeThread: threadWaker(registry, wake), roleOf, admittable, personAs, starter, actsOn, administers, refuseLanding, lands, answerRefusalOf };
}
export type Access = ReturnType<typeof apiAccess>;

/** Landing merges and may deploy, so it takes the same right as `nexus deploy`, whatever the repository. */
export const landing = { role: "deployer", action: "land a pull request, which deploys", lands: true } satisfies Policy;

/** Refuses a caller holding `roles` that does not hold `policy`'s role: a route's, or one its body asks for, such as a landing. */
export function demand(roles: ReadonlySet<Role>, policy: Policy, caller: TailnetNodeId | null = null) {
  const refused = refusal(roles, policy, caller);
  if (refused !== null) throw refused;
}

