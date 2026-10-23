/**
 * The LiveSpec a pylon should run with, rendered from its records: its preview ports and the overlay that tells
 * the agent about its pylon. The API renders it when a thread starts and the loop renders it again on every pass,
 * so a new preview port reaches the pylon, PUBLIC_URL and PYLON.md included, through the next spawn.
 */
import { renderOverlay, type LiveSpec, type Project } from "../project.ts";
import type { NodeRecord, Preview, StoredPylon } from "./registry.ts";

/** What the data model calls a preview's URL. */
export const previewUrl = (node: Pick<NodeRecord, "tailnetHost">, httpsPort: number) => `https://${node.tailnetHost}:${httpsPort}/`;

export function pylonLive(pylon: Pick<StoredPylon, "pylonId" | "thread" | "node" | "boot">, project: Project, node: Pick<NodeRecord, "tailnetHost">, previews: readonly Preview[]): LiveSpec {
  return {
    previews: previews.map(({ service, httpsPort }) => ({ service, httpsPort })),
    overlay: renderOverlay({
      pylonId: pylon.pylonId,
      threadId: pylon.thread,
      project: project.id,
      node: pylon.node,
      allowedHosts: pylon.boot.network.allowedHosts,
      previews: previews.map((p) => ({ service: p.service, url: previewUrl(node, p.httpsPort) })),
      logins: project.logins,
      dotfiles: pylon.boot.dotfiles,
    }),
  };
}
