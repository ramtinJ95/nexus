/**
 * Counts the SQL statements the registry's list, placement, locator and start-up reads execute, the conversations a
 * start aborts, and the parked reports the harness sends, against the real registry on a SQLite file. Run from a
 * checkout with `node --no-warnings docs/verification/registry-reads/measure.ts [threads]`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentObserver, LiveState, TaskId } from "@earendil-works/pi-durable";
import { openRegistry, type Registry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { nodePylons, roomLeft } from "../../../src/control/placement.ts";
import { registryLocator } from "../../../src/control/locator.ts";
import { trackActivity } from "../../../src/harness/activity.ts";
import { newPylonRecord } from "../../../src/tick.ts";
import { transcriptStart } from "../../../src/claude-transcript.ts";
import type { LiveHash, NodeName, NodeObservation, PylonId, TailnetNodeId } from "../../../src/protocol.ts";
import type { ProjectId } from "../../../src/project.ts";

const threads = Number(process.argv[2] ?? 300);
const node = "rj-firebat" as NodeName;
const dir = await mkdtemp(join(tmpdir(), "nexus-registry-reads-"));

let statements = 0;
for (const method of ["get", "all", "run", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    statements++;
    return original.apply(this, args);
  };
}
const counted = <T>(read: () => T): { statements: number; result: T } => {
  const before = statements;
  const result = read();
  return { statements: statements - before, result };
};

/** Every fourth thread deleted, every third a Claude worker with a transcript, every fifth with a live session turn and every seventh waiting. */
function seed(registry: Registry) {
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.createProject({
    id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  let sequence = 0;
  for (let n = 0; n < threads; n++) {
    const id = `th-${String(n).padStart(6, "0")}` as ThreadId;
    const pylonId = `pylon-${id}` as PylonId;
    const claude = n % 3 === 0;
    const thread: Thread = {
      seenAt: null, lastReplyAt: null, id, title: "t", project: "acme" as ProjectId, pylonId, status: "active", conversationId: claude ? null : String(n + 1), startedBy: "nLAPTOP",
      createdAt: 1_000 + n, agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: n % 2 === 0 ? Date.now() : 0,
    };
    const { desired: _, ...pylon } = newPylonRecord({
      thread: id, pylonId, node, desired: "running",
      boot: {
        pylonId, image: "img-000000000000", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
        repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
        dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
      },
      firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash-1" as LiveHash,
    });
    registry.createThread(thread, pylon, claude ? "hello" : undefined);
    if (claude) {
      registry.setClaudeWorker(id, "hello", "started", undefined, "s1");
      const entries = Array.from({ length: 20 }, (_, i) => ({ kind: "reply" as const, at: i, text: `reply ${i}` }));
      assert.equal(registry.appendClaudeRead(id, { session: "s1", from: transcriptStart, entries, cursor: { offset: 10, skipping: false, before: "h" }, reset: false, readAt: 10 }), true);
    }
    const report = (kind: "session.turn-started" | "session.waiting") => registry.reportSession(node, { sequence: ++sequence, pylon: pylonId, time: Date.now(), event: { kind, session: "s1", at: 100 + sequence } });
    if (n % 5 === 0) report("session.turn-started");
    if (n % 7 === 0) report("session.waiting");
    if (n % 4 === 3) registry.setThreadStatus(id, "deleted");
  }
  const capacity = { cpus: 1024, committedCpus: 0, memoryGiB: 4096, committedMemoryGiB: 0, diskFreeGiB: 10_000, committedDiskGiB: 0 };
  const live = registry.threads().filter((t) => t.status !== "deleted");
  const observation: NodeObservation = {
    node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
    pylons: live.map((t, i): NodeObservation["pylons"][number] => i === 0 ? {
      pylonId: t.pylonId, phase: "running", liveHash: null, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000", checkpoint: null },
      services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    } : i % 2 === 0 ? { pylonId: t.pylonId, phase: "booting" } : { pylonId: t.pylonId, phase: "stopped", checkpoint: null, sessions: null }),
  };
  registry.ingested(observation, [{ record: "node", node, state: "online", capacity }]);
}

/** What main.ts reads at start to open the harness, on whichever checkout this runs. */
function startRead(registry: Registry) {
  const narrow = (registry as Registry & { harnessThreads?: () => { id: ThreadId; status: string; conversationId: string | null }[] }).harnessThreads;
  const harness = narrow !== undefined ? narrow() : registry.threads().filter((t) => registry.agent(t).kind === "harness");
  return { live: harness.filter((t) => t.status !== "deleted").length, deleted: harness.filter((t) => t.status === "deleted").map((t) => t.conversationId!) };
}

const registry = openRegistry(join(dir, "registry.db"));
seed(registry);
const rows: [string, number | string][] = [];
const all = counted(() => registry.threads());
rows.push([`threads(), ${all.result.length} threads`, all.statements]);
rows.push(["thread(id) for each of them", counted(() => all.result.forEach((t) => registry.thread(t.id))).statements]);
const record = registry.node(node)!;
const tallies = counted(() => nodePylons(registry, record));
rows.push([`nodePylons, ${record.observation!.pylons.length} observed pylons`, tallies.statements]);
const room = counted(() => roomLeft(registry, node, record.observation!, record.observation!.capacity!, { cpus: 1, memoryGiB: 1, diskGiB: 1 }));
rows.push(["roomLeft", room.statements]);
const running = all.result.find((t) => t.status !== "deleted")!;
const before = statements;
await registryLocator(registry).awaitRunning(running.pylonId, Date.now() + 1_000);
rows.push(["locator poll of a running pylon", statements - before]);
const first = counted(() => startRead(registry));
rows.push(["start-up read", first.statements]);
rows.push(["deleted conversations the first start aborts", first.result.deleted.length]);
const recordAborted = (registry as Registry & { recordAborted?: (id: string) => void }).recordAborted;
for (const id of first.result.deleted) recordAborted?.(id);
rows.push(["deleted conversations the next start aborts", startRead(registry).deleted.length]);

let listener: ((value: LiveState) => Promise<void>) | undefined;
const busy: LiveState = { run: { taskId: 1 as TaskId, inputs: [] } };
const observer = { watchDoc: async () => ({ value: busy, start: (l: typeof listener) => { listener = l; }, stop: async () => ({}) }) } as unknown as DocumentObserver;
let parkedReports = 0;
const tracker = trackActivity({ onChange: () => {}, onParked: () => { parkedReports++; } });
await tracker.track(observer, "th-x", 1 as ConversationId, true, context);
for (let i = 0; i < 100; i++) await listener!(busy);
tracker.park(1 as ConversationId, 9 as TaskId);
for (let i = 0; i < 100; i++) await listener!(busy);
tracker.retried("th-x");
await tracker.close();
rows.push(["onParked calls over track, 200 pi.live changes, a park and a retry", parkedReports]);

assert.equal(all.result.length, threads);
registry.close();
await rm(dir, { recursive: true });
for (const [what, n] of rows) console.log(`${what}\t${n}`);
