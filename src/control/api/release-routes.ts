/**
 * The release a deployer asks for, and the deployer's reports and drain.
 */
import { z } from "zod";
import { HttpError } from "../http-error.ts";
import { canDeploy, commitSchema, releaseView, releasesSchema, reportSchema, resolveMain, type DeploymentOptions } from "../releases.ts";
import type { CleanupPass } from "../cleanup.ts";
import { ok, parse, type RouteEntry, type ApiKit } from "./kit.ts";

export function releaseRoutes(kit: ApiKit, options: { deployment?: DeploymentOptions | undefined; cleanup?: CleanupPass | undefined }): readonly RouteEntry[] {
  const { registry, agents, draining, gate } = kit;

  async function turnsRunning(): Promise<boolean> {
    if (gate.busy()) return true;
    for (const t of registry.harnessThreads()) {
      if (t.status === "deleted") continue;
      const { docs } = await agents.harness.view(t);
      const live = docs["pi.live"];
      const inbox = docs["pi.inbox"];
      if (live?.run !== undefined || (Array.isArray(inbox?.items) && inbox.items.length > 0)) return true;
    }
    return gate.busy();
  }

  return [
    ["GET", /^\/v1\/release$/, () => ok(releaseView(registry, options.deployment?.self))],
    ["PUT", /^\/v1\/release$/, { open: "deployers only, which the route checks with its own refusal" }, async (_, r) => {
      if (!canDeploy(registry, options.deployment, r.caller)) throw new HttpError(403, "caller may not deploy; infrastructure nodes and pylons cannot deploy");
      const input = parse(z.strictObject({ commit: z.union([z.literal("main"), commitSchema]) }), await r.body());
      const commit = input.commit === "main" ? await (options.deployment?.resolveMain ?? resolveMain)() : input.commit;
      if (draining()) throw new HttpError(409, "control plane is draining; wait for this deployment to finish");
      registry.setDesiredRelease({ commit: commitSchema.parse(commit), requestedBy: r.caller, requestedAt: Date.now() });
      return ok(releaseView(registry, options.deployment?.self));
    }],
    // admit lets only a node with its deployer key reach these.
    ["GET", /^\/v1\/deployer\/release$/, () => ok(releaseView(registry, options.deployment?.self))],
    ["POST", /^\/v1\/deployer\/report$/, { open: "admit lets only a reporter reach a deployer route" }, async (_, r) => {
      const node = registry.nodeByTailnetId(r.caller)!;
      const report = parse(reportSchema, await r.body());
      if (report.role === "control" && r.caller !== options.deployment?.self) throw new HttpError(403, "only the control node reports control health");
      registry.reportRelease({ ...report, node: node.name, observedAt: Date.now() });
      return ok({ ok: true });
    }],
    ["POST", /^\/v1\/deployer\/releases$/, { open: "admit lets only a reporter reach a deployer route" }, async (_, r) => {
      const node = registry.nodeByTailnetId(r.caller)!;
      const { inventory, outcomes } = parse(releasesSchema, await r.body());
      if (options.cleanup === undefined) throw new HttpError(409, "this control plane runs no cleanup, so it records no releases");
      return ok({ delete: options.cleanup.releases(node.name, inventory, outcomes) });
    }],
    ["POST", /^\/v1\/deployer\/drain$/, { open: "admit lets only a reporter reach a deployer route, and the route only the control node" }, async (_, r) => {
      if (r.caller !== options.deployment?.self) throw new HttpError(403, "only the control node drains");
      const body = parse(z.strictObject({ commit: commitSchema, release: z.boolean().optional(), hold: z.boolean().optional() }), await r.body());
      if (body.commit !== registry.desiredRelease()?.commit) throw new HttpError(409, "release was superseded");
      registry.setDrain(body.release ? null : { commit: body.commit, expiresAt: Date.now() + 120_000, locked: registry.drain()?.locked ?? false });
      const idle = body.release ? false : !await turnsRunning();
      if (body.hold && idle) registry.setDrain({ commit: body.commit, expiresAt: Date.now() + 120_000, locked: true });
      return ok({ idle, expiresAt: registry.drain()?.expiresAt ?? null });
    }],
  ];
}
