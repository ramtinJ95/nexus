/**
 * The LiveSpec a pylon should run with, rendered from its records: its preview ports and the overlay that tells
 * the agent about its pylon. The API renders it when a thread starts and the loop renders it again on every pass,
 * so a new preview port reaches the pylon, PUBLIC_URL and PYLON.md included, through the next spawn.
 */
import { renderOverlay, type LiveSpec, type Project } from "../project.ts";
import type { Preview, StoredPylon } from "./registry.ts";

export function pylonLive(pylon: Pick<StoredPylon, "pylonId" | "thread" | "node" | "boot">, project: Project, previews: readonly Preview[]): LiveSpec {
  return {
    previews: previews.map(({ service, httpsPort }) => ({ service, httpsPort })),
    overlay: renderOverlay({
      pylonId: pylon.pylonId,
      threadId: pylon.thread,
      project: project.id,
      node: pylon.node,
      allowedHosts: pylon.boot.network.allowedHosts,
      previews: previews.map(({ service, url }) => ({ service, url })),
      logins: project.logins,
      dotfiles: pylon.boot.dotfiles,
      repo: pylon.boot.repo,
      secrets: pylon.boot.network.secrets,
    }),
  };
}
