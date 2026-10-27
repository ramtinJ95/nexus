// A local Nexus control plane for the auto-review captures: the real registry, API, dashboard, PR watch, inbox and
// review loop, wired as src/control/main.ts wires them, on 127.0.0.1:7470 for a deployer and 127.0.0.1:7471 for a
// caller who is not one. The same file runs on main and on the branch, and passes the branch's new options, which
// main ignores. Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient. A builder's push opens a PR on its branch. A PR made to
//    conflict reports mergeable_state "dirty" and answers a merge 405, until its builder pushes a rebased head.
//  - Builders are Claude workers with no Claude Code. A thread's prompt says what it pushes ("push <branch>", and
//    "conflict" for a branch that conflicts with main). Each message typed into it is logged, and a CONFLICT finding
//    makes it push a rebased head and answer the finding as fixed, written as its transcript read would be.
//  - Reviewers are harness threads in the test's fake harness, which approve every head they are sent.
//    A prompt with "reserved" pushes a change under images/, which the merge policy holds for the person.
//  - The person closes a PR with POST http://127.0.0.1:7472/close/<number>, as on GitHub.
//  - .nexus/check passes a second after it starts, and the node reports each desired release healthy at once.
// The PR watch polls every 2 s and the review loop every second, instead of every 2 minutes and 15 s.
//
//   node docs/verification/auto-review/stack.ts
import { appendFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { canDeploy } from "../../../src/control/releases.ts";
import { agentReplies, reviewLoop } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import type { ImageId } from "../../../src/images.ts";
import type { CommandResult, NodeName, PylonCommand, PylonId, TailnetNodeId } from "../../../src/protocol.ts";
import { transcriptStart, type TranscriptCursor } from "../../../src/claude-transcript.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-auto-review-out-"));
const log = (file: string, line: string) => appendFileSync(join(out, file), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const phone = "nPHONE" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-auto-review-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };

let commits = 0;
const commit = (tag: string) => `${tag}${String(++commits).padStart(4, "0")}`.padEnd(40, "0");
let main = commit("aaaa");
registry.setDesiredRelease({ commit: main, requestedBy: "verify seed", requestedAt: Date.now() });
const reportHealthy = (release: string) => {
  for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: release, target: release, state: "healthy", reason: null, observedAt: Date.now() });
};
reportHealthy(main);

