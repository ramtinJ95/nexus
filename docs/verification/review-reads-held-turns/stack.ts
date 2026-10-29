// A local Nexus control plane for the held-turn and gate-hold captures: the real registry, API, PR watch, inbox and
// review loop, wired as src/control/main.ts wires them, on 127.0.0.1:7470 for a deployer. It runs four reviews and
// saves what each did in OUT. The same file runs on main and on the branch, and records whatever each does.
//  - #211 and #212 have Claude worker builders whose turns end while a background shell runs. #211's builder answers
//    the reviewer's finding and pushes, #212's says it started the tests and gives no answer.
//  - #213 is held for the person after an approval because its builder did not rebase a conflicting branch. #214 is
//    held because its builder never answered the reviewer's changes. Both builders then push a new head.
// Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient (github.log).
//  - The reviewer is a harness thread in the test's fake harness. It requests changes in round 1 of #211 and #212,
//    and approves every other head it is sent (reviewer.log).
//  - A Claude builder's pylon. What the loop types into the session goes to builder.log. The stand-in writes the
//    session's transcript records into the registry, as the control plane's transcript read does, and reports
//    session.turn-started and then a session.heartbeat every 2 s, as the pylon's Stop hook does every 5 minutes for a
//    turn that ends with a background shell running. It never reports session.turn-ended.
//  - .nexus/check passes 2 s after it starts (check.log).
//
//   OUT=<dir> ROOT=<checkout> node docs/verification/review-reads-held-turns/stack.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox, type Inbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { agentReplies, reviewLoop, type Review } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import type { CheckRuns } from "../../../src/control/gate.ts";
import type { ImageId } from "../../../src/images.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";
import { transcriptStart, type ClaudeEntry } from "../../../src/claude-transcript.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-held-turns-out-"));
const root = process.env.ROOT ?? process.cwd();
const log = (file: string, line: string) => appendFileSync(join(out, file), `${new Date().toISOString()} ${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const node = "verify-node" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const repo = "ramtinJ95/demo";
const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-held-turns-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };

const head = (n: number, round: number) => `${n}${round}`.padEnd(40, "0");
const notCheckedLive = "The cache under real traffic could not be checked live; the stack stands in for it.";
const prs = new Map([211, 212, 213, 214].map((number) => [number, { number, title: `PR ${number}`, branch: `fix/pr-${number}`, head: head(number, 1), merged: null as string | null }]));
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const base = `/repos/${repo}`;
  if (method !== "GET") log("github.log", `${method} ${url.pathname}`);
  const pull = (pr: typeof prs extends Map<number, infer P> ? P : never) => ({
    number: pr.number, title: pr.title, html_url: `https://github.com/${repo}/pull/${pr.number}`, state: pr.merged === null ? "open" : "closed", merged: pr.merged !== null, merge_commit_sha: pr.merged,
    body: `${pr.title}.\n\nNot checked live: ${notCheckedLive}`, head: { sha: pr.head, ref: pr.branch, repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  const number = Number(/\/(?:pulls|issues)\/(\d+)/.exec(url.pathname)?.[1]);
  const pr = prs.get(number);
  if (url.pathname === `${base}/pulls`) return Response.json([...prs.values()].filter((p) => url.searchParams.get("head")?.endsWith(`:${p.branch}`)).map(pull));
  if (pr !== undefined && url.pathname === `${base}/pulls/${number}`) return Response.json(pull(pr));
  if (pr !== undefined && url.pathname === `${base}/pulls/${number}/files`) return Response.json([{ filename: "src/cache.ts", patch: "@@ -0,0 +1 @@\n+export {};" }]);
  if (pr !== undefined && url.pathname === `${base}/pulls/${number}/merge`) {
    pr.merged = `m${number}`.padEnd(40, "0");
    return Response.json({ sha: pr.merged, merged: true });
  }
  if (url.pathname.startsWith(`${base}/contents/`)) return new Response(null, { status: 404 });
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null, completed_at: "2026-10-29T00:00:00Z" }] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);
const finding = { id: "F1", priority: "P1", where: "src/cache.ts:1", summary: "The cache never expires", detail: "Add a TTL." };

