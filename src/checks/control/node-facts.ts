/**
 * What the node checks read from the node they run on: the probe's config, this node's tailnet ID and MagicDNS name,
 * the control plane its deployer trusts, what tailscale serve serves, and the probe's preview route table. They read
 * the node only through here, which reads each fact as the probe and the deployer do.
 */
import { readControlPlane } from "../../deploy/control-plane.ts";
import { tailnetNodeIdSchema } from "../../protocol/fields.ts";
import { readProbeConfig, type ProbeConfig } from "../../probe/config.ts";
import { parseServeStatus, readRoutes } from "../../probe/serve.ts";
import { selfDnsName, tailscaleCli, tailscaleStatus } from "../../tailscale.ts";

const tailscale = tailscaleCli();

/** The probe's config at `probeJson`, and this node as tailscale and /etc/nexus/control-plane.json name it. */
export async function readNodeFacts(probeJson: string) {
  const probeConfig = await readProbeConfig(probeJson);
  const status = await tailscaleStatus(tailscale);
  const self = tailnetNodeIdSchema.parse(status.self?.id ?? "");
  return { probeConfig, self, dnsName: selfDnsName(status), trustedControlPlane: (await readControlPlane()).tailnetNodeId };
}

/** The node's previews: tailscale serve's config, as printed, as JSON, and by port as the probe owns it, and the probe's route table. */
export function nodePreviews(previews: NonNullable<ProbeConfig["previews"]>) {
  const serveJson = () => tailscale(["serve", "status", "--json"]);
  return {
    serveJson,
    serveStatus: async () => JSON.parse(await serveJson()) as { TCP?: Record<string, unknown> },
    listeners: async () => parseServeStatus(await serveJson(), `http://127.0.0.1:${previews.gatewayPort}`),
    routes: () => readRoutes(previews.routesFile),
  };
}
