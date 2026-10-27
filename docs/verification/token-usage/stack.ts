// A local Nexus control plane for the token usage captures: the real registry, pi-durable harness, API, dashboard and,
// where the checkout has one, usage counter, wired as src/control/main.ts wires them, on plain HTTP at 127.0.0.1:7470.
// The harness answers with the scripted model of src/harness/test-fixture.ts. Stand-ins replace only what this pylon
// cannot host:
//  - Each pylon is a directory, WORK/pylons/<pylon>, that stands for its /home/user. Its probe runs only the usage
//    reader's pipe, as a local process, and points the paths it is sent under /home/user/ at that directory (probe.log).
//    Any other pipe, such as the Changes tab's read of the checkout, fails as a pylon that is not running would.
//  - Every pylon whose thread is not deleted is observed running. A deleted thread's directory is removed, as its
//    pylon's disk goes.
// On its first start, with an empty WORK, the stack starts three threads through the real thread starter:
//  - builder: a Nexus agent thread a person started, sent two messages.
//  - claude: a Claude worker thread a person started. Its pylon holds FIXTURES/claude-transcript.jsonl as the worker's
//    transcript, and FIXTURES/pi-session.jsonl as a harness reviewer's pi session in the same pylon. run.sh names the
//    branch's src/fixtures, so main's run reads the same files.
//  - reviewer: a Nexus agent thread the review loop started, sent one message.
// A later start on the same WORK reopens the same registry and harness storage, as a restarted control plane does.
// POST /verify/reread on port 7489 appends the Claude worker's transcript to itself, as a resumed or forked session
// copies records, and reports a session.turn-ended for it, as its Stop hook would.
//
//   WORK=<dir> EVIDENCE=<dir> FIXTURES=<dir> node docs/verification/token-usage/stack.ts
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { openRegistry, type ThreadId } from "../../../src/control/registry.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { openHarnessHost, type ConversationId } from "../../../src/harness/host.ts";
import { scriptedModel, scriptedModels } from "../../../src/harness/test-fixture.ts";
import { processStream } from "../../../src/process-stream.ts";
import type { ByteStream, NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const work = process.env.WORK!;
const evidence = process.env.EVIDENCE!;
mkdirSync(evidence, { recursive: true });
const log = (file: string, line: string) => appendFileSync(join(evidence, file), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const fixtures = process.env.FIXTURES!;

const fresh = !existsSync(join(work, "registry.db"));
mkdirSync(join(work, "pylons"), { recursive: true });
const registry = openRegistry(join(work, "registry.db"));
if (fresh) {
  registry.upsertNode({ name: node, tailnetHost: "verify-node.example.ts.net", tailnetNodeId: "nVERIFYNODE" as TailnetNodeId });
  registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
  registry.setCurrentImage("img-0000000000aa" as never);
  registry.createProject({ id: "nexus", repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
  registry.createProject({ id: "spoon", repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 1, memoryGiB: 1, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
}
const homeOf = (pylon: PylonId) => join(work, "pylons", pylon);
function observe() {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  const live = registry.pylonsOn(node).filter((p) => registry.thread(p.thread)?.status !== "deleted");
  for (const p of registry.pylonsOn(node)) {
    if (registry.thread(p.thread)?.status === "deleted" && existsSync(homeOf(p.pylonId))) {
      rmSync(homeOf(p.pylonId), { recursive: true });
      log("probe.log", `${p.pylonId}: its thread was deleted, so its disk is gone`);
    }
  }
  registry.ingested({
    node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [],
    pylons: live.map((p) => ({
      pylonId: p.pylonId, phase: "running", liveHash: p.liveHash, bootedAt: "2026-10-27T00:00:00Z", bootedFrom: { image: "img-0000000000aa", checkpoint: null },
      services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    })) as never,
  }, [{ record: "node", node, state: "online", capacity }]);
}
observe();

const probe = {
  async stream(pylon: PylonId, argv: readonly string[]): Promise<ByteStream> {
    log("probe.log", `${pylon}: ${argv.slice(0, 2).join(" ")} …`);
    if (argv[0] !== "python3" || argv[1] !== "-c") throw { code: "not-running", message: "the verify stack's pylons run only the usage reader" };
    const stream = processStream(argv[0]!, argv.slice(1), (text) => log("probe.log", `${pylon} stderr: ${text}`));
    return { ...stream, write: (chunk) => stream.write(Buffer.from(Buffer.from(chunk).toString().replaceAll("/home/user/", `${homeOf(pylon)}/`))) };
  },
};
const probes = new Map([[node, probe]]);

const conversing = registry.threads().filter((t) => t.conversationId !== null);
const conversationOf = (id: string | null) => Number(id) as ConversationId;
const harness = await openHarnessHost({
  storagePath: join(work, "harness.sqlite"), models: scriptedModels(), model: scriptedModel, tailscaled: join(work, "none.sock"),
  locator: { awaitRunning: () => Promise.reject(new Error("the verify stack's agents run no tools")) },
  threads: conversing.filter((t) => t.status !== "deleted").map((t) => ({ threadId: t.id, conversationId: conversationOf(t.conversationId), agentTurnRunning: t.agentTurnRunning })),
  deleted: conversing.filter((t) => t.status === "deleted").map((t) => conversationOf(t.conversationId)),
  onReply: (id, at) => registry.recordReply(id as ThreadId, at),
  onActivity: (id, facts) => registry.recordActivity(id as ThreadId, { agent: facts.lastAgentActivityAt, agentTurnRunning: facts.agentTurnRunning }),
  log: (message) => log("stack.log", message),
});
const counterModule = await import("../../../src/control/usage-counter.ts").catch(() => null);
const counter = counterModule?.usageCounter({ registry, probes, harness, log: (message) => log("stack.log", message) }) ?? null;
log("stack.log", counter === null ? "this checkout has no usage counter" : "the usage counter runs");

const startThread = threadStarter({ registry, harness, wake: () => {}, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } } as never);
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: false, reviews: null, queue: null,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  harness, startThread, wake: () => {}, probes, previewPorts: { first: 10200, last: 10299 },
} as never);

async function answered(id: ThreadId, replies: number) {
  for (let i = 0; i < 200; i++) {
    if (registry.events("0", { thread: id, kinds: ["thread.turn-ended"] }).length >= replies) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${id} did not answer ${replies} times`);
}
const send = async (id: ThreadId, text: string, n: number) => {
  await harness.send(id, text, `verify:${id}:${n}`, "followUp");
  await answered(id, n);
};

if (fresh) {
  const builder = await startThread({ project: "nexus", title: "Fix the flaky queue test" }, laptop);
  await send(builder.id, "hello", 1);
  await send(builder.id, "and again", 2);
  const claude = await startThread({ project: "nexus", title: "Build the usage page", claude: "build the usage page" }, laptop);
  const transcript = join(homeOf(claude.pylonId), ".claude/projects/-home-user-workspace-repo/6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30.jsonl");
  const session = join(homeOf(claude.pylonId), ".pi/agent/sessions/--home-user-workspace-repo--/2026-10-27T22-42-05-996Z_01a17f87-262c-71b1-937e-ee435ee114b8.jsonl");
  for (const [from, to] of [["claude-transcript.jsonl", transcript], ["pi-session.jsonl", session]] as const) {
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(join(fixtures, from), to);
  }
  const reviewer = await startThread({ project: "spoon", title: "Review of #160: Count tokens" }, "nexus-review");
  await send(reviewer.id, "review it", 1);
  log("stack.log", `seeded ${builder.id}, ${claude.id} and ${reviewer.id}`);
}
const titled = (title: string) => registry.threads().find((t) => t.title === title)!;
const ids = { builder: titled("Fix the flaky queue test").id, claude: titled("Build the usage page").id, reviewer: titled("Review of #160: Count tokens").id };
observe();
await counter?.sweep();
setInterval(observe, 500).unref();

createServer((req, res) => {
  if (req.url === "/verify/reread" && req.method === "POST") {
    const claude = registry.thread(ids.claude)!;
    const transcript = join(homeOf(claude.pylonId), ".claude/projects/-home-user-workspace-repo/6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30.jsonl");
    appendFileSync(transcript, readFileSync(transcript));
    registry.appendEvent("session.turn-ended", ids.claude, {});
    log("stack.log", `appended the transcript of ${ids.claude} to itself and reported its turn's end`);
    return void res.writeHead(204).end();
  }
  res.writeHead(404).end();
}).listen(7489, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await api.close();
      await counter?.close();
      await harness.close();
      registry.close();
      process.exit(0);
    })();
  });
}
console.log(JSON.stringify({ ...ids, evidence, fresh }));
