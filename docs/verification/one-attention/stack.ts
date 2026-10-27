// A local Nexus control plane for the attention captures: the real registry, API and dashboard on 127.0.0.1:7470,
// seeded with an unread reply, a Claude session waiting for input, a Claude session working, a parked run and an idle
// thread. The model harness is the test fake, told about the park the way the control plane's harness host tells the
// registry, and the node's observation is written here, so nothing reaches a pylon or the live control plane.
// SIGUSR2 moves the working session to waiting, as Claude's permission prompt does. The same file runs on main and
// on the branch.
//
//   node docs/verification/one-attention/stack.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";

const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-attention-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
const fake = fakeHarness();
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
  harness: fake.harness, wake: () => {}, probes: new Map(),
  startThread: threadStarter({
    registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@example.com:dotfiles.git", ref: "main" },
    mirror: { setupInputs: () => Promise.reject(new Error("the stack reads no remote")) },
  }), previewPorts: { first: 10200, last: 10299 },
});
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};

const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
await call("POST", "/v1/projects", {
  id: "nexus", repoUrl: "git@example.com:nexus.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
await call("POST", "/v1/images", image);
registry.setCurrentImage(image.id as ImageId);

const start = (title: string, claude?: string): Promise<Thread> => call("POST", "/v1/threads", { project: "nexus", title, ...(claude === undefined ? {} : { claude }) });
const reply = await start("Answer the reviewer");
const asks = await start("Rename the fork button", "Rename the fork button to Copy");
const busy = await start("Pick a migration path", "Pick a migration path for the events table");
const parked = await start("Fix the flaky stream test");
const quiet = await start("Spike: preview over HTTPS");

let sequence = 0;
const report = (thread: Thread, kind: "session.turn-started" | "session.waiting", session: string) =>
  registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session } });
registry.recordReply(reply.id, Date.now() - 120_000);
registry.setClaudeWorker(asks.id, "Rename the fork button to Copy", "started", undefined, "s1");
report(asks, "session.waiting", "s1");
registry.setClaudeWorker(busy.id, "Pick a migration path for the events table", "started", undefined, "s2");
report(busy, "session.turn-started", "s2");
fake.park(parked.id, 1);
registry.recordParked(parked.id, true);
registry.recordReply(quiet.id, Date.now() - 600_000);
registry.markSeen(quiet.id, false);

process.on("SIGUSR2", () => {
  report(busy, "session.waiting", "s2");
  console.log(`${busy.id} waiting`);
});

const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } });
  const pylons = [reply, asks, busy, parked, quiet].map((t): PylonObservation => ({
    pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [], pylons, previewRoutes: [] }, []);
};
observe();
setInterval(observe, 1000);

const ids: Record<string, ThreadId> = { reply: reply.id, asks: asks.id, busy: busy.id, parked: parked.id, quiet: quiet.id };
console.log(JSON.stringify(ids));
