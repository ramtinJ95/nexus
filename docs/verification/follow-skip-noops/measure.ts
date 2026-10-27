// Drives the real reconcile loop, registry and ingest through one simulated hour of a node's observe stream, counts
// the work the loop's follow() does for it, and dumps the registry state a person or client can read afterwards.
// Run from the root of a checkout: node docs/verification/follow-skip-noops/measure.ts <out-dir>
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

// One fixed clock, so the two checkouts store the same times and their state dumps compare byte for byte.
const now = Date.parse("2026-10-27T12:00:00Z");
Date.now = () => now;

const { startLoop } = await import("../../../src/control/loop.ts");
const { openRegistry } = await import("../../../src/control/registry.ts");
const { ingest } = await import("../../../src/reconcile.ts");
const { newPylonRecord } = await import("../../../src/tick.ts");
type Registry = ReturnType<typeof openRegistry>;
type ProbeEvent = import("../../../src/protocol.ts").ProbeEvent;
type ProbeClient = import("../../../src/protocol.ts").ProbeClient;
type JobStatus = import("../../../src/protocol.ts").JobStatus;
type PylonObservation = import("../../../src/protocol.ts").PylonObservation;
type ReportedEvent = import("../../../src/events.ts").ReportedEvent;

const out = process.argv[2]!;
const node = "rj-firebat" as import("../../../src/protocol.ts").NodeName;
const image = "img-000000000000" as import("../../../src/images.ts").ImageId;
const pylonCount = 10;

const counts = {
  events: {} as Record<string, number>,
  /** Registry calls whose caller is follow(), by method. */
  calls: {} as Record<string, number>,
  /** SQL that runs inside those calls. */
  statements: 0,
  transactions: 0,
  observationWrites: 0,
  observationBytes: 0,
};
let inFollow = 0;
const countSql = (text: string) => {
  if (inFollow === 0) return;
  counts.statements++;
  if (text === "BEGIN IMMEDIATE") counts.transactions++;
  if (text.startsWith("UPDATE nodes SET observation")) counts.observationWrites++;
};
for (const method of ["run", "get", "all", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    countSql(this.sourceSQL);
    if (inFollow > 0 && this.sourceSQL.startsWith("UPDATE nodes SET observation")) counts.observationBytes += String(args[0]).length;
    return original.apply(this, args);
  };
}
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, text: string) { countSql(text); return exec.call(this, text); };

/** Wraps every registry method so a call made by follow() counts, with the SQL it runs. */
function counted(registry: Registry): Registry {
  for (const [name, value] of Object.entries(registry)) {
    if (typeof value !== "function") continue;
    (registry as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const caller = new Error().stack!.split("\n")[2]!.trim().split(" ")[1];
      if (caller !== "follow" || inFollow > 0) return value(...args);
      counts.calls[name] = (counts.calls[name] ?? 0) + 1;
      inFollow++;
      try { return value(...args); } finally { inFollow--; }
    };
  }
  return registry;
}

