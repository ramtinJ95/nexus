/**
 * How the Mac CLI reaches the control plane's API. This Mac joins the home tailnet only through ts-home's
 * userspace tailscaled, which offers a SOCKS5 proxy and no routes, so the CLI opens a SOCKS5 CONNECT tunnel to
 * the API and speaks HTTP over it. The proxy resolves the name, as curl's --socks5-hostname does,
 * because only it knows MagicDNS. Without a proxy the CLI connects directly, as on a machine on the tailnet.
 * An https:// URL speaks TLS inside that connection, to the dashboard's port.
 */
import { Agent, request } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";

/** Every way a command fails. Each has its own exit code, so a caller can tell them apart without parsing text. */
export type ErrorKind = "failed" | "unreachable" | "refused" | "not-found" | "conflict" | "invalid";
export const exitCodes: Readonly<Record<ErrorKind, number>> = {
  failed: 1, unreachable: 2, refused: 3, "not-found": 4, conflict: 5,
  // EX_USAGE, as the pylon CLI uses.
  invalid: 64,
};

export class CliError extends Error {
  readonly kind: ErrorKind;
  /** The API's HTTP status, or null when the CLI failed before or without a reply. */
  readonly status: number | null;
  /** The `code` of the API's error reply, or null when it sent none, as a control plane older than codes does. */
  readonly code: string | null;
  constructor(kind: ErrorKind, message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** Whether the control plane has no such route, which one older than the route says without a code. */
export const isMissingRoute = (err: unknown): err is CliError => err instanceof CliError && err.status === 404
  && (err.code === "no-route" || (err.code === null && err.message.startsWith("no route ")));

export interface HostPort { host: string; port: number }
export interface Endpoint {
  url: URL;
  /** Null connects directly. */
  socks: HostPort | null;
}

/** No byte in either direction for this long fails the request: a proxy or node that hangs rather than refusing. */
const idleTimeoutMs = 30_000;

const statusKinds: Readonly<Record<number, ErrorKind>> = { 400: "invalid", 413: "invalid", 403: "refused", 415: "refused", 404: "not-found", 409: "conflict" };

async function open(endpoint: Endpoint): Promise<Socket> {
  const secure = endpoint.url.protocol === "https:";
  const target: HostPort = { host: endpoint.url.hostname, port: Number(endpoint.url.port || (secure ? 443 : 80)) };
  const raw = await (endpoint.socks === null ? direct(target) : tunnel(endpoint.socks, target));
  const socket = secure ? await handshake(raw, target.host) : raw;
  // Once connected, a silence is the API's, such as a command queued behind a slow one in its pylon, not the proxy's.
  raw.removeAllListeners("timeout");
  return withIdleTimeout(socket, `the control plane at ${endpoint.url.host}`);
}

/** The raw socket's idle timeout still covers a handshake that hangs. */
function handshake(raw: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // `host` is what the certificate must name. SNI takes only a name, never an IP address.
    const socket = tlsConnect({ socket: raw, host, ...isIP(host) === 0 ? { servername: host } : {} });
    const fail = (err: Error) => {
      raw.destroy();
      reject(err instanceof CliError ? err : new CliError("unreachable", `the TLS handshake with ${host} failed: ${err.message}`));
    };
    socket.once("error", fail);
    raw.once("error", fail);
    socket.once("secureConnect", () => {
      socket.off("error", fail);
      raw.off("error", fail);
      resolve(socket);
    });
  });
}

/**
 * Sends JSON as the API requires and returns its JSON reply, or null for an empty one. A request the API answers
 * only once its work is done, such as a session open that waits for its agent, passes a longer `idleMs`.
 */
export async function call(endpoint: Endpoint, method: string, path: string, body?: unknown, idleMs = idleTimeoutMs): Promise<unknown> {
  // Only a GET shares a connection. An error on a reused one may hide a request that ran, and only a GET may run twice.
  const via = method === "GET" ? pool(endpoint) : await open(endpoint);
  const { status, text } = await exchange(via, endpoint.url.host, method, path, body, idleMs);
  return reply(method, path, status, text);
}

/** The API's server closes a connection idle for Node's default 5 s, so the pool lets go of one before that. */
const pooledMs = 4_000;
const pools = new WeakMap<Endpoint, Agent>();

/** One keep-alive connection for the GETs of a process, so a poll every second or two costs no tunnel or handshake. */
function pool(endpoint: Endpoint): Agent {
  let agent = pools.get(endpoint);
  if (agent === undefined) {
    // The agent unrefs an idle socket, so the CLI still exits once its command is done.
    agent = new Agent({ keepAlive: true, timeout: pooledMs });
    agent.createConnection = (_options, done) => {
      open(endpoint).then((socket) => done?.(null, socket), (err: Error) => done?.(err, null as never));
      return undefined;
    };
    pools.set(endpoint, agent);
  }
  return agent;
}

