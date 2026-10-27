// A local Nexus control plane for the land button captures: the real registry, API, dashboard and review loop, as
// src/control/main.ts wires them, with plain HTTP on 127.0.0.1:7470 for the CLI and HTTPS on 7443 as
// rj-firebat.example.ts.net, the dashboard's address, with a self-signed certificate. Five builders' reviews wait for
// the person, each held by the real merge policy on the stack's first pass:
//  - reserved: PR #42 adds a registry migration, which the policy reserves for the person as irreversible, and
//    nothing else holds it.
//  - claude: PR #45 was approved by a Claude reviewer, and changes src/control/api.ts.
//  - moved: PR #46 changes images/pylon/Dockerfile, an image rebuild. POST /verify/advance moves it to a new
//    approved commit, as a builder that pushed again and was approved again would.
//  - failing: PR #47 changes deploy/README.md, a secrets path, and its GitHub checks fail.
//  - unchecked: PR #48 changes deploy/control.json, and .nexus/check failed at its head.
// Stand-ins replace only what this pylon cannot host, as in dashboard-land-button/stack.ts:
//  - GitHub is a fetch handler behind the real githubClient. Each PR is open at its head, its checks pass unless it
//    says otherwise, and a merge checks the head SHA it is given (github.log).
//  - A check thread's run passes 4 s after it starts (check.log).
//  - The node's release worker reports a new desired release healthy 6 s later (release.log).
//  - whois answers the laptop, a deployer, until POST /verify/caller on port 7489 names another node, such as the
//    phone, which the API allows but which is not a deployer.
// The same file runs on main and on the branch. Main's API takes the passkeys option, which binds passkeys to the
// dashboard's address, and the branch's ignores it.
//
//   EVIDENCE=<dir> node docs/verification/land-button-waives/stack.ts
import { createHash, createPublicKey } from "node:crypto";
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
import { testCertificate } from "../../../src/test-certificate.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-land-evidence-"));
mkdirSync(evidence, { recursive: true });
const log = (file: string, line: string) => appendFileSync(join(evidence, file), `${new Date().toISOString()} ${line}\n`);
const hostname = "rj-firebat.example.ts.net";
const node = "verify-node" as NodeName;
const nodeId = "nVERIFYNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const phone = "nPHONE" as TailnetNodeId;
let caller = laptop;
const repo = "ramtinJ95/nexus";
const hex = (n: number) => n.toString(16).repeat(40).slice(0, 40);
const release0 = hex(1);

const work = mkdtempSync(join(tmpdir(), "nexus-land-"));
const db = join(work, "registry.db");
const registry = openRegistry(db);
registry.upsertNode({ name: node, tailnetHost: "verify-node.example.ts.net", tailnetNodeId: nodeId });
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
const migration = "@@ -284,4 +284,5 @@ const migrations: readonly string[] = [\n+  `CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,";
const prs = new Map<number, { title: string; head: string; files: { filename: string; patch: string }[]; merged: string | null; checks?: "failure" }>([
  [42, { title: "Keep the thread list cache in the registry", head: hex(4), files: [{ filename: "src/control/registry.ts", patch: migration }, { filename: "src/control/dashboard.ts", patch: "@@ -1 +1 @@\n-a\n+b" }], merged: null }],
  [45, { title: "Name the caller in API errors", head: hex(5), files: [{ filename: "src/control/api.ts", patch: "@@ -1 +1 @@\n-a\n+b" }], merged: null }],
  [46, { title: "Pin the pylon's Node to 26", head: hex(6), files: [{ filename: "images/pylon/Dockerfile", patch: "@@ -1 +1 @@\n-FROM node:24\n+FROM node:26" }], merged: null }],
  [47, { title: "Say where the merge token lives", head: hex(0xa), files: [{ filename: "deploy/README.md", patch: "@@ -1 +1 @@\n-a\n+b" }], merged: null, checks: "failure" }],
  [48, { title: "Raise the control plane's log level", head: hex(0xb), files: [{ filename: "deploy/control.json", patch: "@@ -1 +1 @@\n-a\n+b" }], merged: null }],
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
  if (m[3] === "/check-runs") return Response.json({ check_runs: [{ id: number, name: "ci", status: "completed", conclusion: pr.checks ?? "success", details_url: null, completed_at: "2026-10-27T00:00:00Z" }] });
  if (m[3] === "/files") return Response.json(pr.files);
  if (m[3] === "/merge" && method === "PUT") {
    const { sha } = JSON.parse(String(init!.body));
    if (sha !== pr.head) return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
    pr.merged = hex(8 + number - 42);
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
    log("check.log", `check thread ${t.id} for ${builder.id} at ${head}`);
    return t.id;
  },
  poll(thread) {
    if (Date.now() - (started.get(thread) ?? 0) < 4_000) return { kind: "running" };
    return { kind: "done", passed: true, output: "npm run typecheck: ok\nnpm test: 1181 passed" };
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
  replies: agentReplies(registry, fake.harness), checks, release: { self: nodeId, repo }, log: (message) => console.error(message),
  mayLand: (caller: string) => caller === laptop,
} as Parameters<typeof reviewLoop>[0]);
const certificate = await testCertificate(work, hostname);
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: true, reviews,
  https: { port: 7443, certificate: async () => certificate },
  passkeys: { id: hostname, origin: `https://${hostname}:7443` },
  deployment: { self: nodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => caller, allowed: new Set([laptop, phone]), hostnames: new Set(["127.0.0.1", hostname]),
  harness: fake.harness, startThread, wake, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
} as Parameters<typeof startApi>[0]);

