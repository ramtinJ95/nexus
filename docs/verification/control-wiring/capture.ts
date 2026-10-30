// Starts the checkout's control plane as main.ts wires it, on loopback, with a fake tailscaled and the real probe
// client pointed at a loopback stand-in for each node's probe. Writes what the API answers a node-health read when the
// probe refuses the control plane and when it is down, an expired event cursor and an event read whose table is gone,
// the deployer report and whoami answers that the tailnet ID lookup decides, and how many peer lists reach a probe
// across snapshots of one probe boot and then another.
// Run from the root of a checkout: node docs/verification/control-wiring/capture.ts <out-file>
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { connectProbe } = await import("../../../src/protocol.ts");
const { parseConfig, startControlPlane } = await import("../../../src/control/main.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { scriptedModel, scriptedModels } = await import("../../../src/harness/test-fixture.ts");
const { call } = await import("../../../src/test-kit.ts");
const { tokenDigest } = await import("../../../src/deploy/model.ts");
type NodeName = import("../../../src/protocol.ts").NodeName;
type TailnetNodeId = import("../../../src/protocol.ts").TailnetNodeId;

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => { lines.push(line); console.log(line); };
const dir = await mkdtemp(join(tmpdir(), "nexus-control-wiring-"));
const socket = join(dir, "tailscaled.sock");
let caller = "nLaptopCNTRL";
const tailscaled = createServer((_req, res) => res.end(JSON.stringify({ Node: { StableID: caller, Name: "laptop.example.ts.net." } })));
// Appending 10,002 events takes longer than Node's 5 s keep-alive, which would reset the API's kept whois connection.
tailscaled.keepAliveTimeout = 60_000;
await new Promise<void>((ready) => tailscaled.listen(socket, ready));

/** rj-firebat's probe: it streams the snapshots the capture sends, counts peer puts, and refuses the node-health read. */
const peerPuts: string[] = [];
let observer: ServerResponse | undefined;
const firebat = createServer((req, res) => {
  const body: Buffer[] = [];
  req.on("data", (chunk: Buffer) => body.push(chunk)).on("end", () => {
    if (req.url === "/v1/observe") { observer = res.writeHead(200, { "content-type": "application/x-ndjson" }); return; }
    if (req.method === "PUT" && req.url === "/v1/peers") { peerPuts.push(Buffer.concat(body).toString()); return void res.writeHead(204).end(); }
    if (req.url === "/v1/node-health") return void res.writeHead(403).end("not you");
    res.writeHead(404).end();
  });
});
firebat.listen(0, "127.0.0.1");
await new Promise<void>((ready) => firebat.once("listening", ready));
const firebatPort = (firebat.address() as AddressInfo).port;
const down = createServer();
down.listen(0, "127.0.0.1");
await new Promise<void>((ready) => down.once("listening", ready));
const downPort = (down.address() as AddressInfo).port;
await new Promise<void>((closed) => down.close(() => closed()));

const example = JSON.parse(await readFile("deploy/control.example.json", "utf8"));
delete example.https;
const db = join(dir, "registry.db");
const plane = await startControlPlane(parseConfig(JSON.stringify({
  ...example, db, tailscaledSocket: socket,
  deployers: ["nLaptopCNTRL"],
  deployKeys: { nControlPlaneCNTRL: tokenDigest("firebat-token"), nPeerProbeCNTRL: tokenDigest("bench-token") },
  listen: { host: "127.0.0.1", port: 0, hostnames: ["127.0.0.1"] },
  harness: { storage: join(dir, "harness.sqlite"), credentials: join(dir, "harness-credentials.json"), model: scriptedModel },
})), scriptedModels(), undefined, (node) => connectProbe(node.name, "127.0.0.1", node.tailnetNodeId, {
  port: node.name === "rj-firebat" ? firebatPort : downPort, whois: async () => node.tailnetNodeId,
}));
const api = async (as: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  caller = as;
  const reply = await call({ host: "127.0.0.1", port: plane.port, method, path, body, headers });
  return `${reply.status} ${JSON.stringify(reply.body)}`;
};
const settle = () => new Promise((done) => setTimeout(done, 300));

log(`health of rj-firebat, whose probe answers 403: ${await api("nLaptopCNTRL", "GET", "/v1/nodes/rj-firebat/health")}`);
log(`health of infra-testbench, whose probe is down: ${(await api("nLaptopCNTRL", "GET", "/v1/nodes/infra-testbench/health")).replace(/127\.0\.0\.1:\d+/, "127.0.0.1:<port>")}`);

const report = { role: "probe", commit: null, target: null, state: "pending", reason: null };
log(`infra-testbench reports with its own key: ${await api("nPeerProbeCNTRL", "POST", "/v1/deployer/report", report, { authorization: "Bearer bench-token" })}`);
log(`infra-testbench reports with rj-firebat's key: ${await api("nPeerProbeCNTRL", "POST", "/v1/deployer/report", report, { authorization: "Bearer firebat-token" })}`);
for (const id of ["nLaptopCNTRL", "nControlPlaneCNTRL", "nPeerProbeCNTRL"]) log(`whoami as ${id}: ${await api(id, "GET", "/v1/whoami")}`);

while (observer === undefined) await settle();
const snapshot = (probeBootId: string) => JSON.stringify({ type: "snapshot", observation: {
  events: [], node: "rj-firebat", observedAt: new Date().toISOString(), probeBootId, capacity: null, artifacts: [], jobs: [], pylons: [],
  previewRoutes: [], grants: { secrets: [], gitSsh: false }, heldSecrets: [],
} });
await settle();
const before = peerPuts.length;
for (const boot of ["boot-1", "boot-1", "boot-1", "boot-2"]) {
  observer.write(`${snapshot(boot)}\n`);
  await settle();
  log(`after a snapshot of ${boot}, peer puts to rj-firebat: ${peerPuts.length - before}`);
}

const registry = openRegistry(db);
for (let i = 0; i < 10_002; i++) registry.appendEvent("release.changed", null, {});
registry.close();
log(`events since an expired cursor: ${await api("nLaptopCNTRL", "GET", "/v1/events?since=1")}`);
const raw = new DatabaseSync(db);
raw.exec("DROP TABLE events");
raw.close();
log(`events with the events table gone: ${await api("nLaptopCNTRL", "GET", "/v1/events?since=0")}`);

await plane.close();
observer.end();
await new Promise<void>((closed) => firebat.close(() => closed()));
await new Promise<void>((closed) => tailscaled.close(() => closed()));
await rm(dir, { recursive: true, force: true });
await writeFile(out, `${lines.join("\n")}\n`);
