/**
 * Counts the pylon lists a probe makes for a command and a stream to one pylon, for listening polls while an observer
 * is connected, and the snapshots it publishes when five pauses finish together. A real probe (startProbe) over a real
 * pylon-vm backend (createPylonVmBackend), as src/probe/main.ts wires them. No VM boots: each pylon is the files
 * pylon-vm leaves for a stopped instance, and a pause of a stopped pylon changes nothing.
 *
 *   node docs/verification/probe-state/count.ts > docs/verification/probe-state/<side>.txt
 */
import fsp from "node:fs/promises";
import { connect } from "node:net";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPylonVmBackend } from "../../../src/pylon-vm-backend.ts";
import { startProbe } from "../../../src/probe/server.ts";
import { nodeSecrets } from "../../../src/probe/config.ts";
import { envelope } from "../../../src/reconcile.ts";
import { connectProbe, type NodeName, type PylonId, type TailnetNodeId } from "../../../src/protocol.ts";

const pylons = 10;
const pollMs = 50;
const pollWindowMs = 1_000;

const root = await mkdtemp("/tmp/nexus-pst-");
const stateRoot = join(root, "state");
const instances = join(stateRoot, "instances");
const artifacts = join(root, "artifacts");
const image = "img-count0000000";
await mkdir(join(artifacts, image), { recursive: true });
await writeFile(join(artifacts, image, "manifest.json"), "{}");
await writeFile(join(artifacts, image, "image.json"), "{}");
await mkdir(instances, { recursive: true, mode: 0o700 });
const ids = Array.from({ length: pylons }, (_, i) => `pylon-count-${i}` as PylonId);
for (const pylonId of ids) {
  const dir = join(instances, pylonId);
  await mkdir(dir, { mode: 0o700 });
  const config = { version: 1, diskGiB: 8, image: join(artifacts, image), workspace: "/home/user/workspace", setup: [], resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: pylonId, config, createdAt: "2026-10-30T00:00:00Z", labels: { "nexus.image": image } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: pylonId, state: "stopped" }));
  await writeFile(join(dir, "nexus-checkpoint.json"), JSON.stringify({ checkpoint: `ckpt-${pylonId}-1` }));
}

let lists = 0;
const { readdir } = fsp;
fsp.readdir = ((path: string, ...rest: never[]) => {
  if (String(path) === instances) lists++;
  return readdir(path, ...rest);
}) as typeof readdir;
syncBuiltinESMExports();

const node = "count-node" as NodeName;
const controlPlane = "nCONTROL" as TailnetNodeId;
const probe = await startProbe({
  node, host: "127.0.0.1", port: 0,
  auth: { controlPlane, peers: [] },
  whois: async () => controlPlane,
  backend: createPylonVmBackend({ stateRoot, artifacts, secrets: { value: () => undefined, names: () => [] } }),
  secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
  log: () => {},
  listeningPollMs: pollMs,
});
const client = connectProbe(node, "127.0.0.1", "nPROBE" as TailnetNodeId, { port: probe.port, whois: async () => "nPROBE" as TailnetNodeId });
const [target] = ids as [PylonId];
const row = (what: string, value: string) => console.log(`${what.padEnd(52)} ${value}`);

lists = 0;
const refused = await client.command(target, { kind: "exec", argv: ["true"], cwd: "/", timeoutMs: 1000 }).then(() => "ran", (err: Error & { code?: string }) => err.code);
row(`POST /v1/pylons/${target}/commands (${refused})`, `${lists} lists`);

lists = 0;
const socket = connect(probe.port, "127.0.0.1");
socket.write(`GET /v1/pylons/${target}/stream?request=${encodeURIComponent(JSON.stringify({ argv: ["true"] }))} HTTP/1.1\r\nhost: probe\r\nconnection: upgrade\r\nupgrade: nexus-stream\r\n\r\n`);
const [head] = await once(socket, "data") as [Buffer];
socket.destroy();
row(`stream upgrade to ${target} (${head.toString().split("\r\n")[0]})`, `${lists} lists`);

const stop = new AbortController();
const events = client.observe(stop.signal)[Symbol.asyncIterator]();
await events.next();
let snapshots = 0;
const counting = (async () => {
  for (let e = await events.next(); !e.done; e = await events.next()) if (e.value.type === "snapshot") snapshots++;
})().catch(() => undefined);
lists = 0;
await new Promise((resolve) => setTimeout(resolve, pollWindowMs));
row(`${pollWindowMs} ms of ${pollMs} ms listening polls, one observer`, `${lists} lists`);

lists = 0;
snapshots = 0;
const pauses = ids.slice(0, 5).map((pylonId) => envelope({ kind: "pause", pylonId, checkpoint: `ckpt-${pylonId}-1` }, node, Date.now()));
await Promise.all(pauses.map((env) => client.submit(env)));
for (const env of pauses) {
  for (let status = await client.job(env.jobId); status === "unknown" || status.state === "running"; status = await client.job(env.jobId)) await new Promise((resolve) => setTimeout(resolve, 5));
}
await new Promise((resolve) => setTimeout(resolve, pollWindowMs));
row("five pauses submitted together", `${snapshots} snapshots, ${lists} lists`);

stop.abort();
await counting;
await probe.close();
await rm(root, { recursive: true, force: true });
process.exit(0);
