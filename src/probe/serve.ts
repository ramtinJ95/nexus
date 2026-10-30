/**
 * TailscaleServe over the `tailscale` CLI. Every preview is one `tailscale serve --bg --https=<port>` entry that
 * proxies to the gateway, which routes by the port (S6).
 *
 * Ownership:
 * - An entry is Nexus's when its only handler proxies `/` to the gateway origin. Nothing else is ever changed,
 *   and a wanted port held by anything else fails the job. So the gateway port must stay fixed across restarts.
 * - Which pylon an entry belongs to is the gateway's route table. Every converge writes it to the routes file and
 *   the probe loads it at start, because a paused pylon keeps its previews and is not re-spawned after a probe
 *   restart. An entry of Nexus's that the table does not map was withdrawn, or is left from a converge that stopped
 *   between adding it and writing the file, and any converge removes it.
 *
 * The serve config is one object per node, so converges change it one at a time. Warming runs outside that.
 */
import { setTimeout as delay } from "node:timers/promises";
import { JobFailure } from "../backend.ts";
import type { TailscaleServe } from "./run.ts";
import { output } from "../exec.ts";
import { readJson, saveJson } from "../json-file.ts";
import type { PreviewAssignment } from "../project.ts";
import type { PylonId } from "../protocol.ts";
import { serialQueue } from "../single-flight.ts";
import { warmHeader, type PreviewGateway, type PreviewRoute } from "./gateway.ts";

/** Runs the tailscale CLI and resolves to its stdout. Rejects when it exits nonzero. */
export type TailscaleCli = (args: readonly string[], signal: AbortSignal) => Promise<string>;

/** One GET that resolves to the HTTP status. The probe uses fetch. Tests route it to the gateway without TLS. */
export type HttpsGet = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<number>;

/** The binary is looked up on PATH. On the nodes it is the home tailnet's `tailscale`. */
export function tailscaleCli(binary = "tailscale"): TailscaleCli {
  return (args, signal) => output(binary, args, { signal, timeout: 30_000 });
}

export const fetchGet: HttpsGet = async (url, headers, signal) => {
  const res = await fetch(url, { headers, signal });
  await res.body?.cancel();
  return res.status;
};

/** S4's first request hung in TLS for 15 s and a retry passed, so attempts are short and repeated. */
const warm = { attemptMs: 10_000, budgetMs: 60_000, pauseMs: 500 } as const;

export function createTailscaleServe(options: {
  cli: TailscaleCli;
  gateway: Pick<PreviewGateway, "origin" | "routes">;
  /** Where the route table is kept between probe runs. Load it with readRoutes before the gateway starts. */
  routesFile: string;
  get?: HttpsGet | undefined;
}): TailscaleServe {
  const { cli, gateway } = options;
  const get = options.get ?? fetchGet;
  const changes = serialQueue();

  async function status(signal: AbortSignal): Promise<Map<number, Listener>> {
    return parseServeStatus(await cli(["serve", "status", "--json"], signal), gateway.origin);
  }

  async function apply(pylonId: PylonId, previews: readonly PreviewAssignment[], signal: AbortSignal): Promise<Map<number, string>> {
    signal.throwIfAborted();
    const listeners = await status(signal);
    const { add, remove, taken } = planServe(pylonId, previews, listeners, gateway.routes);
    try {
      // Before a taken port fails the job, so two pylons that each want a port the other still routes do not both wait.
      for (const port of remove) {
        await cli(["serve", `--https=${port}`, "off"], signal);
        gateway.routes.delete(port);
      }
      for (const [port, route] of gateway.routes) {
        if (route.pylonId === pylonId && !previews.some((p) => p.httpsPort === port)) gateway.routes.delete(port);
      }
      // A spawn that carries a port its pylon has since released, which another pylon now holds. Retried, the
      // pylon's next spawn carries its current previews.
      const [first] = taken;
      if (first !== undefined) throw new JobFailure("backend", `https port ${first.port} routes to ${first.owner}, so it cannot also route to ${pylonId}`);
      for (const { service, httpsPort } of previews) gateway.routes.set(httpsPort, { pylonId, service });
      for (const port of add) await cli(["serve", "--bg", `--https=${port}`, gateway.origin], signal);
    } finally {
      await writeRoutes(options.routesFile, gateway.routes);
    }
    const after = add.length + remove.length === 0 ? listeners : await status(signal);
    const urls = new Map<number, string>();
    for (const { httpsPort } of previews) {
      const listener = after.get(httpsPort);
      if (listener?.kind !== "nexus") throw new Error(`tailscale serve reports no entry to the gateway on port ${httpsPort} after adding it`);
      urls.set(httpsPort, listener.url);
    }
    return urls;
  }

  async function warmUp(url: string, expect: string, signal: AbortSignal): Promise<void> {
    const budget = AbortSignal.any([signal, AbortSignal.timeout(warm.budgetMs)]);
    let last = "no attempt finished";
    for (;;) {
      try {
        const status = await get(url, { [warmHeader]: expect }, AbortSignal.any([budget, AbortSignal.timeout(warm.attemptMs)]));
        if (status === 204) return;
        last = `HTTP ${status}`;
      } catch (err) {
        last = (err as Error).message;
      }
      signal.throwIfAborted();
      if (budget.aborted) throw new JobFailure("backend", `preview ${url} did not answer within ${warm.budgetMs / 1000} s: ${last}`);
      await delay(warm.pauseMs, undefined, { signal: budget }).catch(() => {});
    }
  }

  return {
    async converge(pylonId, previews, signal) {
      const urls = await changes.run(() => apply(pylonId, previews, signal));
      await Promise.all(previews.map((p) => warmUp(urls.get(p.httpsPort)!, `${pylonId}/${p.service}`, signal)));
    },
    async withdraw(pylonId, service) {
      // The entry is then Nexus's and unmapped, which the next converge of any pylon removes. Written even when the
      // table no longer maps it, because an earlier withdraw may have failed to write.
      await changes.run(async () => {
        for (const [port, route] of gateway.routes) {
          if (route.pylonId === pylonId && route.service === service) gateway.routes.delete(port);
        }
        await writeRoutes(options.routesFile, gateway.routes);
      });
    },
  };
}

