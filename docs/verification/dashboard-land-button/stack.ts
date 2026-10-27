// A local Nexus control plane for the Land button captures: the real registry, API, dashboard and review loop on
// 127.0.0.1:7470, as src/control/main.ts wires them, with four builders whose reviews wait for the person:
//  - held: the policy held its landing because the PR's GitHub checks were pending. They have passed since.
//  - reserved: held because the reviewer named a breaking CLI change and the PR changes src/control/api.ts.
//  - approved: approved by a review started without --land. Its deploy fails, so its landing rolls back.
//  - refused: approved too, for the landing a device that is not a deployer tries.
// Stand-ins replace only what this pylon cannot host, as in review-flow/stack.ts:
//  - GitHub is a fetch handler behind the real githubClient. Each PR is open at its approved head, its checks pass,
//    and a merge checks the head SHA it is given. Every request is logged in github.log.
//  - A check thread's run passes 6 s after it starts, as a check pylon's .nexus/check would.
//  - The node's release worker reports a new desired release healthy 8 s later, or the approved builder's merge
//    commit rolled back. Each report is logged in release.log.
//  - whois answers the laptop, a deployer, until POST /verify/caller on port 7489 names another node, such as the
//    phone, which the API allows but which is not a deployer.
// The same file runs on main and on the branch.
//
//   EVIDENCE=<dir> node docs/verification/dashboard-land-button/stack.ts
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { agentReplies, reviewLoop, type Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-land-evidence-"));
mkdirSync(evidence, { recursive: true });
const log = (file: string, line: string) => appendFileSync(join(evidence, file), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nVERIFYNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const phone = "nPHONE" as TailnetNodeId;
let caller = laptop;
const repo = "ramtinJ95/nexus";
const hex = (n: number) => n.toString(16).repeat(40).slice(0, 40);
const release0 = hex(1);

const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-land-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
registry.setCurrentImage("img-0000000000aa" as never);
registry.createProject({ id: "nexus", repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null } as never);
registry.setDesiredRelease({ commit: release0, requestedBy: "verify seed", requestedAt: Date.now() });
for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: release0, target: release0, state: "healthy", reason: null, observedAt: Date.now() });

