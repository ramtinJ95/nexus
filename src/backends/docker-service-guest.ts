/**
 * The Docker test double's ServiceGuest (src/pylon-vm/guest.ts), so a container runs the pylon VM's services supervisor
 * and relay. Commands run as root through `docker exec`. The ingress stands in for Gondolin's: a host HTTP server on
 * 127.0.0.1 that sends each request to the port of its longest matching route on the container's 127.0.0.1, with the
 * headers Gondolin's sets, over one `docker exec` of a socket pipe per request, so the container publishes no port.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { Duplex } from "node:stream";
import { docker, dockerExec } from "./docker-cli.ts";
import type { ServiceGuest } from "../pylon-vm/guest.ts";

type Route = { prefix: string; port: number; stripPrefix: boolean };

/** argv: a port. Carries stdin to 127.0.0.1:<port>, and what that port answers to stdout. */
const pipeScript = [
  "import os,socket,sys,threading",
  "s=socket.create_connection(('127.0.0.1',int(sys.argv[1])))",
  "def up():",
  " while d:=os.read(0,65536): s.sendall(d)",
  " s.shutdown(socket.SHUT_WR)",
  "threading.Thread(target=up,daemon=True).start()",
  "while d:=s.recv(65536): os.write(1,d)",
].join("\n");

export function dockerServiceGuest(container: string): ServiceGuest & { close(): Promise<void> } {
  let routes: Route[] = [];
  const open = new Set<Duplex>();
  let server: Promise<{ server: http.Server; url: URL }> | undefined;

  function pipe(port: number): Duplex {
    const child = spawn("docker", ["exec", "--interactive", container, "python3", "-c", pipeScript, String(port)], { stdio: ["pipe", "pipe", "ignore"] });
    const socket = new Duplex({
      read: () => void child.stdout.resume(),
      write: (chunk, _encoding, done) => void child.stdin.write(chunk, done),
      final: (done) => void child.stdin.end(done),
      destroy(err, done) {
        open.delete(socket);
        child.kill();
        done(err);
      },
    });
    child.stdout.on("data", (data: Buffer) => { if (!socket.push(data)) child.stdout.pause(); }).on("end", () => socket.push(null));
    child.stdin.on("error", (err) => socket.destroy(err));
    child.on("close", () => socket.destroy());
    open.add(socket);
    return socket;
  }

  /** The route and the path it sends, as Gondolin's ingress picks and strips them, null for no route, or "invalid" for a target that is no URL path. */
  function routed(target: string): { route: Route; path: string } | null | "invalid" {
    if (!URL.canParse(target, "http://ingress")) return "invalid";
    const url = new URL(target, "http://ingress");
    const matches = (prefix: string) => prefix === "/" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
    const route = routes.filter((r) => matches(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (route === undefined) return null;
    const rest = route.stripPrefix && route.prefix !== "/" ? url.pathname.slice(route.prefix.length) || "/" : url.pathname;
    return { route, path: rest + url.search };
  }

  function headers(incoming: http.IncomingMessage, route: Route, upgrade: boolean): http.OutgoingHttpHeaders {
    const host = incoming.headers.host ?? "localhost";
    const client = incoming.socket.remoteAddress;
    const prior = incoming.headers["x-forwarded-for"];
    return {
      ...incoming.headers,
      ...(upgrade ? {} : { connection: "close" }),
      ...(client === undefined ? {} : { "x-forwarded-for": prior ? `${prior}, ${client}` : client }),
      "x-forwarded-host": host,
      "x-forwarded-proto": "http",
      ...(route.stripPrefix && route.prefix !== "/" ? { "x-forwarded-prefix": route.prefix } : {}),
    };
  }

  async function listen(): Promise<{ server: http.Server; url: URL }> {
    const server = http.createServer((incoming, response) => {
      const found = routed(incoming.url ?? "/");
      if (found === "invalid") return void response.writeHead(400).end("invalid request target\n");
      if (found === null) return void response.writeHead(404).end("no route\n");
      const upstream = http.request({ method: incoming.method, path: found.path, headers: headers(incoming, found.route, false), createConnection: () => pipe(found.route.port) }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("bad gateway\n");
      });
      response.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    });
    server.on("upgrade", (incoming: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const found = routed(incoming.url ?? "/");
      if (found === "invalid") return void socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      if (found === null) return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      const backend = pipe(found.route.port);
      const lines = Object.entries(headers(incoming, found.route, true)).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      backend.write(`${incoming.method} ${found.path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) backend.write(head);
      socket.pipe(backend).pipe(socket);
      socket.on("error", () => backend.destroy()).on("close", () => backend.destroy());
      backend.on("error", () => socket.destroy()).on("close", () => socket.destroy());
    });
    await new Promise<void>((accept, reject) => server.once("error", reject).listen(0, "127.0.0.1", accept));
    return { server, url: new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}`) };
  }

  return {
    async execute(cmd, timeoutMs) {
      const { exitCode, output } = await dockerExec(container, ["sh", "-lc", cmd], { timeoutMs });
      if (exitCode === null) throw new Error(`Guest command timed out after ${timeoutMs} ms in ${container}`);
      return { exitCode, output };
    },
    async stamp(path) {
      const { exitCode, output } = await dockerExec(container, ["stat", "-L", "-c", "%s %i %y", path]);
      if (exitCode === 0) return output.trim();
      if (output.includes("No such file or directory")) return null;
      throw new Error(`${path} could not be read: ${output.trim()}`);
    },
    async readFile(path) {
      const { exitCode, output } = await dockerExec(container, ["sh", "-c", 'test -e "$1" || exit 3; exec cat -- "$1"', "sh", path]);
      if (exitCode === 3) return null;
      if (exitCode !== 0) throw new Error(`reading ${path} in ${container} exited ${exitCode}: ${output.trim()}`);
      return Buffer.from(output);
    },
    async writeFile(path, content) {
      await docker(["exec", "--interactive", container, "sh", "-c", 'cat > "$1"', "sh", path], { input: content });
    },
    async ingress() {
      server ??= listen().catch((err: unknown) => { server = undefined; throw err; });
      return (await server).url;
    },
    setIngressRoutes(set) {
      routes = set.map((route) => ({ ...route, prefix: route.prefix.length > 1 && route.prefix.endsWith("/") ? route.prefix.slice(0, -1) : route.prefix }));
    },
    async close() {
      for (const socket of open) socket.destroy();
      const listening = await server?.catch(() => undefined);
      server = undefined;
      if (listening !== undefined) await new Promise<void>((accept) => listening.server.close(() => accept()));
    },
  };
}
