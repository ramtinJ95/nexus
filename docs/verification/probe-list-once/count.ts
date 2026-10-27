/**
 * Counts what one probe snapshot and one peer artifact fetch cost a pylon-vm backend: its instance lists (the
 * sandbox list RPC, one readdir of <stateRoot>/instances) and the per-instance sidecar and record reads.
 * A real probe (startProbe) over a real pylon-vm backend (createPylonVmBackend), as src/probe/main.ts wires them.
 * No VM boots: each pylon is the files pylon-vm leaves for a stopped instance.
 *
 *   node docs/verification/probe-list-once/count.ts > docs/verification/probe-list-once/<side>.txt
 */
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPylonVmBackend } from "../../../src/pylon-vm-backend.ts";
import { startProbe } from "../../../src/probe/server.ts";
import { nodeSecrets } from "../../../src/probe/config.ts";
import { connectProbe, type NodeName, type NodeObservation, type TailnetNodeId } from "../../../src/protocol.ts";

const stopped = 8;
const neverPaused = 2;
const rounds = 5;

const root = await mkdtemp("/tmp/nexus-plo-");
const stateRoot = join(root, "state");
const instances = join(stateRoot, "instances");
const artifacts = join(root, "artifacts");
const image = "img-count0000000";
await mkdir(join(artifacts, image), { recursive: true });
await writeFile(join(artifacts, image, "manifest.json"), "{}");
await writeFile(join(artifacts, image, "image.json"), "{}");
await mkdir(instances, { recursive: true, mode: 0o700 });
for (let i = 0; i < stopped + neverPaused; i++) {
  const pylonId = `pylon-count-${i}`;
  const dir = join(instances, pylonId);
  await mkdir(dir, { mode: 0o700 });
  const config = { version: 1, diskGiB: 8, image: join(artifacts, image), workspace: "/home/user/workspace", setup: [], resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: pylonId, config, createdAt: "2026-10-27T00:00:00Z", labels: { "nexus.image": image } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: pylonId, state: "stopped" }));
  if (i < stopped) await writeFile(join(dir, "nexus-checkpoint.json"), JSON.stringify({ checkpoint: `ckpt-count-${i}` }));
}

const counts = { lists: 0, sidecars: 0, records: 0 };
const { readdir, readFile } = fsp;
fsp.readdir = ((path: string, ...rest: never[]) => {
  if (String(path) === instances) counts.lists++;
  return readdir(path, ...rest);
}) as typeof readdir;
fsp.readFile = ((path: string, ...rest: never[]) => {
  const p = String(path);
  if (p.startsWith(instances) && p.endsWith("/nexus-checkpoint.json")) counts.sidecars++;
  if (p.startsWith(instances) && p.endsWith("/record.json")) counts.records++;
  return readFile(path, ...rest);
}) as typeof readFile;
syncBuiltinESMExports();

const controlPlane = "nCONTROL" as TailnetNodeId;
const peer = "nPEER" as TailnetNodeId;
let caller = controlPlane;
const probe = await startProbe({
  node: "count-node" as NodeName, host: "127.0.0.1", port: 0,
  auth: { controlPlane, peers: [peer] },
  whois: async () => caller,
  backend: createPylonVmBackend({ stateRoot, artifacts, secrets: { value: () => undefined, names: () => [] } }),
  secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
  log: () => {},
});
const client = connectProbe("count-node" as NodeName, "127.0.0.1", "nPROBE" as TailnetNodeId, { port: probe.port, whois: async () => "nPROBE" as TailnetNodeId });

async function snapshot(): Promise<NodeObservation> {
  const stop = new AbortController();
  try {
    for await (const e of client.observe(stop.signal)) if (e.type === "snapshot") return e.observation;
  } finally {
    stop.abort();
  }
  throw new Error("observe ended before a snapshot");
}

const row = (what: string) => `${what.padEnd(34)} ${String(counts.lists).padStart(6)} ${String(counts.sidecars).padStart(9)} ${String(counts.records).padStart(8)}`;
const reset = () => Object.assign(counts, { lists: 0, sidecars: 0, records: 0 });
console.log(`${stopped + neverPaused} stopped pylons, ${stopped} of them with a checkpoint. Per operation:`);
console.log(`${"".padEnd(34)} ${"lists".padStart(6)} ${"sidecars".padStart(9)} ${"records".padStart(8)}`);
let observed: NodeObservation | null = null;
for (let i = 1; i <= rounds; i++) {
  reset();
  observed = await snapshot();
  console.log(row(`snapshot ${i}`));
}
reset();
caller = peer;
const absent = "tpl-absent000000";
const fetched = await fetch(`http://127.0.0.1:${probe.port}/v1/artifacts/${absent}?sha256=${"0".repeat(64)}`);
await fetched.body?.cancel();
console.log(row(`GET /v1/artifacts/${absent} (${fetched.status})`));
await probe.close();
await rm(root, { recursive: true, force: true });

console.log("\nWhat the last snapshot reported:");
console.log(JSON.stringify({ artifacts: observed!.artifacts, pylons: observed!.pylons }));
process.exit(0);
