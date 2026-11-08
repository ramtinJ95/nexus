import type { NexusEvent } from "./events.ts";
import type { Registry } from "./registry.ts";
import { busyDrainReason, type ReleaseView } from "../protocol/deploy.ts";
import { command, repository } from "../deploy/install.ts";
import { commitSchema } from "../contract/release-parse.ts";

type ReleasesRegistry = Pick<Registry, "desiredRelease" | "nodes" | "releaseReports">;

export function releaseView(registry: ReleasesRegistry, self: string | undefined, now = Date.now()): ReleaseView {
  const desired = registry.desiredRelease();
  const reports = registry.releaseReports();
  return { desired, controlNode: registry.nodes().find((n) => n.tailnetNodeId === self)?.name ?? null, nodes: registry.nodes().flatMap((n) => {
    const roles = n.tailnetNodeId === self ? ["control", "probe"] as const : ["probe"] as const;
    return roles.map((role) => {
      const report = reports.find((r) => r.node === n.name && r.role === role);
      if (report === undefined) return { node: n.name, role, commit: null, target: desired?.commit ?? null, state: "pending" as const, reason: "no deployer report", observedAt: 0 };
      if (now - report.observedAt >= 90_000) return { ...report, state: "pending" as const, reason: "deployer report is stale" };
      if (busyDrainReason(report.reason)) return { ...report, state: "pending" as const, reason: "Previous deploy waited for a busy turn; retry deployment, not a revert" };
      return report;
    });
  }) };
}
/**
 * Whether a release.changed event gives a node's deployer something to do: a new desired release, or the control role
 * healthy at it, which every probe role waits for.
 */
export function wakesDeployers(registry: Pick<ReleasesRegistry, "desiredRelease">, event: Pick<NexusEvent, "kind" | "payload">): boolean {
  if (event.kind !== "release.changed") return false;
  const { desired, role, state, commit } = event.payload;
  return desired !== undefined || (role === "control" && state === "healthy" && commit === registry.desiredRelease()?.commit);
}

export async function resolveMain(): Promise<string> {
  const result = await command("git", ["ls-remote", repository, "refs/heads/main"], "/tmp", 10_000);
  return commitSchema.parse(result.split(/\s/)[0]);
}
