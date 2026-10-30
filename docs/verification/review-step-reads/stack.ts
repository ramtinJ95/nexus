// A local Nexus control plane for the review-step read captures: the real registry, API, inbox, GitHub client, review
// loop, PR watch, nudge, usage-limit and judgment passes, wired as src/control/main.ts wires them, on 127.0.0.1:7471.
// It drives the passes by hand and counts what each one reads. The same file runs on main and on the branch, and
// records whatever each does.
//  - #301 is a running review of a Claude worker builder. The reviewer requests changes, the builder answers F1 and
//    pushes, and the reviewer approves the new head.
//  - #302 is a review held for the person whose PR watch stopped at its comment cap.
//  - 20 archived and 20 deleted threads sit beside them, which none of the passes act on.
// Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient. Each GET of /pulls/<n> is one read of PR n.
//  - The reviewer is a harness thread in the test's fake harness, which replies 200 ms after each request.
//  - A Claude builder's pylon. What the loop types into the session is answered 200 ms later by transcript entries
//    written into the registry, as the control plane's transcript read writes them.
//
//   OUT=<dir> node docs/verification/review-step-reads/stack.ts
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox, type Inbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { builderNudger } from "../../../src/control/nudge.ts";
import { usageLimitResumer } from "../../../src/control/usage-limit.ts";
import { judgmentPass } from "../../../src/control/judgment.ts";
import { openRegistry, type Registry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import * as reviewModule from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";
import { transcriptStart, type ClaudeEntry } from "../../../src/claude-transcript.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-step-reads-out-"));
const log = (file: string, line: string) => appendFileSync(join(out, file), `${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/demo";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-step-reads-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };

const head = (n: number, round: number) => `${n}${round}`.padEnd(40, "0");
const notCheckedLive = "The cache under real traffic could not be checked live; the stack stands in for it.";
const prs = new Map([301, 302].map((number) => [number, { number, title: `PR ${number}`, branch: `fix/pr-${number}`, head: head(number, 1) }]));
const prReads = new Map<number, number>();
const fakeGitHub: typeof fetch = async (input) => {
  const url = new URL(String(input));
  const base = `/repos/${repo}`;
  const pull = (pr: { number: number; title: string; branch: string; head: string }) => ({
    number: pr.number, title: pr.title, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: "open", merged: false, merge_commit_sha: null,
    body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, head: { sha: pr.head, ref: pr.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  const number = Number(/\/pulls\/(\d+)$/.exec(url.pathname)?.[1]);
  const pr = prs.get(number);
  if (url.pathname === `${base}/pulls`) return Response.json([...prs.values()].filter((p) => url.searchParams.get("head")?.endsWith(`:${p.branch}`)).map(pull));
  if (pr !== undefined) {
    prReads.set(number, (prReads.get(number) ?? 0) + 1);
    return Response.json(pull(pr));
  }
  if (url.pathname.startsWith(`${base}/contents/`)) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

/** What the passes read through the registry: the builder's transcript, every thread row, and each archived or deleted thread. */
const counts = { entries: 0, threadRows: 0, gone: 0 };
const gone = new Set<ThreadId>();
const counted: Registry = {
  ...registry,
  claudeEntries: (...args) => { counts.entries++; return registry.claudeEntries(...args); },
  threads: (...args) => { const rows = registry.threads(...args); counts.threadRows += rows.length; return rows; },
  thread: (id) => { if (gone.has(id)) counts.gone++; return registry.thread(id); },
  isReviewer: (id) => { if (gone.has(id)) counts.gone++; return registry.isReviewer(id); },
};

const fake = fakeHarness();
const watches = new Map<string, number>();
const harness = {
  ...fake.harness,
  async watch(threadId: string) { watches.set(threadId, (watches.get(threadId) ?? 0) + 1); return fake.harness.watch(threadId); },
  async send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: "pr-watch" | "review") {
    const submission = await fake.harness.send(threadId, text, requestId, mode, sender);
    setTimeout(() => review(threadId as ThreadId, text), 200);
    return submission;
  },
};
const finding = { id: "F1", priority: "P1", where: "src/cache.ts:1", summary: "The cache never expires", detail: "Add a TTL." };
function review(thread: ThreadId, request: string) {
  const token = /token"?:? "(rv-[0-9a-z-]+:[0-9a-f]+)"/.exec(request)?.[1];
  const r = registry.reviews().find((r) => r.reviewer === thread);
  if (token === undefined || r === undefined) return;
  const changes = r.rounds.length === 1;
  const verdict = { token, verdict: changes ? "changes" : "approve", findings: changes ? [finding] : [], reserved: [], notCheckedLive };
  const text = `I reviewed ${r.rounds.at(-1)!.head}.\n\n\`\`\`nexus-review\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
  fake.transcript(thread).messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never);
  fake.commit(thread);
  registry.recordReply(thread, Date.now());
}
const pylonInbox = (real: Inbox): Inbox => async (target, message) => {
  if (registry.agent(target).kind !== "claude") return real(target, message);
  const token = /token"?:? "(rv-[0-9a-z-]+:[0-9a-f]+)"/.exec(message.text)?.[1];
  if (token !== undefined) {
    setTimeout(() => {
      prs.get(301)!.head = head(301, 2);
      const at = Date.now();
      const from = registry.claudeTranscript(target.id)?.cursor ?? transcriptStart;
      const text = `Added a 5-minute TTL and pushed.\n\n\`\`\`nexus-review-answers\n${JSON.stringify({ token, answers: [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }] })}\n\`\`\``;
      const entries: ClaudeEntry[] = [{ kind: "prompt", at, text: message.text, from: "person" }, { kind: "reply", at, text }, { kind: "turn", at, durationMs: 1_000 }];
      registry.appendClaudeRead(target.id, { session: "s1", from, entries, cursor: { ...from, offset: from.offset + 1 }, reset: false, readAt: at });
      registry.recordReply(target.id, at);
    }, 200);
  }
  return "delivered";
};

