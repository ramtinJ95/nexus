// A local Nexus control plane for the nudge captures: the real registry, API, PR watch, inbox and, where the checkout
// has it, the nudge pass, wired as src/control/main.ts wires them, on 127.0.0.1:7470 for the person's laptop. The same
// file runs on main and on the branch. Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient. A builder's push opens a PR on its branch.
//  - Builders are Claude workers with no Claude Code. Each answers every message typed into it with a reply and a turn
//    end, written as its transcript read would be. Its prompt says what it does:
//      "push <branch>": pushes the branch and opens its PR as its first turn ends.
//      "stop-before-push <branch>": ends its first turn without pushing, and pushes when it is nudged.
//      "stop-before-push <branch> stay": ends every turn without pushing.
//      "investigate": answers, and never pushes.
// The PR watch polls every 2 minutes, as on the control plane, so a PR opened as a turn ends stays unlinked for a
// while. The nudge pass runs every second with a 2 s grace, instead of every 15 s with a minute's grace.
//
//   OUT=... node docs/verification/nudge-stalled-builder/stack.ts
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { transcriptStart, type ClaudeEntry, type TranscriptCursor } from "../../../src/claude-transcript.ts";
import type { ImageId } from "../../../src/images.ts";
import type { CommandResult, NodeName, PylonCommand, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-nudge-out-"));
const log = (file: string, line: string) => appendFileSync(join(out, file), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-nudge-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };

interface Pr { number: number; title: string; branch: string; head: string }
const prs: Pr[] = [];
const pull = (p: Pr) => ({
  number: p.number, title: p.title, html_url: `https://github.com/${repo}/pull/${p.number}`, state: "open", merged: false, body: "", merge_commit_sha: null,
  head: { sha: p.head, ref: p.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
});
const fakeGitHub: typeof fetch = async (input) => {
  const url = new URL(String(input));
  const base = `/repos/${repo}`;
  const p = prs.find((pr) => pr.number === Number(/\/(?:pulls|issues)\/(\d+)/.exec(url.pathname)?.[1]));
  if (url.pathname === `${base}/pulls`) {
    const branch = url.searchParams.get("head")!.split(":")[1];
    log("github.log", `searched ${branch} (state ${url.searchParams.get("state") ?? "open"})`);
    return Response.json(prs.filter((pr) => pr.branch === branch).map(pull));
  }
  if (p !== undefined && url.pathname === `${base}/pulls/${p.number}`) return Response.json(pull(p));
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const cursors = new Map<ThreadId, TranscriptCursor>();
function transcribe(thread: ThreadId, entries: ClaudeEntry[]) {
  const from = cursors.get(thread) ?? transcriptStart;
  const cursor = { offset: from.offset + 1, skipping: false, before: from.before };
  registry.appendClaudeRead(thread, { session: registry.claudeWorker(thread)!.session!, from, entries, cursor, reset: false, readAt: Date.now() });
  cursors.set(thread, cursor);
}
let numbers = 0;
function push(t: Thread, branch: string) {
  const pr: Pr = { number: ++numbers, title: t.title, branch, head: `cccc${numbers}`.padEnd(40, "0") };
  prs.push(pr);
  registry.apply({ record: "output", pylonId: t.pylonId, kind: "branch", ref: `origin/${branch}` });
  log("github.log", `${t.id} pushed ${branch}, opening PR #${pr.number}`);
  return pr;
}
/** One turn of the scripted builder: its reply, then its turn's end. */
function answer(t: Thread, text: string) {
  transcribe(t.id, [{ kind: "reply", at: Date.now(), text }]);
  registry.recordReply(t.id, Date.now());
  log("turns.log", `${t.id} ended a turn: ${text}`);
}
function turn(t: Thread, nudged: boolean) {
  const prompt = registry.claudeWorker(t.id)!.prompt;
  const [, mode, branch, stay] = /(push|stop-before-push|investigate) ?([\w-]+)?( stay)?/.exec(prompt) ?? [];
  if (mode === "push" && !prs.some((p) => p.branch === branch)) return answer(t, `Pushed ${branch} and opened PR #${push(t, branch!).number}.`);
  if (mode === "stop-before-push" && nudged && stay === undefined && !prs.some((p) => p.branch === branch)) return answer(t, `Pushed ${branch} and opened PR #${push(t, branch!).number}.`);
  if (mode === "stop-before-push") return answer(t, `The change to ${branch} is written and committed. I stopped before pushing, as the brief said.`);
  answer(t, mode === "investigate" ? "Here is what I found. Nothing to change." : "Done.");
}

const probe = {
  async command(pylonId: PylonId, command: PylonCommand): Promise<CommandResult> {
    const t = registry.threads().find((th) => th.pylonId === pylonId)!;
    if (command.kind === "send-claude") {
      log("typed.log", `typed into ${t.id}:\n${command.text}\n`);
      transcribe(t.id, [{ kind: "prompt", at: Date.now(), text: command.text, from: "person" }]);
      setTimeout(() => turn(registry.thread(t.id)!, command.text.startsWith("[Nexus nudge")), 500);
      return { kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false };
    }
    if (command.kind === "send-claude-outcome") return { kind: "send-claude-outcome", send: "unknown" };
    throw Object.assign(new Error(`the verify stack's pylons run no ${command.kind}`), { code: "unsupported" });
  },
};
const probes = new Map([[node, probe]]);
const fake = fakeHarness();
const wake = () => {};
const inbox = agentInbox({ registry, harness: fake.harness, probes: probes as never, wake });
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness: fake.harness, mirror, dotfiles, wake });
const watch = prWatcher({ registry, github, inbox });
const nudge = await import("../../../src/control/nudge.ts" as string).catch(() => null) as typeof import("../../../src/control/nudge.ts") | null;
const nudges = nudge?.builderNudger({ registry, github, inbox, harness: fake.harness, graceMs: 2_000, log: (message) => log("stack.log", message) });
log("stack.log", nudges === undefined ? "this checkout has no nudge pass" : "nudge pass running");

const api = await startApi({
  registry, host: "127.0.0.1", prWatchEnabled: true, deployment, hostnames: new Set(["127.0.0.1", "localhost"]), dotfiles,
  harness: fake.harness, startThread, mirror, wake, probes: probes as never, previewPorts: { first: 10200, last: 10299 },
  port: 7470, whois: async () => laptop, allowed: new Set([laptop]),
} as Parameters<typeof startApi>[0]);
const call = async (method: string, path: string, payload: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
await call("POST", "/v1/images", image);
registry.setCurrentImage(image.id as ImageId);
await call("POST", "/v1/projects", {
  id: "nexus", repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node,
  resources: { cpus: 1, memoryGiB: 1, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});

function observe() {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => ({
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", events: [], capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
}

// What the reconcile loop's launch would leave: a started worker that has its prompt and runs its first turn.
function launch() {
  for (const t of registry.threads()) {
    const worker = registry.claudeWorker(t.id);
    if (worker?.state !== "pending") continue;
    registry.setClaudeWorker(t.id, worker.prompt, "started", undefined, crypto.randomUUID());
    transcribe(t.id, [{ kind: "prompt", at: Date.now(), text: worker.prompt, from: "command" }]);
    turn(registry.thread(t.id)!, false);
  }
}

setInterval(() => { observe(); launch(); }, 200);
setInterval(() => { void watch.poll(); }, 120_000);
void watch.poll();
setInterval(() => { void nudges?.poll(); }, 1_000);
observe();
console.log(JSON.stringify({ out }));
