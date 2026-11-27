/**
 * On a shared install every pylon boots with its owner's own Claude and GitHub logins, and never with a value a node or a
 * project shares. A start reads the owner's logins once, is refused when one is missing, and hands what it read to the
 * probe of the pylon's node for that one pylon before the pylon exists. The probe holds them in memory only, and a
 * value handed while its pylon boots may come too late for that boot, so snapshots hand a pylon's values again until
 * one shows them in use, and again after the probe restarts. Values are read from the store at each handoff and never
 * kept here.
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
  /** Each node's latest snapshot, numbered in the order they arrive, so a handoff is judged only by one that came after it. */
  const latest = new Map<NodeName, { seq: number; observation: Pick<NodeObservation, "probeBootId" | "pylons"> }>();
  let seq = 0;
  /**
   * Per node and probe boot: the pylons whose values are known to be in use, and those handed and waiting on a later
   * snapshot, with the boot the pylon was running on when the handoff began, if it ran.
   */
  const state = new Map<NodeName, { bootId: string; settled: Set<PylonId>; handed: Map<PylonId, { afterSeq: number; runningBoot: string | null }> }>();
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

  /**
   * A handoff is in use once a snapshot that came after it shows the pylon stopped, whose next boot reads the values,
   * or running on the boot it ran on before the handoff began, which the probe swapped them into. Anything else, such
   * as a boot that may have read the stand-in, is handed again.
   */
  async function handNode(node: NodeName) {
    const at = latest.get(node);
    if (at === undefined) return;
    const { seq: now, observation } = at;
    if (state.get(node)?.bootId !== observation.probeBootId) state.set(node, { bootId: observation.probeBootId, settled: new Set(), handed: new Map() });
    const { settled, handed } = state.get(node)!;
    const seen = new Map(observation.pylons.map((p) => [p.pylonId, p]));
    for (const { pylon, thread } of registry.threads.pylonsWithThreadsOn(node)) {
      const { pylonId } = pylon;
      if (thread.status === "deleted" || settled.has(pylonId) || !ownerBoot(pylon.boot)) continue;
      const observed = seen.get(pylonId);
      const runningBoot = observed?.phase === "running" ? observed.bootedAt : null;
      const pending = handed.get(pylonId);
      if (pending !== undefined && pending.afterSeq >= now) continue;
      if (pending !== undefined && (observed?.phase === "stopped" || (runningBoot !== null && runningBoot === pending.runningBoot))) {
        settled.add(pylonId);
        continue;
      }
      let owned: Owned;
      try {
        owned = await logins.owned(thread.owner);
      } catch (err) {
        log(`${thread.owner}'s logins for ${pylonId} could not be read: ${(err as Error).message}`);
        continue;
      }
      if (await hand(node, pylonId, thread.owner, owned)) handed.set(pylonId, { afterSeq: seq, runningBoot });
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
      latest.set(node, { seq: ++seq, observation });
      flight(node).catch((err: unknown) => log(`handing owners' logins on ${node} failed: ${(err as Error).message}`));
    },
    close: () => Promise.all([...flights.values()].map((f) => f.settled())).then(() => undefined),
  };
}
