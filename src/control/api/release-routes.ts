import { HttpError } from "../http-error.ts";
import { releaseView, resolveMain } from "../releases.ts";
import { feature, type Features } from "../features.ts";
import { ok, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, demand, type Deployment } from "./access.ts";
import { releaseRoutes as routes } from "../../contract/release.ts";
import { commitSchema, deploySchema, drainSchema, releasesSchema, reportSchema } from "../../contract/release-parse.ts";

/** The deployment, and what `main` resolves to, which a test fixes. */
export type DeploymentOptions = Deployment & { resolveMain?: () => Promise<string> };

export function releaseRoutes(kit: ApiKit, options: { deployment?: DeploymentOptions | undefined; features: Features }): readonly RouteEntry[] {
  const { registry, agents, draining, gate } = kit;

  async function busyTurns() {
    const entering = gate.busy();
    const threads: string[] = [];
    for (const t of registry.threads.storedThreads()) {
      if (t.status !== "deleted" && await agents[registry.threads.agent(t).kind].busy(t)) threads.push(t.id);
    }
    return { threads, entering: entering || gate.busy() };
  }

  return [
    on(routes.release, anyAllowed, () => ok(releaseView(registry, options.deployment?.self))),
    on(routes.deploy, { role: "deployer", action: "deploy" }, async (_, r) => {
      const input = parse(deploySchema, await r.body());
      const commit = input.commit === "main" ? await (options.deployment?.resolveMain ?? resolveMain)() : input.commit;
      if (draining()) throw new HttpError(409, "control plane is draining; wait for this deployment to finish");
      registry.setDesiredRelease({ commit: commitSchema.parse(commit), requestedBy: r.caller, requestedAt: Date.now() });
      return ok(releaseView(registry, options.deployment?.self));
    }),
    on(routes.deployerRelease, { role: "reporter" }, () => ok(releaseView(registry, options.deployment?.self))),
    on(routes.report, { role: "reporter" }, async (_, r) => {
      const node = registry.nodeByTailnetId(r.caller)!;
      const report = parse(reportSchema, await r.body());
      if (report.role === "control") demand(r.roles, { role: "control-node", action: "reports control health" });
      registry.reportRelease({ ...report, node: node.name, observedAt: Date.now() });
      return ok({ ok: true as const });
    }),
    on(routes.releases, { role: "reporter" }, async (_, r) => {
      const node = registry.nodeByTailnetId(r.caller)!;
      const { inventory, outcomes } = parse(releasesSchema, await r.body());
      return ok({ delete: feature(options.features, "cleanup").releases(node.name, inventory, outcomes) });
    }),
    on(routes.drain, { role: "control-node", action: "drains" }, async (_, r) => {
      const body = parse(drainSchema, await r.body());
      if (body.commit !== registry.desiredRelease()?.commit) throw new HttpError(409, "release was superseded");
      registry.setDrain(body.release ? null : { commit: body.commit, expiresAt: Date.now() + 120_000, locked: registry.drain()?.locked ?? false });
      const busy = body.release ? { threads: [], entering: false } : await busyTurns();
      const idle = !body.release && !busy.entering && busy.threads.length === 0;
      if (body.hold && idle) registry.setDrain({ commit: body.commit, expiresAt: Date.now() + 120_000, locked: true });
      return ok({ idle, ...body.release ? {} : busy, expiresAt: registry.drain()?.expiresAt ?? null });
    }),
  ];
}
