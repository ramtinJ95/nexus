import { createHash } from "node:crypto";
import { z } from "zod";
import type { TailnetNodeId } from "../protocol.ts";
import type { Registry } from "./registry.ts";
import { fullCommit, type ReleaseView } from "../deploy/model.ts";
import { command, repository } from "../deploy/install.ts";

export interface DeploymentOptions {
  self: TailnetNodeId;
  deployers: ReadonlySet<TailnetNodeId>;
  keys: Readonly<Record<string, string>>;
  resolveMain?: () => Promise<string>;
}
export const commitSchema = z.string().regex(fullCommit);
export const reportSchema = z.strictObject({
  role: z.enum(["control", "probe"]), commit: commitSchema.nullable(), target: commitSchema.nullable(),
  state: z.enum(["pending", "waiting-for-control", "waiting-for-idle", "installing", "healthy", "rolled-back", "failed"]),
  reason: z.string().max(20_000).nullable(),
});

/** Whether the caller is a person's device: neither the control node nor a node, whose pylons call as their node. */
export function isPerson(registry: Registry, options: DeploymentOptions | undefined, caller: TailnetNodeId): boolean {
  return caller !== options?.self && !registry.nodes().some((n) => n.tailnetNodeId === caller);
}
export function canDeploy(registry: Registry, options: DeploymentOptions | undefined, caller: TailnetNodeId): boolean {
  return options !== undefined && options.deployers.has(caller) && isPerson(registry, options, caller);
}
export function isReporter(registry: Registry, options: DeploymentOptions | undefined, caller: TailnetNodeId, authorization: string | undefined): boolean {
  if (options === undefined || !registry.nodes().some((n) => n.tailnetNodeId === caller)) return false;
  if (!authorization?.startsWith("Bearer ") || authorization.length > 256) return false;
  return createHash("sha256").update(authorization.slice(7)).digest("hex") === options.keys[caller];
}
export function releaseView(registry: Registry, self: string | undefined, now = Date.now()): ReleaseView {
  const desired = registry.desiredRelease();
  const reports = registry.releaseReports();
  return { desired, nodes: registry.nodes().flatMap((n) => {
    const roles = n.tailnetNodeId === self ? ["control", "probe"] as const : ["probe"] as const;
    return roles.map((role) => {
      const report = reports.find((r) => r.node === n.name && r.role === role);
      if (report === undefined) return { node: n.name, role, commit: null, target: desired?.commit ?? null, state: "pending" as const, reason: "no deployer report", observedAt: 0 };
      if (now - report.observedAt >= 90_000) return { ...report, state: "pending" as const, reason: "deployer report is stale" };
      return report;
    });
  }) };
}
export async function resolveMain(): Promise<string> {
  const result = await command("git", ["ls-remote", repository, "refs/heads/main"], "/tmp", 10_000);
  return commitSchema.parse(result.split(/\s/)[0]);
}
