/**
 * How the Mac CLI reaches the control plane's API. This Mac joins the home tailnet only through ts-home's
 * userspace tailscaled, which offers a SOCKS5 proxy and no routes, so each request opens a SOCKS5 CONNECT
 * tunnel to the API and speaks HTTP over it. The proxy resolves the name, as curl's --socks5-hostname does,
 * because only it knows MagicDNS. Without a proxy the CLI connects directly, as on a machine on the tailnet.
 */
import { request } from "node:http";
import { connect, type Socket } from "node:net";

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
  constructor(kind: ErrorKind, message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface HostPort { host: string; port: number }
export interface Endpoint {
  url: URL;
  /** Null connects directly. */
  socks: HostPort | null;
}

/** No byte in either direction for this long fails the request: a proxy or node that hangs rather than refusing. */
const idleTimeoutMs = 30_000;

const statusKinds: Readonly<Record<number, ErrorKind>> = { 400: "invalid", 413: "invalid", 403: "refused", 415: "refused", 404: "not-found", 409: "conflict" };

/** Sends JSON as the API requires and returns its JSON reply, or null for an empty one. */
export async function call(endpoint: Endpoint, method: string, path: string, body?: unknown): Promise<unknown> {
  const target: HostPort = { host: endpoint.url.hostname, port: Number(endpoint.url.port || 80) };
  const socket = endpoint.socks === null ? await direct(target) : await tunnel(endpoint.socks, target);
  const { status, text } = await exchange(socket, endpoint.url.host, method, path, body);
  let reply: unknown = null;
  try {
    if (text !== "") reply = JSON.parse(text);
  } catch {
    throw new CliError("failed", `${method} ${path} answered ${status} with a body that is not JSON`, status);
  }
  if (status >= 200 && status < 300) return reply;
  const message = (reply as { error?: unknown } | null)?.error;
  throw new CliError(statusKinds[status] ?? "failed", typeof message === "string" ? message : `${method} ${path} failed with ${status}`, status);
}

function exchange(socket: Socket, host: string, method: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      method, path, createConnection: () => socket,
      // The API refuses a state change without a JSON content type, so a browser page cannot forge one.
      headers: { host, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, text }));
      res.on("error", (err) => reject(lost(host, err)));
    });
    req.on("error", (err) => reject(lost(host, err)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const lost = (host: string, err: Error) => err instanceof CliError ? err : new CliError("unreachable", `the connection to ${host} failed: ${reason(err)}`);
/** A name with both an IPv6 and an IPv4 address fails with one error per address and no message of its own. */
const reason = (err: Error) => err instanceof AggregateError ? err.errors.map((e: Error) => e.message).join(", ") : err.message;

function withIdleTimeout(socket: Socket, what: string): Socket {
  socket.setTimeout(idleTimeoutMs, () => socket.destroy(new CliError("unreachable", `${what} sent nothing for ${idleTimeoutMs / 1000}s`)));
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
