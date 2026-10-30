/**
 * The program pi-env's Connection starts in place of its daemon, one per pylon with a live connection:
 *
 *   node src/harness/bridge.ts <BridgeTarget JSON> <pylonId> serve --token <hex>
 *
 * Connection appends `serve --token <hex>`. The bridge opens a raw pipe on the pylon's probe that runs the
 * daemon in the guest with those arguments, then pumps its own stdin and stdout through it. It exits with
 * the daemon's exit code, or 1 when the pipe never opened or was lost. When the harness process dies, the
 * bridge's stdin ends, so the daemon's stdin ends and it kills every command it started.
 *
 * It imports only the probe client, because one runs per busy pylon and each costs a Node process.
 */
import { once } from "node:events";
import type { NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { ByteStream } from "../protocol/streams.ts";
import { connectProbe } from "../protocol/client.ts";
import { localApiWhois } from "../tailscale.ts";

/** How to reach and verify the pylon's probe. `tailscaled` is the control plane's LocalAPI socket. */
export interface BridgeTarget {
  node: NodeName;
  host: string;
  port: number;
  nodeId: TailnetNodeId;
  tailscaled: string;
}

/** Through a login shell, so tool commands see the image's /etc/profile.d PATH and CA settings. */
const daemon = ["bash", "-lc", 'exec /usr/local/libexec/nexus/pi-env "$@"', "pi-env"];

const [targetJson, pylonId, ...serveArgs] = process.argv.slice(2);
if (targetJson === undefined || pylonId === undefined || serveArgs[0] !== "serve") {
  process.stderr.write("usage: bridge.ts <BridgeTarget JSON> <pylonId> serve --token <hex>\n");
  process.exit(2);
}
const target = JSON.parse(targetJson) as BridgeTarget;
const client = connectProbe(target.node, target.host, target.nodeId, { port: target.port, whois: localApiWhois(target.tailscaled) });

let stream: ByteStream;
try {
  stream = await client.stream(pylonId as PylonId, [...daemon, ...serveArgs]);
} catch (err) {
  process.stderr.write(`bridge: ${pylonId} on ${target.node}: ${(err as Error).message}\n`);
  process.exit(1);
}

(async () => {
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) await stream.write(chunk);
  await stream.close();
})().catch(() => {
  // The pipe broke under a write. `done` reports it as lost.
});
for await (const chunk of stream) {
  if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
}
const end = await stream.done;
if (end.kind === "lost") process.stderr.write(`bridge: the pipe to ${pylonId} on ${target.node} was lost\n`);
process.exitCode = end.kind === "exited" ? end.code : 1;
// Stop reading stdin, so the process exits once stdout has drained.
process.stdin.destroy();
