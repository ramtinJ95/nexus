// Three nodes as the control plane sees them, behind the real API on 127.0.0.1:7471, which the real `nexus` CLI drives.
// No probe or VM runs: each node's observation is ingested into the registry as a probe's would be, and the harness is
// the fake one, which takes 2 s to create a conversation so two starts overlap as they can on the live control plane.
//
//   node docs/verification/placement-spread/stack.ts
//   NEXUS_URL=http://127.0.0.1:7471 NEXUS_SOCKS=none node src/cli/nexus.ts nodes
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, NodeObservation, PylonId, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const root = "/tmp/nexus-spread";
const image = "img-0000000000dd" as ImageId;
const laptop = "nLAPTOP" as TailnetNodeId;
const port = 7471;
await rm(root, { recursive: true, force: true });
await mkdir(root);

const registry = openRegistry(join(root, "registry.db"));
const nodes = { "rj-firebat": 22.8, "infra-testbench": 31.3, "spare-node": 31.3 } as const;
for (const name of Object.keys(nodes)) registry.upsertNode({ name: name as NodeName, tailnetHost: "127.0.0.1", tailnetNodeId: `n${name}` as TailnetNodeId });
registry.saveImage({ id: image, gondolinBuildId: "b", builtOn: "rj-firebat", builtAt: "2026-10-26T00:00:00Z", sha256: "d".repeat(64), pins: {} } as never);
registry.setCurrentImage(image);
// As every project's default node was before: rj-firebat.
registry.createProject({
  id: "nexus", repoUrl: "https://github.com/ramtinJ95/nexus.git", defaultBranch: "main", defaultNode: "rj-firebat", resources: { cpus: 4, memoryGiB: 8, diskGiB: 40 },
  allowedHosts: [], secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }], logins: ["claude"], preSetup: null,
} as never);

const fake = fakeHarness();
const startConversation = fake.harness.startThread;
fake.harness.startThread = async (thread) => { await sleep(2000); return startConversation(thread); };
await startApi({
  registry, whois: async () => laptop, host: "127.0.0.1", port, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "https://github.com/ramtinJ95/dotfiles.git", ref: "main" }, harness: fake.harness, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});

async function post(path: string, body: unknown): Promise<Thread> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json() as Thread;
}

// rj-firebat as it was: Claude workers running, one paused, two archived, and an orphaned VM the registry does not know.
const workers: Thread[] = [];
for (const title of ["worker 1", "worker 2", "worker 3", "worker 4", "paused worker", "archived 1", "archived 2"]) {
  workers.push(await post("/v1/threads", { project: "nexus", title, node: "rj-firebat", claude: title }));
}
for (const t of workers.slice(5)) await post(`/v1/threads/${t.id}/archive`, {});
const running = (t: Thread): PylonObservation => ({
  pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2026-10-26T00:00:00Z", bootedFrom: { image, checkpoint: null },
  services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
});
const stopped = (pylonId: PylonId): PylonObservation => ({ pylonId, phase: "stopped", checkpoint: null, sessions: null });
const orphan = { ...running(workers[0]!), pylonId: "pylon-th-0rphan000000" as PylonId };

function observe(name: keyof typeof nodes, committed: { cpus: number; memoryGiB: number; diskGiB: number }, pylons: PylonObservation[]) {
  const capacity = { cpus: 16, committedCpus: committed.cpus, memoryGiB: nodes[name], committedMemoryGiB: committed.memoryGiB, diskFreeGiB: 400, committedDiskGiB: committed.diskGiB };
  registry.apply({ record: "node", node: name as NodeName, state: "online", capacity });
  const observation: NodeObservation = {
    node: name as NodeName, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [image], jobs: [], pylons,
    grants: { secrets: ["GH_TOKEN"], gitSsh: true }, previewRoutes: [],
  };
  registry.ingested(observation, []);
}
// Four running workers and the orphan hold 5 x 4 CPUs and 5 x 8 GiB. All eight VMs' disks stay.
observe("rj-firebat", { cpus: 20, memoryGiB: 40, diskGiB: 320 }, [...workers.slice(0, 4).map(running), orphan, ...workers.slice(4).map((t) => stopped(t.pylonId))]);
observe("infra-testbench", { cpus: 0, memoryGiB: 0, diskGiB: 0 }, []);
observe("spare-node", { cpus: 2, memoryGiB: 4, diskGiB: 40 }, []);
console.log(`nexus API on http://127.0.0.1:${port} with rj-firebat, infra-testbench and spare-node`);
