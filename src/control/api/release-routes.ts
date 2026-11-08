/**
 * The release a deployer asks for, and the deployer's reports and drain.
 */
import { z } from "zod";
import { HttpError } from "../http-error.ts";
import { commitSchema, releaseView, releasesSchema, reportSchema, resolveMain } from "../releases.ts";
import type { CleanupPass } from "../cleanup.ts";
import { ok, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, demand, type Deployment } from "./access.ts";

/** The deployment, and what `main` resolves to, which a test fixes. */
export type DeploymentOptions = Deployment & { resolveMain?: () => Promise<string> };

export function releaseRoutes(kit: ApiKit, options: { deployment?: DeploymentOptions | undefined; cleanup?: CleanupPass | undefined }): readonly RouteEntry[] {
  const { registry, agents, draining, gate } = kit;

  async function busyTurns() {
    const entering = gate.busy();
    const threads: string[] = [];
    for (const t of registry.harnessThreads()) {
      if (t.status === "deleted") continue;
      const { docs } = await agents.harness.view(t);
      const live = docs["pi.live"];
      const inbox = docs["pi.inbox"];
      if (live?.run !== undefined || (Array.isArray(inbox?.items) && inbox.items.length > 0)) threads.push(t.id);
    }
    return { threads, entering: entering || gate.busy() };
  }

  return [
    ["GET", /^\/v1\/release$/, anyAllowed, () => ok(releaseView(registry, options.deployment?.self))],
    ["PUT", /^\/v1\/release$/, { role: "deployer", action: "deploy" }, async (_, r) => {
      const input = parse(z.strictObject({ commit: z.union([z.literal("main"), commitSchema]) }), await r.body());
      const commit = input.commit === "main" ? await (options.deployment?.resolveMain ?? resolveMain)() : input.commit;
      if (draining()) throw new HttpError(409, "control plane is draining; wait for this deployment to finish");
      registry.setDesiredRelease({ commit: commitSchema.parse(commit), requestedBy: r.caller, requestedAt: Date.now() });
      return ok(releaseView(registry, options.deployment?.self));
    }],
    ["GET", /^\/v1\/deployer\/release$/, { role: "reporter" }, () => ok(releaseView(registry, options.deployment?.self))],
    ["POST", /^\/v1\/deployer\/report$/, { role: "reporter" }, async (_, r) => {
      const node = registry.nodeByTailnetId(r.caller)!;
      const report = parse(reportSchema, await r.body());
      if (report.role === "control") demand(r.roles, { role: "control-node", action: "reports control health" });
      registry.reportRelease({ ...report, node: node.name, observedAt: Date.now() });
      return ok({ ok: true });
    }],
    ["POST", /^\/v1\/deployer\/releases$/, { role: "reporter" }, async (_, r) => {
      const node = registry.nodeByTailnetId(r.caller)!;
      const { inventory, outcomes } = parse(releasesSchema, await r.body());
      if (options.cleanup === undefined) throw new HttpError(409, "this control plane runs no cleanup, so it records no releases");
      return ok({ delete: options.cleanup.releases(node.name, inventory, outcomes) });
    }],
    ["POST", /^\/v1\/deployer\/drain$/, { role: "control-node", action: "drains" }, async (_, r) => {
      const body = parse(z.strictObject({ commit: commitSchema, release: z.boolean().optional(), hold: z.boolean().optional() }), await r.body());
      if (body.commit !== registry.desiredRelease()?.commit) throw new HttpError(409, "release was superseded");
      registry.setDrain(body.release ? null : { commit: body.commit, expiresAt: Date.now() + 120_000, locked: registry.drain()?.locked ?? false });
      const busy = body.release ? { threads: [], entering: false } : await busyTurns();
      const idle = !body.release && !busy.entering && busy.threads.length === 0;
      if (body.hold && idle) registry.setDrain({ commit: body.commit, expiresAt: Date.now() + 120_000, locked: true });
      return ok({ idle, ...body.release ? {} : busy, expiresAt: registry.drain()?.expiresAt ?? null });
    }],
  ];
}
