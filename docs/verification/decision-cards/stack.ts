// A local Nexus control plane for the decision-card captures: the real registry, API, dashboard, review loop and PR
// watch on 127.0.0.1:7470, as src/control/main.ts wires them, with one thread for each source of the `decision`
// attention:
//  - #51, whose reviewer ended 3 turns without an answer Nexus could read, in round 1, so there is nothing to land. Its
//    builder is a Claude worker, so Review again gets a harness reviewer on another model, in a project that lands;
//  - #52, held for a reserved case, then merged on GitHub by hand, as #190 was;
//  - #53, merged by its landing, whose deploy rolled back;
//  - #54, held while its GitHub checks were pending, which the person can land;
//  - a builder that stopped short of a pull request after two nudges;
//  - a question for the person, and a proposed item, as a planning thread asks one. The stack has no planning pass,
//    so the thread is not marked planning.
// Stand-ins replace only what this pylon cannot host, as in needs-you/stack.ts: GitHub is a fetch handler behind the
// real githubClient (github.log), the harness is the fake one, and whois answers the laptop, a deployer.
// The same file runs on main and on the branch.
//
//   EVIDENCE=<dir> node docs/verification/decision-cards/stack.ts
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
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
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const evidence = process.env.EVIDENCE ?? mkdtempSync(join(tmpdir(), "nexus-decision-evidence-"));
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

const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-decision-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never, null);
registry.setCurrentImage("img-0000000000aa" as never);
registry.createProject({ id: "nexus", repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null, autoReview: { land: true, enabledBy: laptop } } as never);
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

