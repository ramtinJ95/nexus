import { pylonEventSchema, type PylonEvent } from "../events.ts";
/**
 * The probe's answers to the in-pylon `nexus` CLI (PylonApiRequest in project.ts), and the listener a backend's
 * host bridge delivers them through. The bridge names the calling pylon from the VM or container the request
 * came through, so the guest holds no token and nothing here takes identity from the request. Everything else
 * in a request is the guest's, so it is parsed here.
 *
 * A reply is the CLI's --json output. An error is plain text: 400 for a request this API does not take, 409 for an
 * output or a port the agent can fix, such as a missing file or a port a service's preview owns, and 500 for a failed guest operation, whose message the
 * guest's own refusals (an unknown service, a declared name given to `service start`) come through in.
 */
import { chmod, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import type { Guest } from "../backend.ts";
import { addOutput, listOutputs, OutputRefused } from "../outputs.ts";
import { linkedName, serviceDecl, type PreviewAssignment, type PylonApiRequest, type ServiceName } from "../project.ts";
import type { DeclaredOutput, PylonId, ServiceFact } from "../protocol.ts";
import { bridgePylonHeader, hostBridgeSocket } from "../pylon-vm/host-bridge.ts";
import { privateDirectory } from "../pylon-vm/storage.ts";

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

/** One NEXUS_API call, from the pylon the bridge named. A 200 body is JSON, any other is plain text. */
export type HostBridgeAnswer = (pylonId: PylonId, body: string) => Promise<{ status: number; body: string }>;

/** A backend's end of NEXUS_API. The probe starts it once and closes it when it closes. */
export type HostBridge = (answer: HostBridgeAnswer) => Promise<{ close(): Promise<void> }>;

export interface PylonApiDeps {
  event?(pylon: PylonId, event: PylonEvent): void;
  guest(pylonId: PylonId): Guest;
  /** The previews the pylon's last successful spawn published and warmed. */
  published(pylonId: PylonId): readonly PreviewAssignment[];
  /** Publishes a fresh observation, so the control plane sees a new service or output without waiting for the next snapshot. */
  changed(): void;
  /** The URL tailscale serves for an https port, or null when it serves none. */
  previewUrl(httpsPort: number): Promise<string | null>;
  /** Stops routing an unlinked port's preview now (TailscaleServe.withdraw). */
  withdraw(pylonId: PylonId, service: ServiceName): Promise<void>;
  /** A port was linked, so spawns may route its service again after a withdraw. */
  linked(pylonId: PylonId, service: ServiceName): void;
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

const serviceName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
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
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Invalid("the request body is not JSON");
  }
  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) throw new Invalid(`not a request this API takes:\n${z.prettifyError(parsed.error)}`);
  // Zod types an optional field as `T | undefined`, but it never adds a key the body lacks.
  return parsed.data as PylonApiRequest;
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
    const found = await Promise.all(assigned.map(async (p) => [p.service, await deps.previewUrl(p.httpsPort)] as const));
    return new Map(found.flatMap(([service, url]) => url === null ? [] : [[service, url]]));
  }

  async function views(pylonId: PylonId, facts: readonly ServiceFact[], ms: number): Promise<ServiceView[]> {
    const found = await urls(pylonId, facts.filter((f) => f.wantsPreview).map((f) => f.name), ms);
    return facts.map((f) => ({ ...f, url: found.get(f.name) ?? null }));
  }

  async function info(guest: Guest, pylonId: PylonId): Promise<PylonInfo> {
    const read = await guest.exec(["cat", pylonInfoFile], { cwd: "/", timeoutMs: 10_000 });
    if (read.exitCode !== 0) throw new Error(`reading ${pylonInfoFile} failed with exit ${read.exitCode}: ${read.output}`);
    let parsed: ReturnType<typeof pylonInfoSchema.safeParse>;
    try {
      parsed = pylonInfoSchema.safeParse(JSON.parse(read.output));
    } catch {
      throw new Error(`${pylonInfoFile} is not JSON`);
    }
    if (!parsed.success) throw new Error(`${pylonInfoFile} is not the file Nexus wrote:\n${z.prettifyError(parsed.error)}`);
    if (parsed.data.pylonId !== pylonId) throw new Error(`${pylonInfoFile} names ${parsed.data.pylonId}, but the request came from ${pylonId}`);
    return parsed.data;
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
        const service = await guest.linkPort(request.port, request.title);
        deps.linked(pylonId, service);
        deps.changed();
        const found = await urls(pylonId, [service], waitMs);
        return { service, port: request.port, url: found.get(service) ?? null };
      }
      case "unpreview":
        const refused = await guest.unlinkPort(request.port);
        if (refused !== null) throw new Refused(refused);
        await deps.withdraw(pylonId, linkedName(request.port));
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

const maxBodyBytes = 1 << 20;

/**
 * An HTTP listener for NEXUS_API calls. `identify` names the calling pylon from what the bridge attached to the
 * request, or returns null for a request no bridge sent, which gets a 404.
 */
export function listenHostBridge(
  at: { path: string } | { host: string; port: number },
  identify: (req: IncomingMessage) => Promise<PylonId | null>,
): HostBridge {
  return async (answer) => {
    const server = createServer((req, res) => {
      const reply = async (): Promise<{ status: number; body: string }> => {
        const pylonId = await identify(req);
        if (pylonId === null) return { status: 404, body: `no route ${req.method} ${req.url}` };
        if (req.method !== "POST") return { status: 405, body: "NEXUS_API takes POST only" };
        let body = "";
        req.setEncoding("utf8");
        for await (const chunk of req as AsyncIterable<string>) {
          body += chunk;
          if (body.length > maxBodyBytes) return { status: 413, body: `request body over ${maxBodyBytes} bytes` };
        }
        return answer(pylonId, body);
      };
      reply().then(
        ({ status, body }) => res.writeHead(status, { "content-type": status === 200 ? "application/json" : "text/plain; charset=utf-8" }).end(body),
        (err: unknown) => res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end((err as Error).message),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const done = () => { server.off("error", reject); resolve(); };
      if ("path" in at) server.listen(at.path, done);
      else server.listen(at.port, at.host, done);
    });
    return {
      close: () => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    };
  };
}

const pylonIdPattern = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * The pylon VM backend's bridge: a Unix socket under the state root, which each instance's controller forwards
 * the guest's requests to with the instance name in a header (src/pylon-vm/host-bridge.ts). The socket is
 * private to the probe's user, so only the controllers can set that header.
 */
export function pylonVmHostBridge(stateRoot: string): HostBridge {
  const path = hostBridgeSocket(stateRoot);
  const listen = listenHostBridge({ path }, async (req) => {
    const name = req.headers[bridgePylonHeader];
    return req.url === "/v1/request" && typeof name === "string" && pylonIdPattern.test(name) ? name as PylonId : null;
  });
  return async (answer) => {
    // The probe can start before the backend's first action makes the state root, so the bridge makes it as the fork does.
    await privateDirectory(stateRoot);
    await rm(path, { force: true }); // left by a probe that did not close
    const bridge = await listen(answer);
    await chmod(path, 0o600);
    return bridge;
  };
}
