/**
 * The probe's side of NEXUS_API for one pylon, from the probe's own parts: the pylon API that validates and answers
 * `op: "event"`, the event journal it commits to before answering, and a registry that applies each journaled
 * report as control does. Only the VM and the observe link are missing: on start it replays the journal into the
 * registry, as a snapshot would. LOSE_FIRST_ACK=1 drops the connection after journaling the first event, as a
 * probe that dies between its commit and its answer would.
 *   node stand-in-probe.ts <port> <state dir>
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { createPylonApi } from "../../../src/probe/pylon-api.ts";
import { eventJournal } from "../../../src/probe/event-journal.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { newPylonRecord } from "../../../src/tick.ts";
import type { NodeName, PylonId, TailnetNodeId, LiveHash } from "../../../src/protocol.ts";
import type { ProjectId, RemoteProject } from "../../../src/project.ts";

const [port, state] = process.argv.slice(2) as [string, string];
const node = "rj-firebat" as NodeName;
const threadId = "th-verify" as ThreadId;
const pylonId = "pylon-th-verify" as PylonId;
const registryPath = join(state, "registry.sqlite");
const registry = openRegistry(registryPath);
if (registry.thread(threadId) === undefined) {
  const project: RemoteProject = {
    id: "verify" as ProjectId, repoUrl: "https://example.com/verify.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  };
  const thread: Omit<Thread, "seenAt" | "lastReplyAt"> = {
    id: threadId, title: "verify", project: project.id, pylonId, status: "active", conversationId: null, startedBy: "nVERIFY",
    createdAt: Date.now(), agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now(),
  };
  const { desired: _, ...pylon } = newPylonRecord({
    thread: threadId, pylonId, node, desired: "running",
    boot: {
      pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    },
    firstBoot: { kind: "fresh", preSetup: null },
    live: { previews: [], overlay: [] },
    liveHash: "hash-1" as LiveHash,
  });
  registry.upsertNode({ name: node, tailnetHost: "verify.ts.net", tailnetNodeId: "nVERIFY" as TailnetNodeId });
  registry.createProject(project);
  registry.createThread(thread, pylon);
}
const journal = eventJournal(join(state, "events.sqlite"));
const log = (record: object) => console.log(JSON.stringify({ t: new Date().toISOString(), ...record }));
const facts = () => {
  const t = registry.thread(threadId)!;
  return { sessionTurnRunning: t.sessionTurnRunning ?? false, lastReplyAt: t.lastReplyAt, sessionEvents: registry.events("0", { thread: threadId, kinds: ["session.turn-started", "session.heartbeat", "session.turn-ended", "session.ended"] }).map((e) => e.kind) };
};
for (const report of journal.recent()) registry.reportSession(node, report);
log({ started: true, pid: process.pid, replayed: journal.recent().length, ...facts() });

const api = createPylonApi({
  event(pylon, event) {
    const report = journal.append(pylon, event);
    registry.reportSession(node, report);
    log({ journaled: report.sequence, kind: event.kind, at: event.at, id: event.id, ...facts() });
  },
  // Events never reach the guest; the API looks it up before it reads the op.
  guest: () => ({}) as never,
  published: () => [],
  changed() {},
  previewUrl: async () => null,
  withdraw: async () => {},
  linked() {},
});
let loseAck = process.env.LOSE_FIRST_ACK === "1";
createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const reply = await api.answer(pylonId, body);
  if (loseAck) {
    loseAck = false;
    log({ droppedAnswer: reply.status });
    return void res.destroy();
  }
  res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
}).listen(Number(port), "127.0.0.1");