interface Pr { number: number; title: string; branch: string; head: string; conflict: boolean; reserved: boolean; merged: string | null; closed: boolean }
const prs: Pr[] = [];
const body = "Adds a greeting.\n\nNot checked live: the greeting is printed by a script, with no service to start.";
const pull = (p: Pr) => ({
  number: p.number, title: p.title, html_url: `https://github.com/${repo}/pull/${p.number}`, state: p.merged === null && !p.closed ? "open" : "closed", merged: p.merged !== null, body, merge_commit_sha: p.merged,
  head: { sha: p.head, ref: p.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: p.conflict ? "dirty" : "clean",
});
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const base = `/repos/${repo}`;
  const number = Number(/\/(?:pulls|issues)\/(\d+)/.exec(url.pathname)?.[1]);
  const p = prs.find((pr) => pr.number === number);
  if (method !== "GET") log("github.log", `${method} ${url.pathname}${init?.body ? ` ${String(init.body)}` : ""}`);
  if (url.pathname === `${base}/pulls`) {
    const branch = url.searchParams.get("head")!.split(":")[1];
    return Response.json(prs.filter((pr) => pr.branch === branch && pr.merged === null && !pr.closed).map(pull));
  }
  if (p !== undefined && url.pathname === `${base}/pulls/${p.number}`) return Response.json(pull(p));
  if (p !== undefined && url.pathname === `${base}/pulls/${p.number}/files`) return Response.json([{ filename: p.reserved ? `images/pylon/${p.branch}.Dockerfile` : `src/${p.branch}.ts`, patch: `@@ -0,0 +1 @@\n+export const greeting = "${p.title}";` }]);
  if (p !== undefined && url.pathname === `${base}/pulls/${p.number}/merge` && method === "PUT") {
    const { sha } = JSON.parse(String(init!.body));
    if (sha !== p.head) return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
    if (p.conflict) {
      log("github.log", `refused to merge PR #${p.number}: it conflicts with main`);
      return Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
    }
    p.merged = main = commit("eeee");
    log("github.log", `merged PR #${p.number} at ${sha} as ${p.merged}`);
    return Response.json({ sha: p.merged, merged: true, message: "Pull Request successfully merged" });
  }
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const fake = fakeHarness();
const harness = {
  ...fake.harness,
  async send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: "pr-watch" | "review") {
    const submission = await fake.harness.send(threadId, text, requestId, mode, sender);
    log("reviewer.log", `${threadId} received ${requestId}`);
    setTimeout(() => approve(threadId as ThreadId, text), 1_000);
    return submission;
  },
};
const tokenOf = (text: string) => /"token": "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(text)?.[1] ?? /token "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(text)?.[1];
function approve(thread: ThreadId, request: string) {
  const token = tokenOf(request);
  const head = registry.reviews().find((r) => r.reviewer === thread)?.rounds.at(-1)?.head;
  if (token === undefined || head === undefined) return;
  const verdict = { token, verdict: "approve", findings: [], reserved: [], notCheckedLive: "the greeting is printed by a script, with no service to start." };
  const text = `I read the change at ${head}. It does what it says.\n\n\`\`\`nexus-review\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
  fake.transcript(thread).messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never);
  fake.commit(thread);
  registry.recordReply(thread, Date.now());
  log("reviewer.log", `${thread} approved ${head}`);
}

// A builder's transcript, as the probe's reads would store it.
const cursors = new Map<ThreadId, TranscriptCursor>();
function transcribe(thread: ThreadId, entries: Parameters<typeof registry.appendClaudeRead>[1]["entries"]) {
  const from = cursors.get(thread) ?? transcriptStart;
  const cursor = { offset: from.offset + 1, skipping: false, before: from.before };
  registry.appendClaudeRead(thread, { session: registry.claudeWorker(thread)!.session!, from, entries, cursor, reset: false, readAt: Date.now() });
  cursors.set(thread, cursor);
}
function builderTyped(thread: Thread, text: string) {
  log("typed.log", `typed into ${thread.id}:\n${text}\n`);
  transcribe(thread.id, [{ kind: "prompt", at: Date.now(), text, from: "person" }]);
  const token = tokenOf(text);
  if (token === undefined || !text.includes("CONFLICT (P0)")) return;
  setTimeout(() => {
    const p = prs.find((pr) => pr.branch === registry.reviews().find((r) => r.builder === thread.id)?.pr.branch)!;
    p.head = commit("bbbb");
    p.conflict = false;
    log("github.log", `${thread.id} pushed ${p.branch} rebased onto main at ${p.head}`);
    const answers = { token, answers: [{ id: "CONFLICT", action: "fixed", reason: `Rebased ${p.branch} onto main, kept main's change and this greeting, reran the typecheck and the tests, and pushed ${p.head}.` }] };
    transcribe(thread.id, [{ kind: "reply", at: Date.now(), text: `Rebased and pushed.\n\n\`\`\`nexus-review-answers\n${JSON.stringify(answers, null, 2)}\n\`\`\`` }]);
    registry.recordReply(thread.id, Date.now());
  }, 1_500);
}

const probe = {
  async command(pylonId: PylonId, command: PylonCommand): Promise<CommandResult> {
    const thread = registry.threads().find((t) => t.pylonId === pylonId)!;
    if (command.kind === "send-claude") {
      builderTyped(thread, command.text);
      return { kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false };
    }
    if (command.kind === "send-claude-outcome") return { kind: "send-claude-outcome", send: "unknown" };
    throw Object.assign(new Error(`the verify stack's pylons run no ${command.kind}`), { code: "unsupported" });
  },
};
const probes = new Map([[node, probe]]);
const wake = () => {};
const inbox = agentInbox({ registry, harness, probes: probes as never, wake });
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness, mirror, dotfiles, wake });