const start = async (title: string): Promise<Thread> => {
  const res = await fetch(`http://127.0.0.1:${api.port}/v1/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "nexus", title }) });
  if (res.status !== 201) throw new Error(`start ${title}: ${res.status} ${await res.text()}`);
  return await res.json() as Thread;
};
const passed = { passed: true, output: "npm run typecheck: ok\nnpm test: 1181 passed" };
const round = (head: string, check = passed): Review["rounds"][number] => ({ head, verdict: { token: "t", verdict: "approve", findings: [{ id: "N1", priority: "P3", where: null, summary: "Name the constant" }], reserved: [], notCheckedLive }, check, answers: null });
/** A review that landed and is about to merge, so the loop's next pass runs the real policy and holds it. */
async function seed(number: number, title: string, extra: Partial<Review> = {}, check = passed): Promise<ThreadId> {
  const pr = prs.get(number)!;
  const builder = await start(title);
  const reviewer = await start(`Review of #${number}: ${pr.title}`);
  registry.saveReview({
    id: `rv-${number}000000`.slice(0, 11), builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000,
    pr: { repo, number, url: `https://github.com/${repo}/pull/${number}`, title: pr.title, branch: `feature-${number}` },
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: { requestedBy: laptop }, merged: null,
    rounds: [round(pr.head, check)], phase: { kind: "merging", authorized: null }, ...extra,
  } as Review);
  return builder.id;
}

const ids = {
  reserved: await seed(42, "Cache the thread list"),
  claude: await seed(45, "Name the caller", { models: { builder: "gpt-6-astra", reviewer: "claude-opus-5-5" }, reviewerKind: "claude" }),
  moved: await seed(46, "Pin Node 26"),
  failing: await seed(47, "Document the merge token"),
  unchecked: await seed(48, "Log more", {}, { passed: false, output: "npm test: 1180 passed, 1 failed" }),
};
await reviews.poll();

let deployed = release0;
setInterval(() => {
  observe();
  const desired = registry.desiredRelease()!.commit;
  if (desired === deployed) return;
  deployed = desired;
  log("release.log", `desired release ${desired} by ${registry.desiredRelease()!.requestedBy}`);
  setTimeout(() => {
    for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: desired, target: desired, state: "healthy", reason: null, observedAt: Date.now() });
    log("release.log", `reported ${desired} healthy`);
  }, 6_000);
}, 500);
setInterval(() => { void reviews.poll(); }, 1_000);
observe();

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (req.url === "/verify/caller" && req.method === "POST") {
      caller = JSON.parse(body).node;
      log("stack.log", `whois now answers ${caller}`);
      return void res.writeHead(204).end();
    }
    if (req.url === "/verify/advance" && req.method === "POST") {
      const pr = prs.get(46)!;
      pr.head = hex(7);
      const r = registry.review(ids.moved)!;
      registry.saveReview({ ...r, rounds: [...r.rounds, round(pr.head)] });
      log("stack.log", `PR #46 moved to ${pr.head}, approved again with its check passed`);
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
}).listen(7489, "127.0.0.1");

const spki = createHash("sha256").update(createPublicKey(certificate.cert).export({ type: "spki", format: "der" })).digest("base64");
console.log(JSON.stringify({ ...ids, laptop, phone, hostname, spki, evidence }));
