/**
 * Tells each probe its peers: the tailnet node IDs of every other node this control plane follows, whose probes may fetch
 * images and templates from it. A probe keeps probe.json's peers until then, and forgets the list when it restarts, so
 * every snapshot from a node puts its list again, and a join puts every node's. A probe from before this answers 404
 * and keeps probe.json's.
 */
import type { NodeName, ProbeClient } from "../protocol.ts";
import { singleFlight, type SingleFlight } from "../single-flight.ts";
import type { Registry } from "./registry.ts";

export function peerHandoff(options: { registry: Registry; probes: ReadonlyMap<NodeName, Pick<ProbeClient, "putPeers">>; log?: (message: string) => void }) {
  const { registry, probes, log = (message: string) => console.error(message) } = options;
  const unaware = new Set<NodeName>();
  const flights = new Map<NodeName, SingleFlight>();

  async function put(node: NodeName) {
    const ids = registry.nodeIds();
    const peers = [...probes.keys()].filter((n) => n !== node).map((n) => ids.get(n)!);
    try {
      await probes.get(node)!.putPeers(peers);
      unaware.delete(node);
    } catch (err) {
      const message = (err as Error).message;
      if (!/HTTP 404/.test(message)) return log(`telling ${node} its peers failed: ${message}`);
      if (!unaware.has(node)) log(`${node}: its probe cannot learn its peers yet, so it keeps the peers in its probe.json until it is upgraded`);
      unaware.add(node);
    }
  }
  // One put at a time per node, so a slow put of an older list never lands after a newer one.
  const flight = (node: NodeName) => {
    let f = flights.get(node);
    if (f === undefined) flights.set(node, f = singleFlight(() => put(node)));
    return f.rerun();
  };
  return {
    observed(node: NodeName) { void flight(node); },
    all: () => Promise.all([...probes.keys()].map(flight)).then(() => undefined),
    close: () => Promise.all([...flights.values()].map((f) => f.settled())).then(() => undefined),
  };
}