function reply(method: string, path: string, status: number, text: string): unknown {
  let parsed: unknown = null;
  try {
    if (text !== "") parsed = JSON.parse(text);
  } catch {
    throw new CliError("failed", `${method} ${path} answered ${status} with a body that is not JSON`, status);
  }
  if (status >= 200 && status < 300) return parsed;
  const { error: message, code } = (parsed ?? {}) as { error?: unknown; code?: unknown };
  throw new CliError(statusKinds[status] ?? "failed", typeof message === "string" ? message : `${method} ${path} failed with ${status}`, status, typeof code === "string" ? code : null);
}

/**
 * Follows a server-sent event stream, handing `onEvent` each event's data as JSON. Resolves when the API ends the
 * stream or `signal` aborts it, and rejects as `call` does when the API refuses it or the connection fails. The
 * API pings a quiet stream, so the idle timeout still catches a link that hangs.
 */
export async function follow(endpoint: Endpoint, path: string, onEvent: (data: unknown) => void | Promise<void>, signal: AbortSignal, onCursor?: (id: string) => void): Promise<void> {
  const socket = await open(endpoint);
  const host = endpoint.url.host;
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    let transportFailure: Error | undefined;
    const failed = (err: Error) => signal.aborted ? resolve() : reject(err instanceof CliError ? err : lost(host, err));
    const req = request({ method: "GET", path, createConnection: () => socket, signal, headers: { host, accept: "text/event-stream" } }, (res) => {
      responseStarted = true;
      res.setEncoding("utf8");
      const read = async () => {
        if (res.statusCode !== 200) {
          let text = "";
          for await (const chunk of res) text += chunk;
          reply("GET", path, res.statusCode!, text);
          throw new CliError("failed", `GET ${path} answered ${res.statusCode} rather than a stream`, res.statusCode!);
        }
        let pending = "";
        let data: string[] = [];
        let cursor: string | undefined;
        for await (const chunk of res) {
          const lines = (pending + chunk).split("\n");
          pending = lines.pop()!;
          for (const line of lines.map((l) => l.replace(/\r$/, ""))) {
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            if (line.startsWith("id:")) cursor = line.slice(3).replace(/^ /, "");
            if (line !== "") continue;
            if (data.length > 0) {
              let event: unknown;
              try { event = JSON.parse(data.join("\n")); }
              catch { throw new CliError("failed", `GET ${path} sent an event that is not JSON`); }
              data = [];
              // Waiting for the consumer is not an idle network. Async iteration bounds the unread response.
              socket.setTimeout(0);
              try { await onEvent(event); } finally { if (!signal.aborted && !socket.destroyed) socket.setTimeout(idleTimeoutMs); }
            }
            if (cursor !== undefined) onCursor?.(cursor);
            cursor = undefined;
          }
        }
      };
      void read().then(() => transportFailure === undefined ? resolve() : failed(transportFailure), (err: Error) => { res.destroy(); failed(err); });
    });
    req.on("error", (err: Error) => {
      // Do not reconnect around an outstanding consumer write when the network drops under backpressure.
      if (responseStarted) transportFailure = err;
      else failed(err);
    });
    req.end();
  });
}

/**
 * Opens a WebSocket to the API over the same direct or SOCKS connection as `call`, paused until the caller resumes
 * it. A refused handshake rejects as `call` does. A 404 that names no route is a control plane older than the route.
 * The server's pings keep the idle timeout from firing, so a link that hangs still fails, and the socket's own
 * error, such as that timeout, is what the WebSocket's `error` event carries.
 */
export async function upgrade(endpoint: Endpoint, path: string): Promise<WebSocket> {
  const socket = await open(endpoint);
  const host = endpoint.url.host;
  let failure: Error | null = null;
  socket.on("error", (err) => { failure ??= err; });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${endpoint.url.protocol === "https:" ? "wss" : "ws"}://${host}${path}`, { createConnection: () => socket, perMessageDeflate: false });
    // ws reports a failed handshake as its own error, and the socket's, kept above, says why.
    const failed = (err: Error) => reject(lost(host, failure ?? err));
    ws.on("error", failed);
    ws.once("unexpected-response", (_req, res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("error", failed);
      res.on("end", () => {
        socket.destroy();
        try {
          reply("GET", path, res.statusCode!, text);
          reject(new CliError("failed", `GET ${path} answered ${res.statusCode} rather than a WebSocket`, res.statusCode!));
        } catch (err) {
          reject(isMissingRoute(err)
            ? new CliError("failed", `the control plane at ${host} has no attach route. Upgrade it, as deploy/README.md describes`, 404)
            : err);
        }
      });
    });
    ws.once("open", () => {
      ws.off("error", failed);
      // Until the caller listens, so a message that came with the 101 waits for it. The caller resumes it.
      ws.pause();
      // ws turns the socket's timeout off once the handshake is done.
      socket.setTimeout(idleTimeoutMs);
      socket.on("error", (err) => ws.emit("error", lost(host, err)));
      resolve(ws);
    });
  });
}

