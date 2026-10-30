import { pylonEventSchema, type PylonEvent } from "../events.ts";
/**
 * The probe's answers to the in-pylon `nexus` CLI (PylonApiRequest below), which a backend's host bridge
 * (host-bridge.ts) delivers. The bridge names the calling pylon from the VM or container the request
 * came through, so the guest holds no token and nothing here takes identity from the request. Everything else
 * in a request is the guest's, so it is parsed here.
 *
 * A reply is the CLI's --json output. An error is plain text: 400 for a request this API does not take, 409 for an
 * output or a port the agent can fix, such as a missing file or a port a service's preview owns, and 500 for a failed guest operation, whose message the
 * guest's own refusals (an unknown service, a declared name given to `service start`) come through in.
 */
import { z } from "zod";
import type { Guest } from "../backend.ts";
import type { HostBridgeAnswer } from "../host-bridge.ts";
import type { PortLinks } from "./run.ts";
import { addOutput, listOutputs, OutputRefused } from "../outputs.ts";
import { serviceDecl, serviceName, type ServiceDecl, type ServiceName } from "../services-file.ts";
import type { PreviewAssignment } from "../spawn.ts";
import type { PylonId } from "../ids.ts";
import type { DeclaredOutput, ServiceFact } from "../protocol/observations.ts";
import { parseJson } from "../parse.ts";

/** What `nexus info --json` prints: /home/user/.nexus/pylon.json, which renderOverlay writes. */
export const pylonInfoFile = "/home/user/.nexus/pylon.json";
export const pylonInfoSchema = z.strictObject({
  pylonId: z.string(),
  threadId: z.string(),
  project: z.string(),
  node: z.string(),
  api: z.string(),
  allowedHosts: z.array(z.string()),
  previews: z.array(z.strictObject({ service: z.string(), url: z.string() })),
  logins: z.array(z.enum(["claude", "chatgpt"])),
  dotfiles: z.strictObject({ repo: z.string(), ref: z.string() }),
});
export type PylonInfo = z.infer<typeof pylonInfoSchema>;

/** A service with the preview URL tailscale serves for it, or null while it has none. */
export type ServiceView = ServiceFact & { url: string | null };

// In-pylon commands. The `nexus` CLI in the image calls the probe at NEXUS_API.

/**
 * NEXUS_API is http://nexus.pylon. Gondolin's onRequest hook answers that host from the probe on the node
 * (pi-sandbox change 4), so the call never leaves the machine and needs no tailnet route. The probe knows
 * which pylon is calling from the VM the request came through, so the guest holds no token.
 * If change 4 is refused, the fallback is a file pair with one writer each: the CLI writes requests under
 * /run/nexus/requests/ and the probe polls them through Gondolin's file API and writes the replies.
 */
export type PylonApiRequest =
  | ({ op: "event" } & PylonEvent)
  | { op: "info" }
  | { op: "services"; action: "ensure" | "list" | "restart" | "stop"; name?: ServiceName }
  | { op: "service-logs"; name: ServiceName; lines: number }
  | { op: "service-start"; name: ServiceName; decl: ServiceDecl } // ad hoc. Rejects declared names
  | { op: "preview"; port: number; title?: string }
  | { op: "unpreview"; port: number }
  | { op: "output-add"; output: { kind: "file"; path: string; title?: string } | { kind: "diff"; title?: string } }
  | { op: "output-list" };

/**
 * `services ensure` and `preview` wait up to 30 s for a preview URL. A new preview needs an https port,
 * which only the control plane allocates. The probe reports the new service, the control plane sends a
 * spawn with a new LiveSpec, the probe publishes and warms the URL (S4's first request timed out), and only
 * then does the command return it. Declared outputs are recorded in the guest under /home/user/.nexus/outputs/
 * and surface through the next observation. Responses are the CLI's --json output.
 */
export interface PylonApiReplies {
  event: { accepted: true };
  info: PylonInfo;
  services: { services: readonly ServiceView[] };
  "service-logs": { logs: string };
  "service-start": { services: readonly ServiceView[] };
  /** `url` is null when no preview was published within the wait. The service stays linked, and a later `services list` shows the URL. */
  preview: { service: ServiceName; port: number; url: string | null };
  /** The control plane drops the preview once it sees the port unlinked, and its URL stops at its next spawn. */
  unpreview: { port: number };
  "output-add": { output: DeclaredOutput };
  "output-list": { outputs: readonly DeclaredOutput[] };
}

export interface PylonApiDeps {
  event?(pylon: PylonId, event: PylonEvent): void;
  guest(pylonId: PylonId): Guest;
  /** The previews the pylon's last successful spawn published and warmed. */
  published(pylonId: PylonId): readonly PreviewAssignment[];
  /** Publishes a fresh observation, so the control plane sees a new service or output without waiting for the next snapshot. */
  changed(): void;
  /** The URL tailscale serves for each https port Nexus serves, from one `tailscale serve status`. */
  previewUrls(): Promise<ReadonlyMap<number, string>>;
  ports: PortLinks;
  /** How long `services ensure`, `service start` and `preview` wait for a URL. Default 30 s. */
  previewWaitMs?: number;
}

export interface PylonApi {
  answer: HostBridgeAnswer;
  /** Call when a successful spawn changes what `deps.published` returns, so waiting calls look again. */
  republished(): void;
}

class Invalid extends Error {}
/** A request the pylon turns down for a reason the agent can act on, such as a port a service's preview owns. */
class Refused extends Error {}

