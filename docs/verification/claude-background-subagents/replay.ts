// node replay.ts <events.jsonl> <hooks.jsonl>
// Replays one real Claude session into a fresh registry at the receipt times captured, twice: as the image's old hook
// would have reported the raw hook inputs, and as capture-server.mjs recorded the new hook reporting them. After each
// report it prints the thread's attention, whether a session turn runs, and whether a reply is recorded.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { newPylonRecord } from "../../../src/tick.ts";
import { heartbeatIntervalMs } from "../../../images/pylon/nexus-heartbeat.ts";
import type { PylonEvent } from "../../../src/events.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";
import type { ProjectId, RemoteProject } from "../../../src/project.ts";

type Report = { time: number; event: PylonEvent; note: string };
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const [eventsFile, hooksFile] = process.argv.slice(2) as [string, string];

const oldKinds: Record<string, PylonEvent["kind"]> = { UserPromptSubmit: "session.turn-started", PostToolUse: "session.heartbeat", Stop: "session.turn-ended", SessionEnd: "session.ended" };
let lastBeat = -Infinity;
const old: Report[] = lines(hooksFile).flatMap(({ t, hook, payload }): Report[] => {
  const kind = oldKinds[hook];
  if (kind === undefined) return [];
  if (kind === "session.heartbeat") {
    if (t - lastBeat < heartbeatIntervalMs) return [];
    lastBeat = t;
  }
  const note = hook === "Stop" ? `Stop, background_tasks ${JSON.stringify((payload.background_tasks ?? []).map((b: { type: string; status: string }) => `${b.type}:${b.status}`))}` : `${hook}${payload.agent_id ? ` in subagent ${payload.agent_id}` : ""}`;
  return [{ time: t, event: { kind, session: payload.session_id, at: t }, note }];
});
const captured: Report[] = lines(eventsFile).map(({ time, request: { op: _, ...event } }) => ({ time, event, note: "" }));

function replay(title: string, reports: Report[]) {
  const node = "rj-firebat" as NodeName;
  const pylonId = "pylon-th-verify" as PylonId;
  const project: RemoteProject = {
    id: "verify" as ProjectId, repoUrl: "https://example.com/verify.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 },
    allowedHosts: [], secrets: [], logins: ["claude"], preSetup: null,
  };
  const start = reports[0]!.time;
  const thread: Thread = {
    id: "th-verify" as ThreadId, title: "verify", project: project.id, pylonId, status: "active", conversationId: null, startedBy: "nVERIFY",
    createdAt: start, agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: 0, seenAt: start, lastReplyAt: null,
  };
  let now = start;
  const registry = openRegistry(join(tmpdir(), `replay-${randomUUID()}.db`), () => now);
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nVERIFY" as TailnetNodeId });
  registry.createProject(project);
  const { desired: _, ...pylon } = newPylonRecord({
    thread: thread.id, pylonId, node, desired: "running",
    boot: { pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "empty", branch: "main" }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" } },
    firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "h" as LiveHash,
  });
  registry.createThread(thread, pylon);
  console.log(`\n${title}\n  +s     report                  attention  session turn  reply`);
  reports.forEach(({ time, event, note }, i) => {
    now = time;
    registry.reportSession(node, { sequence: i + 1, pylon: pylonId, time, event });
    const t = registry.thread(thread.id)!;
    const attention = registry.events("0", { kinds: ["attention.changed"] }).at(-1)?.payload.attention ?? null;
    const at = ((time - start) / 1000).toFixed(1).padStart(6);
    console.log(`  ${at}  ${event.kind.padEnd(22)}  ${String(attention).padEnd(9)}  ${String(t.sessionTurnRunning === true).padEnd(12)}  ${t.lastReplyAt === null ? "no" : "yes"}${note ? `   (${note})` : ""}`);
  });
  registry.close();
}

replay("Old hook, from the raw hook inputs", old);
replay("New hook, as captured from nexus-claude-hook", captured);
