/** Probe contract, the ports Nexus keeps for itself in every pylon, which no service, command or link may take. */
/**
 * The ports the pylon's loopback relay (src/pylon-vm/relay.ts) listens on, one per routed port. They are below 1024,
 * so the agent's apps, which run as `user`, can never hold one.
 */
export const relayPorts = { first: 700, last: 799 } as const;
/**
 * Nexus's own listeners in every pylon: the sshd that Gondolin's enableSsh starts for streams and terminals, and the
 * relay's ports. They are never reported as listening, and never linked.
 */
export const reservedPorts: ReadonlySet<number> = new Set([22, ...Array.from({ length: relayPorts.last - relayPorts.first + 1 }, (_, i) => relayPorts.first + i)]);
/** Why a declaration may not fix a port in reservedPorts. */
export const reservedPortMessage = `is Nexus's own: sshd's 22, or the preview relay's ${relayPorts.first} to ${relayPorts.last}`;
