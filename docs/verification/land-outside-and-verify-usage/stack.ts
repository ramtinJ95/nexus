// A local Nexus control plane for the land-outside and verify-usage captures: the real registry, API, dashboard, inbox
// and review loop, wired as src/control/main.ts wires them, on 127.0.0.1:7471 for a deployer. Three reviews stopped at
// approval, with no landing asked for. The PR watch last read #301 as closed, #302 as merged at the approved head, and
// #303 as open. A thread started by the review loop's verify caller has one recorded model call. The driver lands each
// review with `nexus land`, polls the loop, reads each builder's dashboard page and runs `nexus usage --by role`. The
// same file runs on main and on the branch. Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient (github.log), which agrees with the PR watch.
//  - The check passes at once, and the fleet is one node that reports each desired release healthy at once.
//
//   OUT=<dir> node docs/verification/land-outside-and-verify-usage/stack.ts
import { execFile } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { verifyCaller, type CheckRuns } from "../../../src/control/gate.ts";
import { githubClient, type PullRequest } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { agentReplies, reviewLoop, type Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-land-outside-out-"));
const log = (file: string, line: string) => appendFileSync(join(out, file), `${line}\n`);
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-land-outside-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const setDesired = registry.setDesiredRelease.bind(registry);
registry.setDesiredRelease = (release) => {
  setDesired(release);
  log("release.log", `desired release ${release.commit.slice(0, 12)}, set by ${release.requestedBy}`);
};
setDesired({ commit: "a".repeat(40), requestedBy: "verify seed", requestedAt: Date.now() });
const report = () => {
  const desired = registry.desiredRelease()!.commit;
  for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: desired, target: desired, state: "healthy", reason: null, observedAt: Date.now() });
};
report();

const notCheckedLive = "The landing on the live control plane could not be checked live; the stack stands in for it.";
const prs = [
  { number: 301, title: "Closed outside its review", branch: "fix/closed", head: "301a".padEnd(40, "0"), state: "closed" as const, merge: null },
  { number: 302, title: "Merged outside its review", branch: "fix/merged", head: "302a".padEnd(40, "0"), state: "merged" as const, merge: "302c".padEnd(40, "0") },
  { number: 303, title: "Still open", branch: "fix/open", head: "303a".padEnd(40, "0"), state: "open" as const, merge: null },
];
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const base = `/repos/${repo}`;
  const pr = prs.find((p) => url.pathname.startsWith(`${base}/pulls/${p.number}`));
  log("github.log", `${method} ${url.pathname}`);
  if (pr !== undefined && method === "PUT" && url.pathname.endsWith("/merge")) return Response.json({ sha: `${pr.number}d`.padEnd(40, "0"), merged: true });
  if (pr !== undefined && url.pathname.endsWith("/files")) return Response.json([{ filename: "src/control/queue.ts", patch: "@@ -0,0 +1 @@\n+x" }]);
  if (pr !== undefined && url.pathname === `${base}/pulls/${pr.number}`) {
    return Response.json({
      number: pr.number, title: pr.title, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: pr.state === "open" ? "open" : "closed", merged: pr.state === "merged", merge_commit_sha: pr.merge,
      body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, head: { sha: pr.head, ref: pr.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
    });
  }
  if (url.pathname.startsWith(`${base}/contents/`)) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null, completed_at: "2026-10-29T00:00:00Z" }] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const fake = fakeHarness();
