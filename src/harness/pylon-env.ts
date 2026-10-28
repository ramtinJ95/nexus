/**
 * The harness's `env` factory: every tool call of a thread runs in its pylon, through pi-env's
 * RemoteExecutionEnv and one daemon connection per pylon. The connection starts lazily and starts again after
 * a lost link. Its command waits until the pylon runs, then spawns the bridge, which carries the daemon's
 * frames over the probe's raw pipe. A conversation with no cwd, as a judgment's, has no pylon and no environment.
 */
import { join } from "node:path";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { jobDeadlineMs, type PylonId } from "../protocol.ts";
import type { BridgeTarget } from "./bridge.ts";
import { readThread } from "./thread-doc.ts";

export type ProbeAddress = Omit<BridgeTarget, "tailscaled">;

export interface PylonLocator {
  /** Resolves once the probe reports the pylon running. Rejects at the deadline. */
  awaitRunning(pylonId: PylonId, deadline: number): Promise<ProbeAddress>;
}

export interface PylonEnvs {
  readonly env: NonNullable<HarnessOptions["env"]>;
  /** Stops the pylon's daemon, which kills every command it started. For a deleted thread. */
  forget(pylonId: PylonId): void;
  close(): void;
}

const bridge = join(import.meta.dirname, "bridge.ts");

export function pylonEnvs(locator: PylonLocator, options: { tailscaled: string; log(message: string): void }): PylonEnvs {
  const connections = new Map<PylonId, Connection>();

  function connection(pylonId: PylonId): Connection {
    let c = connections.get(pylonId);
    if (c !== undefined) return c;
    c = new Connection({
      // A wake can take as long as a spawn job. pi-env's own 60 s start timeout only begins once this resolves.
      command: async () => {
        const probe = await locator.awaitRunning(pylonId, Date.now() + jobDeadlineMs.spawn);
        const target: BridgeTarget = { ...probe, tailscaled: options.tailscaled };
        return [process.execPath, bridge, JSON.stringify(target), pylonId];
      },
      onLog: (text) => options.log(`${pylonId} pi-env: ${text.trimEnd()}`),
    });
    connections.set(pylonId, c);
    return c;
  }

  return {
    // No environment read here: the harness also calls this to render sections, which must not wait for a wake.
    async env({ conversationId, cwd, read }, context) {
      if (cwd === undefined) return undefined;
      const { pylonId } = await readThread(read, conversationId, context);
      return new RemoteExecutionEnv({ connection: connection(pylonId), id: `pi-env:${pylonId}`, cwd });
    },
    forget(pylonId) {
      connections.get(pylonId)?.close();
      connections.delete(pylonId);
    },
    close() {
      for (const c of connections.values()) c.close();
      connections.clear();
    },
  };
}
