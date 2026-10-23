/**
 * The Docker test double's host bridge, standing in for the pylon VM's (src/pylon-vm/host-bridge.ts) so a test
 * can run the in-pylon `nexus` CLI end to end. Docker Desktop proxies every container's connection to the host,
 * so a caller cannot be told apart by its address. Each container instead gets an unguessable token in the path
 * of its NEXUS_API, kept in a label so a probe restart loses nothing, and the probe names the pylon from the
 * running container that carries the token.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { listenHostBridge, type HostBridge } from "./probe/pylon-api.ts";
import type { PylonId } from "./protocol.ts";

const execFileAsync = promisify(execFile);
const tokenLabel = "nexus.bridge-token";

/** `docker run` arguments for a new container: its token, its NEXUS_API, and the host name NEXUS_API uses. */
export function dockerBridgeRunArgs(port: number): string[] {
  const token = randomBytes(16).toString("hex");
  return [
    "--label", `${tokenLabel}=${token}`,
    "--env", `NEXUS_API=http://host.docker.internal:${port}/${token}`,
    "--add-host", "host.docker.internal:host-gateway",
  ];
}

/**
 * Listens on `port` for the containers created with dockerBridgeRunArgs(port). Docker Desktop reaches the Mac's
 * loopback as host.docker.internal. On Linux that name is the bridge gateway, which loopback does not answer, so
 * the listener takes every address there and the token is all that guards it. `labels` scopes the lookup as
 * DockerBackendOptions.labels does.
 */
export function dockerHostBridge(port: number, labels: Readonly<Record<string, string>> = {}): HostBridge {
  const scope = Object.entries(labels).flatMap(([k, v]) => ["--filter", `label=${k}=${v}`]);
  return listenHostBridge({ host: process.platform === "darwin" ? "127.0.0.1" : "0.0.0.0", port }, async (req) => {
    const token = /^\/([0-9a-f]{32})\/v1\/request$/.exec(req.url ?? "")?.[1];
    if (token === undefined) return null;
    const { stdout } = await execFileAsync("docker", ["ps", "--filter", `label=${tokenLabel}=${token}`, ...scope, "--format", '{{.Label "nexus.pylon"}}']);
    const pylons = stdout.split("\n").filter((line) => line !== "");
    return pylons.length === 1 ? pylons[0] as PylonId : null;
  });
}
