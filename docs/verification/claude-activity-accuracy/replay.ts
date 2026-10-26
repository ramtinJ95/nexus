// node replay.ts <hooks.jsonl> <events.jsonl> <session prefixes, comma-separated>
// Replays the named real Claude sessions from one pylon into one thread of a fresh registry, twice: as the old hook
// would have reported the raw hook inputs, and as capture-server.mjs recorded the branch's hook reporting them. The person reads each
// reply right after it is printed, so a waiting session shows. Each line is the thread's attention, whether a session
// turn runs, and whether a reply is recorded.
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
const [hooksFile, eventsFile, prefixes] = process.argv.slice(2) as [string, string, string];
const named = (session: string) => prefixes.split(",").some((prefix) => session.startsWith(prefix));

const oldKinds: Record<string, PylonEvent["kind"]> = {
  UserPromptSubmit: "session.turn-started", PostToolUse: "session.heartbeat", Stop: "session.turn-ended", Notification: "session.waiting", SessionEnd: "session.ended",
};
const lastBeat = new Map<string, number>();
const short = (session: string) => session.slice(0, 8);
const old: Report[] = lines(hooksFile).flatMap(({ t, hook, payload }): Report[] => {
  let kind = oldKinds[hook];
  if (kind === undefined) return [];
  const session = payload.session_id as string;
  if (!named(session)) return [];
  const running = (payload.background_tasks ?? []).filter((b: { status: string }) => b.status === "running").map((b: { type: string }) => b.type);
  if (hook === "Notification" && !/permission_prompt|idle_prompt|elicitation_dialog/.test(payload.notification_type)) return [];
  if (hook === "Stop" && running.includes("subagent")) kind = "session.heartbeat";
  if (kind === "session.heartbeat") {
    if (t - (lastBeat.get(session) ?? -Infinity) < heartbeatIntervalMs) return [];
    lastBeat.set(session, t);
  }
  const what = hook === "Stop" ? `Stop, running ${JSON.stringify(running)}` : hook === "Notification" ? `Notification ${payload.notification_type}` : hook;
  return [{ time: t, event: { kind, session, at: t }, note: `${short(session)} ${what}` }];
});
const captured: Report[] = lines(eventsFile).filter(({ request }) => named(request.session)).map(({ time, request: { op: _, ...event } }) => ({
  time, event, note: `${short(event.session)}${event.at < time - 60_000 ? `, held report stamped ${((time - event.at) / 1000).toFixed(0)} s earlier` : ""}`,
}));

function replay(title: string, reports: Report[]) {
  const node = "rj-firebat" as NodeName;
  const pylonId = "pylon-th-verify" as PylonId;
  const project: RemoteProject = {
    id: "verify" as ProjectId, repoUrl: "https://example.com/verify.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 },
    allowedHosts: [], secrets: [], logins: ["claude"], preSetup: null,
  };
  reports.sort((a, b) => a.time - b.time);
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
  console.log(`\n${title}\n  +s      report                  attention  session turn  reply`);
  reports.forEach(({ time, event, note }, i) => {
    now = time;
    registry.reportSession(node, { sequence: i + 1, pylon: pylonId, time, event });
    const t = registry.thread(thread.id)!;
    const attention = registry.events("0", { kinds: ["attention.changed"] }).at(-1)?.payload.attention ?? null;
    const at = ((time - start) / 1000).toFixed(1).padStart(6);
    console.log(`  ${at}  ${event.kind.padEnd(22)}  ${String(attention).padEnd(9)}  ${String(t.sessionTurnRunning === true).padEnd(12)}  ${t.lastReplyAt === null ? "no " : "yes"}   (${note})`);
    registry.markSeen(thread.id, false, now);
  });
  registry.close();
}

replay("Old hook", old);
replay("This branch's hook", captured);
