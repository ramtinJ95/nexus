/**
 * What a real probe (startProbe) over a real pylon-vm backend (createPylonVmBackend) reports and answers, as
 * src/probe/main.ts wires them, with no VM booted: each pylon is the files pylon-vm leaves for a stopped or
 * interrupted instance. Counts the artifact store's lists (readdir of <artifacts>) per operation.
 *
 *   node docs/verification/backend-interface/capture.ts
 */
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPylonVmBackend } from "../../../src/pylon-vm-backend.ts";
import { startProbe } from "../../../src/probe/server.ts";
import { nodeSecrets } from "../../../src/probe/config.ts";
import { connectProbe, type NodeName, type NodeObservation, type TailnetNodeId } from "../../../src/protocol.ts";

const root = await mkdtemp("/tmp/nexus-bif-");
const stateRoot = join(root, "state");
const instances = join(stateRoot, "instances");
const artifacts = join(root, "artifacts");
const image = "img-capture00000";
const template = "tpl-capture00000";
const sha256 = "a".repeat(64);
await mkdir(join(artifacts, image), { recursive: true });
await writeFile(join(artifacts, image, "image.json"), "{}");
await mkdir(join(artifacts, template), { recursive: true });
await writeFile(join(artifacts, template, "disk.qcow2"), "template disk");
await writeFile(join(artifacts, template, "template.json"), JSON.stringify({ id: template, key: { project: "proj", image, setupHash: "h".repeat(64) }, commit: "c0ffee", builtAt: "2026-10-30T00:00:00.000Z", sha256 }));
await mkdir(instances, { recursive: true, mode: 0o700 });
const sessions = [{ id: "w1:p1", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, title: "sh" }];
const pylons: [string, object, object | null][] = [
  ["pylon-paused", { state: "stopped" }, { checkpoint: "ckpt-paused-1", sessions }],
  ["pylon-recorded-none", { state: "stopped" }, { checkpoint: "ckpt-none-1" }],
  ["pylon-never-paused", { state: "stopped" }, null],
  ["pylon-dead", { state: "interrupted", recovery: "the controller exited without completing a stop" }, { checkpoint: "ckpt-dead-1" }],
];
for (const [pylonId, status, sidecar] of pylons) {
  const dir = join(instances, pylonId);
  await mkdir(dir, { mode: 0o700 });
  const config = { version: 1, diskGiB: 8, image: join(artifacts, image), workspace: "/home/user/workspace", setup: [], resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: pylonId, config, createdAt: "2026-10-30T00:00:00Z", labels: { "nexus.image": image } }));
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: pylonId, ...status }));
  await writeFile(join(dir, "controller.log"), `${pylonId}: last controller line\n`);
  if (sidecar !== null) await writeFile(join(dir, "nexus-checkpoint.json"), JSON.stringify(sidecar));
}

let storeLists = 0;
const { readdir } = fsp;
fsp.readdir = ((path: string, ...rest: never[]) => {
  if (String(path) === artifacts) storeLists++;
  return readdir(path, ...rest);
}) as typeof readdir;
syncBuiltinESMExports();

const controlPlane = "nCONTROL" as TailnetNodeId;
const peer = "nPEER" as TailnetNodeId;
let caller = controlPlane;
const probe = await startProbe({
  node: "capture-node" as NodeName, host: "127.0.0.1", port: 0,
  auth: { controlPlane, peers: [peer] },
  whois: async () => caller,
  backend: createPylonVmBackend({ stateRoot, artifacts, secrets: { value: () => undefined, names: () => [] } }),
  secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
  log: () => {},
});
const client = connectProbe("capture-node" as NodeName, "127.0.0.1", "nPROBE" as TailnetNodeId, { port: probe.port, whois: async () => "nPROBE" as TailnetNodeId });

async function snapshot(): Promise<NodeObservation> {
  const stop = new AbortController();
  try {
    for await (const e of client.observe(stop.signal)) if (e.type === "snapshot") return e.observation;
  } finally {
    stop.abort();
  }
  throw new Error("observe ended before a snapshot");
}

storeLists = 0;
const observed = await snapshot();
console.log(`snapshot: ${storeLists} store list(s)`);
console.log(`  artifacts ${JSON.stringify(observed.artifacts)}`);
for (const p of observed.pylons) console.log(`  ${JSON.stringify(p)}`);

caller = peer;
for (const [id, wanted] of [["ckpt-paused-1", sha256], ["tpl-absent000000", sha256], ["img-absent000000", sha256], [template, "0".repeat(64)], [template, sha256]] as const) {
  storeLists = 0;
  const res = await fetch(`http://127.0.0.1:${probe.port}/v1/artifacts/${id}?sha256=${wanted}`);
  const body = res.status === 200 ? `${(await res.arrayBuffer()).byteLength}-byte archive` : (await res.text()).trim();
  console.log(`GET /v1/artifacts/${id}?sha256=${wanted.slice(0, 4)}…: ${res.status}, ${storeLists} store list(s): ${body}`);
}
await probe.close();
await rm(root, { recursive: true, force: true });
process.exit(0);
