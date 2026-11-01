/**
 * The background read of every online node's health, once a minute, so a node's history has no gaps while the node and
 * the control plane run, whether or not anyone watches its page. The probe clients record each read, as they record the
 * page's. Each node's read runs on its own: a pass starts them all and waits for none, so a slow probe delays no other
 * node, and a node whose last read has not settled is skipped, never queued.
 */
import type { NodeName } from "../ids.ts";
import type { ProbeClient } from "../protocol/client.ts";
import type { Registry } from "./registry.ts";

export function healthSampling(options: {
  registry: Pick<Registry, "nodes">;
  /** The recording clients main.ts makes, one per node. */
  probes: ReadonlyMap<NodeName, Pick<ProbeClient, "health">>;
  log?: (message: string) => void;
}) {
  const { registry, probes, log = (message: string) => console.error(message) } = options;
  const reading = new Map<NodeName, Promise<void>>();
  /** The last failure each node's read hit, so a node that stays unreachable is logged once. */
  const failures = new Map<NodeName, string>();

  function read(node: NodeName, probe: Pick<ProbeClient, "health">) {
    const read = probe.health().then(
      () => { failures.delete(node); },
      (err: unknown) => {
        const message = (err as Error).message;
        if (failures.get(node) !== message) log(`${node}: reading its health for its history failed, and the next pass tries again: ${message}`);
        failures.set(node, message);
      },
    ).finally(() => { reading.delete(node); });
    reading.set(node, read);
  }

  return {
    /** Starts a read of each online node that has none in flight. Returns without waiting for them. */
    poll() {
      for (const { name, state } of registry.nodes()) {
        const probe = probes.get(name);
        if (state === "online" && probe !== undefined && !reading.has(name)) read(name, probe);
      }
    },
    /** Waits for the reads in flight, so none records into a closed registry. */
    async close() { await Promise.allSettled(reading.values()); },
  };
}
