/**
 * On a shared install every pylon boots with its owner's own Claude and GitHub logins, and never with a value a node or a
 * project shares. A start reads the owner's logins once, is refused when one is missing, and hands what it read to the
 * probe of the pylon's node for that one pylon before the pylon exists. The probe holds them in memory only, and a
 * value handed while its pylon boots may come too late for that boot, so each snapshot hands a pylon's values again
 * until a handoff lands while the probe reports it running or stopped, and again after the probe restarts. Values are
 * read from the store at each handoff and never kept here.
 */
import type { NodeName, Person, PylonId } from "../ids.ts";
import type { ProbeClient } from "../protocol/client.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import { ownerGrants } from "../protocol/secret-grants.ts";
import type { GitIdentity } from "../protocol/spawn.ts";
import type { LoginKind } from "../contract/logins.ts";
import { singleFlight, type SingleFlight } from "../single-flight.ts";
import type { Log } from "./log-once.ts";
import type { LoginStore, Owned } from "./logins.ts";
import { ownerBoot } from "./project.ts";
import { Refusal } from "./refusal.ts";
import type { Registry } from "./registry.ts";

type OwnerRegistry = Pick<Registry, "threads">;

const loginNames: Record<LoginKind, string> = { claude: "Claude", github: "GitHub" };
const kinds = Object.keys(ownerGrants) as LoginKind[];
const valueOf = (owned: Owned, kind: LoginKind) => kind === "claude" ? owned.claude : owned.github?.token;

/** What a start boots with: the owner's logins as read once, and the git identity of their GitHub login. */
export interface StartLogins { owned: Owned; identity: GitIdentity }

export interface OwnerLogins {
  /** Refused, naming each login, when the owner lacks one. */
  forStart(owner: Person): Promise<StartLogins>;
  /** Hands `owned` to `pylonId` on `node`'s probe. A failure is logged, and a snapshot hands them again. */
  hand(node: NodeName, pylonId: PylonId, owner: Person, owned: Owned): Promise<void>;
  observed(node: NodeName, observation: Pick<NodeObservation, "probeBootId" | "pylons">): void;
  close(): Promise<void>;
}

export function ownerLogins(options: { registry: OwnerRegistry; logins: Pick<LoginStore, "owned">; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "putPylonSecret">>; log: Log }): OwnerLogins {
  const { registry, logins, probes, log } = options;
  const latest = new Map<NodeName, Pick<NodeObservation, "probeBootId" | "pylons">>();
  /** The pylons whose values landed on each node's probe boot while it reported them running or stopped. */
  const settled = new Map<NodeName, { bootId: string; pylons: Set<PylonId> }>();
  const flights = new Map<NodeName, SingleFlight>();

  /** Whether every value reached the probe. Each kind the owner has since removed is left out and logged by name. */
  async function hand(node: NodeName, pylonId: PylonId, owner: Person, owned: Owned): Promise<boolean> {
    const probe = probes.get(node);
    if (probe === undefined) return false;
    const missing = kinds.filter((kind) => valueOf(owned, kind) === undefined);
    try {
      for (const kind of kinds) {
        const value = valueOf(owned, kind);
        if (value !== undefined) await probe.putPylonSecret(pylonId, ownerGrants[kind].name, value);
      }
    } catch (err) {
      log(`handing ${owner}'s logins to ${pylonId} on ${node} failed: ${(err as Error).message}`);
      return false;
    }
    if (missing.length > 0) log(`${pylonId} on ${node} has no ${missing.map((kind) => loginNames[kind]).join(" or ")} login of ${owner}'s, which they removed`);
    return true;
  }

  async function handNode(node: NodeName) {
    const observation = latest.get(node);
    if (observation === undefined) return;
    const { probeBootId } = observation;
    if (settled.get(node)?.bootId !== probeBootId) settled.set(node, { bootId: probeBootId, pylons: new Set() });
    const done = settled.get(node)!.pylons;
    const phases = new Map(observation.pylons.map((p) => [p.pylonId, p.phase]));
    for (const { pylon, thread } of registry.threads.pylonsWithThreadsOn(node)) {
      if (thread.status === "deleted" || done.has(pylon.pylonId) || !ownerBoot(pylon.boot)) continue;
      const phase = phases.get(pylon.pylonId);
      if (await hand(node, pylon.pylonId, thread.owner, await logins.owned(thread.owner)) && (phase === "running" || phase === "stopped")) done.add(pylon.pylonId);
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
      const missing = kinds.filter((kind) => valueOf(owned, kind) === undefined);
      if (missing.length > 0) {
        throw new Refusal("conflict", `${owner} has no ${missing.map((kind) => loginNames[kind]).join(" or ")} login, and on a shared install a pylon boots with its owner's own logins and never a shared one. Run ${missing.map((kind) => `nexus login ${kind}`).join(" and ")} first`, "no-login");
      }
      return { owned, identity: owned.github!.identity };
    },
    async hand(node, pylonId, owner, owned) {
      await hand(node, pylonId, owner, owned);
    },
    observed(node, observation) {
      latest.set(node, observation);
      void flight(node);
    },
    close: () => Promise.all([...flights.values()].map((f) => f.settled())).then(() => undefined),
  };
}
