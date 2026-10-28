// A local Nexus control plane for the question card captures: the real registry, API and dashboard, as
// src/control/main.ts wires them, on plain HTTP at 127.0.0.1:7470 for the CLI and the browser. Three threads each wait
// on a question the stack asks through the registry, since nothing asks one yet:
//  - image: a deployer question, the merge policy's pylon image rebuild.
//  - secret: a deployer question, the merge policy's secrets.
//  - brief: a question any person may answer.
// Stand-ins replace only what this pylon cannot host:
//  - whois answers the laptop, a deployer, until POST /verify/caller on port 7489 names another caller: the phone, a
//    person the API allows who is not a deployer, or verify-node, the control plane's own node, which the API allows
//    and whose identity a pylon's traffic on it carries.
//  - The node is observed online every half second with its pylons running, as a probe would report it.
//  - The agent is a fake harness that records what it is sent and never answers.
// The same file runs on main and on the branch. Main's registry has no questions, so it asks none and says so.
//
//   EVIDENCE=<dir> node docs/verification/question-cards/stack.ts
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-questions-evidence-"));
mkdirSync(evidence, { recursive: true });
const log = (line: string) => appendFileSync(join(evidence, "stack.log"), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const callers = { laptop: "nLAPTOP", phone: "nPHONE", node: "nVERIFYNODE" } as Record<string, string> as Record<string, TailnetNodeId>;
let caller = callers.laptop!;

const work = mkdtempSync(join(tmpdir(), "nexus-questions-"));
const registry = openRegistry(join(work, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.example.ts.net", tailnetNodeId: callers.node! });
registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-28T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
registry.setCurrentImage("img-0000000000aa" as never);
registry.createProject({ id: "nexus", repoUrl: "https://github.com/ramtinJ95/nexus.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
function observe() {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => ({
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2026-10-28T00:00:00Z",
    bootedFrom: { image: "img-0000000000aa" as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [] } as never, []);
}

const fake = fakeHarness();
const wake = () => {};
const startThread = threadStarter({ registry, harness: fake.harness, wake, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: false,
  deployment: { self: callers.node!, deployers: new Set([callers.laptop!]), keys: {} },
  whois: async () => caller, allowed: new Set(Object.values(callers)), hostnames: new Set(["127.0.0.1"]),
  harness: fake.harness, startThread, wake, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
} as Parameters<typeof startApi>[0]);

async function start(title: string): Promise<Thread> {
  const res = await fetch(`http://127.0.0.1:${api.port}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "nexus", title }) });
  if (res.status !== 201) throw new Error(`start ${title}: ${res.status} ${await res.text()}`);
  return await res.json() as Thread;
}
const ids = {
  image: (await start("Pin the pylon's Node to 26")).id,
  secret: (await start("Rotate the merge token")).id,
  brief: (await start("Plan the pipeline items")).id,
};

interface Asked { id: string; thread: ThreadId; text: string; options: string[]; reserved: string | null; answerer: "person" | "deployer"; askedAt: number }
const ask = (registry as { askQuestion?: (q: Asked) => unknown }).askQuestion;
const questions: Asked[] = [
  { id: "qn-image-rebuild", thread: ids.image, text: "The builder's pull request changes images/pylon/Dockerfile. Rebuild the pylon image and roll it out once it lands?", options: ["Rebuild and roll out", "Leave the image as it is"], reserved: "image-rebuild", answerer: "deployer", askedAt: Date.now() - 120_000 },
  { id: "qn-merge-token", thread: ids.secret, text: "Rotating the merge token changes a secret on rj-firebat. Rotate it now?", options: ["Rotate now", "Not now"], reserved: "secrets", answerer: "deployer", askedAt: Date.now() - 90_000 },
  { id: "qn-brief", thread: ids.brief, text: "The planning thread wrote a brief for \"Archive what landed\". Start a builder with it?", options: ["Start it", "Rewrite the brief", "Drop the item"], reserved: null, answerer: "person", askedAt: Date.now() - 60_000 },
];
if (ask === undefined) log("this registry has no askQuestion, so the stack asks no questions");
else for (const q of questions) { ask.call(registry, q); log(`asked ${q.id} on ${q.thread}: ${q.text}`); }

observe();
setInterval(observe, 500);

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (req.url === "/verify/caller" && req.method === "POST") {
      caller = callers[JSON.parse(body).as as string]!;
      log(`whois now answers ${caller}`);
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
}).listen(7489, "127.0.0.1");

console.log(JSON.stringify({ ...ids, callers, asked: ask !== undefined, evidence }));
