/**
 * Probe contract, the probe's port, and its route table. The control plane decides, and the probe
 * executes and observes.
 *
 * The probe never dials the control plane. The control plane opens every connection, except probe-to-probe artifact
 * copies.
 */
import { z } from "zod";
import type { TailnetNodeId } from "../ids.ts";
import { tailnetNodeIdSchema } from "./fields.ts";

export const probePort = 7480;

/**
 * Who may call each route. The home tailnet keeps its policy as it is, with no tags and no ACL change,
 * so every one of your devices can open a connection. The probe refuses any caller whose whois node ID
 * is not the one its config names for the route.
 */
export type CallerRole = "control-plane" | "peer-probe";

/**
 * A route of the probe's HTTP surface. `path` names each parameter in braces. `retry` is "until-expired" for a call
 * the client repeats on a transport error until its envelope's notAfter. `upgrade` is the protocol a route upgrades to.
 */
export interface ProbeRoute {
  method: "GET" | "PUT" | "POST";
  path: string;
  role: CallerRole;
  retry?: "until-expired";
  upgrade?: string;
}

export const probeRoutes = {
  submit: { method: "PUT", path: "/v1/jobs/{jobId}", role: "control-plane", retry: "until-expired" },
  job: { method: "GET", path: "/v1/jobs/{jobId}", role: "control-plane" },
  observe: { method: "GET", path: "/v1/observe", role: "control-plane" },
  command: { method: "POST", path: "/v1/pylons/{pylonId}/commands", role: "control-plane" },
  readGit: { method: "POST", path: "/v1/pylons/{pylonId}/git", role: "control-plane" },
  stream: { method: "GET", path: "/v1/pylons/{pylonId}/stream", role: "control-plane", upgrade: "nexus-stream" },
  manifest: { method: "GET", path: "/v1/manifests/{artifact}", role: "control-plane" },
  putSecret: { method: "PUT", path: "/v1/secrets/{name}", role: "control-plane" },
  putPeers: { method: "PUT", path: "/v1/peers", role: "control-plane" },
  health: { method: "GET", path: "/v1/node-health", role: "control-plane" },
  artifactUsage: { method: "GET", path: "/v1/cleanup", role: "control-plane" },
  dropArtifacts: { method: "POST", path: "/v1/cleanup", role: "control-plane" },
  wakeDeployer: { method: "POST", path: "/v1/deployer/wake", role: "control-plane" },
  // Checkpoints hold the pylon's logins, so only the other probe may read them.
  fetchArtifact: { method: "GET", path: "/v1/artifacts/{artifact}", role: "peer-probe" },
} as const satisfies Record<string, ProbeRoute>;

/**
 * The probe authorizes by a path's first segment under /v1, before it looks for a handler, so a wrong caller gets 403
 * even for a method or path no route serves.
 */
export function routeRole(path: string): CallerRole | undefined {
  return roleByPrefix.get(authPrefix(path));
}
const authPrefix = (path: string) => path.split("/").slice(0, 3).join("/");
const roleByPrefix = new Map<string, CallerRole>(Object.values(probeRoutes).map((route) => [authPrefix(route.path), route.role]));

/** `controlPlane` is read from /etc/nexus/control-plane.json on each node, and `peers` from /etc/nexus/probe.json until the control plane puts the list of every other node. */
export interface ProbeAuthConfig {
  controlPlane: TailnetNodeId; // rj-firebat
  peers: readonly TailnetNodeId[]; // every other node
}
export const peersSchema = z.array(tailnetNodeIdSchema).max(1_000);

/** POST /v1/pylons/{id}/git's answer: when the snapshot that read the pylon's git again was observed, by the probe's clock. */
export interface GitReadReply { observedAt: string }
export const gitReadReplySchema = z.looseObject({ observedAt: z.iso.datetime() }) satisfies z.ZodType<GitReadReply>;