const requestSchema = z.discriminatedUnion("op", [
  pylonEventSchema.extend({ op: z.literal("event") }),
  z.strictObject({ op: z.literal("info") }),
  z.strictObject({ op: z.literal("services"), action: z.enum(["ensure", "list", "restart", "stop"]), name: serviceName.optional() }),
  // The fork returns at most 500 lines.
  z.strictObject({ op: z.literal("service-logs"), name: serviceName, lines: z.int().min(1).max(500) }),
  z.strictObject({ op: z.literal("service-start"), name: serviceName, decl: serviceDecl }),
  z.strictObject({ op: z.literal("preview"), port: z.int().min(1).max(65535), title: z.string().min(1).optional() }),
  z.strictObject({ op: z.literal("unpreview"), port: z.int().min(1).max(65535) }),
  z.strictObject({
    op: z.literal("output-add"),
    output: z.discriminatedUnion("kind", [
      // The CLI resolves a relative path against its own cwd before it sends it.
      z.strictObject({ kind: z.literal("file"), path: z.string().startsWith("/").refine((s) => !s.includes("\0")), title: z.string().min(1).optional() }),
      z.strictObject({ kind: z.literal("diff"), title: z.string().min(1).optional() }),
    ]),
  }),
  z.strictObject({ op: z.literal("output-list") }),
]);

function parseRequest(body: string): PylonApiRequest {
  try {
    // Zod types an optional field as `T | undefined`, but it never adds a key the body lacks.
    return parseJson(requestSchema, body, "request") as PylonApiRequest;
  } catch (err) {
    throw new Invalid(`not a request this API takes: ${(err as Error).message}`);
  }
}

export function createPylonApi(deps: PylonApiDeps): PylonApi {
  const waitMs = deps.previewWaitMs ?? 30_000;
  /** Calls waiting for a spawn to publish previews. Each removes itself when it ends. */
  const waiters = new Set<() => void>();

  /** The URLs of those of `services` that have a published preview, waiting up to `ms` for all of them to have one. */
  async function urls(pylonId: PylonId, services: readonly ServiceName[], ms: number): Promise<Map<ServiceName, string>> {
    const deadline = Date.now() + ms;
    let assigned: PreviewAssignment[];
    for (;;) {
      assigned = deps.published(pylonId).filter((p) => services.includes(p.service));
      const left = deadline - Date.now();
      if (assigned.length === new Set(services).size || left <= 0) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, left).unref();
      waiters.add(resolve);
      try {
        await promise;
      } finally {
        clearTimeout(timer);
        waiters.delete(resolve);
      }
    }
    if (assigned.length === 0) return new Map();
    const served = await deps.previewUrls();
    return new Map(assigned.flatMap((p) => {
      const url = served.get(p.httpsPort);
      return url === undefined ? [] : [[p.service, url]];
    }));
  }

  async function views(pylonId: PylonId, facts: readonly ServiceFact[], ms: number): Promise<ServiceView[]> {
    const found = await urls(pylonId, facts.filter((f) => f.wantsPreview).map((f) => f.name), ms);
    return facts.map((f) => ({ ...f, url: found.get(f.name) ?? null }));
  }

  async function info(guest: Guest, pylonId: PylonId): Promise<PylonInfo> {
    const read = await guest.exec(["cat", pylonInfoFile], { cwd: "/", timeoutMs: 10_000 });
    if (read.exitCode !== 0) throw new Error(`reading ${pylonInfoFile} failed with exit ${read.exitCode}: ${read.output}`);
    const info = parseJson(pylonInfoSchema, read.output, `${pylonInfoFile} is not the file Nexus wrote`);
    if (info.pylonId !== pylonId) throw new Error(`${pylonInfoFile} names ${info.pylonId}, but the request came from ${pylonId}`);
    return info;
  }

  async function handle(pylonId: PylonId, request: PylonApiRequest): Promise<PylonApiReplies[PylonApiRequest["op"]]> {
    const guest = deps.guest(pylonId);
    switch (request.op) {
      case "event": {
        if (deps.event === undefined) throw new Error("event reporting is unavailable");
        const { op: _, ...event } = request;
        deps.event(pylonId, event);
        return { accepted: true };
      }
      case "info":
        return info(guest, pylonId);
      case "services": {
        const { action, name } = request;
        const { services } = await guest.services(action, name);
        if (action !== "list") deps.changed();
        return { services: await views(pylonId, services, action === "ensure" ? waitMs : 0) };
      }
      case "service-logs": {
        const { logs } = await guest.services("logs", request.name, request.lines);
        if (logs === undefined) throw new Error(`the guest returned no logs for ${request.name}`);
        return { logs };
      }
      case "service-start": {
        const services = await guest.startService(request.name, request.decl);
        deps.changed();
        return { services: await views(pylonId, services, waitMs) };
      }
      case "preview": {
        const service = await deps.ports.link(pylonId, request.port, request.title);
        deps.changed();
        const found = await urls(pylonId, [service], waitMs);
        return { service, port: request.port, url: found.get(service) ?? null };
      }
      case "unpreview":
        const refused = await deps.ports.unlink(pylonId, request.port);
        if (refused !== null) throw new Refused(refused);
        deps.changed();
        return { port: request.port };
      case "output-add": {
        const output = await addOutput(guest, request.output);
        deps.changed();
        return { output };
      }
      case "output-list":
        return { outputs: await listOutputs(guest) };
    }
  }

  return {
    async answer(pylonId, body) {
      try {
        return { status: 200, body: JSON.stringify(await handle(pylonId, parseRequest(body))) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: err instanceof Invalid ? 400 : err instanceof OutputRefused || err instanceof Refused ? 409 : 500, body: message };
      }
    },
    republished() {
      for (const wake of waiters) wake();
    },
  };
}
