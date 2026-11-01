/**
 * Probe contract, the probe's port, and who may call each of its routes. The control plane decides, and the probe
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
export const routeAuth = {
  "/v1/jobs": "control-plane",
  "/v1/observe": "control-plane",
  "/v1/pylons": "control-plane",
  "/v1/manifests": "control-plane",
  "/v1/secrets": "control-plane",
  "/v1/peers": "control-plane",
  "/v1/node-health": "control-plane",
  "/v1/cleanup": "control-plane",
  "/v1/artifacts": "peer-probe", // checkpoints hold the pylon's logins, so only the other probe may read them
} as const satisfies Record<string, CallerRole>;

/** `controlPlane` is read from /etc/nexus/control-plane.json on each node, and `peers` from /etc/nexus/probe.json until the control plane puts the list of every other node. */
export interface ProbeAuthConfig {
  controlPlane: TailnetNodeId; // rj-firebat
  peers: readonly TailnetNodeId[]; // every other node
}
export const peersSchema = z.array(tailnetNodeIdSchema).max(1_000);
