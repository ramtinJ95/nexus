// A local Nexus control plane for the held review captures: the real registry, API, dashboard, PR watch, inbox and
// review loop, wired as src/control/main.ts wires them, on 127.0.0.1:7470 for a deployer. One builder's PR #185
// adds a registry migration, which the merge policy reserves for the person, and its review starts at the merge step,
// so the loop's first pass holds it for the person at its approved head. The same file runs on main and on the branch.
// Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient, whose heads have no .nexus/verify. POST http://127.0.0.1:7472/push moves PR #185 to a
//    rebased head, as its builder's push after a conflict with main would (github.log).
//  - The reviewer is a harness thread in the test's fake harness, which approves every head it is sent (reviewer.log).
//  - .nexus/check passes 2 s after it starts (check.log).
// The PR watch reads GitHub only on POST /watch, and the review loop runs every second unless POST /pause stopped it
// until POST /resume, so the driver can capture the page between a push, the watch's read and the loop's next pass.
//
//   OUT=<dir> node docs/verification/held-review-new-head/stack.ts
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
import { agentReplies, reviewLoop, type Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-held-review-out-"));
const log = (file: string, line: string) => appendFileSync(join(out, file), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-held-review-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };
const release = "a".repeat(40);
registry.setDesiredRelease({ commit: release, requestedBy: "verify seed", requestedAt: Date.now() });
for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: release, target: release, state: "healthy", reason: null, observedAt: Date.now() });

const approvedHead = "103598e".padEnd(40, "0");
const rebasedHead = "b3ee8a6".padEnd(40, "0");
const notCheckedLive = "The planning cards on the live control plane could not be checked live; the stack stands in for it.";
const pr = { number: 185, title: "Planning threads whose proposals become decision cards", branch: "feat/planning-threads", head: approvedHead };
const migration = "@@ -284,4 +284,5 @@ const migrations: readonly string[] = [\n+  `CREATE TABLE planning_threads (thread TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;`,";
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const base = `/repos/${repo}`;
  if (method !== "GET") log("github.log", `${method} ${url.pathname}`);
  const pull = {
    number: pr.number, title: pr.title, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: "open", merged: false, merge_commit_sha: null,
    body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, head: { sha: pr.head, ref: pr.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  };
  if (url.pathname === `${base}/pulls`) return Response.json(url.searchParams.get("head")?.endsWith(`:${pr.branch}`) ? [pull] : []);
  if (url.pathname === `${base}/pulls/${pr.number}`) return Response.json(pull);
  if (url.pathname === `${base}/pulls/${pr.number}/files`) return Response.json([{ filename: "src/control/registry.ts", patch: migration }, { filename: "src/control/planning.ts", patch: "@@ -0,0 +1 @@\n+export {};" }]);
  if (url.pathname.startsWith(`${base}/contents/`)) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null, completed_at: "2026-10-28T00:00:00Z" }] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const fake = fakeHarness();
const harness = {
  ...fake.harness,
  async send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: "pr-watch" | "review") {
    const submission = await fake.harness.send(threadId, text, requestId, mode, sender);
    log("reviewer.log", `${threadId} received ${requestId}:\n${text}\n`);
    setTimeout(() => approve(threadId as ThreadId, text), 1_000);
    return submission;
  },
};
function approve(thread: ThreadId, request: string) {
  const token = /token "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(request)?.[1];
  const head = registry.reviews().find((r) => r.reviewer === thread)?.rounds.at(-1)?.head;
  if (token === undefined || head === undefined) return;
  const verdict = { token, verdict: "approve", findings: [], reserved: [], notCheckedLive };
  const text = `I read the rebased head ${head} against main and compared its commits with the ones I approved. It does what it says.\n\n\`\`\`nexus-review\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
  fake.transcript(thread).messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never);
  fake.commit(thread);
  registry.recordReply(thread, Date.now());
  log("reviewer.log", `${thread} approved ${head}`);
}

const wake = () => {};
const inbox = agentInbox({ registry, harness, probes: new Map(), wake });
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
    if (Date.now() - runs.get(id)! < 2_000) return { kind: "running" };
    log("check.log", `.nexus/check passed at ${head}`);
    return { kind: "done", passed: true, output: "npm run typecheck: ok\nnpm test: 1190 passed" };
  },
  discard(id) { runs.delete(id); },
};

const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread, replies: agentReplies(registry, harness), checks: checkRuns,
  live: { async start() { throw new Error("no live check runs here"); }, poll: () => ({ kind: "void" }), discard() {} },
  release: { self: nodeId, repo }, mayLand: (caller) => caller === laptop, wake, log: (message) => log("stack.log", message),
} as Parameters<typeof reviewLoop>[0]);
const watch = prWatcher({ registry, github, inbox });
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: true, reviews, deployment, hostnames: new Set(["127.0.0.1", "localhost"]), dotfiles,
  harness, startThread, mirror, wake, probes: new Map(), previewPorts: { first: 10200, last: 10299 }, whois: async () => laptop, allowed: new Set([laptop]),
} as Parameters<typeof startApi>[0]);

const call = async (method: string, path: string, payload?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json();
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-28T00:00:00Z", sha256: "a".repeat(64),
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
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2026-10-28T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [] }, []);
}

const builder = await call("POST", "/v1/threads", { project: "nexus", title: "Planning threads" }) as Thread;
const reviewer = await call("POST", "/v1/threads", { project: "nexus", title: `Review of #${pr.number}: ${pr.title}` }) as Thread;
registry.apply({ record: "output", pylonId: builder.pylonId, kind: "branch", ref: `origin/${pr.branch}` });
observe();
await watch.poll();
registry.saveReview({
  id: "rv-e94f1556", builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000,
  pr: { repo, number: pr.number, url: `https://github.com/${repo}/pull/${pr.number}`, title: pr.title, branch: pr.branch },
  models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: { requestedBy: laptop }, auto: false, merged: null, waiver: null,
  rounds: [{ head: approvedHead, verdict: { token: "t", verdict: "approve", findings: [], reserved: [], notCheckedLive }, check: { passed: true, output: "npm run typecheck: ok\nnpm test: 1188 passed" }, live: { kind: "absent" }, answers: null }],
  phase: { kind: "merging", authorized: null },
} as Review);
await reviews.poll();

let paused = false;
setInterval(observe, 500);
setInterval(() => { if (!paused) void reviews.poll(); }, 1_000);
createServer((req, res) => {
  void (async () => {
    if (req.method !== "POST") return void res.writeHead(404).end();
    if (req.url === "/push") {
      pr.head = rebasedHead;
      log("github.log", `the builder rebased ${pr.branch} onto main and pushed ${pr.head}`);
    } else if (req.url === "/watch") {
      await watch.poll();
      log("stack.log", `the PR watch read #${pr.number} at ${registry.prWatch(builder.id)!.links[0]!.pr.head ?? "(no head recorded)"}`);
    } else if (req.url === "/pause" || req.url === "/resume") {
      paused = req.url === "/pause";
      log("stack.log", `the review loop ${paused ? "paused" : "resumed"}`);
    } else return void res.writeHead(404).end();
    res.writeHead(204).end();
  })();
}).listen(7472, "127.0.0.1");
console.log(JSON.stringify({ builder: builder.id, reviewer: reviewer.id, approvedHead, rebasedHead, out }));