const notCheckedLive = "- A real deploy to the home lab.";
const prs = new Map<number, { title: string; head: string; merged: string | null; checks: "success" | null }>([
  [51, { title: "Read the reviewer's answer from its last turn", head: hex(5), merged: null, checks: "success" }],
  [52, { title: "Install Nexus with one command", head: hex(6), merged: hex(9), checks: "success" }],
  [53, { title: "Rename nexus deploy --wait to --follow", head: hex(7), merged: hex(10), checks: "success" }],
  [54, { title: "Cache the thread list between polls", head: hex(8), merged: null, checks: null }],
]);
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  log("github.log", `${method} ${url.pathname}${url.search}`);
  const listed = /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname) ? Number(/:feature-(\d+)$/.exec(url.searchParams.get("head") ?? "")?.[1]) : NaN;
  if (prs.has(listed)) return Response.json([{ number: listed, head: { repo: { full_name: repo } } }]);
  const m = /^\/repos\/[^/]+\/[^/]+\/(pulls|commits)\/([0-9a-f]+)(\/.*)?$/.exec(url.pathname);
  const pr = m?.[1] === "pulls" ? prs.get(Number(m[2])) : [...prs.values()].find((p) => p.head === m?.[2]);
  if (m === null || pr === undefined) return Response.json([]);
  const number = [...prs].find(([, p]) => p === pr)![0];
  if (m[3] === undefined) return Response.json({
    number, title: pr.title, html_url: `https://github.com/${repo}/pull/${number}`, state: pr.merged ? "closed" : "open", merged: pr.merged !== null,
    body: `What it changes.\n\n## Not checked live\n\n${notCheckedLive}`, merge_commit_sha: pr.merged, head: { sha: pr.head, ref: `feature-${number}`, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  if (m[3] === "/check-runs") return Response.json({ check_runs: [{ id: number, name: "ci", status: pr.checks === null ? "in_progress" : "completed", conclusion: pr.checks, details_url: null, completed_at: null }] });
  if (m[3] === "/files") return Response.json([{ filename: "src/control/review.ts", patch: "@@ -1 +1 @@\n-a\n+b" }]);
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const checks: CheckRuns = {
  async start() { throw new Error("the decision-card stack runs no check"); },
  poll() { return { kind: "running" }; },
  discard() {},
};
const fake = fakeHarness();
const wake = () => {};
const startThread = threadStarter({ registry, harness: fake.harness, wake, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
const inbox = agentInbox({ registry, harness: fake.harness, probes: new Map(), wake });
const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread,
  replies: agentReplies(registry, fake.harness), checks, live: checks, release: { self: nodeId, repo }, mayLand: (caller) => caller === laptop, wake, log: (message) => log("review.log", message),
});
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: true, reviews,
  deployment: { self: nodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  harness: fake.harness, startThread, wake, probes: new Map(), previewPorts: { first: 10200, last: 10299 },
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  return await res.json() as Thread;
};
const start = (title: string) => post("/v1/threads", { project: "nexus", title });
const claude = async (title: string) => {
  const t = await post("/v1/threads", { project: "nexus", title, claude: title.toLowerCase() });
  registry.setClaudeWorker(t.id, title.toLowerCase(), "started", undefined, "s1");
  return t;
};

const round = (head: string, approve: boolean): Review["rounds"][number] => ({
  head, verdict: approve ? { token: "t", verdict: "approve", findings: [], reserved: [], notCheckedLive } : null,
  check: approve ? { passed: true, output: "npm test: ok" } : null, ...approve ? { live: { kind: "absent" as const } } : {}, answers: null,
});
async function seedReview(builder: Thread, number: number, phase: Review["phase"], extra: Partial<Review>, since: number): Promise<ThreadId> {
  const pr = prs.get(number)!;
  registry.apply({ record: "output", pylonId: builder.pylonId, kind: "branch", ref: `origin/feature-${number}` });
  const reviewer = await start(`Review of #${number}: ${pr.title}`);
  registry.saveReview({
    id: `rv-${number}0000000`.slice(0, 11), builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since, nudges: 0, startedAt: since - 3_600_000,
    pr: { repo, number, url: `https://github.com/${repo}/pull/${number}`, title: pr.title, branch: `feature-${number}` },
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: { requestedBy: laptop, fromProject: true }, auto: true, merged: null, waiver: null,
    rounds: [round(pr.head, true)], phase, ...extra,
  });
  return builder.id;
}

const ids = {
  silent: await seedReview(await claude("Read the reviewer's answer"), 51, { kind: "needs-person", reasons: ["The reviewer ended 3 turns in a row without an answer Nexus could read, in round 1."] }, { rounds: [round(hex(5), false)] }, minutes(90)),
  mergedByHand: await seedReview(await start("Install with one command"), 52, { kind: "needs-person", reasons: ["Always needs the person: changes to the install, by the reviewer's reading."] }, {}, minutes(80)),
  rolledBack: await seedReview(await start("Rename the deploy flag"), 53, { kind: "needs-person", reasons: ["The deploy of 999999999999 failed: verify-node control failed.", "Rolled back to the previous release, 111111111111, which every service reports healthy."] }, { merged: hex(10) }, minutes(70)),
  held: await seedReview(await start("Cache the thread list"), 54, { kind: "needs-person", reasons: ["The pull request's GitHub checks are pending."] }, {}, minutes(60)),
  nudged: (await start("Draft the install guide")).id,
  question: (await start("Rebuild the pylon image")).id,
  planning: (await start("Plan the install wave")).id,
};
registry.recordReply(ids.nudged, minutes(50));
registry.saveNudge(ids.nudged, { state: "person", turn: minutes(50) });
registry.askQuestion({ id: "qn-image", thread: ids.question, text: "The base layer changed, so every pylon boots from a new image once it is built.\n\nRebuild the pylon image now?", options: ["Rebuild", "Not now"], reserved: null, answerer: "person", askedAt: minutes(40) });
registry.askQuestion({ id: "qn-plan-1", thread: ids.planning, text: "Proposed item: **Admit a first device with a join token.**\n\nThe installer prints a token that the first laptop's `nexus connect` sends.", options: ["Accept", "Reject"], reserved: null, answerer: "person", askedAt: minutes(30), proposal: { block: "b1", index: 0, key: "admit", title: "Admit a first device with a join token", brief: "The installer prints a token.", after: [] } });

setInterval(observe, 500);
const watch = prWatcher({ registry, github, inbox });
await watch.poll();
setInterval(() => { void reviews.poll(); void watch.poll(); }, 1_000);
observe();

console.log(JSON.stringify({ ...ids, laptop, evidence }));
