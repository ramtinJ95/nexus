// A local Nexus control plane for the Needs you captures: the real registry, API, dashboard and review loop on
// 127.0.0.1:7470, as src/control/main.ts wires them, with 49 threads in three projects. Ten wait on the person:
//  - three held reviews: #41 held while its GitHub checks were pending, which have passed since, #42 held by a hold
//    the policy reserves for the person, which they may waive, and #45 approved by a Claude reviewer, which nothing on
//    the dashboard gets past;
//  - two questions of the Nexus agent's, one reserved for a deployer;
//  - one Claude worker's AskUserQuestion;
//  - one Claude worker whose dialog waits in its terminal, one stopped on its usage limit, and one whose launch failed;
//  - one review that ran out of rounds, which only the thread's page can take further.
// The other 34, and the reviewers of the four reviews, are idle, working or have a new reply.
// Stand-ins replace only what this pylon cannot host, as in dashboard-land-button/stack.ts:
//  - GitHub is a fetch handler behind the real githubClient. Each PR is open at its approved head and its checks pass.
//  - A check thread's run passes 6 s after it starts, and the node's release worker reports a release healthy 8 s
//    after it is desired.
//  - The probe answers only the pylon hook's `answer` command, as the hook does once Claude takes the answer, and logs
//    what it was handed in hook.log. ask-user-question-card covers the real hook and Claude.
//  - whois answers the laptop, a deployer. POST /verify/fail on port 7489 fails one more Claude worker, so the driver
//    can watch a notice open its card.
// The same file runs on main and on the branch.
//
//   EVIDENCE=<dir> node docs/verification/needs-you/stack.ts
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { agentReplies, reviewLoop, type Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { transcriptStart } from "../../../src/claude-transcript.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-needs-evidence-"));
mkdirSync(evidence, { recursive: true });
const log = (file: string, line: string) => appendFileSync(join(evidence, file), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nVERIFYNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const hex = (n: number) => n.toString(16).repeat(40).slice(0, 40);
const release0 = hex(1);
const now = Date.now();
const minutes = (n: number) => now - n * 60_000;

const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-needs-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
registry.setCurrentImage("img-0000000000aa" as never);
for (const id of ["nexus", "shop", "notes"]) {
  registry.createProject({ id, repoUrl: `https://github.com/${id === "nexus" ? repo : `ramtinJ95/${id}`}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
}
registry.setDesiredRelease({ commit: release0, requestedBy: "verify seed", requestedAt: now });
for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: release0, target: release0, state: "healthy", reason: null, observedAt: now });

function observe() {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => ({
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2026-10-27T00:00:00Z",
    bootedFrom: { image: "img-0000000000aa" as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [], events: [], heldSecrets: [] }, []);
}

const notCheckedLive = "- A real deploy to the home lab: the stack's release worker stands in for it.\n- A real phone's browser.";
const prs = new Map<number, { title: string; head: string; merged: string | null }>([
  [41, { title: "Cache the thread list between polls", head: hex(4), merged: null }],
  [42, { title: "Rename nexus deploy --wait to --follow", head: hex(5), merged: null }],
  [45, { title: "Show the node's load in the sidebar", head: hex(6), merged: null }],
  [46, { title: "Retry a failed image build", head: hex(7), merged: null }],
]);
const bodies: Record<number, string> = {
  41: "## What changes\nThe sidebar and the home page no longer read the whole thread list on every poll. A poll reads only the threads that changed since the last one, so a control plane with many threads answers in a few milliseconds.",
  42: "`nexus deploy --wait` is now `--follow`, which says what it does: it follows the deploy until every service reports healthy. Scripts that pass `--wait` get an error that names the new flag.",
  45: "Each node in the sidebar shows its load over the last minute beside its memory.",
  46: "A failed image build is retried once on another node before it is reported.",
};
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  log("github.log", `${method} ${url.pathname}`);
  const listed = /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname) ? Number(/:feature-(\d+)$/.exec(url.searchParams.get("head") ?? "")?.[1]) : NaN;
  if (prs.has(listed)) return Response.json([{ number: listed, head: { repo: { full_name: repo } } }]);
  const m = /^\/repos\/[^/]+\/[^/]+\/(pulls|commits)\/([0-9a-f]+)(\/.*)?$/.exec(url.pathname);
  const pr = m?.[1] === "pulls" ? prs.get(Number(m[2])) : [...prs.values()].find((p) => p.head === m?.[2]);
  if (m === null || pr === undefined) return Response.json([]);
  const number = [...prs].find(([, p]) => p === pr)![0];
  if (m[3] === undefined) return Response.json({
    number, title: pr.title, html_url: `https://github.com/${repo}/pull/${number}`, state: pr.merged ? "closed" : "open", merged: pr.merged !== null,
    body: `${bodies[number]}\n\n## Not checked live\n\n${notCheckedLive}`, merge_commit_sha: pr.merged, head: { sha: pr.head, ref: `feature-${number}`, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  if (m[3] === "/check-runs") return Response.json({ check_runs: [{ id: number, name: "ci", status: "completed", conclusion: "success", details_url: null, completed_at: "2026-10-27T00:00:00Z" }] });
  if (m[3] === "/files") return Response.json([{ filename: "src/control/dashboard.ts", patch: "@@ -1 +1 @@\n-a\n+b" }]);
  if (m[3] === "/merge" && method === "PUT") {
    const { sha } = JSON.parse(String(init!.body));
    if (sha !== pr.head) return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
    pr.merged = hex(8 + number - 41);
    log("github.log", `merged PR #${number} at ${sha} as ${pr.merged}`);
    return Response.json({ sha: pr.merged, merged: true, message: "Pull Request successfully merged" });
  }
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const started = new Map<ThreadId, number>();
const checks: CheckRuns = {
  async start(builder, _branch, head) {
    const t = await startThread({ project: builder.project, title: `Check ${head.slice(0, 12)}`, node }, "nexus-check");
    started.set(t.id, Date.now());
    return t.id;
  },
  poll(thread) {
    if (Date.now() - (started.get(thread) ?? 0) < 6_000) return { kind: "running" };
    return { kind: "done", passed: true, output: "npm run typecheck: ok\nnpm test: 1165 passed" };
  },
  discard(thread) {
    if (registry.thread(thread)?.status !== "deleted") registry.setThreadStatus(thread, "deleted");
  },
};

const fake = fakeHarness();
const wake = () => {};
const startThread = threadStarter({ registry, harness: fake.harness, wake, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const reviews = reviewLoop({
  registry, github, inbox: agentInbox({ registry, harness: fake.harness, probes: new Map(), wake }), harnessModel: "gpt-6-astra", startThread,
  replies: agentReplies(registry, fake.harness), checks, live: checks, release: { self: nodeId, repo }, mayLand: (caller) => caller === laptop, wake, log: (message) => console.error(message),
});
const probe = {
  async command(pylonId: string, command: { kind: string; argv?: readonly string[] }) {
    if (command.kind !== "exec" || command.argv?.[1] !== "answer") throw new Error(`the verify probe runs only the hook's answer, not ${command.kind}`);
    log("hook.log", `pylon ${pylonId} was handed ${command.argv[2]}`);
    return { kind: "exec", exitCode: 0, output: "delivered\n", truncated: false };
  },
  stream() { throw new Error("the verify probe streams nothing"); },
  health() { throw new Error("the verify probe reads no health"); },
};
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: true, reviews,
  deployment: { self: nodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  harness: fake.harness, startThread, wake, probes: new Map([[node, probe as never]]), previewPorts: { first: 10200, last: 10299 },
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  return await res.json() as Thread;
};
const start = (project: string, title: string) => post("/v1/threads", { project, title });
const claude = async (project: string, title: string) => {
  const t = await post("/v1/threads", { project, title, claude: title.toLowerCase() });
  registry.setClaudeWorker(t.id, title.toLowerCase(), "started", undefined, "s1");
  return t;
};

const quiet = [
  ["nexus", "Tidy the probe's logs"], ["nexus", "Name the poll interval"], ["nexus", "Drop the old image pins"], ["nexus", "Explain the merge policy"],
  ["nexus", "Count tokens per role"], ["nexus", "Speed up the slice test"], ["nexus", "Page the event log"], ["nexus", "Theme the dashboard"],
  ["nexus", "Render images in replies"], ["nexus", "Read the node's temperatures"], ["nexus", "Draft the install guide"], ["nexus", "Check the join token's expiry"],
  ["shop", "Fix the checkout total"], ["shop", "Add a gift card"], ["shop", "Cache product pages"], ["shop", "Translate the cart"], ["shop", "Resize thumbnails"],
  ["shop", "Audit the payment logs"], ["shop", "Move to the new CDN"], ["shop", "Count abandoned carts"], ["shop", "Bump the framework"],
  ["notes", "Sync notes offline"], ["notes", "Search by tag"], ["notes", "Export to Markdown"], ["notes", "Fix the dark editor"], ["notes", "Share a notebook"],
  ["notes", "Import from Evernote"], ["notes", "Undo across devices"], ["notes", "Attach images"], ["notes", "Lock a note"], ["notes", "Spell check"],
  ["notes", "Sort by edited"], ["shop", "Rate limit the API"], ["nexus", "Prune merged worktrees"],
] as const;
for (const [i, [project, title]] of quiet.entries()) {
  const t = await start(project, title);
  registry.recordActivity(t.id, { human: minutes(200 - i * 5), agent: minutes(190 - i * 5) });
  if (i % 4 === 1) registry.recordReply(t.id, minutes(30 - i / 2));
}

async function seedReview(number: number, title: string, phase: Review["phase"], extra: Partial<Review>, since: number): Promise<ThreadId> {
  const pr = prs.get(number)!;
  const builder = await start("nexus", title);
  registry.apply({ record: "output", pylonId: builder.pylonId, kind: "branch", ref: `origin/feature-${number}` });
  const reviewer = await start("nexus", `Review of #${number}: ${pr.title}`);
  registry.saveReview({
    id: `rv-${number}0000000`.slice(0, 11), builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since, nudges: 0, startedAt: since - 3_600_000,
    pr: { repo, number, url: `https://github.com/${repo}/pull/${number}`, title: pr.title, branch: `feature-${number}` },
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: { requestedBy: laptop }, auto: false, merged: null, waiver: null,
    rounds: [
      { head: hex(2), verdict: { token: "t1", verdict: "changes", findings: [{ id: "F1", priority: "P1", where: "src/control/dashboard.ts:212", summary: "A thread archived during a poll keeps its stale row" }], reserved: [], notCheckedLive }, check: null, answers: [{ id: "F1", action: "fixed", reason: "" }] },
      { head: pr.head, verdict: { token: "t2", verdict: "approve", findings: [{ id: "N1", priority: "P3", where: null, summary: "Name the poll interval constant" }], reserved: [], notCheckedLive }, check: { passed: true, output: "npm run typecheck: ok\nnpm test: 1165 passed" }, live: { kind: "absent" }, answers: null },
    ],
    phase, ...extra,
  });
  return builder.id;
}

const ids = {
  held: await seedReview(41, "Cache the thread list", { kind: "needs-person", reasons: ["The pull request's GitHub checks are pending."] }, {}, minutes(95)),
  reserved: await seedReview(42, "Rename the deploy flag", { kind: "needs-person", reasons: [
    "Always needs the person: breaking changes to the CLI's contract, by the reviewer's reading (renames nexus deploy --wait, which scripts call).",
  ] }, {}, minutes(80)),
  claudeReviewed: await seedReview(45, "Show node load", { kind: "approved" }, { reviewerKind: "claude", land: null }, minutes(70)),
  outOfRounds: await seedReview(46, "Retry image builds", { kind: "needs-person", reasons: ["The review ran out of rounds: 5 of 5, and the reviewer still asks for changes."] }, {}, minutes(65)),
  question: (await start("nexus", "Rebuild the pylon image")).id,
  deployerQuestion: (await start("shop", "Rotate the payment keys")).id,
  ask: (await claude("notes", "Pick the editor font")).id,
  dialog: (await claude("shop", "Migrate the orders table")).id,
  limited: (await claude("notes", "Write the sync docs")).id,
  failed: (await claude("shop", "Port the CLI to Rust")).id,
};
const outOfRounds = registry.review(ids.outOfRounds)!;
registry.saveReview({ ...outOfRounds, rounds: outOfRounds.rounds.with(-1, { ...outOfRounds.rounds.at(-1)!, verdict: { ...outOfRounds.rounds.at(-1)!.verdict!, verdict: "changes" }, check: null }) });
registry.askQuestion({ id: "qn-image", thread: ids.question, text: "The base layer changed, so every pylon boots from a new image once it is built.\n\nRebuild the pylon image now?", options: ["Rebuild", "Not now"], reserved: null, answerer: "person", askedAt: minutes(60) });
registry.askQuestion({ id: "qn-keys", thread: ids.deployerQuestion, text: "Rotating the keys restarts the payment service. **Rotate them now?**", options: ["Rotate", "Wait for the weekend"], reserved: "secrets", answerer: "deployer", askedAt: minutes(50) });
registry.setWaitingAsks(ids.ask, [{ ask: { session: "s1", toolUseId: "toolu_font", questions: [
  { question: "Which font should the editor use?", header: "Font", multiSelect: false, options: [{ label: "Inter", description: "The UI's own font", preview: "The quick brown fox" }, { label: "iA Writer Quattro", description: "Made for writing" }] },
  { question: "Which sizes should it offer?", header: "Sizes", multiSelect: true, options: [{ label: "14", description: "" }, { label: "16", description: "" }, { label: "18", description: "" }] },
] }, at: minutes(40) }]);
registry.reportSession(node, { sequence: 1, pylon: registry.thread(ids.dialog)!.pylonId, time: minutes(30), event: { kind: "session.waiting", session: "s1", at: minutes(30), message: "Claude needs your permission to use Bash" } });
registry.recordActivity(ids.dialog, { agent: minutes(30) });
registry.appendClaudeRead(ids.limited, { session: "s1", from: transcriptStart, entries: [{ kind: "notice", at: minutes(20), tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: now + 2 * 3_600_000 } }], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: minutes(20) });
registry.setClaudeWorker(ids.failed, "port the cli to rust", "failed", "Claude launch did not complete: claude exited 1 before its session started");
registry.appendEvent("thread.failed", ids.failed, { message: "Claude launch did not complete" });
registry.recordActivity(ids.failed, { agent: minutes(10) });
const working = await start("nexus", "Stream the thread list");
fake.transcript(working.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };

let deployed = release0;
setInterval(() => {
  observe();
  const desired = registry.desiredRelease()!.commit;
  if (desired === deployed) return;
  deployed = desired;
  setTimeout(() => {
    for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: desired, target: desired, state: "healthy", reason: null, observedAt: Date.now() });
    log("release.log", `reported ${desired} healthy`);
  }, 8_000);
}, 500);
const watch = prWatcher({ registry, github, inbox: agentInbox({ registry, harness: fake.harness, probes: new Map(), wake }) });
await watch.poll();
setInterval(() => { void reviews.poll(); void watch.poll(); }, 1_000);
observe();

createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    if (req.url !== "/verify/fail" || req.method !== "POST") return void res.writeHead(404).end();
    const t = await claude("nexus", "Bump the Node pin");
    registry.setClaudeWorker(t.id, "bump the node pin", "failed", "Claude launch did not complete: the pylon ran out of disk");
    registry.appendEvent("thread.failed", t.id, { message: "Claude launch did not complete" });
    log("stack.log", `failed ${t.id}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: t.id }));
  });
}).listen(7489, "127.0.0.1");

console.log(JSON.stringify({ ...ids, laptop, evidence }));
