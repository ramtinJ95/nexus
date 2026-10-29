// A local Nexus control plane for the serial landings captures: the real registry, API, inbox and review loop, wired
// as src/control/main.ts wires them, on 127.0.0.1:7470 for a deployer. It replays 2026-10-28: PRs #189 and #190 were
// approved with their checks passed, and PR #199 added only docs and test stand-ins. All three reviews start at the
// merge step at once. The same file runs on main and on the branch. Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient, whose heads have no .nexus/verify (github.log).
//  - The fleet is one node whose control and probe report each desired release installing, then healthy 4 s after it
//    became desired (release.log, which also records every release the review loop sets).
//
//   OUT=<dir> node docs/verification/serial-landings/stack.ts
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { openRegistry, type Thread } from "../../../src/control/registry.ts";
import { agentReplies, reviewLoop, type Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-serial-landings-out-"));
const log = (file: string, line: string) => appendFileSync(join(out, file), `${new Date().toISOString()} ${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-serial-landings-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };

const seed = "a".repeat(40);
const setDesired = registry.setDesiredRelease.bind(registry);
let installed = seed;
let desiredAt = Date.now();
registry.setDesiredRelease = (release) => {
  setDesired(release);
  desiredAt = Date.now();
  log("release.log", `desired release ${release.commit.slice(0, 12)}, set by ${release.requestedBy}`);
};
registry.setDesiredRelease({ commit: seed, requestedBy: "verify seed", requestedAt: Date.now() });
installed = seed;
function report() {
  const desired = registry.desiredRelease()!.commit;
  if (desired !== installed && Date.now() - desiredAt >= 4_000) {
    installed = desired;
    log("release.log", `every service reports ${desired.slice(0, 12)} healthy`);
  }
  const state = desired === installed ? "healthy" : "installing";
  for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: installed, target: desired, state, reason: null, observedAt: Date.now() });
}
report();

const notCheckedLive = "The landing on the live control plane could not be checked live; the stack stands in for it.";
const fresh = "docs/verification/fresh-install";
const prs = [
  { number: 189, title: "Queued threads wait for their predecessor's landing", branch: "fix/queue-wait", head: "189a".padEnd(40, "0"), merge: "189c".padEnd(40, "0"), merged: false, files: ["src/control/queue.ts", "src/control/queue.test.ts"] },
  { number: 190, title: "Pipeline items keep their brief", branch: "fix/pipeline-brief", head: "190a".padEnd(40, "0"), merge: "190c".padEnd(40, "0"), merged: false, files: ["src/control/pipeline.ts", "src/control/pipeline.test.ts"] },
  { number: 199, title: "A fresh-install run and a quickstart", branch: "test/fresh-install", head: "199a".padEnd(40, "0"), merge: "199c".padEnd(40, "0"), merged: false, files: [
    "README.md", "docs/explorations/install.md", "docs/roadmap.md",
    ...["README.md", "loopback.py", "run.ts", "standin/apt-get", "standin/github-host-keys", "standin/journalctl", "standin/qemu", "standin/ssh-keyscan", "standin/systemctl", "standin/tailscale", "tailnet.ts", "transcript.txt", "tsconfig.json"].map((p) => `${fresh}/${p}`),
  ] },
];
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const base = `/repos/${repo}`;
  const pr = prs.find((p) => url.pathname.startsWith(`${base}/pulls/${p.number}`));
  if (pr !== undefined && method === "PUT" && url.pathname.endsWith("/merge")) {
    pr.merged = true;
    log("github.log", `merged #${pr.number} at ${pr.head.slice(0, 12)} as ${pr.merge.slice(0, 12)}`);
    return Response.json({ sha: pr.merge, merged: true });
  }
  if (pr !== undefined && url.pathname.endsWith("/files")) return Response.json(pr.files.map((filename) => ({ filename, patch: "@@ -0,0 +1 @@\n+x" })));
  if (pr !== undefined && url.pathname === `${base}/pulls/${pr.number}`) {
    return Response.json({
      number: pr.number, title: pr.title, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: pr.merged ? "closed" : "open", merged: pr.merged, merge_commit_sha: pr.merged ? pr.merge : null,
      body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, head: { sha: pr.head, ref: pr.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
    });
  }
  if (url.pathname.startsWith(`${base}/contents/`)) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null, completed_at: "2026-10-28T00:00:00Z" }] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const fake = fakeHarness();
const wake = () => {};
const inbox = agentInbox({ registry, harness: fake.harness, probes: new Map(), wake });
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness: fake.harness, mirror, dotfiles, wake });
const checkRuns: CheckRuns = { async start() { throw new Error("every check here passed before the stack started"); }, poll: () => ({ kind: "void" }), discard() {} };

const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread, replies: agentReplies(registry, fake.harness), checks: checkRuns,
  live: { async start() { throw new Error("no live check runs here"); }, poll: () => ({ kind: "void" }), discard() {} },
  release: { self: nodeId, repo }, mayLand: (caller) => caller === laptop, wake, log: (message) => log("stack.log", message),
} as Parameters<typeof reviewLoop>[0]);
const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: false, reviews, deployment, hostnames: new Set(["127.0.0.1", "localhost"]), dotfiles,
  harness: fake.harness, startThread, mirror, wake, probes: new Map(), previewPorts: { first: 10200, last: 10299 }, whois: async () => laptop, allowed: new Set([laptop]),
} as Parameters<typeof startApi>[0]);

const call = async (method: string, path: string, payload?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, ...payload === undefined ? {} : { body: JSON.stringify(payload) } });
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
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [], events: [], heldSecrets: [] }, []);
}

const builders: Record<number, string> = {};
for (const [i, pr] of prs.entries()) {
  const builder = await call("POST", "/v1/threads", { project: "nexus", title: pr.title }) as Thread;
  const reviewer = await call("POST", "/v1/threads", { project: "nexus", title: `Review of #${pr.number}: ${pr.title}` }) as Thread;
  builders[pr.number] = builder.id;
  registry.saveReview({
    id: `rv-00000${pr.number}`, builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000 + i,
    pr: { repo, number: pr.number, url: `https://github.com/${repo}/pull/${pr.number}`, title: pr.title, branch: pr.branch },
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: { requestedBy: laptop }, auto: false, merged: null, waiver: null,
    rounds: [{ head: pr.head, verdict: { token: "t", verdict: "approve", findings: [], reserved: [], notCheckedLive }, check: { passed: true, output: "npm run typecheck: ok\nnpm test: 1649 passed" }, live: { kind: "absent" }, answers: null }],
    phase: { kind: "merging", authorized: null },
  } as Review);
}
observe();
setInterval(observe, 500);
setInterval(report, 500);
setInterval(() => void reviews.poll(), 1_000);
console.log(JSON.stringify({ builders, out }));