/** Through the pool, or on a connection of its own. */
function exchange(via: Agent | Socket, host: string, method: string, path: string, body: unknown, idleMs: number, retried = false): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = request({
      method, path, ...via instanceof Agent ? { agent: via } : { createConnection: () => via },
      // The API refuses a state change without a JSON content type, so a browser page cannot forge one. Node frames a
      // DELETE's body only with an explicit length, and without one the API reads it as a malformed next request.
      headers: {
        host, ...(method === "GET" ? {} : { "content-type": "application/json" }),
        ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
      },
    }, (res) => {
      answered = true;
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, text }));
      res.on("error", (err) => reject(lost(host, err)));
    });
    // A reused socket holds the last request's timeout, or the pool's.
    req.once("socket", (socket) => socket.setTimeout(idleMs));
    req.on("error", (err) => {
      // The server closed the pooled connection as the request went out. A silence is the API's, and is not tried again.
      if (req.reusedSocket && !answered && !retried && !(err instanceof CliError)) resolve(exchange(via, host, method, path, body, idleMs, true));
      else reject(lost(host, err));
    });
    req.end(payload);
  });
}

const lost = (host: string, err: Error) => err instanceof CliError ? err : new CliError("unreachable", `the connection to ${host} failed: ${reason(err)}`);
/** A name with both an IPv6 and an IPv4 address fails with one error per address and no message of its own. */
const reason = (err: Error) => err instanceof AggregateError ? err.errors.map((e: Error) => e.message).join(", ") : err.message;

function withIdleTimeout(socket: Socket, what: string, ms = idleTimeoutMs): Socket {
  socket.setTimeout(ms, () => socket.destroy(new CliError("unreachable", `${what} sent nothing for ${socket.timeout! / 1000}s`)));
  return socket;
}

function direct(target: HostPort): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = withIdleTimeout(connect(target.port, target.host), `${target.host}:${target.port}`);
    socket.once("error", (err) => reject(err instanceof CliError ? err : new CliError("unreachable", `cannot reach ${target.host}:${target.port}: ${reason(err)}`)));
    socket.once("connect", () => resolve(socket));
  });
}

const replies: Readonly<Record<number, string>> = {
  1: "general failure", 2: "connection not allowed", 3: "network unreachable", 4: "host unreachable",
  5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported",
};
/** The length of a CONNECT reply's bound address, by address type, once its first five bytes are in. */
const boundLength = (reply: Buffer): number | undefined => ({ 1: 4, 3: 1 + reply[4]!, 4: 16 } as Record<number, number>)[reply[3]!];

/** RFC 1928 without authentication, which ts-home's proxy does not ask for. */
function tunnel(proxy: HostPort, target: HostPort): Promise<Socket> {
  const where = `the SOCKS proxy at ${proxy.host}:${proxy.port}`;
  const name = Buffer.from(target.host);
  if (name.length > 255) return Promise.reject(new CliError("invalid", `the host name ${target.host} is too long for SOCKS5`));
  return new Promise((resolve, reject) => {
    const socket = withIdleTimeout(connect(proxy.port, proxy.host), where);
    let received = Buffer.alloc(0);
    let greeted = false;
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    const onError = (err: NodeJS.ErrnoException) => fail(err instanceof CliError ? err
      : err.code === "ECONNREFUSED" ? new CliError("unreachable", `nothing is listening on ${where}. It is ts-home's userspace tailscaled, the only way this Mac reaches the home tailnet. Check it with \`ts-home status\``)
      : new CliError("unreachable", `cannot reach ${where}: ${reason(err)}`));
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (!greeted) {
        if (received.length < 2) return;
        if (received[0] !== 5 || received[1] !== 0) return fail(new CliError("unreachable", `${where} does not accept a client without authentication`));
        greeted = true;
        received = received.subarray(2);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([target.port >> 8, target.port & 0xff])]));
      }
      if (received.length < 5) return;
      if (received[1] !== 0) {
        return fail(new CliError("unreachable", `${where} could not reach ${target.host}:${target.port}: ${replies[received[1]!] ?? `reply ${received[1]}`}. The node may be offline or its control plane down. \`ts-home status\` shows whether the node is online`));
      }
      const length = boundLength(received);
      if (length === undefined) return fail(new CliError("unreachable", `${where} sent a reply with unknown address type ${received[3]}`));
      if (received.length < 6 + length) return;
      // The API speaks only after the request, so nothing may follow the reply. HTTP reads the socket from here.
      if (received.length > 6 + length) return fail(new CliError("unreachable", `${where} sent bytes after its reply`));
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      resolve(socket);
    };
    // After an error too, which has already rejected.
    const onClose = () => fail(new CliError("unreachable", `${where} closed the connection ${greeted ? "before answering the CONNECT" : "before answering the greeting"}`));
    socket.on("error", onError);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
  });
}
