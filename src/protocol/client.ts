/**
 * Probe contract, the control plane's client for one probe.
 *
 * The wire encoding of node health is private to this module, which reads it in `health`.
 */
import { Agent, request, type IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { localApiWhois, PeerRefused, verifyPeer, type Whois } from "../tailscale.ts";
import { asSent, named, parseJson, unchecked } from "../parse.ts";
import type { ArtifactManifest } from "../images.ts";
import type { JobId, NodeName, PortableArtifactId, PylonId, TailnetNodeId } from "../ids.ts";
import { jobStatusSchema, parseSubmitReply, type JobEnvelope, type JobStatus, type SubmitReply } from "./jobs.ts";
import { parseProbeEvent, type DiskFact, type ProbeEvent } from "./observations.ts";
import { parseCommandResult, type CommandResult, type PylonCommand } from "./commands.ts";
import { clientByteStream, streamPath, streamProtocol, type ByteStream } from "./streams.ts";
import { parseArtifactManifest } from "./artifacts.ts";
import { probePort } from "./routes.ts";
import { isProbeError, probeError, ProbeHttpError, text } from "./http.ts";

/**
 * The control plane's handle on one probe. Methods reject with ProbeError when the probe cannot be reached or is not
 * the node whois must name, with ProbeHttpError for a status the method gives no meaning, and with a plain Error for
 * a reply that fails its checks.
 */
export interface ProbeClient {
  readonly node: NodeName;
  /** PUT /v1/jobs/{jobId}. Retry the same envelope on a transport error until it is accepted or expires. */
  submit(env: JobEnvelope): Promise<SubmitReply>;
  job(jobId: JobId): Promise<JobStatus | "unknown">;
  /** Ends when the link drops. The registry marks the node offline after 30 s without a reconnect. */
  observe(signal: AbortSignal): AsyncIterable<ProbeEvent>;
  command(pylonId: PylonId, command: PylonCommand): Promise<CommandResult>;
  stream(pylonId: PylonId, argv: readonly string[]): Promise<ByteStream>;
  /** GET /v1/manifests/{id}: the manifest of an image or template the node holds, or null when it holds none. */
  manifest(artifact: PortableArtifactId): Promise<ArtifactManifest | null>;
  /** PUT /v1/secrets/{name}: the current value of one of heldSecrets. The probe holds it in memory and applies it to its running pylons. */
  putSecret(name: string, value: string): Promise<void>;
  /** PUT /v1/peers: every other node, whose probes may fetch this node's images and templates and serve it theirs. */
  putPeers(peers: readonly TailnetNodeId[]): Promise<void>;
  /** GET /v1/node-health: the node's host as the probe reads it now. It answers after sampling its pylons' CPU for a second. */
  health(): Promise<NodeHealth>;
}

/**
 * A node's host, read when asked. A reading is null where the host does not expose it, such as temperatures in a VM, or
 * load and memory on a host without Linux's /proc. `disk` is the filesystem the backend keeps its pylons' disks on.
 * `pylons` lists each running pylon's processes, its controller and what it started, such as QEMU, with the percent of
 * one CPU they used over the sample and their resident memory. It is null from a backend that cannot name them.
 */
export interface NodeHealth {
  node: NodeName;
  readAt: string;
  cpus: number;
  load: { one: number; five: number; fifteen: number } | null;
  memory: { totalGiB: number; availableGiB: number; swapTotalGiB: number; swapFreeGiB: number } | null;
  disk: { path: string; totalGiB: number; freeGiB: number };
  /** Each filesystem Nexus writes to, the pylons' first. Absent from a probe older than the field. */
  disks?: readonly DiskFact[];
  temperatures: readonly { sensor: string; celsius: number }[] | null;
  pylons: readonly { pylonId: PylonId; processes: number; cpuPercent: number; residentGiB: number }[] | null;
}
const nodeHealthSchema = z.looseObject({
  node: named<NodeName>(), readAt: unchecked<string>(), cpus: unchecked<number>(), load: unchecked<NodeHealth["load"]>(), memory: unchecked<NodeHealth["memory"]>(),
  disk: unchecked<NodeHealth["disk"]>(), disks: unchecked<readonly DiskFact[]>().exactOptional(), temperatures: unchecked<NodeHealth["temperatures"]>(), pylons: unchecked<NodeHealth["pylons"]>(),
}) satisfies z.ZodType<NodeHealth>;

const requestTimeoutMs = 10_000;
/** A command answers only when it is done: an exec of up to 60 s, or a session open that waits for its agent. */
const commandTimeoutMs = 90_000;

/**
 * `whois` defaults to the local tailscaled. Tests pass a fake one, and `port` exists so they can run
 * a probe on a free loopback port.
 */
export function connectProbe(node: NodeName, tailnetHost: string, expected: TailnetNodeId, options: { port?: number; whois?: Whois } = {}): ProbeClient {
  // Plain HTTP, because WireGuard already encrypts the link. The identity check is whois on the socket we got.
  const port = options.port ?? probePort;
  const whois = options.whois ?? localApiWhois();
  const agent = new Agent({ keepAlive: false });

  /** A silent socket for `requestTimeoutMs` fails the call as unreachable. Observe lifts the limit once its stream starts. */
  function open(method: "GET" | "PUT" | "POST", path: string, body: string | null, signal?: AbortSignal, timeoutMs = requestTimeoutMs, contentType = "application/json"): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({ host: tailnetHost, port, method, path, agent, timeout: timeoutMs, ...(signal ? { signal } : {}) }, (res) => {
        if (res.statusCode === 403) {
          res.destroy();
          return reject(statusError(method, path, 403, ""));
        }
        resolve(res);
      });
      req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      req.on("error", (err) => reject(signal?.aborted || isProbeError(err) ? err : probeError("unreachable", `${node}: ${err.message}`)));
      if (body !== null) req.setHeader("content-type", contentType);
      // A body can be a secret, so not even the request line goes out until whois names the connected peer.
      req.once("socket", (socket) => {
        verifyPeer(socket, whois, (id) => id === expected).then(() => req.end(body ?? undefined), (err: Error) => req.destroy(refusal(err, "connection")));
      });
    });
  }

  /** A ProbeError for verifyPeer's refusal, and whois's own error as it is. */
  function refusal(err: Error, what: "connection" | "stream"): Error {
    if (!(err instanceof PeerRefused)) return err;
    return err.peer === null ? probeError("unreachable", `${node}: the ${what} closed before whois`) : probeError("forbidden", `${node}: ${err.message}, expected ${expected}`);
  }

  function statusError(method: string, path: string, status: number, body: string, conflict?: "not-running"): ProbeHttpError {
    if (status === 403) return new ProbeHttpError(`${node} refused this caller`, 403, "forbidden");
    if (status === 409 && conflict !== undefined) return new ProbeHttpError(`${node}: ${body}`, 409, conflict);
    return new ProbeHttpError(`${node}: ${method} ${path}: HTTP ${status}: ${body}`, status);
  }

  /** Throws for any status but `expected`. `conflict` is what a 409 means to a method that gives it one. */
  function expectStatus(method: string, path: string, res: { status: number; body: string }, expected: number, conflict?: "not-running"): void {
    if (res.status !== expected) throw statusError(method, path, res.status, res.body, conflict);
  }

  async function call(method: "GET" | "PUT" | "POST", path: string, body: string | null = null, timeoutMs = requestTimeoutMs, contentType?: string): Promise<{ status: number; body: string }> {
    const res = await open(method, path, body, undefined, timeoutMs, contentType);
    try {
      return { status: res.statusCode ?? 0, body: await text(res) };
    } catch (err) {
      throw probeError("unreachable", `${node}: the response broke off: ${(err as Error).message}`);
    }
  }

  return {
    node,
    async submit(env) {
      for (;;) {
        try {
          const res = await call("PUT", `/v1/jobs/${encodeURIComponent(env.jobId)}`, JSON.stringify(env));
          return parseSubmitReply(res.status, res.body);
        } catch (err) {
          if (!isProbeError(err) || err.code !== "unreachable" || Date.now() >= Date.parse(env.notAfter)) throw err;
          await delay(500);
        }
      }
    },
    async job(jobId) {
      const res = await call("GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) return "unknown";
      expectStatus("GET", `/v1/jobs/${jobId}`, res, 200);
      return parseJson(asSent(jobStatusSchema), res.body, "status");
    },
    async *observe(signal) {
      const res = await open("GET", "/v1/observe", null, signal);
      if (res.statusCode !== 200) expectStatus("GET", "/v1/observe", { status: res.statusCode ?? 0, body: await text(res) }, 200);
      // The first snapshot arrives with the headers. After that, events can be a minute apart.
      res.socket.setTimeout(0);
      for await (const line of lines(res)) yield parseProbeEvent(line);
    },
    /** Never retried here. commandPolicies in probe/run.ts says which kinds a caller may send again. */
    async command(pylonId, command) {
      const path = `/v1/pylons/${encodeURIComponent(pylonId)}/commands`;
      const res = await call("POST", path, JSON.stringify(command), commandTimeoutMs);
      expectStatus("POST", path, res, 200, "not-running");
      return parseCommandResult(command, res.body);
    },
    async health() {
      const res = await call("GET", "/v1/node-health");
      expectStatus("GET", "/v1/node-health", res, 200);
      return parseJson(asSent(nodeHealthSchema), res.body, "health");
    },
    async putSecret(name, value) {
      const path = `/v1/secrets/${encodeURIComponent(name)}`;
      const res = await call("PUT", path, value, requestTimeoutMs, "text/plain; charset=utf-8");
      expectStatus("PUT", path, res, 204);
    },
    async putPeers(peers) {
      const res = await call("PUT", "/v1/peers", JSON.stringify(peers));
      expectStatus("PUT", "/v1/peers", res, 204);
    },
    stream(pylonId, argv) {
      const path = streamPath(pylonId, argv);
      return new Promise((resolve, reject) => {
        const req = request({ host: tailnetHost, port, method: "GET", path, agent, timeout: requestTimeoutMs, headers: { connection: "upgrade", upgrade: streamProtocol } });
        req.on("upgrade", (_res, socket, head) => {
          // Node hands over an upgraded socket without its error handler. A reset ends the stream as lost.
          socket.on("error", () => undefined);
          verifyPeer(socket, whois, (id) => id === expected).then(() => {
            // pi-env pings every 5 s, but a terminal can be silent for hours.
            socket.setTimeout(0);
            resolve(clientByteStream(socket, head));
          }, (err: Error) => { socket.destroy(); reject(refusal(err, "stream")); });
        });
        req.on("response", (res) => {
          text(res).then((body) => reject(statusError("GET", path, res.statusCode ?? 0, body, "not-running")), reject);
        });
        req.on("timeout", () => req.destroy(new Error(`no answer within ${requestTimeoutMs} ms`)));
        req.on("error", (err) => reject(probeError("unreachable", `${node}: ${err.message}`)));
        req.end();
      });
    },
    async manifest(artifact) {
      const path = `/v1/manifests/${encodeURIComponent(artifact)}`;
      const res = await call("GET", path);
      if (res.status === 404) return null;
      expectStatus("GET", path, res, 200);
      return parseArtifactManifest(JSON.parse(res.body));
    },
  };
}

/** Ends quietly when the link drops or the caller aborts: that is how observe reports a lost link. */
async function* lines(res: IncomingMessage): AsyncGenerator<string> {
  res.setEncoding("utf8");
  let buffered = "";
  try {
    for await (const chunk of res as AsyncIterable<string>) {
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line !== "") yield line;
      }
    }
  } catch {
    return;
  } finally {
    res.destroy();
  }
}
