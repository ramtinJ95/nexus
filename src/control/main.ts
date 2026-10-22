/**
 * The control plane process: `node src/control/main.ts <config.json>`. It opens the registry, follows
 * every configured node's probe, and serves the API until SIGINT or SIGTERM.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { connectProbe, type NodeName, type TailnetNodeId } from "../protocol.ts";
import { ingest } from "../reconcile.ts";
import { localApiWhois } from "../tailscale.ts";
import { startApi } from "./api.ts";
import { startLoop } from "./loop.ts";
import { openRegistry } from "./registry.ts";

const nodeId = z.string().regex(/^n[A-Za-z0-9]+$/, "a Tailscale stable node ID, such as nAbC123CNTRL");

const configSchema = z.strictObject({
  db: z.string().min(1),
  listen: z.strictObject({
    host: z.string().min(1),
    port: z.int().min(0).max(65_535),
    /** Every name callers use for the API, such as the MagicDNS name, the full ts.net name and the tailnet IP. */
    hostnames: z.array(z.string().min(1)).min(1),
  }),
  /** The control plane's own tailnet node. The CLI on the same machine calls the API as this node. */
  self: z.strictObject({ tailnetNodeId: nodeId }),
  nodes: z.array(z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    tailnetHost: z.string().min(1),
    tailnetNodeId: nodeId,
  })).min(1),
  /** Other tailnet nodes, such as your laptop and phone, whose callers may use the API. */
  callers: z.array(nodeId),
  tailscaledSocket: z.string().min(1).optional(),
});
export type ControlPlaneConfig = z.infer<typeof configSchema>;

export function parseConfig(text: string): ControlPlaneConfig {
  const result = configSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error(`invalid control plane config:\n${z.prettifyError(result.error)}`);
  const names = result.data.nodes.map((n) => n.name);
  if (new Set(names).size !== names.length) throw new Error(`invalid control plane config: node names repeat: ${names.join(", ")}`);
  return result.data;
}

async function main(configPath: string) {
  const config = parseConfig(await readFile(configPath, "utf8"));
  const whois = localApiWhois(config.tailscaledSocket);
  const registry = openRegistry(config.db);
  for (const node of config.nodes) {
    registry.upsertNode({ name: node.name as NodeName, tailnetHost: node.tailnetHost, tailnetNodeId: node.tailnetNodeId as TailnetNodeId });
  }
  const probes = config.nodes.map((n) => connectProbe(n.name as NodeName, n.tailnetHost, n.tailnetNodeId as TailnetNodeId, { whois }));
  const loop = startLoop({ registry, probes, ingest });
  const api = await startApi({
    registry, whois, host: config.listen.host, port: config.listen.port,
    allowed: new Set([config.self.tailnetNodeId, ...config.callers] as TailnetNodeId[]),
    hostnames: new Set(config.listen.hostnames),
    wake: (node) => { void loop.wake(node); },
  });
  console.error(`nexus control plane: API on ${config.listen.host}:${api.port}, following ${config.nodes.map((n) => n.name).join(", ")}`);

  const stop = async () => {
    await api.close();
    await loop.close();
    registry.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { stop().then(() => process.exit(0), (err: unknown) => { console.error(err); process.exit(1); }); });
  }
}

if (import.meta.main) {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    console.error("usage: node src/control/main.ts <config.json>");
    process.exit(2);
  }
  await main(configPath);
}