const dir = await mkdtemp(join(tmpdir(), "follow-measure-"));
const dbPath = join(dir, "registry.db");
const registry = counted(openRegistry(dbPath));
registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as never });
registry.createProject({
  id: "acme" as never, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const pylonIds = Array.from({ length: pylonCount }, (_unused, i) => {
  const id = `th-${String(i).padStart(8, "0")}` as never;
  const pylonId = `pylon-${id}` as import("../../../src/protocol.ts").PylonId;
  const { desired: _, ...pylon } = newPylonRecord({
    thread: id, pylonId, node, desired: "running",
    boot: {
      pylonId, image, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    },
    firstBoot: { kind: "fresh", preSetup: null },
    live: { previews: [], overlay: [] },
    liveHash: "hash-1" as never,
  });
  registry.createThread({
    id, title: `thread ${i}`, project: "acme" as never, pylonId, status: "active", conversationId: null, startedBy: "nLAPTOP",
    createdAt: now, agentTurnRunning: false, working: false, lastAgentActivityAt: now, lastHumanActivityAt: now,
  } as never, pylon);
  return pylonId;
});

const running = (pylonId: import("../../../src/protocol.ts").PylonId, minute: number): PylonObservation => ({
  pylonId, phase: "running", liveHash: "hash-1" as never, bootedAt: new Date(now).toISOString(), bootedFrom: { image, checkpoint: null },
  services: [], listening: [], previews: [], git: null, declaredOutputs: [], attachedClients: 0,
  sessions: [{ id: "p1", state: "running", herdrPane: "p1", harness: "pi", harnessSessionId: "s.jsonl", status: minute % 2 === 0 ? "working" : "idle", title: "plan" }],
});

// One hour on a node with ten running pylons. Each minute: ten session reports, a snapshot carrying the journal's last
// 100 reports, and every other minute a preview hit. Every five minutes a job runs, which the probe announces with a
// job event when it starts and ends, a pylon event and a snapshot after it. From minute 30 to 34 the link is down: the
// probe journals that minute's reports and sends nothing, and the snapshot on reconnect brings them.
const journal: ReportedEvent[] = [];
const script: ProbeEvent[] = [];
let sequence = 0;
const pylons = new Map(pylonIds.map((id) => [id, running(id, 0)]));
const snapshot = (minute: number): ProbeEvent => ({
  type: "snapshot",
  observation: {
    node, observedAt: new Date(now + minute * 60_000).toISOString(), probeBootId: "boot-1",
    capacity: { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 },
    artifacts: [image], jobs: [], pylons: [...pylons.values()], grants: { secrets: [], gitSsh: false }, previewRoutes: [],
    events: journal.slice(-100),
  },
});
script.push(snapshot(0));
const kinds = ["session.turn-started", "session.heartbeat", "session.turn-ended"] as const;
for (let minute = 0; minute < 60; minute++) {
  const down = minute >= 30 && minute < 35;
  for (let i = 0; i < 10; i++) {
    const at = now - 3_600_000 + minute * 60_000 + i * 1000;
    const report: ReportedEvent = { sequence: ++sequence, pylon: pylonIds[i]!, time: at, event: { kind: kinds[(minute + i) % 3]!, session: "p1", at } };
    journal.push(report);
    if (!down) script.push({ type: "session-event", report });
  }
  if (down) {
    if (minute === 34) script.push(snapshot(minute));
    continue;
  }
  if (minute % 2 === 0) script.push({ type: "preview-hit", pylonId: pylonIds[minute % pylonCount]!, service: "web", at: new Date(now - 3_600_000 + minute * 60_000).toISOString(), login: null });
  if (minute % 5 === 0) {
    const pylonId = pylonIds[(minute / 5) % pylonCount]!;
    const base = { jobId: `job-${minute}` as never, subject: pylonId, kind: "spawn" as const };
    script.push({ type: "job", status: { ...base, state: "running", startedAt: new Date(now).toISOString() } });
    script.push({ type: "job", status: { ...base, state: "succeeded", finishedAt: new Date(now).toISOString() } });
    pylons.set(pylonId, running(pylonId, minute));
    script.push({ type: "pylon", pylon: pylons.get(pylonId)! });
    script.push(snapshot(minute));
  }
  script.push(snapshot(minute));
}
for (const event of script) counts.events[event.type] = (counts.events[event.type] ?? 0) + 1;

let drained!: () => void;
const allTaken = new Promise<void>((resolve) => { drained = resolve; });
const submitted = new Map<string, JobStatus>();
const probe: ProbeClient = {
  node,
  async submit(env) {
    const status: JobStatus = { jobId: env.jobId, subject: "pylonId" in env.job ? env.job.pylonId : "" as never, kind: env.job.kind, state: "running", startedAt: new Date(now).toISOString() };
    submitted.set(env.jobId, status);
    return { accepted: status };
  },
  async job(jobId) { return submitted.get(jobId) ?? "unknown"; },
  async *observe(signal) {
    yield* script;
    drained();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  },
  command: () => Promise.reject(new Error("unused")),
  stream: () => Promise.reject(new Error("unused")),
  manifest: () => Promise.reject(new Error("unused")),
  putSecret: () => Promise.resolve(),
};

const logged: string[] = [];
const loop = startLoop({
  registry, probes: [probe], ingest, previewPorts: { first: 10200, last: 10299 },
  intervalMs: 3_600_000, silenceMs: 3_600_000, offlineAfterMs: 3_600_000, log: (line) => logged.push(line),
});
await allTaken;
await loop.wake(node);
await loop.close();
registry.close();

// The rows a person or client reads through the API, the dashboard, the event stream and a restarted control plane.
// The pylons table is left out: it holds the envelopes the ticks drew random job IDs for, and nothing here changes ticks.
const db = new DatabaseSync(dbPath, { readOnly: true });
const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('pylons', 'sqlite_sequence') ORDER BY name").all() as { name: string }[]).map((t) => t.name);
const state = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
db.close();
await rm(dir, { recursive: true });

await writeFile(join(out, "counts.json"), JSON.stringify(counts, null, 2) + "\n");
await writeFile(join(out, "state.json"), JSON.stringify(state, null, 2) + "\n");
await writeFile(join(out, "loop.log"), logged.join("\n") + (logged.length > 0 ? "\n" : ""));
console.log(JSON.stringify(counts));