const fake = fakeHarness();
const harness = {
  ...fake.harness,
  async send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: "pr-watch" | "review") {
    const submission = await fake.harness.send(threadId, text, requestId, mode, sender);
    log("reviewer.log", `${threadId} received ${requestId}:\n${text}\n`);
    setTimeout(() => review(threadId as ThreadId, text), 1_000);
    return submission;
  },
};
function review(thread: ThreadId, request: string) {
  const token = /token"?:? "(rv-[0-9a-z-]+:[0-9a-f]+)"/.exec(request)?.[1];
  const r = registry.reviews().find((r) => r.reviewer === thread);
  if (token === undefined || r === undefined) return;
  const changes = r.rounds.length === 1 && (r.pr.number === 211 || r.pr.number === 212);
  const verdict = { token, verdict: changes ? "changes" : "approve", findings: changes ? [finding] : [], reserved: [], notCheckedLive };
  const text = `I reviewed ${r.rounds.at(-1)!.head}.\n\n\`\`\`nexus-review\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
  fake.transcript(thread).messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never);
  fake.commit(thread);
  registry.recordReply(thread, Date.now());
  log("reviewer.log", `${thread} ${verdict.verdict === "approve" ? "approved" : "requested changes at"} ${r.rounds.at(-1)!.head} of #${r.pr.number}`);
}

/** A Claude session that ends its turn with a background shell running: a reply, a turn record, and heartbeats only. */
let sequence = 0;
const heartbeats = new Map<ThreadId, ReturnType<typeof setInterval>>();
function heldTurn(thread: ThreadId, text: string) {
  const at = Date.now();
  const from = registry.claudeTranscript(thread)?.cursor ?? transcriptStart;
  const entries: ClaudeEntry[] = [{ kind: "reply", at, text }, { kind: "turn", at, durationMs: 40_000 }];
  registry.appendClaudeRead(thread, { session: "s1", from, entries, cursor: { ...from, offset: from.offset + 1 }, reset: false, readAt: at });
  const pylon = registry.thread(thread)!.pylonId as PylonId;
  const report = (kind: "session.turn-started" | "session.heartbeat") => registry.reportSession(node, { sequence: ++sequence, time: Date.now(), pylon, event: { kind, session: "s1", at: Date.now() } });
  report("session.turn-started");
  clearInterval(heartbeats.get(thread));
  heartbeats.set(thread, setInterval(() => report("session.heartbeat"), 2_000));
  log("builder.log", `${thread} ended its turn in the transcript with a background shell running, and reports heartbeats only:\n${text}\n`);
}
const pylonInbox = (real: Inbox): Inbox => async (target, message) => {
  if (registry.agent(target).kind !== "claude") return real(target, message);
  log("builder.log", `${target.id} received ${message.id}:\n${message.text}\n`);
  const r = registry.reviews().find((r) => r.builder === target.id)!;
  const token = /token"?:? "(rv-[0-9a-z-]+:[0-9a-f]+)"/.exec(message.text)?.[1];
  if (r.pr.number === 211 && token !== undefined) {
    setTimeout(() => {
      prs.get(211)!.head = head(211, 2);
      log("github.log", `the builder of #211 pushed ${head(211, 2)}`);
      heldTurn(target.id, `Added a 5-minute TTL and pushed. The full suite runs in the background.\n\n\`\`\`nexus-review-answers\n${JSON.stringify({ token, answers: [{ id: "F1", action: "fixed", reason: "Added a 5-minute TTL." }] })}\n\`\`\``);
    }, 1_000);
  }
  if (r.pr.number === 212 && r.nudges === 0 && token !== undefined) setTimeout(() => heldTurn(target.id, "Started the full test suite in the background. I will answer once it finishes."), 1_000);
  return "delivered";
};

const wake = () => {};
const inbox = pylonInbox(agentInbox({ registry, harness, probes: new Map(), wake }));
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness, mirror, dotfiles, wake });

const runs = new Map<ThreadId, number>();
let checks = 0;
const checkRuns: CheckRuns = {
  async start(_builder, _branch, at) {
    const id = `th-check${String(++checks).padStart(7, "0")}` as ThreadId;
    runs.set(id, Date.now());
    log("check.log", `.nexus/check started at ${at}`);
    return id;
  },
  poll(id, at) {
    if (Date.now() - runs.get(id)! < 2_000) return { kind: "running" };
    log("check.log", `.nexus/check passed at ${at}`);
    return { kind: "done", passed: true, output: "npm run typecheck: ok\nnpm test: ok" };
  },
  discard(id) { runs.delete(id); },
};