interface RouteRecord extends PreviewRoute { httpsPort: number }

/** A missing file is an empty table: the probe's first start on this node. */
export async function readRoutes(file: string): Promise<Map<number, PreviewRoute>> {
  const records = await readJson(file, []);
  const valid = (r: Partial<Record<keyof RouteRecord, unknown>>) =>
    Number.isInteger(r.httpsPort) && typeof r.pylonId === "string" && typeof r.service === "string";
  if (!Array.isArray(records) || !records.every(valid)) throw new Error(`${file} is not a list of { httpsPort, pylonId, service }`);
  return new Map((records as RouteRecord[]).map(({ httpsPort, pylonId, service }) => [httpsPort, { pylonId, service }]));
}

async function writeRoutes(file: string, routes: ReadonlyMap<number, PreviewRoute>): Promise<void> {
  await saveJson(file, [...routes].map(([httpsPort, route]): RouteRecord => ({ httpsPort, ...route })));
}

/** What `tailscale serve status --json` says about one https port. */
export type Listener = { kind: "nexus"; url: string } | { kind: "other" };

/**
 * The status shape, as S6 captured it (spikes/evidence/logs/s6-status-*-json.txt):
 * `{ TCP: { "<port>": { HTTPS: true } }, Web: { "<host>:<port>": { Handlers: { "/": { Proxy: "<url>" } } } } }`,
 * and `{}` with no entries. Any port in TCP is taken, whatever serves it.
 */
export function parseServeStatus(json: string, gatewayOrigin: string): Map<number, Listener> {
  const config = JSON.parse(json) as { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> };
  const listeners = new Map<number, Listener>();
  for (const port of Object.keys(config.TCP ?? {})) listeners.set(Number(port), { kind: "other" });
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    const handlers = Object.entries(web.Handlers ?? {});
    const ours = handlers.length === 1 && handlers[0]![0] === "/" && handlers[0]![1].Proxy === gatewayOrigin;
    if (ours && listeners.has(port)) listeners.set(port, { kind: "nexus", url: `https://${hostPort}/` });
  }
  return listeners;
}

/**
 * The serve changes that make `pylonId` publish exactly `previews`: drop its other entries and every entry of
 * Nexus's that no pylon owns, and add the wanted ports that have none. `taken` lists the wanted ports another
 * pylon's route holds, which the converge refuses after it drops the entries.
 */
export function planServe(
  pylonId: PylonId,
  previews: readonly PreviewAssignment[],
  listeners: ReadonlyMap<number, Listener>,
  routes: ReadonlyMap<number, { pylonId: PylonId }>,
): { add: number[]; remove: number[]; taken: { port: number; owner: PylonId }[] } {
  const wanted = new Set(previews.map((p) => p.httpsPort));
  if (wanted.size !== previews.length) throw new JobFailure("invalid", `${pylonId} was assigned the same https port twice`);
  const add: number[] = [];
  const taken: { port: number; owner: PylonId }[] = [];
  for (const port of wanted) {
    const listener = listeners.get(port);
    if (listener?.kind === "other") throw new JobFailure("invalid", `https port ${port} is already served by something other than the Nexus gateway`);
    const owner = routes.get(port)?.pylonId;
    if (owner !== undefined && owner !== pylonId) taken.push({ port, owner });
    else if (listener === undefined) add.push(port);
  }
  const remove: number[] = [];
  for (const [port, listener] of listeners) {
    if (listener.kind !== "nexus" || wanted.has(port)) continue;
    const owner = routes.get(port)?.pylonId;
    if (owner === undefined || owner === pylonId) remove.push(port);
  }
  return { add, remove, taken };
}
