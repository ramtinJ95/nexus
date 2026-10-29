// A local Nexus control plane for the model-failure captures: the real registry, API, PR watch, inbox and review loop,
// wired as src/control/main.ts wires them, on 127.0.0.1:7470 for a deployer. It runs three reviews, one after
// another, and saves what each did in OUT. The same file runs on main and on the branch, and records whatever each does.
//  - #221's reviewer is a harness thread whose model times out on its first three turns, four failed calls a turn as
//    rv-c9d7b72d's did, and approves on the fourth.
//  - #222's reviewer's model times out on every turn.
//  - #223's reviewer requests changes in round 1. Its Claude builder's first turn ends on Claude Code's API error, the
//    synthetic assistant record of src/fixtures/claude-api-errors.jsonl, and its next turn answers and pushes.
// Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient.
//  - The reviewer is a harness thread in the test's fake harness, which pushes the model's messages into its
//    conversation and reports the turn's end (reviewer.log).
//  - A Claude builder's pylon. What the loop types into the session goes to builder.log. The stand-in writes the
//    session's transcript entries into the registry, as the control plane's transcript read does, and records the
//    turn's end, as the StopFailure or Stop hook's session.turn-ended does.
//  - .nexus/check passes at once (check.log).
//  - The clock. The loop and the stand-ins share one that the driver moves forward past the minutes the loop waits,
//    so a run takes seconds. Every time in the captures is on that clock.
//
//   OUT=<dir> ROOT=<checkout> node docs/verification/review-model-failures/stack.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox, type Inbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import * as reviewModule from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, TailnetNodeId } from "../../../src/protocol.ts";
import { parseRecord, transcriptStart, type ClaudeEntry } from "../../../src/claude-transcript.ts";

const { agentReplies, reviewLoop } = reviewModule;
const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-model-failures-out-"));
const root = process.env.ROOT ?? process.cwd();
let skew = 0;
const clock = () => Date.now() + skew;
const stamp = () => new Date(clock()).toISOString();
const log = (file: string, line: string) => appendFileSync(join(out, file), `${stamp()} ${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/demo";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-model-failures-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };

const head = (n: number, round: number) => `${n}${round}`.padEnd(40, "0");
const notCheckedLive = "The cache under real traffic could not be checked live; the stack stands in for it.";
const prs = new Map([221, 222, 223].map((number) => [number, { number, title: `PR ${number}`, branch: `fix/pr-${number}`, head: head(number, 1) }]));
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const base = `/repos/${repo}`;
  if ((init?.method ?? "GET") !== "GET") log("github.log", `${init?.method} ${url.pathname}`);
  const pull = (pr: typeof prs extends Map<number, infer P> ? P : never) => ({
    number: pr.number, title: pr.title, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: "open", merged: false, merge_commit_sha: null,
    body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, head: { sha: pr.head, ref: pr.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  const number = Number(/\/(?:pulls|issues)\/(\d+)/.exec(url.pathname)?.[1]);
  const pr = prs.get(number);
  if (url.pathname === `${base}/pulls`) return Response.json([...prs.values()].filter((p) => url.searchParams.get("head")?.endsWith(`:${p.branch}`)).map(pull));
  if (pr !== undefined && url.pathname === `${base}/pulls/${number}`) return Response.json(pull(pr));
  if (pr !== undefined && url.pathname === `${base}/pulls/${number}/files`) return Response.json([{ filename: "src/cache.ts", patch: "@@ -0,0 +1 @@\n+export {};" }]);
  if (url.pathname.startsWith(`${base}/contents/`)) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);
const finding = { id: "F1", priority: "P1", where: "src/cache.ts:1", summary: "The cache never expires", detail: "Add a TTL." };
const tokenOf = (text: string) => /token"?:? "(rv-[0-9a-z-]+:[0-9a-f]+)"/.exec(text)?.[1];

const fake = fakeHarness();
const harness = {
  ...fake.harness,
  async send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: "pr-watch" | "review") {
    const submission = await fake.harness.send(threadId, text, requestId, mode, sender);
    log("reviewer.log", `${threadId} received ${requestId}: ${text.split("\n")[1]}`);
    setTimeout(() => reviewerTurn(threadId as ThreadId, text), 200);
    return submission;
  },
};
const reviewerTurns = new Map<ThreadId, number>();
function reviewerTurn(thread: ThreadId, request: string) {
  const r = registry.reviews().find((r) => r.reviewer === thread)!;
  const turn = (reviewerTurns.get(thread) ?? 0) + 1;
  reviewerTurns.set(thread, turn);
  const fails = r.pr.number === 222 || (r.pr.number === 221 && turn <= 3);
  if (fails) {
    for (let i = 0; i < 4; i++) fake.transcript(thread).messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out.", timestamp: clock() } as never);
    log("reviewer.log", `${thread} turn ${turn} of #${r.pr.number}: four model calls failed with "Request timed out."`);
  } else {
    const changes = r.pr.number === 223 && r.rounds.length === 1;
    const verdict = { token: tokenOf(request), verdict: changes ? "changes" : "approve", findings: changes ? [finding] : [], reserved: [], notCheckedLive };
    fake.transcript(thread).messages.push({ role: "assistant", content: [{ type: "text", text: `I reviewed ${r.rounds.at(-1)!.head}.\n\n\`\`\`nexus-review\n${JSON.stringify(verdict)}\n\`\`\`` }], stopReason: "stop", timestamp: clock() } as never);
    log("reviewer.log", `${thread} turn ${turn} of #${r.pr.number}: ${verdict.verdict} with token ${verdict.token}`);
  }
  fake.commit(thread);
  registry.recordReply(thread, clock());
}