const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread, replies: agentReplies(registry, harness), checks: checkRuns,
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
for (const number of [211, 212]) await reviews.start(builders.get(number)!, { land: null });
const approval = (token: string) => ({ token, verdict: "approve" as const, findings: [], reserved: [], notCheckedLive });
for (const number of [213, 214]) {
  const reviewer = await call("POST", "/v1/threads", { project: "demo", title: `Reviewer of #${number}` }) as Thread;
  const conflict = number === 213;
  registry.saveReview({
    id: `rv-held${number}`, builder: builders.get(number)!, reviewer: reviewer.id, expect: "x", sent: 3, outbox: null, since: Date.now(), nudges: 0, startedAt: Date.now() - 3_600_000,
    pr: { repo, number, url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, branch: `fix/pr-${number}` },
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, reviewerKind: "harness", maxRounds: 5, land: conflict ? { requestedBy: laptop } : null, auto: false, merged: null, waiver: null,
    rounds: [conflict
      ? { head: head(number, 1), verdict: approval("t"), check: { passed: true, output: "ok" }, live: { kind: "absent" }, conflict: { base: "main" }, answers: [{ id: "CONFLICT", action: "rejected", reason: "I will rebase once main settles." }] }
      : { head: head(number, 1), verdict: { token: "t", verdict: "changes", findings: [finding as never], reserved: [], notCheckedLive }, check: null, answers: null }],
    phase: { kind: "needs-person", reasons: [conflict ? "The branch conflicts with main, and the builder did not rebase it: I will rebase once main settles." : "The builder ended 3 turns in a row without an answer Nexus could read, in round 1."] },
  } as Review);
}

setInterval(observe, 500);
setInterval(() => { void reviews.poll(); }, 1_000);

const summary = (number: number) => {
  const r = registry.review(builders.get(number)!)!;
  return { phase: r.phase, nudges: r.nudges, rounds: r.rounds.map((round) => ({ head: round.head, verdict: round.verdict?.verdict ?? null, answers: round.answers, conflict: round.conflict })), working: registry.thread(r.builder)!.working, lastReplyAt: registry.thread(r.builder)!.lastReplyAt };
};
const capture = async (name: string, number: number) => {
  const thread = builders.get(number)!;
  const show = await promisify(execFile)("node", ["src/cli/nexus.ts", "show", thread], { cwd: root, env: { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" }, encoding: "utf8" }).catch((err) => err as { stdout: string; stderr: string });
  writeFileSync(join(out, `${name}.txt`), `${JSON.stringify(summary(number), null, 2)}\n\n$ nexus show ${thread}\n${show.stdout}${show.stderr}`);
  log("drive.log", `${name}: ${JSON.stringify(summary(number))}`);
};
const until = async (done: () => boolean, ms: number) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) if (done()) return true;
  return false;
};

log("drive.log", `#211 answered while its turn stays held: ${await until(() => registry.review(builders.get(211)!)!.rounds.length > 1, 20_000)}`);
await capture("01-held-turn-answered", 211);

for (const number of [213, 214]) {
  prs.get(number)!.head = head(number, 2);
  log("github.log", `the builder of #${number} pushed ${head(number, 2)}`);
}
await watch.poll();
log("drive.log", `#213 got a round on its rebase and landed: ${await until(() => registry.review(builders.get(213)!)!.phase.kind === "landed", 20_000)}`);
await sleep(3_000);
await capture("02-conflict-hold-rebased", 213);
await capture("03-reviewer-changes-hold-pushed", 214);

const held = registry.claudeEntries(builders.get(212)!).find((e) => e.kind === "turn")?.at ?? Date.now();
log("drive.log", `#212 got a reminder: ${await until(() => registry.review(builders.get(212)!)!.nudges > 0, held + 75_000 - Date.now())}`);
await capture("04-held-turn-silent", 212);
registry.events("0", { kinds: ["review.changed"] }).forEach((e) => log("events.log", `${e.thread} ${JSON.stringify(e.payload)}`));
process.exit(0);