function observe() {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => ({
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2026-10-27T00:00:00Z",
    bootedFrom: { image: "img-0000000000aa" as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [] }, []);
}

const notCheckedLive = "A real deploy to the home lab could not be checked live; the stack's release worker stands in for it.";
const prs = new Map<number, { title: string; head: string; files: string[]; merged: string | null }>([
  [41, { title: "Cache the thread list between polls", head: hex(4), files: ["src/control/dashboard.ts", "src/control/dashboard.test.ts"], merged: null }],
  [42, { title: "Rename nexus deploy --wait to --follow", head: hex(5), files: ["src/cli/nexus.ts", "src/control/api.ts", "docs/cli.md"], merged: null }],
  [43, { title: "Raise the probe's stream timeout", head: hex(6), files: ["src/control/loop.ts"], merged: null }],
  [44, { title: "Show the node's load in the sidebar", head: hex(7), files: ["src/control/dashboard/style.css"], merged: null }],
]);
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  log("github.log", `${method} ${url.pathname}`);
  const m = /^\/repos\/[^/]+\/[^/]+\/(pulls|commits)\/([0-9a-f]+)(\/.*)?$/.exec(url.pathname);
  const pr = m?.[1] === "pulls" ? prs.get(Number(m[2])) : [...prs.values()].find((p) => p.head === m?.[2]);
  if (m === null || pr === undefined) return Response.json([]);
  const number = [...prs].find(([, p]) => p === pr)![0];
  if (m[3] === undefined) return Response.json({
    number, title: pr.title, html_url: `https://github.com/${repo}/pull/${number}`, state: pr.merged ? "closed" : "open", merged: pr.merged !== null,
    body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, merge_commit_sha: pr.merged, head: { sha: pr.head, ref: `feature-${number}`, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  if (m[3] === "/check-runs") return Response.json({ check_runs: [{ id: number, name: "ci", status: "completed", conclusion: "success", details_url: null, completed_at: "2026-10-27T00:00:00Z" }] });
  if (m[3] === "/files") return Response.json(pr.files.map((filename) => ({ filename, patch: "@@ -1 +1 @@\n-a\n+b" })));
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

const checks: CheckRuns = {
  async start(builder, _branch, head) {
    const t = await startThread({ project: builder.project, title: `Check ${head.slice(0, 12)}`, node }, "nexus-check");
    started.set(t.id, Date.now());
    log("check.log", `check thread ${t.id} for ${builder.id} at ${head}`);
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
const started = new Map<ThreadId, number>();

const fake = fakeHarness();
const wake = () => {};
const startThread = threadStarter({ registry, harness: fake.harness, wake, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const reviews = reviewLoop({
  registry, github, inbox: agentInbox({ registry, harness: fake.harness, probes: new Map(), wake }), harnessModel: "gpt-6-astra", startThread,
  replies: agentReplies(registry, fake.harness), checks, release: { self: nodeId, repo }, log: (message) => console.error(message),
});
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: true, reviews,
  deployment: { self: nodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => caller, allowed: new Set([laptop, phone]), hostnames: new Set(["127.0.0.1"]),
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  harness: fake.harness, startThread, wake, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});

const start = async (title: string): Promise<Thread> => {
  const res = await fetch(`http://127.0.0.1:${api.port}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "nexus", title }) });
  if (res.status !== 201) throw new Error(`start ${title}: ${res.status} ${await res.text()}`);
  return await res.json() as Thread;
};
async function seed(number: number, title: string, phase: Review["phase"], extra: Partial<Review> = {}): Promise<ThreadId> {
  const pr = prs.get(number)!;
  const builder = await start(title);
  const reviewer = await start(`Review of #${number}: ${pr.title}`);
  registry.saveReview({
    id: `rv-${number}0000000`.slice(0, 11), builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000,
    pr: { repo, number, url: `https://github.com/${repo}/pull/${number}`, title: pr.title, branch: `feature-${number}` },
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: null, merged: null,
    rounds: [
      { head: hex(2), verdict: { token: "t1", verdict: "changes", findings: [{ id: "F1", priority: "P1", where: "src/control/dashboard.ts:212", summary: "A thread archived during a poll keeps its stale row" }], reserved: [], notCheckedLive }, check: null, answers: [{ id: "F1", action: "fixed", reason: "" }] },
      { head: pr.head, verdict: { token: "t2", verdict: "approve", findings: [{ id: "N1", priority: "P3", where: null, summary: "Name the poll interval constant" }], reserved: [], notCheckedLive }, check: { passed: true, output: "npm run typecheck: ok\nnpm test: 1165 passed" }, answers: null },
    ],
    phase, ...extra,
  });
  return builder.id;
}

const ids = {
  held: await seed(41, "Cache the thread list", { kind: "needs-person", reasons: ["The pull request's GitHub checks are pending."] }, { land: { requestedBy: laptop } }),
  reserved: await seed(42, "Rename the deploy flag", { kind: "needs-person", reasons: [
    "Always needs the person: breaking changes to the CLI's contract, by the reviewer's reading (renames nexus deploy --wait, which scripts call).",
    "Always needs the person: changes to login or auth, as it changes src/control/api.ts.",
  ] }, { land: { requestedBy: laptop } }),
  approved: await seed(43, "Raise the stream timeout", { kind: "approved" }),
  refused: await seed(44, "Show node load", { kind: "approved" }),
};
const reservedReview = registry.review(ids.reserved)!;
registry.saveReview({ ...reservedReview, rounds: reservedReview.rounds.with(-1, { ...reservedReview.rounds.at(-1)!, verdict: { ...reservedReview.rounds.at(-1)!.verdict!, reserved: [{ case: "cli-breaking", why: "renames nexus deploy --wait, which scripts call" }] } }) });

let deployed = release0;
setInterval(() => {
  observe();
  const desired = registry.desiredRelease()!.commit;
  if (desired === deployed) return;
  deployed = desired;
  log("release.log", `desired release ${desired} by ${registry.desiredRelease()!.requestedBy}`);
  setTimeout(() => {
    const failed = desired === prs.get(43)!.merged;
    for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: failed ? release0 : desired, target: desired, state: failed ? "rolled-back" : "healthy", reason: failed ? "health check failed: /v1/health answered 502" : null, observedAt: Date.now() });
    log("release.log", `reported ${desired} ${failed ? "rolled-back" : "healthy"}`);
  }, 8_000);
}, 500);
setInterval(() => { void reviews.poll(); }, 1_000);
observe();

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (req.url !== "/verify/caller" || req.method !== "POST") return void res.writeHead(404).end();
    caller = JSON.parse(body).node;
    log("stack.log", `whois now answers ${caller}`);
    res.writeHead(204).end();
  });
}).listen(7489, "127.0.0.1");

console.log(JSON.stringify({ ...ids, laptop, phone, evidence }));