const [overloaded] = readFileSync(join(root, "src/fixtures/claude-api-errors.jsonl"), "utf8").split("\n").filter((line) => line !== "").slice(3);
const builderTurns = new Map<ThreadId, number>();
function claudeTurn(thread: ThreadId, entries: ClaudeEntry[]) {
  const from = registry.claudeTranscript(thread)?.cursor ?? transcriptStart;
  registry.appendClaudeRead(thread, { session: "s1", from, entries, cursor: { ...from, offset: from.offset + 1 }, reset: false, readAt: clock() });
  registry.recordReply(thread, clock());
}
const pylonInbox = (real: Inbox): Inbox => async (target, message) => {
  if (registry.agent(target).kind !== "claude") return real(target, message);
  const turn = (builderTurns.get(target.id) ?? 0) + 1;
  builderTurns.set(target.id, turn);
  log("builder.log", `${target.id} received ${message.id}: ${message.text.split("\n")[1]}`);
  const prompt: ClaudeEntry = { kind: "prompt", at: clock(), text: message.text, from: "other" };
  setTimeout(() => {
    if (turn === 1) {
      const failed = parseRecord(overloaded!).map((e) => ({ ...e, at: clock() }));
      claudeTurn(target.id, [prompt, ...failed, { kind: "turn", at: clock(), durationMs: 30_000 }]);
      log("builder.log", `${target.id} turn 1: Claude Code's API call failed for good: ${failed.map((e) => e.kind === "notice" ? e.text : e.kind).join("; ")}`);
      return;
    }
    prs.get(223)!.head = head(223, 2);
    const text = `Added a TTL and pushed.\n\n\`\`\`nexus-review-answers\n${JSON.stringify({ token: tokenOf(message.text), answers: [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }] })}\n\`\`\``;
    claudeTurn(target.id, [prompt, { kind: "reply", at: clock(), text }, { kind: "turn", at: clock(), durationMs: 30_000 }]);
    log("builder.log", `${target.id} turn ${turn}: answered F1 with token ${tokenOf(message.text)} and pushed ${head(223, 2)}`);
  }, 200);
  return "delivered";
};

