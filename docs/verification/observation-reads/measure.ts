/**
 * Counts the node rows the loop, the peers handoff and the usage sweep read, the usage cursors a sweep loads and the
 * harness reads it makes, and where a node's orphans are recorded, against the real registry on a SQLite file. Run
 * from a checkout with `node --no-warnings docs/verification/observation-reads/measure.ts [pylons]`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { startLoop } from "../../../src/control/loop.ts";
import { peerHandoff } from "../../../src/control/peers.ts";
import { nodePylons } from "../../../src/control/placement.ts";
import { openRegistry, type Registry } from "../../../src/control/registry.ts";
import { addThread, seedRegistry } from "../../../src/control/test-kit.ts";
import { usageCounter } from "../../../src/control/usage-counter.ts";
import { ingest } from "../../../src/reconcile.ts";
import type { NodeName, NodeObservation, ProbeClient, ProbeEvent, PylonId, PylonObservation, TailnetNodeId } from "../../../src/protocol.ts";
import type { ConversationId } from "../../../src/harness/host.ts";

const pylons = Number(process.argv[2] ?? 50);
const node = "rj-firebat" as NodeName;
const dir = await mkdtemp(join(tmpdir(), "nexus-observation-reads-"));
const path = () => join(dir, `${Math.random().toString(36).slice(2)}.db`);

const counts = { nodeRows: 0, cursorRows: 0 };
for (const method of ["get", "all"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    const result = original.apply(this, args);
    const rows = Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
    if (/^SELECT \* FROM nodes\b/.test(this.sourceSQL)) counts.nodeRows += rows;
    if (/FROM usage_cursors/.test(this.sourceSQL)) counts.cursorRows += rows;
    return result;
  };
}
const reset = () => { counts.nodeRows = 0; counts.cursorRows = 0; };
function uncounted<T>(read: () => T): T {
  const saved = { ...counts };
  const result = read();
  Object.assign(counts, saved);
  return result;
}
const print = (what: string, value: number | string) => console.log(`${what}\t${value}`);

const capacity = { cpus: 64, committedCpus: 0, memoryGiB: 256, committedMemoryGiB: 0, diskFreeGiB: 1000, committedDiskGiB: 0 };
const running = (pylonId: PylonId): PylonObservation => ({
  pylonId, phase: "running", liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000" as never, checkpoint: null },
  services: [{ name: "web", state: "ready", port: 8000, declared: true, wantsPreview: true }],
  listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
});
const observation = (listed: readonly PylonObservation[]): NodeObservation => ({
  node, observedAt: new Date().toISOString(), probeBootId: "boot-1", events: [], capacity, artifacts: [], jobs: [], pylons: [...listed],
  grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
});

/** A probe that sends one snapshot and then holds the stream open, and refuses every job and command. */
function probeOf(snapshot: NodeObservation): ProbeClient {
  const refuse = async () => { throw Object.assign(new Error("refused by the measuring probe"), { code: "unreachable" }); };
  return {
    node, submit: refuse, job: refuse, command: refuse, stream: refuse, manifest: refuse, putSecret: refuse, putPeers: refuse, health: refuse,
    async *observe(signal: AbortSignal): AsyncIterable<ProbeEvent> {
      yield { type: "snapshot", observation: snapshot };
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  };
}

async function loop() {
  const registry = seedRegistry(openRegistry(path()), { nodes: [node] });
  const listed = Array.from({ length: pylons }, () => running(addThread(registry, { node }).pylonId));
  const orphans = Array.from({ length: 5 }, (_, n) => running(`pylon-stray-${n}` as PylonId));
  const snapshot = observation([...listed, ...orphans]);
  print("observation bytes", JSON.stringify(snapshot).length);
  reset();
  const logs: string[] = [];
  const started = startLoop({ registry, probes: [probeOf(snapshot)], ingest, previewPorts: { first: 10200, last: 10200 + pylons }, intervalMs: 3_600_000, log: (l) => logs.push(l) });
  while (!uncounted(() => registry.node(node)?.state === "online" && listed.every((p) => registry.previews(p.pylonId).length > 0))) await new Promise((r) => setTimeout(r, 5));
  await started.wake(node);
  print(`node rows read from start until ${pylons} pylons have previews`, counts.nodeRows);
  reset();
  await started.wake(node);
  print(`node rows read by one pass over ${pylons} running pylons`, counts.nodeRows);
  print("orphans listed by nodePylons", nodePylons(registry, registry.node(node)!)!.orphaned.join(" "));
  await started.close();
  registry.close();
}

async function peers() {
  const names = Array.from({ length: 10 }, (_, n) => `node-${n}` as NodeName);
  const registry = openRegistry(path());
  for (const name of names) registry.upsertNode({ name, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: `n${name}` as TailnetNodeId });
  for (const name of names) registry.ingested({ ...observation(Array.from({ length: pylons }, (_, n) => running(`pylon-${name}-${n}` as PylonId))), node: name }, []);
  const puts: number[] = [];
  const handoff = peerHandoff({ registry, probes: new Map(names.map((name) => [name, { putPeers: async (list: readonly TailnetNodeId[]) => { puts.push(list.length); } }])) });
  reset();
  await handoff.all();
  print(`node rows read to put ${names.length} nodes their peers`, counts.nodeRows);
  reset();
  handoff.observed(names[0]!);
  await handoff.close();
  handoff.observed(names[0]!);
  await handoff.close();
  print("puts of an unchanged list over two snapshots", puts.length - names.length);
  registry.close();
}

async function sweep() {
  const registry = seedRegistry(openRegistry(path()), { nodes: [node] });
  const threads = Array.from({ length: 200 }, (_, n) => addThread(registry, { node, thread: { conversationId: String(n + 1) } }));
  for (const t of threads) registry.recordUsage(t.id, [], [{ source: "harness", key: t.conversationId!, position: 1, before: "" }]);
  for (const t of threads.filter((_, n) => n % 4 === 0)) registry.setThreadStatus(t.id, "deleted");
  let reads = 0;
  const counter = usageCounter({ registry, probes: new Map(), harness: { usage: async (_: ConversationId, after: number | null) => { reads++; return { calls: [], last: after }; } }, sweepMs: 3_600_000 });
  await counter.sweep();
  reads = 0;
  reset();
  await counter.sweep();
  print("harness reads by one sweep of 200 threads, 50 deleted", reads);
  print("usage cursor rows loaded by that sweep", counts.cursorRows);
  await counter.close();
  registry.close();
}

async function orphansTable() {
  const file = path();
  const registry = seedRegistry(openRegistry(file), { nodes: [node] });
  registry.ingested(observation([running("pylon-stray" as PylonId)]), ingest({ type: "snapshot", observation: observation([running("pylon-stray" as PylonId)]) }, node, new Map(), Date.now()));
  registry.close();
  const db = new DatabaseSync(file);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orphans'").get();
  print("orphans table", table === undefined ? "absent" : `${(db.prepare("SELECT count(*) AS n FROM orphans").get() as { n: number }).n} rows`);
  db.close();
}

await loop();
await peers();
await sweep();
await orphansTable();
await rm(dir, { recursive: true });
