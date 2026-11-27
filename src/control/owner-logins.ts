/**
 * On a shared install every pylon boots with its owner's own Claude and GitHub logins, and never with a value a node or a
 * project shares. A start reads the owner's logins and is refused when one is missing. The values go to the probe of
 * the pylon's node for that one pylon, which holds them in memory only, so a snapshot from a probe boot that was not
 * handed a pylon's values hands them again. A value is read from the store at each handoff and never kept here.
 */
import type { NodeName, Person, PylonId } from "../ids.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { ownerGrants } from "../protocol/secret-grants.ts";
import type { GitIdentity } from "../protocol/spawn.ts";
import type { LoginKind } from "../contract/logins.ts";
import { singleFlight, type SingleFlight } from "../single-flight.ts";
import type { Log } from "./log-once.ts";
import type { LoginStore, Owned } from "./logins.ts";
import { Refusal } from "./refusal.ts";
import type { Registry } from "./registry.ts";

type OwnerRegistry = Pick<Registry, "threads">;

const loginNames: Record<LoginKind, string> = { claude: "Claude", github: "GitHub" };

const valueOf = (owned: Owned, kind: LoginKind) => kind === "claude" ? owned.claude : owned.github?.token;

export interface OwnerLogins {
  /** The git identity a start of `owner`'s boots with. Refused, naming each login, when the owner lacks one. */
  forStart(owner: Person): Promise<GitIdentity>;
  /** Hands `owner`'s values to `pylonId` on `node`'s probe. A failure is logged and the next snapshot tries again. */
  hand(node: NodeName, pylonId: PylonId, owner: Person): Promise<void>;
  observed(node: NodeName, probeBootId: string): void;
  close(): Promise<void>;
}

export function ownerLogins(options: { registry: OwnerRegistry; logins: Pick<LoginStore, "owned">; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "putPylonSecret">>; log: Log }): OwnerLogins {
  const { registry, logins, probes, log } = options;
  const boots = new Map<NodeName, string>();
  /** The pylons each node's probe was handed values for, and the probe boot that holds them. */
  const handed = new Map<NodeName, { bootId: string | undefined; pylons: Set<PylonId> }>();
  const flights = new Map<NodeName, SingleFlight>();
  /** Nodes with a handoff that failed, which the next snapshot tries again though its probe boot is the same. */
  const failed = new Set<NodeName>();

  async function hand(node: NodeName, pylonId: PylonId, owner: Person) {
    const owned = await logins.owned(owner);
    const bootId = boots.get(node);
    const probe = probes.get(node);
    if (probe === undefined) return;
    const missing: string[] = [];
    try {
      for (const [kind, grant] of Object.entries(ownerGrants) as [LoginKind, (typeof ownerGrants)[LoginKind]][]) {
        const value = valueOf(owned, kind);
        if (value === undefined) missing.push(loginNames[kind]);
        else await probe.putPylonSecret(pylonId, grant.name, value);
      }
    } catch (err) {
      log(`handing ${owner}'s logins to ${pylonId} on ${node} failed: ${(err as Error).message}`);
      failed.add(node);
      return;
    }
    if (missing.length > 0) log(`${pylonId} on ${node} boots without ${missing.join(" and ")}, which its owner ${owner} has since removed`);
    const sent = handed.get(node);
    if (sent !== undefined && sent.bootId === bootId) sent.pylons.add(pylonId);
    else handed.set(node, { bootId, pylons: new Set([pylonId]) });
  }

  async function handNode(node: NodeName) {
    failed.delete(node);
    const bootId = boots.get(node);
    if (handed.get(node)?.bootId !== bootId) handed.set(node, { bootId, pylons: new Set() });
    const done = handed.get(node)!.pylons;
    for (const { pylon, thread } of registry.threads.pylonsWithThreadsOn(node)) {
      if (thread.status === "deleted" || done.has(pylon.pylonId) || !pylon.boot.network.secrets.some((grant) => grant.owner === true)) continue;
      await hand(node, pylon.pylonId, thread.owner);
    }
  }

  const flight = (node: NodeName) => {
    let f = flights.get(node);
    if (f === undefined) flights.set(node, f = singleFlight(() => handNode(node)));
    return f.rerun();
  };

  return {
    async forStart(owner) {
      const owned = await logins.owned(owner);
      const missing = (Object.keys(ownerGrants) as LoginKind[]).filter((kind) => valueOf(owned, kind) === undefined);
      if (missing.length > 0) {
        throw new Refusal("conflict", `${owner} has no ${missing.map((kind) => loginNames[kind]).join(" or ")} login, and on a shared install a pylon boots with its owner's own logins and never a shared one. Run ${missing.map((kind) => `nexus login ${kind}`).join(" and ")} first`, "no-login");
      }
      return owned.github!.identity;
    },
    hand,
    observed(node, probeBootId) {
      boots.set(node, probeBootId);
      if (handed.get(node)?.bootId !== probeBootId || failed.has(node)) void flight(node);
    },
    close: () => Promise.all([...flights.values()].map((f) => f.settled())).then(() => undefined),
  };
}
