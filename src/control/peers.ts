/**
 * Tells each probe its peers: the tailnet node IDs of every other node this control plane follows, whose probes may fetch
 * images and templates from it. A probe keeps probe.json's peers until then, and forgets the list when it restarts, so
 * a snapshot from a node puts its list again unless the last put that succeeded sent the same list to the same probe
 * boot. A join puts every node's.
 */
import type { NodeName } from "../ids.ts";
import type { ProbeClient } from "../protocol/client.ts";
import { singleFlight, type SingleFlight } from "../single-flight.ts";
import type { Log } from "./log-once.ts";
import type { Registry } from "./registry.ts";

type PeersRegistry = Pick<Registry, "nodeIds">;

export function peerHandoff(options: { registry: PeersRegistry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "putPeers">>; log: Log }) {
  const { registry, probes, log } = options;
  const boots = new Map<NodeName, string>();
  /** The list and probe boot of each node's last put that succeeded. */
  const sent = new Map<NodeName, { peers: string; bootId: string | undefined }>();
  const flights = new Map<NodeName, SingleFlight>();

  async function put(node: NodeName) {
    const ids = registry.nodeIds();
    const peers = [...probes.keys()].filter((n) => n !== node).map((n) => ids.get(n)!);
    const bootId = boots.get(node);
    const last = sent.get(node);
    if (bootId !== undefined && last?.bootId === bootId && last.peers === peers.join()) return;
    sent.delete(node);
    try {
      await probes.get(node)!.putPeers(peers);
      sent.set(node, { peers: peers.join(), bootId });
    } catch (err) {
      log(`telling ${node} its peers failed: ${(err as Error).message}`);
    }
  }
  // One put at a time per node, so a slow put of an older list never lands after a newer one.
  const flight = (node: NodeName) => {
    let f = flights.get(node);
    if (f === undefined) flights.set(node, f = singleFlight(() => put(node)));
    return f.rerun();
  };
  return {
    observed(node: NodeName, probeBootId: string) {
      boots.set(node, probeBootId);
      void flight(node);
    },
    all: () => Promise.all([...probes.keys()].map(flight)).then(() => undefined),
    close: () => Promise.all([...flights.values()].map((f) => f.settled())).then(() => undefined),
  };
}
