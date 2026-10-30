// A local Nexus control plane for the review-gates captures: the real registry, API, GitHub client, PR watch, inbox and
// review loop, wired as src/control/main.ts wires them. One builder has two open PRs on two branches it pushed. #185
// adds a registry migration, which the merge policy reserves for the person, and its review starts at the merge step.
// The same file runs on main and on the branch, and writes what it saw to $OUT/run.txt and every GitHub request to
// $OUT/github.log. Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient that answers each request after 100 ms.
//  - The reviewer is a harness thread in the test's fake harness, which never answers.
//  - No check runs: the review starts past it.
//
//   OUT=<dir> node docs/verification/review-gates/stack.ts
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { agentState } from "../../../src/control/agent-conversation.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import { reviewLoop, type Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-review-gates-out-"));
const started = Date.now();
const say = (line: string) => appendFileSync(join(out, "run.txt"), `${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-review-gates-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const release = "a".repeat(40);
registry.setDesiredRelease({ commit: release, requestedBy: "verify seed", requestedAt: Date.now() });
for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: release, target: release, state: "healthy", reason: null, observedAt: Date.now() });

const notCheckedLive = "The stack stands in for the live control plane.";
const prs = [
  { number: 185, title: "Planning threads", branch: "feat/planning-threads", head: "103598e".padEnd(40, "0") },
  { number: 186, title: "Docs for planning threads", branch: "docs/planning-threads", head: "c0ffee1".padEnd(40, "0") },
];
let inFlight = 0;
let mostPrReads = 0;
let prReads = 0;
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const base = `/repos/${repo}`;
  const pullRead = /\/pulls\/\d+$/.test(url.pathname);
  if (pullRead) { prReads++; mostPrReads = Math.max(mostPrReads, ++inFlight); }
  const etag = new Headers(init?.headers).get("if-none-match");
  appendFileSync(join(out, "github.log"), `+${Date.now() - started}ms ${init?.method ?? "GET"} ${url.pathname}${etag === null ? "" : " If-None-Match"}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (pullRead) inFlight--;
  const pr = prs.find((p) => url.pathname.startsWith(`${base}/pulls/${p.number}`)) ?? prs.find((p) => url.searchParams.get("head")?.endsWith(`:${p.branch}`));
  const pull = pr && {
    number: pr.number, title: pr.title, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: "open", merged: false, merge_commit_sha: null,
    body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, head: { sha: pr.head, ref: pr.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  };
  const headers = { etag: `"${Buffer.from(JSON.stringify(pull ?? url.pathname)).toString("base64")}"` };
  if (url.pathname === `${base}/pulls`) return Response.json(pull ? [pull] : [], { headers });
  if (pr && url.pathname === `${base}/pulls/${pr.number}`) return Response.json(pull, { headers });
  if (pr && url.pathname === `${base}/pulls/${pr.number}/files`) return Response.json([{ filename: "src/control/registry.ts", patch: "@@ -1 +1,2 @@\n+  `CREATE TABLE planning_threads (thread TEXT PRIMARY KEY) STRICT;`," }]);
  if (url.pathname.startsWith(`${base}/contents/`)) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null, completed_at: "2026-10-30T00:00:00Z" }] }, { headers });
  return Response.json([], { headers });
};
const github = githubClient("verify-token", fakeGitHub);

const fake = fakeHarness();
const wake = () => {};
const inbox = agentInbox({ registry, harness: fake.harness, probes: new Map(), wake });
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness: fake.harness, mirror, dotfiles, wake });
const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread, agentState: agentState(registry, fake.harness),
  checks: { async start() { throw new Error("no check runs here"); }, poll: () => ({ kind: "void" }), discard() {} },
  live: { async start() { throw new Error("no live check runs here"); }, poll: () => ({ kind: "void" }), discard() {} },
  release: { self: nodeId, repo }, mayLand: (caller) => caller === laptop, wake, log: say,
} as Parameters<typeof reviewLoop>[0]);
const watch = prWatcher({ registry, github, inbox });
const api = await startApi({
  registry, host: "127.0.0.1", port: 0, prWatchEnabled: true, reviews, deployment: { self: nodeId, deployers: new Set([laptop]), keys: {} },
  hostnames: new Set(["127.0.0.1", "localhost"]), dotfiles, harness: fake.harness, startThread, mirror, wake, probes: new Map(),
  previewPorts: { first: 10200, last: 10299 }, whois: async () => laptop, allowed: new Set([laptop]),
} as Parameters<typeof startApi>[0]);
const call = async (method: string, path: string, payload?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json();
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-30T00:00:00Z", sha256: "a".repeat(64),
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
const builder = await call("POST", "/v1/threads", { project: "nexus", title: "Planning threads" }) as Thread;
const reviewer = await call("POST", "/v1/threads", { project: "nexus", title: "Review of #185" }) as Thread;
for (const pr of prs) registry.apply({ record: "output", pylonId: builder.pylonId, kind: "branch", ref: `origin/${pr.branch}` });

const detail = async () => await call("GET", `/v1/threads/${builder.id}`) as { review: Review; prWatch: { stopped: boolean } };
const phase = async () => {
  const { review } = await detail();
  const { kind, cause, reasons } = review.phase as { kind: string; cause?: string; reasons?: string[] };
  return JSON.stringify({ kind, cause, reasons, rounds: review.rounds.map((r) => r.head.slice(0, 7)) });
};

const watched = Date.now();
await watch.poll();
say(`PR watch pass 1: ${prReads} PR reads, at most ${mostPrReads} in flight at once, in ${Date.now() - watched} ms`);
say(`links (number, read): ${JSON.stringify(registry.prWatch(builder.id)!.links.map((l) => [l.pr.number, l.pr.url !== ""]))}`);

registry.saveReview({
  id: "rv-e94f1556", builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000, asked: "",
  pr: { repo, number: 185, url: `https://github.com/${repo}/pull/185`, title: prs[0]!.title, branch: prs[0]!.branch },
  models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: { requestedBy: laptop }, auto: false, merged: null, waiver: null,
  rounds: [{ head: prs[0]!.head, verdict: { token: "t", verdict: "approve", findings: [], reserved: [], notCheckedLive }, check: { passed: true, output: "ok" }, live: { kind: "absent" }, answers: null }],
  phase: { kind: "merging", authorized: null },
} as Review);
await reviews.poll();
say(`held: ${await phase()}`);

const oldHead = prs[0]!.head;
prs[0]!.head = "b3ee8a6".padEnd(40, "0");
say(`the builder pushed ${prs[0]!.head.slice(0, 7)} to #185`);
await watch.poll();
await reviews.poll();
say(`after the push: ${await phase()}`);
prs[0]!.head = oldHead;
say(`the builder force-pushed back to ${oldHead.slice(0, 7)}`);
const before = Date.now() - started;
await watch.poll();
say(`the old head's check-runs read after the force-push: ${(await import("node:fs")).readFileSync(join(out, "github.log"), "utf8").split("\n")
  .filter((l) => l.includes(`/commits/${oldHead}/check-runs`) && Number(l.slice(1, l.indexOf("ms"))) >= before).map((l) => l.endsWith("If-None-Match") ? "with If-None-Match" : "without If-None-Match").join(", ")}`);
say(`prWatch.stopped: ${(await detail()).prWatch.stopped}`);
await reviews.close();
await watch.close();
await api.close();
process.exit(0);