const runs = new Map<ThreadId, number>();
let checks = 0;
const checkRuns: CheckRuns = {
  async start(_builder, _branch, head) {
    const id = `th-check${String(++checks).padStart(7, "0")}` as ThreadId;
    runs.set(id, Date.now());
    log("check.log", `.nexus/check started at ${head}`);
    return id;
  },
  poll(id, head) {
    if (Date.now() - runs.get(id)! < 1_000) return { kind: "running" };
    log("check.log", `.nexus/check passed at ${head}`);
    return { kind: "done", passed: true, output: "typecheck and tests passed" };
  },
  discard(id) { runs.delete(id); },
};

const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread,
  replies: agentReplies(registry, harness),
  checks: checkRuns,
  release: { self: nodeId, repo },
  mayLand: (caller) => canDeploy(registry, deployment, caller as TailnetNodeId),
  log: (message) => log("stack.log", message),
});
const watch = prWatcher({ registry, github, inbox, linked: (reviews as { auto?: Parameters<typeof prWatcher>[0]["linked"] }).auto });

const apiOptions = {
  registry, host: "127.0.0.1", prWatchEnabled: true, reviews, deployment,
  hostnames: new Set(["127.0.0.1", "localhost"]), dotfiles,
  harness, startThread, mirror, wake, probes: probes as never, previewPorts: { first: 10200, last: 10299 },
};
const api = await startApi({ ...apiOptions, port: 7470, whois: async () => laptop, allowed: new Set([laptop]) });
await startApi({ ...apiOptions, port: 7471, whois: async () => phone, allowed: new Set([phone]) });

const call = async (method: string, path: string, payload?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
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
for (const id of ["nexus", "nexus-manual"]) {
  await call("POST", "/v1/projects", {
    id, repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 1, memoryGiB: 1, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
}

function observe() {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => ({
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [] }, []);
}

// What the reconcile loop's launch and a builder's first push would leave: a started worker, a PR and a branch output.
let numbers = 0;
function launch() {
  for (const t of registry.threads()) {
    const worker = registry.claudeWorker(t.id);
    if (worker?.state !== "pending") continue;
    registry.setClaudeWorker(t.id, worker.prompt, "started", undefined, crypto.randomUUID());
    const [, branch, conflict, reserved] = /push ([\w-]+)( conflict)?( reserved)?/.exec(worker.prompt) ?? [];
    if (branch === undefined) continue;
    const pr: Pr = { number: ++numbers, title: t.title, branch, head: commit("cccc"), conflict: conflict !== undefined, reserved: reserved !== undefined, merged: null, closed: false };
    prs.push(pr);
    registry.apply({ record: "output", pylonId: t.pylonId, kind: "branch", ref: `origin/${branch}` });
    transcribe(t.id, [{ kind: "prompt", at: Date.now(), text: worker.prompt, from: "person" }, { kind: "reply", at: Date.now(), text: `Pushed ${branch} at ${pr.head} and opened PR #${pr.number}.` }]);
    registry.recordReply(t.id, Date.now());
    log("github.log", `${t.id} pushed ${branch} at ${pr.head}, opening PR #${pr.number}${pr.conflict ? ", which conflicts with main" : ""}`);
  }
}

let deployed = main;
setInterval(() => {
  observe();
  launch();
  const desired = registry.desiredRelease()!.commit;
  if (desired !== deployed) {
    deployed = desired;
    reportHealthy(desired);
    log("release.log", `desired release ${desired} by ${registry.desiredRelease()!.requestedBy}, reported healthy`);
  }
}, 200);
createServer((req, res) => {
  const p = prs.find((pr) => req.method === "POST" && req.url === `/close/${pr.number}`);
  if (p !== undefined) {
    p.closed = true;
    log("github.log", `the person closed PR #${p.number} without merging`);
  }
  res.writeHead(p === undefined ? 404 : 204).end();
}).listen(7472, "127.0.0.1");
setInterval(() => { void watch.poll(); }, 2_000);
setInterval(() => { void reviews.poll(); }, 1_000);
observe();
console.log(JSON.stringify({ out }));
