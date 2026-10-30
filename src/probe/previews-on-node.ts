/**
 * Node validation for previews, run by hand on a home-lab node: `node src/probe/previews-on-node.ts [holdSeconds]`.
 * It publishes two previews of one pretend pylon through the real `tailscale serve` and the gateway, to a dummy
 * origin that echoes what it received. It holds after each step so a Mac can curl the URLs, then removes one
 * preview, then both, and checks that the serve config ends as it began. It refuses ports something else serves.
 */
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { PylonId } from "../ids.ts";
import { startGateway } from "./gateway.ts";
import { createTailscaleServe, parseServeStatus, tailscaleCli } from "./serve.ts";

const gatewayPort = 18091;
const pylonId = "pylon-nodecheck" as PylonId;
const web = { service: "web", httpsPort: 10101 };
const api = { service: "api", httpsPort: 10102 };
const holdMs = Number(process.argv[2] ?? 90) * 1000;
const signal = AbortSignal.timeout(10 * 60_000);
const cli = tailscaleCli();

const before = await cli(["serve", "status", "--json"], signal);
console.log(`serve status before:\n${before}`);
for (const [port] of parseServeStatus(before, `http://127.0.0.1:${gatewayPort}`)) {
  if (port === web.httpsPort || port === api.httpsPort) throw new Error(`port ${port} is already served. Free it or pick other ports`);
}

const origin = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: req.url, host: req.headers.host, ...forwarded(req) }));
});
origin.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: ${req.headers.upgrade}\r\nsec-websocket-accept: unchecked\r\n\r\n`);
  socket.end(`upgraded ${req.headers.host}\n`);
});
await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
const originPort = (origin.address() as { port: number }).port;

const gateway = await startGateway({
  port: gatewayPort,
  routes: new Map(),
  origin: () => `http://127.0.0.1:${originPort}`,
  onHit: (hit) => console.log(`hit ${JSON.stringify(hit)}`),
});
const serve = createTailscaleServe({ cli, gateway, routesFile: join(await mkdtemp(join(tmpdir(), "nexus-previews-")), "routes.json") });

async function step(name: string, previews: typeof web[]) {
  const started = performance.now();
  await serve.converge(pylonId, previews, signal);
  console.log(`${name}: converged and warmed in ${Math.round(performance.now() - started)} ms`);
  console.log(await cli(["serve", "status", "--json"], signal));
  if (holdMs > 0) {
    console.log(`holding ${holdMs / 1000} s for curls from the Mac`);
    await delay(holdMs);
  }
}

try {
  await step("publish web and api", [web, api]);
  await step("again, which must change nothing", [web, api]);
  await step("drop api", [web]);
  await step("drop all", []);
} finally {
  await gateway.close();
  origin.close();
}
const after = await cli(["serve", "status", "--json"], signal);
console.log(after === before ? "serve status is back to how it began" : `serve status differs from the start:\n${after}`);

function forwarded(req: IncomingMessage) {
  const pick = (name: string) => req.headers[name] ?? null;
  return { proto: pick("x-forwarded-proto"), forwardedHost: pick("x-forwarded-host"), port: pick("x-forwarded-port"), login: pick("tailscale-user-login") !== null };
}