const wake = () => {};
const inbox = pylonInbox(agentInbox({ registry, harness, probes: new Map(), wake }));
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness, mirror, dotfiles, wake });
const checkRuns: CheckRuns = {
  async start(_builder, _branch, at) { log("check.log", `.nexus/check started at ${at}`); return `th-check${String(Math.random()).slice(2, 9)}` as ThreadId; },
  poll(_id, at) { log("check.log", `.nexus/check passed at ${at}`); return { kind: "done", passed: true, output: "ok" }; },
  discard() {},
};
// Main has no agentModelFailure, and a loop there ignores the dependency.
const modelFailure = (reviewModule as { agentModelFailure?: (r: typeof registry, h: typeof harness) => unknown }).agentModelFailure?.(registry, harness);
const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread, replies: agentReplies(registry, harness), modelFailure, checks: checkRuns, now: clock,
  live: { async start() { throw new Error("no live check runs here"); }, poll: () => ({ kind: "void" }), discard() {} },
  release: { self: nodeId, repo: "ramtinJ95/nexus" }, mayLand: (caller) => caller === laptop, wake, log: (message) => log("stack.log", message),
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
  id: "demo", repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node,
  resources: { cpus: 1, memoryGiB: 1, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
function observe() {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => ({
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2026-10-29T00:00:00Z",
    bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, grants: { secrets: [], gitSsh: false }, previewRoutes: [] }, []);
}

const builders = new Map<number, ThreadId>();
for (const pr of prs.values()) {
  const builder = await call("POST", "/v1/threads", { project: "demo", title: `Builder of #${pr.number}` }) as Thread;
  registry.setClaudeWorker(builder.id, "build it", "started", undefined, "s1");
  registry.apply({ record: "output", pylonId: builder.pylonId, kind: "branch", ref: `origin/${pr.branch}` });
  builders.set(pr.number, builder.id);
}
observe();
await watch.poll();
setInterval(observe, 500);
setInterval(() => { void reviews.poll(); }, 250);

const reviewOf = (number: number) => registry.review(builders.get(number)!)!;
const summary = (number: number) => {
  const r = reviewOf(number);
  return { phase: r.phase, nudges: r.nudges, sent: r.sent, rounds: r.rounds.map((round) => ({ head: round.head, verdict: round.verdict?.verdict ?? null, answers: round.answers })) };
};
const capture = async (name: string, number: number) => {
  const thread = builders.get(number)!;
  const show = await promisify(execFile)("node", ["src/cli/nexus.ts", "show", thread], { cwd: root, env: { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" }, encoding: "utf8" }).catch((err) => err as { stdout: string; stderr: string });
  const page = await (await fetch(`http://127.0.0.1:${api.port}/threads/${thread}`)).text();
  const line = /<p>Nexus review [\s\S]*?<\/p>/.exec(page)?.[0].replace(/<[^>]+>/g, "").replaceAll("&#39;", "'") ?? "(no review line on the page)";
  writeFileSync(join(out, `${name}.txt`), `${JSON.stringify(summary(number), null, 2)}\n\n$ nexus show ${thread} | grep -E "^review|needs you"\n${(show.stdout + show.stderr).split("\n").filter((l) => /^review|needs you/.test(l)).join("\n")}\n\nThe dashboard's review line on /threads/${thread}:\n${line}\n`);
  log("drive.log", `${name}: ${JSON.stringify(summary(number))}`);
};
const until = async (done: () => boolean, ms = 10_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) if (done()) return true;
  return false;
};
/** Moves the shared clock past the reply grace, so the loop reads the turn that just ended. */
const pastGrace = async () => { await sleep(600); skew += 61_000; await sleep(800); };
const failingOf = (number: number) => {
  const phase = reviewOf(number).phase;
  return phase.kind === "reviewing" || phase.kind === "fixing" ? phase.failing : undefined;
};
/** Moves the shared clock to the retry the loop scheduled, if any, or past the reply grace once more. */
const toRetry = async (number: number) => {
  const failing = failingOf(number);
  if (failing !== undefined) skew += failing.retryAt - clock();
  await pastGrace();
};
const ended = (number: number) => ["needs-person", "approved", "checking"].includes(reviewOf(number).phase.kind);

async function run(number: number, prefix: string) {
  await reviews.start(builders.get(number)!, { land: null });
  let captured = false;
  for (let step = 0; step < 12 && !ended(number); step++) {
    await pastGrace();
    if (!captured && failingOf(number) !== undefined) await capture(`${prefix}-while-failing`, number);
    captured ||= failingOf(number) !== undefined;
    await toRetry(number);
  }
  await until(() => ended(number));
  await sleep(1_000);
  await capture(`${prefix}-end`, number);
}

await run(221, "01-reviewer-recovers");
await run(222, "02-reviewer-keeps-failing");
await run(223, "03-claude-builder-api-error");
for (const [number, thread] of builders) {
  const r = registry.review(thread);
  if (r !== null) log("drive.log", `#${number} messages the loop sent: ${r.sent}`);
}
registry.events("0", { kinds: ["review.changed"] }).forEach((e) => log("events.log", `${e.thread} ${JSON.stringify(e.payload)}`));
process.exit(0);