const wake = () => {};
const inbox = agentInbox({ registry, harness: fake.harness, probes: new Map(), wake });
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness: fake.harness, mirror, dotfiles, wake });
const checkRuns: CheckRuns = {
  async start(builder) { log("stack.log", `check started for ${builder.id}`); return "th-check" as ThreadId; },
  poll: () => ({ kind: "done", passed: true, output: "npm test: ok" }), discard() {},
};
const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread, replies: agentReplies(registry, fake.harness), modelFailure: async () => null, checks: checkRuns,
  live: { async start() { throw new Error("no live check runs here"); }, poll: () => ({ kind: "void" }), discard() {} },
  release: { self: nodeId, repo }, mayLand: (caller) => caller === laptop, wake, log: (message) => log("stack.log", message),
} as Parameters<typeof reviewLoop>[0]);
const api = await startApi({
  registry, host: "127.0.0.1", port: 7471, prWatchEnabled: false, reviews, deployment: { self: nodeId, deployers: new Set([laptop]), keys: {} },
  hostnames: new Set(["127.0.0.1", "localhost"]), dotfiles, harness: fake.harness, startThread, mirror, wake, probes: new Map(),
  previewPorts: { first: 10200, last: 10299 }, whois: async () => laptop, allowed: new Set([laptop]),
} as Parameters<typeof startApi>[0]);
const plain = `http://127.0.0.1:${api.port}`;
const call = async (method: string, path: string, payload?: unknown) => {
  const res = await fetch(`${plain}${path}`, { method, headers: { "content-type": "application/json" }, ...payload === undefined ? {} : { body: JSON.stringify(payload) } });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json();
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-29T00:00:00Z", sha256: "a".repeat(64),
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
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
registry.apply({ record: "node", node, state: "online", capacity });

const builders: Record<number, ThreadId> = {};
for (const pr of prs) {
  const builder = await call("POST", "/v1/threads", { project: "nexus", title: pr.title }) as Thread;
  const reviewer = await call("POST", "/v1/threads", { project: "nexus", title: `Review of #${pr.number}` }) as Thread;
  builders[pr.number] = builder.id;
  const link: PullRequest = { repo, number: pr.number, title: pr.title, url: `https://github.com/${repo}/pull/${pr.number}`, state: pr.state, checks: "passing", review: "none", conflict: false, head: pr.head };
  registry.savePrWatch(builder.id, { links: [{ pr: link, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  registry.saveReview({
    id: `rv-00000${pr.number}`, builder: builder.id, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000,
    pr: { repo, number: pr.number, url: link.url, title: pr.title, branch: pr.branch },
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, asked: "the review request", reviewerKind: "harness", maxRounds: 5, land: null, auto: false, merged: null, waiver: null,
    rounds: [{ head: pr.head, verdict: { token: "t", verdict: "approve", findings: [], reserved: [], notCheckedLive }, check: { passed: true, output: "npm test: ok" }, live: { kind: "absent" }, answers: null }],
    phase: { kind: "approved" },
  } as Review);
}
const verify = await startThread({ project: "nexus", title: "Live check at 302a" }, verifyCaller);
registry.recordUsage(verify.id, [{ id: "claude:msg_verify", agent: "claude", model: "claude-opus-5-5", at: Date.now(), input: 1200, output: 300, cacheWrite: 0, cacheRead: 5000 }]);

// The CLI runs as a child process while this one serves its calls, so it must not block.
const nexus = (args: string[]) => new Promise<string>((resolve) => {
  execFile("node", ["src/cli/nexus.ts", ...args], { env: { ...process.env, NEXUS_URL: plain, NEXUS_SOCKS: "none" } }, (err, stdout, stderr) => {
    resolve(`$ nexus ${args.join(" ")}\n${stdout}${stderr}exit ${err === null ? 0 : (err as { code?: number }).code}\n`);
  });
});
const each = async (f: (pr: typeof prs[number]) => Promise<string>) => { const all: string[] = []; for (const pr of prs) all.push(await f(pr)); return all; };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const phases = () => prs.map((pr) => `#${pr.number} ${registry.review(builders[pr.number]!)!.phase.kind}`).join(", ");

for (const pr of prs) {
  const html = await (await fetch(`${plain}/threads/${builders[pr.number]}`)).text();
  const landing = html.match(/<section class="landing[^"]*"[\s\S]*?<\/section>/)?.[0] ?? "";
  log("dashboard.txt", `#${pr.number} (watch: ${pr.state}) Land button: ${landing.includes('data-action="land"') ? "yes" : "no"}\n  ${text(landing) || "(no landing card)"}\n`);
}
log("timeline.txt", `before land: ${phases()}`);
writeFileSync(join(out, "cli-land.txt"), (await each((pr) => nexus(["land", builders[pr.number]!]))).join("\n"));
log("timeline.txt", `after land: ${phases()}`);
for (let i = 1; i <= 6; i++) {
  await reviews.poll().catch((err: Error) => log("stack.log", `poll failed: ${err.message}`));
  report();
  log("timeline.txt", `after pass ${i}: ${phases()}`);
}
writeFileSync(join(out, "cli-show.txt"), (await each(async (pr) => (await nexus(["show", builders[pr.number]!])).split("\n").filter((l) => /^\$|review rv-|exit/.test(l)).join("\n"))).join("\n\n") + "\n");
writeFileSync(join(out, "cli-usage.txt"), await nexus(["usage", "--since", "all", "--by", "role"]));
await api.close?.();
process.exit(0);