const wake = () => {};
const inbox = pylonInbox(agentInbox({ registry, harness, probes: new Map(), wake }));
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness, mirror, dotfiles, wake });
const checkRuns: CheckRuns = {
  async start() { return "th-check0000001" as ThreadId; },
  poll: () => ({ kind: "done", passed: true, output: "npm test: ok" }),
  discard() {},
};

// main reads an agent through two deps, the branch through one.
const conversation = await import("../../../src/control/agent-conversation.ts" as string).catch(() => null) as { agentState: (r: Registry, h: typeof harness) => unknown } | null;
const legacy = reviewModule as unknown as Record<string, (r: Registry, h: typeof harness) => unknown>;
const readers = conversation !== null ? { agentState: conversation.agentState(counted, harness) } : { replies: legacy.agentReplies!(counted, harness), modelFailure: legacy.agentModelFailure!(counted, harness) };
const reviews = reviewModule.reviewLoop({
  registry: counted, github, inbox, harnessModel: "gpt-6-astra", startThread, ...readers, checks: checkRuns,
  live: { async start() { throw new Error("no live check runs here"); }, poll: () => ({ kind: "void" }), discard() {} },
  release: { self: nodeId, repo: "ramtinJ95/nexus" }, mayLand: (caller) => caller === laptop, wake, log: (message) => log("stack.log", message),
} as never);
const watch = prWatcher({ registry: counted, github, inbox });
const passes = {
  nudge: builderNudger({ registry: counted, github, inbox, harness, watch, log: (message) => log("stack.log", message) }),
  "usage-limit": usageLimitResumer({ registry: counted, inbox }),
  judgment: judgmentPass({ registry: counted, harness: harness as never, probes: new Map(), wake, log: (message) => log("stack.log", message) }),
  "pr-watch": watch,
  review: reviews,
};
const api = await startApi({
  registry, host: "127.0.0.1", port: 7471, prWatchEnabled: true, reviews, deployment, hostnames: new Set(["127.0.0.1", "localhost"]), dotfiles,
  harness, startThread, mirror, wake, probes: new Map(), previewPorts: { first: 10300, last: 10399 }, whois: async () => laptop, allowed: new Set([laptop]),
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
  id: "demo", repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node,
  resources: { cpus: 1, memoryGiB: 1, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const builders = new Map<number, ThreadId>();
for (const pr of prs.values()) {
  const builder = await call("POST", "/v1/threads", { project: "demo", title: `Builder of #${pr.number}` }) as Thread;
  registry.setClaudeWorker(builder.id, "build it", "started", undefined, "s1");
  registry.apply({ record: "output", pylonId: builder.pylonId, kind: "branch", ref: `origin/${pr.branch}` });
  builders.set(pr.number, builder.id);
}
for (let i = 0; i < 40; i++) {
  const t = await call("POST", "/v1/threads", { project: "demo", title: `Old thread ${i}` }) as Thread;
  registry.setThreadStatus(t.id, i < 20 ? "archived" : "deleted");
  gone.add(t.id);
}
await watch.poll();
await reviews.start(builders.get(301)!, { land: null });
const held = await call("POST", "/v1/threads", { project: "demo", title: "Reviewer of #302" }) as Thread;
registry.saveReview({
  id: "rv-held302", builder: builders.get(302)!, reviewer: held.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000,
  pr: { repo, number: 302, url: `https://github.com/${repo}/pull/302`, title: "PR 302", branch: "fix/pr-302" },
  models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: null, auto: false, merged: null, waiver: null,
  rounds: [{ head: head(302, 1), verdict: { token: "t", verdict: "changes", findings: [finding as never], reserved: [], notCheckedLive }, check: null, answers: null }],
  phase: { kind: "needs-person", reasons: ["The builder ended 3 turns in a row without an answer Nexus could read, in round 1."] },
} as reviewModule.Review);
registry.savePrWatch(builders.get(302)!, { ...registry.prWatch(builders.get(302)!)!, commentWakes: 10 });

// The pass the start set off, which reads #302 for the first time.
await reviews.poll();
const reviewer = registry.review(builders.get(301)!)!.reviewer;
log("passes.log", "pass | #301 phase after | reads of PR #301 | reads of PR #302 | builder transcript reads | reviewer watches");
for (let pass = 1; pass <= 8; pass++) {
  prReads.clear();
  counts.entries = 0;
  const watched = watches.get(reviewer) ?? 0;
  await reviews.poll();
  log("passes.log", `${pass} | ${registry.review(builders.get(301)!)!.phase.kind} | ${prReads.get(301) ?? 0} | ${prReads.get(302) ?? 0} | ${counts.entries} | ${(watches.get(reviewer) ?? 0) - watched}`);
  await sleep(1_000);
}

log("archived.log", "pass | thread rows built | reads of the 40 archived and deleted threads");
for (const [name, p] of Object.entries(passes)) {
  counts.threadRows = 0;
  counts.gone = 0;
  await p.poll();
  log("archived.log", `${name} | ${counts.threadRows} | ${counts.gone}`);
}
process.exit(0);
