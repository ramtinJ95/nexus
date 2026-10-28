/**
 * Prints what a person, a client and a node can observe of a node observation in each shape a probe ever sent, read
 * the two ways a control plane reads one: from the probe's wire frame, and from a registry row an older control plane
 * stored. For each it prints the nodes row on disk, GET /v1/nodes, the thread detail of a running, a stopped and a
 * broken pylon, POST /v1/threads with node auto, the dashboard's side nodes, the job the planner sends each pylon,
 * the ports preview allocation hands out, whether the ChatGPT token handoff runs, and the writes of the node's next
 * snapshot. It imports the checkout given as its argument, so run.sh runs it unchanged against main and the branch.
 *
 *   node docs/verification/upgrade-observations/capture.ts <checkout> <probe-frames-dir> <out-file>
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const now = Date.parse("2026-10-27T12:00:00Z");
Date.now = () => now;

const root = resolve(process.argv[2]!);
const framesDir = resolve(process.argv[3]!);
const out = process.argv[4]!;
const src = (path: string) => import(join(root, "src", path));
const { startApi } = await src("control/api.ts");
const { openRegistry } = await src("control/registry.ts");
const { fakeHarness } = await src("control/fake-harness.ts");
const { threadStarter } = await src("control/threads.ts");
const { chatgptTokenHandoff } = await src("control/chatgpt-token.ts");
const { encodeProbeEvent, parseProbeEvent } = await src("protocol.ts");
const { ingest } = await src("reconcile.ts");
const { tick } = await src("tick.ts");

const dir = await mkdtemp(join(tmpdir(), "upgrade-capture-"));
const lines: string[] = [];
let ids: [string, string][] = [];
const scrub = (text: string) => ids.reduce((t, [from, to]) => t.replaceAll(from, to), text);
const say = (line: string) => lines.push(scrub(line));

const node = "rj-firebat";
const laptop = "nLAPTOP";
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
const project = (id: string, logins: string[]) => ({
  id, repoUrl: "https://example.com/acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins, preSetup: null,
});

type Ids = { a: string; b: string; c: string };
const counted = { cpus: 16, committedCpus: 2, memoryGiB: 64, committedMemoryGiB: 8, diskFreeGiB: 100, committedDiskGiB: 10 };
// A probe from before pylons were counted always sent 0. 80 shows that a value it sends counts for nothing.
const uncounted = { memoryGiB: 64, committedMemoryGiB: 80, diskFreeGiB: 100 };
const running = (p: Ids) => ({
  pylonId: p.a, phase: "running", liveHash: null, bootedAt: "2026-10-27T11:00:00Z", bootedFrom: { image: image.id, checkpoint: null },
  services: [{ name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true }], listening: [{ port: 5173 }, { port: 3000 }], previews: [],
  sessions: [{ id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, status: "idle", title: "shell" }],
  git: null, declaredOutputs: [], attachedClients: 0,
});
const today = (p: Ids) => ({
  node, observedAt: "2026-10-27T11:59:00Z", probeBootId: "boot-1", events: [], capacity: counted, artifacts: [image.id], jobs: [],
  pylons: [running(p), { pylonId: p.b, phase: "stopped", checkpoint: null, sessions: [] }, { pylonId: p.c, phase: "broken", detail: "a service did not start", cause: "services" }],
  previewRoutes: [{ httpsPort: 10200, pylonId: p.a, service: "web" }], grants: { secrets: ["GH_TOKEN"], gitSsh: true }, claudeLaunchRepeatable: true, heldSecrets: ["NEXUS_CHATGPT_TOKEN"],
});
const without = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const shapes: [string, (p: Ids) => Record<string, unknown>][] = [
  ["the probe every node runs (82a703f), which sends claudeLaunchRepeatable", today],
  ["a probe that sends no claudeLaunchRepeatable, as this branch's", (p) => without(today(p), "claudeLaunchRepeatable")],
  ["a probe from before held secrets (#114)", (p) => without(today(p), "claudeLaunchRepeatable", "heldSecrets")],
  ["a probe from before pylons were counted (#95), with no grants", (p) => ({ ...without(today(p), "claudeLaunchRepeatable", "heldSecrets", "grants"), capacity: uncounted })],
  ["a probe from before preview routes (#27)", (p) => ({ ...without(today(p), "claudeLaunchRepeatable", "heldSecrets", "grants", "previewRoutes"), capacity: uncounted })],
  ["the oldest probe: also no listening ports, session states, paused session lists or broken causes", (p) => ({
    ...without(today(p), "claudeLaunchRepeatable", "heldSecrets", "grants", "previewRoutes"), capacity: uncounted,
    pylons: [
      { ...without(running(p), "listening"), sessions: [{ herdrPane: "w1:p1", harness: "shell", harnessSessionId: null, status: "idle" }] },
      { pylonId: p.b, phase: "stopped", checkpoint: null },
      { pylonId: p.c, phase: "broken", detail: "a service did not start" },
    ],
  })],
  ["grants but no committed disk, which no probe sent", (p) => ({ ...without(today(p), "claudeLaunchRepeatable"), capacity: uncounted })],
];

async function stack() {
  const path = join(dir, `${lines.length}.db`);
  const registry = openRegistry(path);
  registry.upsertNode({ name: node, tailnetHost: `${node}.tail.ts.net`, tailnetNodeId: "nFIREBAT" });
  const fake = fakeHarness();
  const startThread = threadStarter({ registry, harness: fake.harness, mirror: { setupInputs: () => Promise.reject(new Error("no remote")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake: () => {} });
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0, whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
    harness: fake.harness, startThread, wake: () => {}, probes: new Map(), previewPorts: { first: 10200, last: 10209 },
  });
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; text: string }>((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    request({ host: "127.0.0.1", port: api.port, method, path, headers: { host: `127.0.0.1:${api.port}`, ...payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; }).on("end", () => done({ status: res.statusCode!, text }));
    }).on("error", fail).end(payload);
  });
  for (const p of [project("plain", []), project("chatgpt", ["chatgpt"])]) await call("POST", "/v1/projects", p);
  await call("POST", "/v1/images", image);
  registry.setCurrentImage(image.id);
  const start = async (projectId: string, title: string) => JSON.parse((await call("POST", "/v1/threads", { project: projectId, title })).text);
  const threads = { a: await start("plain", "Running"), b: await start("plain", "Stopped"), c: await start("plain", "Broken"), d: await start("chatgpt", "Not booted") };
  ids = Object.entries(threads).flatMap(([key, t]) => [[t.pylonId, `<pylon-${key}>`], [t.id, `<thread-${key}>`]] as [string, string][]);
  return { path, registry, api, call, threads, pylons: { a: threads.a.pylonId, b: threads.b.pylonId, c: threads.c.pylonId } };
}

async function observe(name: string, how: "frame" | "stored", shape: (p: Ids) => Record<string, unknown>) {
  const s = await stack();
  say(`\n## ${name}, read from ${how === "frame" ? "the probe's frame" : "a row an older control plane stored"}`);
  const observation = shape(s.pylons);
  if (how === "frame") {
    const event = parseProbeEvent(encodeProbeEvent({ type: "snapshot", observation }));
    const known = new Map(s.registry.pylonIdsOn(node).map((id: string) => [id, "absent"]));
    s.registry.ingested(event.observation, ingest(event, node, known, now, new Set(known.keys())));
  } else {
    s.registry.apply({ record: "node", node, state: "online", capacity: observation.capacity });
    s.registry.ingested(observation, []);
  }
  await report(s);
  s.registry.close();
}

async function report(s: Awaited<ReturnType<typeof stack>>) {
  const db = new DatabaseSync(s.path);
  const disk = db.prepare("SELECT state, capacity, observation FROM nodes WHERE name = ?").get(node) as Record<string, string>;
  db.close();
  say(`disk nodes.capacity: ${disk.capacity}`);
  say(`disk nodes.observation: ${disk.observation}`);
  const nodes = await s.call("GET", "/v1/nodes");
  say(`GET /v1/nodes: ${nodes.status} ${nodes.text}`);
  for (const key of ["a", "b", "c"] as const) {
    const detail = await s.call("GET", `/v1/threads/${s.threads[key].id}`);
    const d = JSON.parse(detail.text);
    say(`GET /v1/threads/<thread-${key}>: ${detail.status} pylon ${JSON.stringify(d.pylon)} ports ${JSON.stringify(d.ports)} sessions ${JSON.stringify(d.sessions)}`);
  }
  for (const projectId of ["plain", "chatgpt"]) {
    const started = await s.call("POST", "/v1/threads", { project: projectId, title: "Placed", node: "auto" });
    const body = JSON.parse(started.text);
    say(`POST /v1/threads ${projectId} auto: ${started.status} ${started.status === 201 ? JSON.stringify(body.placement) : body.error}`);
  }
  const page = (await s.call("GET", "/")).text;
  say(`dashboard side nodes: ${page.split('id="side-nodes"')[1]!.split("</div>")[0]!.replace(/^[^>]*>/, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}`);
  const observation = s.registry.node(node)!.observation;
  for (const key of ["a", "b", "c", "d"] as const) {
    const pylon = { ...s.registry.pylon(s.threads[key].pylonId)!, desired: key === "b" ? "paused" : "running" };
    const sent: string[] = [];
    const probe = { node, submit: async (env: { jobId: string; job: { kind: string; boot?: { source: { kind: string } } } }) => {
      sent.push(`${env.job.kind}${env.job.boot === undefined ? "" : ` from ${env.job.boot.source.kind}`}`);
      return { accepted: { jobId: env.jobId, subject: pylon.pylonId, kind: env.job.kind, state: "running", startedAt: "2026-10-27T12:00:00Z" } };
    } };
    const step = await tick(pylon, { probe, observation, holders: () => [], artifactSha256: () => image.sha256, save: () => {} });
    say(`planner for <pylon-${key}>: ${step.kind}${"reason" in step ? ` ${step.reason}` : ""}${sent.length > 0 ? `, sends ${sent.join(", ")}` : ""}`);
  }
  const puts: string[] = [];
  const handoff = chatgptTokenHandoff({ probes: [{ node, putSecret: async (name: string) => { puts.push(name); } }], token: async () => "token", log: (line: string) => puts.push(line) });
  handoff.observed(observation);
  await handoff.close();
  say(`ChatGPT token handoff: ${puts.length === 0 ? "sends nothing" : `sends ${puts.join(", ")}`}`);
  s.registry.allocatePreviews(s.pylons.a, ["web", "api"], { first: 10200, last: 10209 });
  say(`preview allocation for <pylon-a>: ${s.registry.previews(s.pylons.a).map((p: { service: string; httpsPort: number }) => `${p.service} ${p.httpsPort}`).join(", ")}`);
  const next = parseProbeEvent(encodeProbeEvent({ type: "snapshot", observation: without(today(s.pylons), "claudeLaunchRepeatable") }));
  const known = new Map(s.registry.pylonIdsOn(node).map((id: string) => [id, observation?.pylons.find((p: { pylonId: string }) => p.pylonId === id) ?? "absent"]));
  say(`writes of the next snapshot: ${JSON.stringify(ingest(next, node, known, now))}`);
  await s.api.close();
}

for (const file of (await readdir(framesDir)).sort()) {
  const frame = (await readFile(join(framesDir, file), "utf8")).trim();
  await observe(`the snapshot ${file.replace(/\.json$/, "")}'s real probe sent`, "frame", (p) => {
    const { observation } = JSON.parse(frame);
    return { ...observation, ...without(today(p), "events", "previewRoutes", "grants", "claudeLaunchRepeatable", "heldSecrets") };
  });
}
for (const [name, shape] of shapes) for (const how of ["frame", "stored"] as const) await observe(name, how, shape);

await rm(dir, { recursive: true, force: true });
await writeFile(out, lines.join("\n").trimStart() + "\n");
