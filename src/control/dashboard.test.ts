import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { startApi, type ApiOptions } from "./api.ts";
import { threadStarter } from "./threads.ts";
import { threadQueue, type QueuedThread } from "./queue.ts";
import { turnGate } from "./drain.ts";
import { readEvents } from "./event-reader.ts";
import { fakeHarness } from "./fake-harness.ts";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import type { Review, ReviewLoop } from "./review.ts";
import type { AgentCall } from "./usage.ts";
import type { JobId, NodeName, PylonObservation, ServiceFact, TailnetNodeId } from "../protocol.ts";
import type { ImageId } from "../images.ts";
import { githubTokenGrant } from "../project.ts";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { transcriptStart, type ClaudeConversation, type ClaudeEntry } from "../claude-transcript.ts";
import { liveFrames } from "./dashboard.ts";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const project = (id: string) => ({
  id, repoUrl: `git@example.com:${id}.git`, defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };

const dir = await mkdtemp(join(tmpdir(), "nexus-dashboard-"));
after(() => rm(dir, { recursive: true }));

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string }

async function setup(t: TestContext, options: Partial<ApiOptions> = {}) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  let caller: TailnetNodeId | null = laptop;
  const fake = fakeHarness({ onParked: (id, parked) => registry.recordParked(id as ThreadId, parked) });
  const startThread = threadStarter({
    registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" },
    mirror: { setupInputs: () => Promise.reject(new Error("the dashboard tests read no remote")) },
  });
  const queue = threadQueue({ registry, startThread, gate: turnGate(() => false), send: (id, text, requestId) => fake.harness.send(id, text, requestId, "followUp") });
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0,
    whois: async () => caller,
    allowed: new Set([laptop]),
    hostnames: new Set(["127.0.0.1"]),
    harness: fake.harness,
    startThread,
    queue,
    wake: () => {},
    probes: new Map(),
    previewPorts: { first: 10200, last: 10299 },
    ...options,
  });
  t.after(async () => {
    await queue.close();
    await api.close();
    registry.close();
  });
  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: api.port, method, path,
        headers: { host: `127.0.0.1:${api.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function start(projectId: string, title: string): Promise<Thread> {
    const res = await call("POST", "/v1/threads", { project: projectId, title });
    assert.equal(res.status, 201, res.text);
    return JSON.parse(res.text) as Thread;
  }
  /** Reports the node online with these pylons running, as an ingested probe snapshot would. */
  function observe(...threads: Thread[]) {
    observeWith({}, ...threads);
  }
  /** As observe, with these services and listening ports in every pylon. */
  function observeWith(facts: { services?: ServiceFact[]; listening?: number[] }, ...threads: Thread[]) {
    registry.apply({ record: "node", node, state: "online", capacity });
    const pylons = threads.map((t): PylonObservation => ({
      pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
      bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
      services: facts.services ?? [], listening: (facts.listening ?? []).map((port) => ({ port })), previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    }));
    registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons, grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  }
  return {
    registry, fake, call, start, observe, observeWith, callAs(id: TailnetNodeId | null) { caller = id; },
    events: (path: string) => readEvents(api.port, path),
  };
}

async function seeded(t: TestContext, options: Partial<ApiOptions> = {}) {
  const s = await setup(t, options);
  for (const id of ["acme", "beta"]) assert.equal((await s.call("POST", "/v1/projects", project(id))).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  return s;
}

/** The page as a reader sees it: tags dropped, entities decoded, whitespace collapsed. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/** The inspector section headed by the element with this id, or the overview's section for a project. */
function sectionOf(html: string, headingId: string): string {
  const section = html.split("<section").find((chunk) => chunk.includes(`aria-labelledby="${headingId}"`));
  assert.ok(section !== undefined, `no section for ${headingId}`);
  return `<section${section.split("</section>")[0]!}`;
}

/** The sidebar's rows as a reader takes them in: each status dot's name, then the row's text. */
function sidebarOf(html: string) {
  const nav = html.split('id="side-threads"')[1]!.split("</nav>")[0]!;
  return {
    rows: [...nav.matchAll(/<a class="row[^"]*" href="\/threads\/([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => `${/aria-label="([^"]*)"/.exec(m[2]!)![1]} ${textOf(m[2]!)}`),
    active: /<a class="row active" href="\/threads\/([^"]+)"/.exec(nav)?.[1],
    text: textOf(nav.replace(/^[^>]*>/, "")),
  };
}

/** One overview row per thread, as its table cells read. */
function overviewRow(html: string, thread: Thread): string {
  const row = html.split('id="overview"')[1]!.split(/<tr(?: class="[^"]*")?>/).find((chunk) => chunk.includes(`href="/threads/${thread.id}"`));
  assert.ok(row !== undefined, `no overview row for ${thread.id}`);
  return textOf(row.split("</tr>")[0]!);
}

const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): Message => ({
  role: "assistant", content, stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), api: "x", provider: "x", model: "gpt-test", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });
const bash = (id: string, command: string) => call(id, "bash", { command });
const result = (toolCallId: string, text: string, isError = false, toolName = "bash"): Message => ({
  role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 0,
});

/**
 * A thread page's conversation as a reader sees it: one row per message, notice, tool call and fold, which
 * tool calls and folds start open, and the dock under it with the run bar and the prompt box.
 */
function conversationOf(html: string) {
  const convo = html.split('id="convo"')[1]!.split('<div class="dock">')[0]!;
  const dock = html.split('<div class="dock">')[1]!.split("</main>")[0]!;
  return {
    rows: convo.split(/(?=<div class="msg |<p class="notice|<p class="note"|<details class="tool|<details class="steps)/).slice(1).map((row) => textOf(`<x ${row}`).replace(/^<x /, "")),
    open: [...convo.matchAll(/<details class="(?:tool|steps)[^"]*" id="([^"]*)"( open)?>/g)].map((m) => [m[1], m[2] !== undefined]),
    text: textOf(convo.replace(/^[^>]*>/, "")),
    dock: textOf(dock),
  };
}

test("the overview lists each project's open threads with their phases, node and activity, and folds the archived", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const docs = await s.start("beta", "Write docs");
  const old = await s.start("acme", "Old spike");
  const started = Date.now() - 63_000;
  s.registry.recordActivity(docs.id, { agent: started, agentTurnRunning: true });
  assert.equal((await s.call("POST", `/v1/threads/${old.id}/archive`)).status, 200);
  s.observe(fix);

  const res = await s.call("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] as string, /^text\/html/);
  assert.match(res.headers["content-security-policy"] as string, /script-src 'self'/);

  const [acme, beta] = ["project-acme", "project-beta"].map((id) => sectionOf(res.text, id));
  assert.ok(acme!.includes(fix.id) && !acme!.includes(docs.id), "each thread is listed under its own project");
  assert.ok(beta!.includes(docs.id));
  assert.equal(overviewRow(res.text, fix), "Fix checkout running running rj-firebat just now never");
  assert.match(overviewRow(res.text, docs), /^Write docs running not on its node rj-firebat just now working 1m 03s$/);
  assert.match(beta!, new RegExp(`<td class="wide">working <time data-since="${started}">1m 03s</time></td>`), "the client ticks the turn's clock from its start");
  assert.match(textOf(acme!), /Thread Desired Observed Node Human Agent Fix checkout .* 1 archived Thread .* Old spike archived paused not on its node/);
  assert.match(acme!, /<details class="ov-closed"[^>]*><summary>1 archived<\/summary>/, "archived threads start folded away");
});

test("the sidebar lists every project's threads with their state, folds the archived and marks the open one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const docs = await s.start("beta", "Write docs");
  const old = await s.start("acme", "Old spike");
  const gone = await s.start("acme", "Gone");
  const started = Date.now() - 63_000;
  s.registry.recordActivity(docs.id, { agent: started, agentTurnRunning: true });
  await s.call("POST", `/v1/threads/${old.id}/archive`);
  await s.call("DELETE", `/v1/threads/${gone.id}`);
  s.observe(fix);

  for (const path of ["/", `/threads/${fix.id}`, "/threads/new", "/threads/th-missing"]) {
    const html = (await s.call("GET", path)).text;
    const sidebar = sidebarOf(html);
    // Threads started in the same millisecond have no order between them.
    assert.deepEqual(sidebar.rows.toSorted(), ["agent working Write docs working 1m 03s", "archived Old spike now", "deleted Gone now", "running Fix checkout now"], `${path} lists the threads`);
    assert.match(sidebar.text, /^acme main Fix checkout now 1 archived, 1 deleted (Gone now Old spike now|Old spike now Gone now) beta main Write docs working 1m 03s$/);
    assert.match(html, new RegExp(`<span class="row-at">working <time data-since="${started}">1m 03s</time></span>`), `${path} ticks the working thread's clock`);
  }
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.equal(sidebarOf(page).active, fix.id);
  assert.match(page, /<details class="archived" id="archived-acme">/, "the archived fold starts closed");
  assert.match((await s.call("GET", `/threads/${old.id}`)).text, /<details class="archived" id="archived-acme" open>/, "an archived thread's page opens its fold");
  assert.match(textOf(page.split('id="side-nodes"')[1]!.split("</div>")[0]!), /rj-firebat/);
});

test("a review the person cancelled says which thread they archived, and asks nothing of them", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.registry.saveReview({
    id: "rv-1", builder: fix.id, reviewer: "th-reviewer" as Thread["id"], pr: { repo: "acme/repo", number: 7, url: "https://github.com/acme/repo/pull/7", title: "Cache", branch: "cache" }, reviewerKind: "harness",
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, maxRounds: 5, land: null, auto: false, merged: null, waiver: null, expect: "rv-1:t", sent: 1, outbox: null, since: 0, nudges: 0, startedAt: 0,
    rounds: [{ head: "1".repeat(40), verdict: null, check: null, answers: null }], phase: { kind: "cancelled", who: "reviewer", status: "archived" },
  });
  const page = textOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.match(page, /Nexus review rv-1: cancelled, round 1 of 5, by th-reviewer on gpt-6-astra, the reviewer thread th-reviewer was archived/);
});

const phone = "nPHONE" as TailnetNodeId;
/** A control plane whose deployers are the laptop only, with a review loop whose PRs from acme/nexus deploy. */
const landingOptions = (landed: string[] = []): Partial<ApiOptions> => ({
  allowed: new Set([laptop, phone]),
  deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  reviews: {
    deploys: (r: Review) => r.pr.repo === "acme/nexus",
    land(builder: string) { landed.push(builder); return {}; },
  } as never as ReviewLoop,
});
const head = "9f".repeat(20);
/** A review of PR #7 whose reviewer approved `head` with one P3 note and whose check passed there. */
const approvedReview = (builder: ThreadId, phase: Review["phase"], extra: Partial<Review> = {}): Review => ({
  id: "rv-1", builder, reviewer: "th-reviewer" as ThreadId, pr: { repo: "acme/nexus", number: 7, url: "https://github.com/acme/nexus/pull/7", title: "Cache", branch: "cache" }, reviewerKind: "harness",
  models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, maxRounds: 5, land: null, auto: false, merged: null, waiver: null, expect: "rv-1:t", sent: 3, outbox: null, since: 0, nudges: 0, startedAt: 0,
  rounds: [
    { head: "1".repeat(40), verdict: { token: "a", verdict: "changes", findings: [{ id: "F1", priority: "P1", where: "src/cache.ts:12", summary: "The cache never expires" }], reserved: [], notCheckedLive: null }, check: null, answers: [{ id: "F1", action: "fixed", reason: "" }] },
    { head, verdict: { token: "b", verdict: "approve", findings: [{ id: "F2", priority: "P3", where: null, summary: "Name the TTL" }], reserved: [], notCheckedLive: "The cache's behaviour under load could not be checked live." }, check: { passed: true, output: "ok 412 tests" }, answers: null },
  ],
  phase, ...extra,
});
const landingOf = (page: string) => /<div id="landing" data-live>([\s\S]*?)<\/div>\n<div id="run"/.exec(page)![1]!;

test("a review held for the person says why on its builder's page, and a deployer can land it after confirming the PR and commit", async (t) => {
  const landed: string[] = [];
  const s = await seeded(t, landingOptions(landed));
  const fix = await s.start("acme", "Fix checkout");
  s.registry.saveReview(approvedReview(fix.id, { kind: "needs-person", reasons: ["The pull request's GitHub checks are pending."] }, { land: { requestedBy: laptop } }));
  const region = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(textOf(region), `Held for you #7 Cache ↗ Head ${head.slice(0, 12)} · approved by gpt-6-astra (harness) in round 2 of 5 · .nexus/check passed `
    + "Why it waits for you The pull request's GitHub checks are pending. not waivable Failing or pending GitHub checks hold every landing until they pass. The reviewer's findings P3 F2 : Name the TTL "
    + `.nexus/check passed at ${head.slice(0, 12)} ok 412 tests Land #7`);
  assert.match(region, /<a href="https:\/\/github.com\/acme\/nexus\/pull\/7" target="_blank"/, "the PR links to GitHub");
  const button = /<button [^>]*data-action="land"[^>]*>/.exec(region)?.[0];
  assert.ok(button !== undefined, "a deployer gets the Land button");
  assert.match(button, new RegExp(`data-thread="${fix.id}"`));
  assert.match(button, new RegExp(`data-head="${head}"`), "the button sends the commit its confirmation names, so a review that moved on is not landed");
  assert.equal(textOf(/data-confirm="([^"]*)"/.exec(button)![1]!), `Land pull request #7, "Cache", at commit ${head.slice(0, 12)}? Nexus checks the merge policy again, merges that commit and deploys the merge commit.`);
  assert.equal((await s.call("POST", `/v1/threads/${fix.id}/land`, { head })).status, 200, "the button's route lands for a deployer");
  assert.deepEqual(landed, [fix.id]);

  s.registry.saveReview(approvedReview(fix.id, { kind: "approved" }));
  assert.match(textOf(landingOf((await s.call("GET", `/threads/${fix.id}`)).text)), /^Approved, not landed .* Nothing holds it\. The review stopped at approval because it was started without --land\. .* Land #7$/,
    "a review that stopped at approval can be landed too");

  s.callAs(phone);
  const refused = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!refused.includes('data-action="land"'), "a device that is not a deployer gets no working button");
  assert.match(textOf(refused), /Land #7 This device cannot land: landing deploys, so only the control plane's deployers may, and this device \(tailnet node nPHONE\) is not one\./);
  const post = await s.call("POST", `/v1/threads/${fix.id}/land`, {});
  assert.equal(post.status, 403, "the route refuses it whatever the page shows");
  assert.match(post.text, /only deployers may/);
  assert.deepEqual(landed, [fix.id]);
});

test("a review is not offered for landing when its PR closed, or when the control plane has no review loop", async (t) => {
  const s = await seeded(t, { ...landingOptions(), reviews: null });
  const fix = await s.start("acme", "Fix checkout");
  s.registry.saveReview(approvedReview(fix.id, { kind: "approved" }));
  const off = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!off.includes('data-action="land"'));
  assert.match(textOf(off), /Land #7 Nexus cannot land it now: the review loop needs the control plane's GitHub token \(github\.tokenFile\), which is not configured\.$/);

  const pr = { repo: "acme/nexus", number: 7, title: "Cache", url: "https://github.com/acme/nexus/pull/7", state: "closed" as const, checks: "passing" as const, review: "none" as const, conflict: false };
  s.registry.savePrWatch(fix.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  assert.equal(landingOf((await s.call("GET", `/threads/${fix.id}`)).text), "", "a closed PR has nothing to land");
});

test("a hold the policy reserves for the person is marked waivable, and pressing Land waives it", async (t) => {
  const reserved = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  s.registry.saveReview(approvedReview(fix.id, { kind: "needs-person", reasons: ["The pull request's GitHub checks are pending.", reserved] }, { land: { requestedBy: laptop } }));
  const page = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  const region = textOf(page);
  assert.match(region, /The pull request's GitHub checks are pending\. not waivable Failing or pending GitHub checks hold every landing until they pass\. /);
  assert.match(region, /src\/control\/api\.ts\. you may waive The policy reserves this for you, and pressing Land here is you waiving it\. /);
  const button = /<button [^>]*data-action="land"[^>]*>([^<]*)<\/button>/.exec(page);
  assert.ok(button !== null, "a deployer gets the button");
  assert.equal(button[1], "Land #7");
  assert.match(button[0], new RegExp(`data-head="${head}"`));
  assert.deepEqual(JSON.parse(textOf(/data-holds="([^"]*)"/.exec(button[0])![1]!)), [reserved], "it waives only what the person may");
  assert.equal(textOf(/data-confirm="([^"]*)"/.exec(button[0])![1]!), `Land pull request #7, "Cache", at commit ${head.slice(0, 12)}, waiving the hold the merge policy reserves for you? Nexus checks everything else again, merges that commit and deploys the merge commit.`);
  assert.match(region, /Land #7 Pressing Land waives what is marked "you may waive", for commit 9f9f9f9f9f9f only\. Landing checks everything else again\.$/);
  s.callAs(phone);
  const refused = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!refused.includes("data-action"), "a device that is not a deployer gets no working button");
  assert.match(textOf(refused), /Land #7 This device cannot land/);
  s.callAs(laptop);

  s.registry.saveReview(approvedReview(fix.id, { kind: "approved" }, { land: { requestedBy: laptop } }));
  assert.ok(!landingOf((await s.call("GET", `/threads/${fix.id}`)).text).includes("data-holds"), "a card with nothing to waive waives nothing");

  s.registry.saveReview(approvedReview(fix.id, { kind: "approved" }, { reviewerKind: "claude" }));
  const claude = textOf(landingOf((await s.call("GET", `/threads/${fix.id}`)).text));
  assert.match(claude, /A Claude reviewer approved it\..* holds again Nothing here stands in for a harness reviewer's approval.* holds every landing of this commit\. Only you can get past it, by merging the pull request on GitHub and deploying it with nexus deploy\.$/, "an approval the policy never lands is marked before any landing tries");
  assert.ok(!claude.includes("Land #7"));
});

test("the dashboard has no Passkeys page and links to none", async (t) => {
  const s = await seeded(t, {});
  assert.equal((await s.call("GET", "/passkeys")).status, 404);
  assert.doesNotMatch((await s.call("GET", "/")).text, /passkey/i);
});

test("a landing shows its steps as the review moves through them, until it lands or ends for the person", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  const steps = async (phase: Review["phase"], extra: Partial<Review> = {}) => {
    s.registry.saveReview(approvedReview(fix.id, phase, { land: { requestedBy: laptop }, ...extra }));
    const region = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
    return { states: [...region.matchAll(/<li class="land-step land-(\w+)"/g)].map((m) => m[1]).join(" "), text: textOf(region).replace(/ ([,.])(?= |$)/g, "$1") };
  };
  const merge = "4".repeat(40);
  assert.deepEqual(await steps({ kind: "checking", startedAt: 0, thread: null }), {
    states: "now todo todo todo", text: `Landing #7 Cache ↗ Check Merge Deploy Landed .nexus/check runs at ${head.slice(0, 12)}, or its kept result for that commit is read.` });
  assert.equal((await steps({ kind: "merging", authorized: head })).states, "done now todo todo");
  assert.deepEqual(await steps({ kind: "deploying", commit: merge, previous: "3".repeat(40), requested: true, deadline: 0 }, { merged: merge }), {
    states: "done done now todo", text: `Landing #7 Cache ↗ Check Merge Deploy Landed Deploying the merge commit ${merge.slice(0, 12)} until every service reports it healthy.` });
  assert.deepEqual(await steps({ kind: "rolling-back", commit: merge, previous: "3".repeat(40), why: "The deploy of 4444 failed: rj-firebat control failed.", requested: true, deadline: 0 }, { merged: merge }), {
    states: "done done failed todo", text: `Rolling back #7 Cache ↗ Check Merge Deploy Landed The deploy of 4444 failed: rj-firebat control failed. Rolling back to ${"3".repeat(12)}.` });
  assert.deepEqual(await steps({ kind: "needs-person", reasons: ["The deploy of 4444 failed.", "Rolled back to the previous release, 3333, which every service reports healthy."] }, { merged: merge }), {
    states: "done done failed todo", text: "Merged, not deployed #7 Cache ↗ Check Merge Deploy Landed The deploy of 4444 failed. Rolled back to the previous release, 3333, which every service reports healthy." });
  assert.deepEqual(await steps({ kind: "landed", commit: merge }, { merged: merge }), {
    states: "done done done done", text: `Landed #7 Cache ↗ Check Merge Deploy Landed Merged as ${merge.slice(0, 12)}, deployed, and every service reports it healthy.` });
  const other = await steps({ kind: "landed", commit: merge }, { merged: merge, pr: { repo: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", title: "Cache", branch: "cache" } });
  assert.deepEqual(other, { states: "done done skipped done", text: `Landed #7 Cache ↗ Check Merge Deploy (nothing to deploy) Landed Merged as ${merge.slice(0, 12)}.` }, "a PR that does not deploy skips the step");
  assert.equal((await steps({ kind: "fixing" })).text, "", "a review that is not landing has nothing to land");
});

test("a waiting session's message replaces the waiting label, such as a background command still running at the cap", async (t) => {
  const s = await seeded(t);
  const [quiet, held] = await Promise.all(["Asks", "Serves"].map((title) => s.start("acme", title)));
  let sequence = 0;
  for (const [thread, message] of [[quiet!, undefined], [held!, "A background command was still running after 2 hours"]] as const) {
    s.registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "c1" } });
    s.registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.waiting", session: "c1", ...(message === undefined ? {} : { message }) } });
  }
  const page = (await s.call("GET", `/threads/${held!.id}`)).text;
  assert.match(page, /A background command was still running after 2 hours/);
  assert.match((await s.call("GET", `/threads/${quiet!.id}`)).text, /waiting for input/);
});

test("rows of threads that need the person stay bright, and the rest dim unless open", async (t) => {
  const s = await seeded(t);
  const [failed, parked, reply, working, waiting, idle, open] = await Promise.all(["Failed", "Parked", "Reply", "Working", "Waiting", "Idle", "Open"].map((title) => s.start("acme", title)));
  s.registry.savePylon({ ...s.registry.pylon(failed!.pylonId)!, failed: "setup exited 1" });
  s.fake.park(parked!.id, 1);
  s.registry.recordReply(reply!.id, Date.now());
  s.registry.recordActivity(working!.id, { agent: Date.now(), agentTurnRunning: true });
  s.registry.reportSession(node, { sequence: 1, pylon: waiting!.pylonId, time: Date.now(), event: { kind: "session.waiting", session: "c1" } });
  const dimmed = (html: string, pattern: RegExp) => Object.fromEntries([...html.matchAll(pattern)].map((m) => [m[2]!, m[1] !== undefined]));
  const bright = { [failed!.id]: false, [parked!.id]: false, [reply!.id]: false, [waiting!.id]: false, [working!.id]: true, [idle!.id]: true };

  const home = (await s.call("GET", "/")).text;
  assert.deepEqual(dimmed(home.split('id="overview"')[1]!, /<tr( class="dim")?>\s*<td><span class="ov-title">.*?href="\/threads\/([^"]+)"/g), { ...bright, [open!.id]: true });
  assert.deepEqual(dimmed(home.split('id="side-threads"')[1]!, /<a class="row( dim)?" href="\/threads\/([^"]+)"/g), { ...bright, [open!.id]: true });
  const page = (await s.call("GET", `/threads/${open!.id}`)).text;
  assert.deepEqual(dimmed(page.split('id="side-threads"')[1]!, /<a class="row(?: active)?( dim)?" href="\/threads\/([^"]+)"/g), { ...bright, [open!.id]: false }, "the open thread's row stays bright");
});

test("a new thread whose node does not have its pylon yet reads as absent, not deleted", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe();

  const detail = await s.call("GET", `/v1/threads/${fix.id}`);
  assert.equal(JSON.parse(detail.text).pylon.actualState, "absent");
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(textOf(sectionOf(page, "pylon-h")), /Observed not on its node Node rj-firebat Last seen just now/);
  assert.equal(overviewRow((await s.call("GET", "/")).text, fix), "Fix checkout running not on its node rj-firebat just now never");
});

test("the side nodes show each node's committed memory, mark an overcommitted one, and say what its paused pylons need to wake", async (t) => {
  const s = await seeded(t);
  const [fix, docs] = [await s.start("acme", "Fix checkout"), await s.start("acme", "Write docs")];
  const over = { ...capacity, memoryGiB: 22.8, committedMemoryGiB: 40, committedDiskGiB: 20 };
  s.registry.apply({ record: "node", node, state: "online", capacity: over });
  const stopped = (t: Thread): PylonObservation => ({ pylonId: t.pylonId, phase: "stopped", checkpoint: null, sessions: null });
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: over, artifacts: [], jobs: [], pylons: [stopped(fix), stopped(docs)], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  assert.equal((await s.call("POST", `/v1/threads/${docs.id}/archive`)).status, 200);
  const nodes = (await s.call("GET", "/")).text.split('id="side-nodes"')[1]!.split("</div>")[0]!;
  assert.match(nodes, /<em>overcommitted<\/em>/, "the marker uses the offline marker's style");
  assert.match(textOf(nodes), /rj-firebat overcommitted 40\/22\.8 GiB memory · 4 GiB to wake paused/, "only the paused pylon whose thread is not archived needs memory to wake");

  s.observe();
  const fits = textOf((await s.call("GET", "/")).text.split('id="side-nodes"')[1]!.split("</div>")[0]!);
  assert.match(fits, /rj-firebat 0\/64 GiB memory/);
  assert.doesNotMatch(fits, /overcommitted|to wake/);
});

test("the side nodes show no memory for a node whose capacity is from a probe before pylons were counted, and never mark it overcommitted", async (t) => {
  const s = await seeded(t);
  s.registry.apply({ record: "node", node, state: "online", capacity: { memoryGiB: 6, committedMemoryGiB: 8, diskFreeGiB: 100 } as never });
  const nodes = textOf((await s.call("GET", "/")).text.split('id="side-nodes"')[1]!.split("</div>")[0]!);
  assert.match(nodes, /rj-firebat/);
  assert.doesNotMatch(nodes, /overcommitted|GiB memory/);
});

test("an offline node shows its pylons as unknown, and the last observation as stale", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.markOffline(node);

  const list = (await s.call("GET", "/")).text;
  assert.equal(overviewRow(list, fix), "Fix checkout running unknown rj-firebat offline just now never");
  assert.match(textOf(list.split('id="side-nodes"')[1]!.split("</div>")[0]!), /rj-firebat offline/);
  const pylon = textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "pylon-h"));
  assert.match(pylon, /Observed unknown Node rj-firebat offline Last seen just now \(stale\)/);
});

test("the thread page shows a paused session as resuming on wake, or on unarchive, and a failed one with why", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.apply({ record: "sessions", pylonId: fix.pylonId, sessions: [
    { id: "w1:p1", state: "paused", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: null, title: "review", status: null, message: null },
    { id: "failed-0123456789ab", state: "failed", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan", status: null, message: "pi exited 1" },
  ] });
  const sessions = async () => {
    const section = sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "sessions-h");
    return { section, text: textOf(section) };
  };
  const shown = await sessions();
  assert.match(shown.text, /Claude Code review paused, resumes on wake w1:p1/);
  assert.match(shown.text, /pi plan failed It did not come back from the last wake, which the next tries again: pi exited 1/);
  assert.ok(!shown.section.includes("failed-0123456789ab"), "a session in no pane shows no pane");
  assert.equal((await s.call("POST", `/v1/threads/${fix.id}/archive`)).status, 200);
  assert.match((await sessions()).text, /Claude Code review paused, resumes on unarchive w1:p1/);
});

test("the thread page shows its pylon, sessions with how to attach, previews as tailnet links, and outputs", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  const pane = (herdrPane: string, harness: "claude-code" | "pi" | "shell", status: "working" | "idle", harnessSessionId: string | null = null, title: string | null = null) =>
    ({ id: herdrPane, state: "running", herdrPane, harness, harnessSessionId, status, title, message: null }) as const;
  s.registry.apply({ record: "sessions", pylonId: fix.pylonId, sessions: [
    pane("w1:p1", "claude-code", "working", "5f0c", "review"),
    pane("w2:p1", "pi", "idle", "/home/user/.pi/sessions/a.jsonl"),
    pane("w3:p1", "shell", "idle"),
  ] });
  s.registry.allocatePreviews(fix.pylonId, ["web", "api"], { first: 8443, last: 8444 });
  s.registry.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  for (const [kind, ref] of [["branch", "nexus/fix-checkout"], ["diff", "abc1234"], ["preview", "web"], ["file", "out-1"]] as const) {
    s.registry.apply({ record: "output", pylonId: fix.pylonId, kind, ref });
  }

  const res = await s.call("GET", `/threads/${fix.id}`);
  assert.equal(res.status, 200);
  assert.equal(textOf(res.text.split('id="bar"')[1]!.split("</header>")[0]!.replace(/^[^>]*>/, "")), "☰ acme / Fix checkout running Archive Delete ⋯");
  assert.match(conversationOf(res.text).text, new RegExp(`^${fix.id} · started just now`));
  assert.equal(textOf(sectionOf(res.text, "pylon-h")), `Pylon Desired running Observed running Node rj-firebat Last seen just now Human just now Agent never Tokens none counted ${fix.pylonId}`);

  const sessions = textOf(sectionOf(res.text, "sessions-h"));
  assert.match(sessions, /^Sessions 3 /);
  assert.match(sessions, /Claude Code review working w1:p1 session 5f0c/);
  assert.match(sessions, /pi idle w2:p1 session \/home\/user\/\.pi\/sessions\/a\.jsonl/);
  assert.match(sessions, /Shell idle w3:p1 Attach from a shell in the pylon herdr --session nexus Copy$/);

  const previews = sectionOf(res.text, "previews-h");
  assert.ok(previews.includes('href="https://rj-firebat.tail.ts.net:8443/"'), "a ready preview links to its tailnet HTTPS URL");
  assert.equal(textOf(previews), "Previews 2 api starting rj-firebat.tail.ts.net:8444 web Open ↗ rj-firebat.tail.ts.net:8443");
  assert.ok(!previews.includes(":8444/"), "a preview that is not ready has no link yet");

  const outputs = sectionOf(res.text, "outputs-h");
  assert.equal(textOf(outputs), "Outputs 3 PR watch: off (no control-plane GitHub token configured). branch nexus/fix-checkout diff abc1234 file out-1", "web's preview is listed once, under Previews");

  const strip = textOf(res.text.split('id="strip"')[1]!.split("</div>")[0]!.replace(/^[^>]*>/, ""));
  assert.equal(strip, "running · rj-firebat api, starting web ↗ Changes 3 outputs", "the phone's strip names the pylon, each preview, the changes and the outputs");


  assert.match(res.text, new RegExp(`<main[^>]* data-activity="${fix.id}"`), "an open thread page records the visit as human activity");

  s.registry.releasePreviews(fix.pylonId);
  const released = sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "outputs-h");
  assert.equal(textOf(released), "Outputs 4 PR watch: off (no control-plane GitHub token configured). branch nexus/fix-checkout diff abc1234 file out-1 preview web", "a preview the control plane no longer has stays an output");
});

test("the inspector's tabs pick the changes, the previews or the pylon, and the changes are the client's to read", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.deepEqual([...page.matchAll(/<input type="radio" name="pane" value="([a-z]+)"( checked)?>/g)].map((m) => [m[1], m[2] !== undefined]), [["changes", true], ["previews", false], ["pylon", false]], "the changes are picked first");
  const regions = page.split('<div class="pane-live" id="inspect" data-live>')[1]!.split("</aside>")[0]!;
  assert.ok(regions.includes('id="pane-previews"') && regions.includes('id="pane-pylon"'), "the previews and the pylon refresh with the page");
  assert.match(page, /id="changes-turn"><span class="switch-label">Latest turn<\/span>/);
  assert.ok(!regions.includes('id="pane-changes"') && page.includes(`<section class="ipane" id="pane-changes" aria-labelledby="changes-h" data-thread="${fix.id}">`), "no refresh replaces what the client read");
  assert.match(page, /<div id="facts" data-live hidden><span data-pylon="running" data-turn="false" data-agent-at="0" data-thread-status="(active|idle)"><\/span><\/div>/, "the client learns when the pylon runs and a turn ends");
  assert.match(page, /<div class="tabs" id="tabs" role="tablist" aria-label="Open views" data-thread="[^"]+"><button type="button" class="tab active" role="tab" aria-selected="true" aria-controls="scroll" data-tab="convo">.*Fix checkout<\/span><\/button><\/div>/, "the conversation is the first tab");
});

test("the inspector lists each listening port once: under Ports with an Open button until it has a preview, then under Previews", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const page = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    return { ports: sectionOf(html, "ports-h"), previews: textOf(sectionOf(html, "previews-h")) };
  };
  assert.equal(textOf((await page()).ports), "Ports 0 Ports show while the pylon runs.");
  s.observeWith({ services: [{ name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true }, { name: "db", state: "ready", port: 5432, declared: true, wantsPreview: false }], listening: [3000, 5173, 5432] }, fix);
  s.registry.allocatePreviews(fix.pylonId, ["web"], { first: 8443, last: 8443 });
  const before = await page();
  assert.equal(textOf(before.ports), "Ports 2 3000 Open 5432 db", "web's port is under Previews, and db's has no preview to open");
  assert.ok(before.ports.includes(`<button type="button" class="btn btn-xs" data-action="link-port" data-thread="${fix.id}" data-port="3000" aria-label="Open port 3000">Open</button>`), "a port no service owns offers to publish it");
  assert.equal(before.previews, "Previews 1 web starting rj-firebat.tail.ts.net:8443");

  // Opening 3000 links it, and the node's next read lists its service.
  s.registry.allocatePreviews(fix.pylonId, ["web", "port-3000"], { first: 8443, last: 8444 });
  s.observeWith({ services: [{ name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true }, { name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], listening: [3000, 5173] }, fix);
  const after = await page();
  assert.equal(textOf(after.ports), "Ports 0 Every port that listens is under Previews.");
  assert.equal(after.previews, "Previews 2 port-3000 starting Unpublish rj-firebat.tail.ts.net:8444 web starting rj-firebat.tail.ts.net:8443", "only the linked port's preview can be unpublished");
  const unpublish = `<button type="button" class="btn btn-xs btn-ghost" data-action="unpublish" data-thread="${fix.id}" data-port="3000" aria-label="Unpublish port-3000">Unpublish</button>`;
  assert.ok(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "previews-h").includes(unpublish));

  s.observeWith({ listening: [] }, fix);
  assert.equal(textOf((await page()).ports), "Ports 0 Nothing listens yet.");
  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  assert.ok(!(await page()).previews.includes("Unpublish"), "an archived thread's previews cannot be unpublished");
});

test("a paused pylon's preview keeps its link, labelled paused, unless the thread is archived", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.registry.allocatePreviews(fix.pylonId, ["web"], { first: 8443, last: 8443 });
  s.observe(fix);
  const url = "https://rj-firebat.tail.ts.net:8443/";
  const previews = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    const section = sectionOf(html, "previews-h");
    return { previews: textOf(section), linked: section.includes(`href="${url}"`) };
  };
  assert.deepEqual(await previews(), { previews: "Previews 1 web starting rj-firebat.tail.ts.net:8443", linked: false }, "a running pylon's preview that is not ready has no link yet");

  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [{ pylonId: fix.pylonId, phase: "stopped", checkpoint: null, sessions: null }], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused Open ↗ rj-firebat.tail.ts.net:8443 Opening it wakes the pylon.", linked: true });

  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused rj-firebat.tail.ts.net:8443 Unarchive the thread to open it.", linked: false }, "an archived thread's visit cannot wake its pylon");

  // Right after the archive, before the pylon pauses, the preview still serves but is about to sleep for good.
  s.observe(fix);
  s.registry.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  assert.match(textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "pylon-h")), /Observed running/);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused rj-firebat.tail.ts.net:8443 Unarchive the thread to open it.", linked: false }, "an archived thread's running pylon offers no link");
});

test("a published preview whose service is starting shows starting and one whose service failed shows failed, with why, neither with a link", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const web = (state: ServiceFact["state"]): ServiceFact => ({ name: "web", state, port: 8003, declared: true, wantsPreview: true });
  s.registry.allocatePreviews(fix.pylonId, ["web"], { first: 8443, last: 8443 });
  s.registry.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  const url = "https://rj-firebat.tail.ts.net:8443/";
  const page = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    const section = sectionOf(html, "previews-h");
    const strip = textOf(html.split('id="strip"')[1]!.split("</div>")[0]!.replace(/^[^>]*>/, ""));
    return { previews: textOf(section), strip, linked: section.includes(`href="${url}"`) };
  };
  s.observeWith({ services: [web("ready")], listening: [8003] }, fix);
  assert.deepEqual(await page(), { previews: "Previews 1 web Open ↗ rj-firebat.tail.ts.net:8443", strip: "running · rj-firebat web ↗ Changes 0 outputs", linked: true });

  s.observeWith({ services: [web("starting")] }, fix);
  assert.deepEqual(await page(), { previews: "Previews 1 web starting rj-firebat.tail.ts.net:8443", strip: "running · rj-firebat web, starting Changes 0 outputs", linked: false }, "its URL answers 502 until the service is ready");

  s.observeWith({ services: [web("failed")] }, fix);
  assert.deepEqual(await page(), {
    previews: "Previews 1 web failed rj-firebat.tail.ts.net:8443 the service web failed. `nexus service logs web` in the pylon shows why",
    strip: "running · rj-firebat web, failed Changes 0 outputs",
    linked: false,
  }, "the gateway can only answer 502 for it");
});

test("a run of tool calls folds into a line that says what it did, over rows where only failures and edits start open", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const long = Array.from({ length: 40 }, (_, i) => `ok ${i + 1} test`).join("\n");
  s.fake.transcript(fix.id).messages.push(
    { role: "user", content: "Run the tests", timestamp: 0 },
    assistant([{ type: "thinking", thinking: "not shown" }, { type: "text", text: "Running them with `npm test`." }, bash("c1", "npm test")]),
    result("c1", long),
    assistant([{ type: "text", text: "One more." }, bash("c2", "git status")]),
    result("c2", "fatal: not a git repository\nCommand exited with code 128\n", true),
    assistant([call("c3", "edit", { path: "src/a.ts", edits: [{ oldText: "const a = 1;\nconst b = 2;", newText: "const a = 2;" }] })]),
    result("c3", "Successfully replaced 1 block in src/a.ts.", false, "edit"),
    assistant([call("c4", "read", { path: "src/b.ts", offset: 10 })], "aborted"),
    assistant([], "error", "rate limited"),
    { role: "user", content: [{ type: "text", text: "Look at this " }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 0 },
    assistant([{ type: "text", text: "All 40 pass." }]),
  );

  const { rows, open } = conversationOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.deepEqual(rows, [
    "You Run the tests",
    "Running them with npm test .",
    "Ran a command ›",
    `› bash npm test 40 lines ✓ npm test ${long.replace(/\n/g, " ")}`,
    "One more.",
    "Ran a command, changed a file, read a file 1 failed ›",
    "› bash git status 2 lines exit 128 git status fatal: not a git repository Command exited with code 128",
    "› edit src/a.ts +1 −2 ✓ src/a.ts − const a = 1; − const b = 2; + const a = 2;",
    `› read src/b.ts no result src/b.ts { "offset": 10 } No output.`,
    "! Aborted.",
    "! The model failed: rate limited",
    "You Look at this [image/png image]",
    "All 40 pass.",
  ]);
  assert.deepEqual(open, [["steps-c1", false], ["tool-c1", false], ["steps-c2", true], ["tool-c2", true], ["tool-c3", true], ["tool-c4", false]], "only a fold with a failure, the failure and the edit start open");
});

test("a fold counts each kind of call, a file once however often it is read, and opens itself for a failure", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  const steps = (prefix: string, failing: boolean): Message[] => [
    assistant([call(`${prefix}1`, "read", { path: "src/checkout/total.ts" }), call(`${prefix}2`, "grep", { pattern: "applyCoupon" }), bash(`${prefix}3`, "npm test -- --watch=false"), bash(`${prefix}4`, "npm test -- --watch=false"), call(`${prefix}5`, "read", { path: "src/checkout/cart.ts" })]),
    result(`${prefix}1`, "x"), result(`${prefix}2`, "y"), result(`${prefix}3`, "ok"), result(`${prefix}4`, "1 failed\nCommand exited with code 1", failing), result(`${prefix}5`, "z"),
  ];
  transcript.messages.push({ role: "user", content: "Look", timestamp: 0 }, ...steps("a", false), assistant([{ type: "text", text: "Found it." }]), ...steps("b", true));
  transcript.messages.push(assistant([{ type: "text", text: "Now the rest." }, bash("c1", "ls"), bash("c2", "pwd"), bash("c3", "id")]), result("c1", "a"), result("c2", "b"), result("c3", "c"));

  const { rows, open } = conversationOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(rows[1], "Ran 2 commands, read 2 files, searched the code ›");
  assert.equal(rows[8], "Ran 2 commands, read 2 files, searched the code 1 failed ›");
  assert.equal(rows[14], "Now the rest.");
  assert.equal(rows[15], "Ran 3 commands ›");
  assert.equal(rows[16], "› bash ls 1 line ✓ ls a");
  assert.deepEqual(open.filter(([id]) => String(id).startsWith("steps-")), [["steps-a1", false], ["steps-b1", true], ["steps-c1", false]], "a fold with a failure starts open");
  assert.deepEqual(open.filter(([id]) => ["tool-b4", "tool-a4"].includes(String(id))), [["tool-a4", false], ["tool-b4", true]]);
});

test("a fold says what its calls did by action, weightiest first, a changed file once, and counts the tools past three actions", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.fake.transcript(fix.id).messages.push(
    { role: "user", content: "Fix it", timestamp: 0 },
    assistant([
      call("a1", "read", { path: "src/a.ts" }), call("a2", "edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }), call("a3", "write", { path: "src/a.ts", content: "b" }),
      bash("a4", "npm test"), call("a5", "write", { path: "src/b.ts", content: "c" }), call("a6", "grep", { pattern: "b" }),
      call("a7", "lint", {}), call("a8", "deploy", {}), call("a9", "lint", {}),
    ]),
    assistant([{ type: "text", text: "Fixed." }]),
    assistant([bash("b1", "ls"), call("b2", "find", { pattern: "*.ts" }), call("b3", "frob", {})]),
    assistant([], "aborted"),
    assistant([bash("c1", "pwd"), call("c2", "read", { path: "src/a.ts" }), call("c3", "grep", { pattern: "x" }), call("c4", "ls", { path: "src" }), call("c5", "frob", {})]),
  );
  const { rows } = conversationOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.deepEqual(rows.filter((row) => row.endsWith("›") && !row.startsWith("›")), [
    "Changed 2 files, ran a command, read a file, used 3 other tools ›",
    "Ran a command, searched the code, used frob ›",
    "Ran a command, read a file, searched the code 2 times, used another tool ›",
  ]);
  assert.ok(rows.includes("! Aborted."), "a notice between two runs stays between their folds");
});

test("a running turn shows its tool's output so far, the partial answer, queued messages and what the run has done", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push({ role: "user", content: "Build it", timestamp: 0 }, assistant([bash("c1", "npm run build")], "toolUse"));
  s.registry.recordActivity(fix.id, { agent: Date.now() - 72_000, agentTurnRunning: true });
  transcript.docs["pi.live"] = {
    run: { taskId: 1, inputs: [1] },
    tools: [{ callId: "c1", name: "bash", status: "running", output: "compiling\n" }],
    generation: { attempt: 2, message: assistant([{ type: "text", text: "Half an ans" }], "pending") as never, retry: { at: 0, error: "overloaded" } },
  };
  transcript.docs["pi.inbox"] = { items: [{ id: 2, mode: "followUp", content: "then deploy" }, { id: 3, mode: "write", entry: {} }] };

  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  const { rows, open, dock } = conversationOf(html);
  assert.deepEqual(rows, [
    "You Build it",
    "Ran a command 1 running ›",
    "› bash npm run build 1 line running npm run build compiling",
    "Half an ans",
    "! The model request failed and will be retried: overloaded",
    "You queued, sends after this run then deploy",
  ]);
  assert.deepEqual(open, [["steps-c1", true], ["tool-c1", true]]);
  assert.match(dock, /^The agent is working\. 1m 12s · 1 tool this turn · new messages queue Abort gpt-test ⌘↵ to queue Queue$/);
  assert.match(html, /placeholder="Queue a follow-up…"/);
});

test("a thread page's stream sends its conversation, then only the text that grew, and the conversation again when its shape changes", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push({ role: "user", content: "Build it", timestamp: Date.now() }, assistant([bash("c1", "npm run build")], "toolUse"));
  const live = (partial: string, output: string) => ({
    run: { taskId: 1, inputs: [1] },
    tools: [{ callId: "c1", name: "bash", status: "running", output }],
    generation: { attempt: 1, message: assistant([{ type: "text", text: partial }], "pending") as never },
  });
  transcript.docs["pi.live"] = live("Hal", "compiling\n");
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(page, new RegExp(`<div class="convo" id="convo" data-rendered-reply-at="" data-live data-stream="/threads/${fix.id}/stream">`));

  const stream = s.events(`/threads/${fix.id}/stream`);
  const first = await stream.next();
  assert.ok(page.includes(`data-stream="/threads/${fix.id}/stream">${first.convo}</div></div>`), "the first event is the region the page holds");
  assert.deepEqual(conversationOf(`<div id="convo" ${first.convo}<div class="dock"></main>`).rows.slice(1), ["Ran a command 1 running ›", "› bash npm run build 1 line running npm run build compiling", "Hal"]);

  transcript.docs["pi.live"] = live("Half an <answer>", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await stream.next(), { grow: [[0, "2 lines"], [1, "compiling\nlinking\n"], [2, '<p>Half an &lt;answer&gt;<span class="caret" aria-hidden="true"></span></p>']] },
    "the line count, the output and the answer grow in place, escaped as the page escapes them");
  transcript.docs["pi.live"] = live("Half an <answer> and more", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await stream.next(), { grow: [[2, '<p>Half an &lt;answer&gt; and more<span class="caret" aria-hidden="true"></span></p>']] }, "only the parts that grew");
  transcript.docs["pi.live"] = live("Half an <answer> and more\n\n- **one**\n```sh\nnpm te <!--/grow-->", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await stream.next(), {
    grow: [[2, '<p>Half an &lt;answer&gt; and more</p><ul><li><p><strong>one</strong></p></li></ul><pre class="code">npm te &lt;!--/grow--&gt;<span class="caret" aria-hidden="true"></span></pre>']],
  }, "markdown blocks grow in place, an open fence is code so far, the caret trails the last character, and text cannot close the part");

  transcript.messages.push(result("c1", "built"), assistant([{ type: "text", text: "Built." }]));
  transcript.docs["pi.live"] = {};
  s.fake.commit(fix.id);
  const done = await stream.next();
  assert.deepEqual(conversationOf(`<div id="convo" ${done.convo}<div class="dock"></main>`).rows.slice(1), ["Ran a command ›", "› bash npm run build 1 line ✓ npm run build built", "Built."], "a finished call and a committed answer send the region whole");
  assert.doesNotMatch(done.convo, /data-grow/);
  stream.close();
});

test("each thread state offers only the actions and prompt box that apply", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const state = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    return {
      actions: [...html.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]).sort(),
      prompt: html.includes('<form id="prompt"'),
      running: html.includes("The agent is working."),
      visit: html.includes("data-activity="),
      chip: textOf(html.split('<span class="chip chip-')[1]!.split("</span></span>")[0]!.replace(/^[^>]*>/, "")),
      ...conversationOf(html),
    };
  };

  const fresh = await state();
  assert.deepEqual([fresh.actions, fresh.prompt, fresh.running, fresh.visit, fresh.text], [["archive", "delete"], true, false, true, `${fix.id} · started just now No messages yet.`]);
  assert.equal(fresh.dock, "⌘↵ to send Send");

  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  s.registry.recordActivity(fix.id, { agent: Date.now(), agentTurnRunning: true });
  const running = await state();
  assert.deepEqual(running.actions, ["abort", "archive", "delete"]);
  assert.ok(running.prompt && running.running);
  assert.equal(running.chip, "agent working");

  // The harness reports a parked run as no running turn, so its pylon may sleep. It can still be aborted.
  s.fake.park(fix.id, 2);
  s.registry.recordActivity(fix.id, { agent: Date.now(), agentTurnRunning: false });
  const parked = await state();
  assert.deepEqual(parked.actions, ["abort", "archive", "delete", "retry"]);
  assert.ok(parked.prompt && !parked.running, "a parked run is not shown as working");
  assert.match(parked.dock, /^2 tasks hit the restart limit and hold the run\. Retry runs them again\. Retry Abort /);

  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  const archived = await state();
  assert.deepEqual(archived.actions, ["abort", "delete", "unarchive"], "an archived thread can still abort, but not retry");
  assert.ok(!archived.prompt && !archived.visit);
  assert.equal(archived.chip, "parked");
  assert.equal(archived.dock, "2 tasks hit the restart limit and hold the run. Unarchive the thread to retry them. Abort An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one.");

  await s.call("POST", `/v1/threads/${fix.id}/unarchive`);
  assert.deepEqual((await state()).actions, ["abort", "archive", "delete", "retry"]);

  await s.call("DELETE", `/v1/threads/${fix.id}`);
  s.fake.calls.length = 0;
  const deleted = await state();
  assert.deepEqual([deleted.actions, deleted.prompt, deleted.running, deleted.visit, deleted.chip, deleted.dock], [[], false, false, false, "deleted", ""]);
  assert.equal(deleted.text, `${fix.id} · started just now The thread is deleted, so its conversation is gone.`);
  assert.deepEqual(s.fake.calls, [], "a deleted thread's conversation is not read");
});

test("a paused pylon's prompt box says a message wakes it", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [{ pylonId: fix.pylonId, phase: "stopped", checkpoint: null, sessions: null }], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  assert.equal(conversationOf((await s.call("GET", `/threads/${fix.id}`)).text).dock, "The pylon is paused. Sending a message wakes it. ⌘↵ to send Send");
});

test("a thread deleted while its conversation is read shows no conversation", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.fake.transcript(fix.id).messages.push({ role: "user", content: "secret plan", timestamp: 0 });
  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  const watch = s.fake.harness.watch;
  s.fake.harness.watch = async (threadId) => {
    const view = await watch(threadId);
    s.registry.setThreadStatus(fix.id, "deleted");
    return view;
  };
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.ok(!html.includes("secret plan"));
  assert.match(conversationOf(html).text, /The thread is deleted, so its conversation is gone\.$/);
});

test("a conversation that cannot be read says why, and the rest of the page still renders", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.fake.harness.watch = async () => { throw new Error("the harness has no conversation for thread x"); };
  const res = await s.call("GET", `/threads/${fix.id}`);
  assert.equal(res.status, 200);
  assert.match(conversationOf(res.text).text, /The conversation could not be read: the harness has no conversation for thread x$/);
  assert.match(textOf(sectionOf(res.text, "pylon-h")), /Desired running/);
});

test("replies and prompts render their markdown, and every string in it stays text", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const reply = [
    "## Plan", "", "Some **bold**, __strong__, *soft* and _soft_ words, with snake_case_name, __init__.py beside my_var_ and 2*3*4 as typed.",
    "", "- one", "- two", "  - nested", "", "3. third", "", "4. fourth", "", "> quoted", "", "---", "",
    "See [the docs](https://example.com/a?b=1&c=2), not [this](javascript:alert(1)) or [that](file:///etc/passwd).",
    "", "An odd ` count leaves `this` as typed.", "", "Run `npm test`:", "```sh", "npm test -- <all> **not bold**", "```",
    "**<script>alert(1)</script>** [<img src=x>](https://example.com/\"onclick)",
  ].join("\n");
  s.fake.transcript(fix.id).messages.push({ role: "user", content: "First line\nsecond *line*\n\n- a list", timestamp: 0 }, assistant([{ type: "text", text: reply }]));
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  const [prompt, answer] = [...html.matchAll(/<div class="text">([\s\S]*?)<\/div><\/div>/g)].map((m) => m[1]!);
  const blocks = (markup: string) => markup.replace(/<\/?p>/g, "");

  assert.equal(blocks(prompt!), "First line\nsecond <em>line</em><ul><li>a list</li></ul>", "the person's prompt keeps its lines and renders its markdown");
  assert.ok(answer!.startsWith('<h4 class="md-h">Plan</h4>'), "a heading stays below the page's own");
  assert.ok(answer!.includes("Some <strong>bold</strong>, <strong>strong</strong>, <em>soft</em> and <em>soft</em> words, with snake_case_name, __init__.py beside my_var_ and 2*3*4 as typed."),
    "markers inside a word stay as typed");
  assert.ok(blocks(answer!).includes("<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start=\"3\"><li>third</li><li>fourth</li></ol><blockquote>quoted</blockquote><hr>"));
  assert.ok(answer!.includes('<a class="link" href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the docs</a>'));
  assert.ok(answer!.includes(", not [this](javascript:alert(1)) or [that](file:///etc/passwd)."), "a link to any other scheme stays text");
  assert.ok(answer!.includes("<p>An odd ` count leaves `this` as typed.</p><p>Run <code>npm test</code>:</p>"));
  assert.ok(answer!.includes('<pre class="code">npm test -- &lt;all&gt; **not bold**</pre>'), "a fenced block is code, as written");
  assert.ok(answer!.endsWith('<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong> <a class="link" href="https://example.com/&quot;onclick" target="_blank" rel="noopener noreferrer">&lt;img src=x&gt;</a></p>'));
  assert.equal(answer!.match(/<a /g)?.length, 2);
});

test("markdown nested past what a page shows renders the rest as escaped text instead of failing the page", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const replies = [
    ">".repeat(10_000) + " <x>quoted</x>",
    "- ".repeat(10_000) + "<x>listed</x>",
  ];
  s.fake.transcript(fix.id).messages.push(...replies.map((text) => assistant([{ type: "text", text }])));
  const res = await s.call("GET", `/threads/${fix.id}`);
  assert.equal(res.status, 200);
  for (const word of ["quoted", "listed"]) assert.ok(res.text.includes(`&lt;x&gt;${word}&lt;/x&gt;`), `${word} shows, escaped`);
  assert.ok(!res.text.includes("<x>"));
  assert.ok((res.text.match(/<blockquote>/g)?.length ?? 0) < 100 && (res.text.match(/<li>/g)?.length ?? 0) < 100, "the nesting shown is bounded");
});

test("strings from humans and probes are escaped, never markup", async (t) => {
  const s = await seeded(t);
  const evil = await s.start("acme", `<img src=x onerror="alert(1)">`);
  s.registry.apply({ record: "output", pylonId: evil.pylonId, kind: "branch", ref: `"><script>alert(2)</script>` });
  const transcript = s.fake.transcript(evil.id);
  transcript.messages.push(
    { role: "user", content: "<script>alert(3)</script>", timestamp: 0 },
    assistant([
      { type: "text", text: "<script>alert(4)</script> and `<script>alert(11)</script>`\n```html\n<script>alert(12)</script>\n```" },
      { type: "toolCall", id: `"><script>alert(5)</script>`, name: "<script>alert(6)</script>", arguments: { command: "</code><script>alert(7)</script>", x: "<script>alert(8)</script>" } },
      call("e1", "edit", { path: "<script>alert(13)</script>", edits: [{ oldText: "<script>alert(14)</script>", newText: "<script>alert(15)</script>" }] }),
    ]),
    { ...result(`"><script>alert(5)</script>`, "<script>alert(9)</script>"), toolName: "<script>alert(6)</script>" } as Message,
  );
  transcript.docs["pi.inbox"] = { items: [{ id: 1, mode: "followUp", content: "<script>alert(10)</script>" }] };
  for (const path of ["/", `/threads/${evil.id}`, "/threads/new"]) {
    const { text } = await s.call("GET", path);
    assert.ok(!text.includes("<img src=x") && !text.includes("<script>alert"), `${path} renders the strings as text`);
    assert.ok(textOf(text).includes(`<img src=x onerror="alert(1)">`), `${path} still shows the title`);
  }
  const page = textOf((await s.call("GET", `/threads/${evil.id}`)).text);
  // alert(5) is the call's ID, which is only an attribute.
  for (const i of [3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) assert.ok(page.includes(`<script>alert(${i})</script>`), `the conversation shows alert(${i}) as text`);
});

test("a failed pylon's thread offers no prompt box, but says why and offers a retry or a fresh start", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const reason = "last job failed with setup-failed, which is not retryable: Setup exited 128\nfatal: <unable> to access";
  s.registry.savePylon({ ...s.registry.pylon(fix.pylonId)!, failed: reason });
  s.fake.park(fix.id, 1);
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.ok(!html.includes('<form id="prompt"'), "a failed pylon cannot serve a message");
  assert.equal(conversationOf(html).dock, `1 task hit the restart limit and hold the run. Retry runs them again. Retry The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages. Fix the cause, such as the project's git access, and retry, or start again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk. ${reason.replace("\n", " ")} Retry Start again`);
  assert.ok(html.includes(`<button type="button" class="btn" id="retry-pylon" data-action="retry-pylon" data-thread="${fix.id}">Retry</button>`), "the retry goes through the client's action handler, which disables it while it is sent");
  assert.match(html, /<button type="button" class="btn" data-start="acme" data-title="Fix checkout">Start again<\/button>/, "starting again opens the dialog on the same project and title");

  assert.equal((await s.call("POST", `/v1/threads/${fix.id}/pylon/retry`)).status, 204);
  const retried = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.ok(retried.includes('<form id="prompt"') && !retried.includes('id="retry-pylon"'), "a retried pylon takes messages again");
});

test("a failed pylon whose disk holds a failed setup offers no retry, and says to start again", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.registry.ingested({
    node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 }, artifacts: [], jobs: [],
    pylons: [{ pylonId: fix.pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause: "saved-setup" }], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
  }, []);
  s.registry.savePylon({ ...s.registry.pylon(fix.pylonId)!, failed: "pylon is broken: Setup exited 128. Read controller logs" });
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.ok(!html.includes('id="retry-pylon"'), "a retry could not help");
  assert.match(conversationOf(html).dock, /Its disk holds the failed setup, and every boot of that disk fails the same way, so a retry cannot help\. Start again from the project\. .* Start again$/);
});

test("a tool call's expanded body shows its whole command, path or pattern", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const command = `for f in src/*.ts; do\n  grep -n "<TODO>" "$f" | head -5 # ${"x".repeat(200)}\ndone`;
  s.fake.transcript(fix.id).messages.push(assistant([bash("c1", command), call("c2", "grep", { pattern: "a|b<c>", path: "src" })]), result("c1", "ok"), result("c2", "src/a.ts:1", false, "grep"));
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  const body = (id: string) => /<pre class="t-full">([^<]*)<\/pre>/.exec(html.split(`id="tool-${id}"`)[1]!)![1]!;
  assert.equal(body("c1"), command.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), "the multiline command is whole and escaped");
  assert.equal(body("c2"), "a|b&lt;c&gt;");
  assert.equal(conversationOf(html).rows[0], "Ran a command, searched the code ›");
  assert.equal(conversationOf(html).rows[2], `› grep a|b<c> 1 line ✓ a|b<c> { "path": "src" } src/a.ts:1`);
});

test("the start dialog's projects refresh with the page, so a project added elsewhere can be picked", async (t) => {
  const s = await setup(t);
  const region = async (path: string) => {
    const html = (await s.call("GET", path)).text;
    const body = html.split('<div id="start-body" data-live>')[1];
    assert.ok(body !== undefined, `${path} renders the dialog's projects as a refreshed region`);
    return textOf(body.split("</dialog>")[0]!);
  };
  assert.match(await region("/"), /^No projects yet/);
  await s.call("POST", "/v1/projects", project("acme"));
  assert.match(await region("/"), /^No image is current yet, .* Worker Claude Code .* Prompt .* Title \(optional\) Project acme git@example\.com:acme\.git Node/, "a refresh brings the form once a project exists");
  await s.call("POST", "/v1/projects", project("beta"));
  assert.match(await region("/threads/th-missing"), /Project acme git@example\.com:acme\.git beta git@example\.com:beta\.git Node/);
});

test("with no projects, the overview, the sidebar and the start dialog each offer a new project", async (t) => {
  const s = await setup(t);
  const page = (await s.call("GET", "/")).text;
  const offers = (html: string) => [...html.matchAll(/<a class="[^"]*" href="\/projects\/new" data-new-project>([^<]*)<\/a>/g)].map((m) => m[1]);
  const overview = page.split('id="overview"')[1]!.split("</main>")[0]!;
  assert.match(textOf(overview.replace(/^[^>]*>/, "")), /^No projects yet\. A project names the repository its threads clone and the node they run on\. New project$/);
  assert.deepEqual(offers(overview), ["New project"]);
  assert.deepEqual(offers(page.split('<header class="bar">')[1]!.split("</header>")[0]!), ["New project"], "the overview's bar offers one");
  assert.deepEqual(offers(page.split('<aside class="side"')[1]!.split("</aside>")[0]!), ["New project"], "the sidebar offers one under its projects");
  const start = page.split('<div id="start-body" data-live>')[1]!.split("</dialog>")[0]!;
  assert.equal(textOf(start), "No projects yet, so there is no repository to start a thread on. New project");
  assert.deepEqual(offers(start), ["New project"], "the start dialog offers one instead of a form");

  await s.call("POST", "/v1/projects", project("acme"));
  const later = (await s.call("GET", "/")).text;
  assert.deepEqual(offers(later.split('id="overview"')[1]!.split("</main>")[0]!), [], "the overview lists the projects instead");
  assert.equal(offers(later).length, 2, "the bar and the sidebar still offer one");
});

test("/projects/new opens the new-project dialog with the fields of nexus project add and its defaults", async (t) => {
  const s = await setup(t);
  // Nodes are listed by name, so the online one comes after the offline rj-firebat.
  const tower = "tower" as NodeName;
  s.registry.upsertNode({ name: tower, tailnetHost: "tower.tail.ts.net", tailnetNodeId: "nTOWER" as TailnetNodeId });
  s.registry.apply({ record: "node", node: tower, state: "online", capacity });
  const dialogOf = (html: string) => html.split('<dialog id="project-dialog"')[1]!.split("</dialog>")[0]!;

  const page = (await s.call("GET", "/projects/new")).text;
  assert.match(page, /<title>New project · Nexus<\/title>/);
  const dialog = dialogOf(page);
  assert.match(dialog, /^[^>]* data-autoopen>/, "/projects/new opens the dialog");
  assert.doesNotMatch(dialogOf((await s.call("GET", "/")).text), /^[^>]* data-autoopen>/, "the dialog stays closed until asked for");
  const fields = [...dialog.matchAll(/<label for="([^"]+)">([^<]+)<\/label>\s*(?:<(?:input|select) id="\1" name="([^"]+)"([^>]*)>)/g)]
    .map((m) => [m[2], m[3], /required/.test(m[4]!), /value="([^"]*)"/.exec(m[4]!)?.[1] ?? null]);
  assert.deepEqual(fields, [["ID", "id", true, null], ["Repository URL", "repoUrl", true, null], ["Node", "defaultNode", false, null], ["Branch", "defaultBranch", true, "main"]]);
  assert.deepEqual([...dialog.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)</g)].map((m) => [m[1], m[2] !== undefined, m[3]]),
    [["auto", true, "auto, where it fits best"], [node, false, `${node}, offline`], [tower, false, tower]], "the node defaults to auto");
  assert.deepEqual([...dialog.matchAll(/<input type="radio" name="repoKind" value="([^"]*)"( checked)?>/g)].map((m) => [m[1], m[2] !== undefined]), [["clone", true], ["scratch", false]],
    "the repository is cloned from a URL unless the project is scratch");
  assert.match(dialog, /<label class="check"><input type="checkbox" name="github"> GitHub access<\/label>/, "GitHub access is off unless asked for");
  assert.deepEqual(JSON.parse(/data-github-grant="([^"]*)"/.exec(dialog)![1]!.replace(/&quot;/g, '"')), githubTokenGrant);
  assert.match(textOf(dialog), /GitHub access sends the node's GH_TOKEN to api\.github\.com and github\.com/);
  assert.match(textOf(dialog), /Each pylon gets 2 CPUs, 6 GiB of memory and 10 GiB of disk\. nexus project add can set those, allowed hosts, logins and other secrets\./);
  assert.match(dialog, /<p id="project-error" class="error" role="alert" hidden><\/p>/, "the dialog has a place for the API's refusal");
});

test("the new-project form adds the project nexus project add would, and the API's refusal is its message", async (t) => {
  const s = await setup(t);
  const form = /<form id="project" class="form" data-resources="([^"]*)" data-github-grant="([^"]*)">/.exec((await s.call("GET", "/")).text);
  assert.ok(form !== null);
  // The body client.js sends: the dialog's four fields and the form's resources.
  const add = (id: string, defaultNode: string) => s.call("POST", "/v1/projects", {
    id, repoUrl: `git@example.com:${id}.git`, defaultBranch: "main", defaultNode,
    resources: JSON.parse(form[1]!.replace(/&quot;/g, '"')), allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
  const added = await add("acme", node);
  assert.equal(added.status, 201, added.text);
  assert.deepEqual(JSON.parse(added.text), { ...project("acme"), resources: { cpus: 2, memoryGiB: 6, diskGiB: 10 } }, "the same project as the CLI's defaults");
  assert.equal(sidebarOf((await s.call("GET", "/")).text).text, "acme main", "the sidebar lists it with its branch");

  const refusal = (res: Reply) => [res.status, (JSON.parse(res.text) as { error: string }).error];
  assert.deepEqual(refusal(await add("acme", node)), [409, "project acme exists"]);
  assert.deepEqual(refusal(await add("beta", "nowhere")), [400, "no node nowhere"]);

  // What client.js sends for an empty repository with GitHub access: no URL, and the grant the form carries.
  const scratch = { ...project("sketch"), repoUrl: null, secrets: [JSON.parse(form[2]!.replace(/&quot;/g, '"'))] };
  const sketch = await s.call("POST", "/v1/projects", scratch);
  assert.equal(sketch.status, 201, sketch.text);
  assert.deepEqual(JSON.parse(sketch.text), { ...project("sketch"), repoUrl: null, secrets: [githubTokenGrant] });
});

test("a scratch project shows as scratch, and starting a thread on it starts an empty repository", async (t) => {
  const s = await seeded(t);
  assert.equal((await s.call("POST", "/v1/projects", { ...project("sketch"), repoUrl: null })).status, 201);
  const page = (await s.call("GET", "/threads/new?project=sketch")).text;
  const dialog = page.split('<dialog id="start-dialog"')[1]!.split("</dialog>")[0]!;
  assert.deepEqual([...dialog.matchAll(/<input type="radio" name="project" required value="([^"]*)"[^>]*?( data-scratch)?( checked)?><span class="seg-name">[^<]*<\/span><span class="seg-repo">([^<]*)</g)].map((m) => [m[1], m[2] !== undefined, m[4]]),
    [["acme", false, "git@example.com:acme.git"], ["beta", false, "git@example.com:beta.git"], ["sketch", true, "scratch"]]);
  assert.match(textOf(dialog), new RegExp(`Boots a pylon on rj-firebat from image ${image.id} and starts an empty repository on main \\.`));
  assert.match(textOf(sectionOf(page, "project-sketch")), /^sketch scratch, no remote New thread/);
});

test("every page has somewhere to say a refresh failed", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  for (const path of ["/", "/threads/new", `/threads/${fix.id}`, "/threads/th-missing", "/usage"]) {
    assert.equal([...(await s.call("GET", path)).text.matchAll(/<p id="refresh-state" class="refresh-state" role="status"><\/p>/g)].length, 1, `${path} has one refresh status`);
  }
});

test("an unknown thread page is a 404 page", async (t) => {
  const s = await setup(t);
  const res = await s.call("GET", "/threads/th-missing");
  assert.equal(res.status, 404);
  assert.match(res.headers["content-type"] as string, /^text\/html/);
  assert.match(textOf(res.text), /No thread th-missing\./);
});

test("every page carries the start dialog, which offers every project and node and warns when no image is current", async (t) => {
  const s = await setup(t);
  assert.match(textOf((await s.call("GET", "/threads/new")).text), /Start a thread ✕ No projects yet/);
  for (const id of ["acme", "beta"]) await s.call("POST", "/v1/projects", project(id));

  const page = (await s.call("GET", "/threads/new?project=beta")).text;
  const dialog = page.split('<dialog id="start-dialog"')[1]!.split("</dialog>")[0]!;
  assert.match(dialog, /^[^>]* data-autoopen>/, "/threads/new opens the dialog");
  assert.deepEqual([...dialog.matchAll(/<input type="radio" name="project" required value="([^"]*)"[^>]*?( checked)?>/g)].map((m) => [m[1], m[2] !== undefined]), [["acme", false], ["beta", true]]);
  assert.deepEqual([...dialog.matchAll(/<option value="([^"]*)">([^<]*)</g)].map((m) => [m[1], m[2]]), [["", "rj-firebat (project default)"], ["auto", "auto, where it fits best"], [node, `${node}, offline`]]);
  assert.match(textOf(dialog), /No image is current yet.* Boots a pylon on rj-firebat and checks out main \./);

  await s.call("POST", "/v1/projects", { ...project("spread"), defaultNode: "auto" });
  const spread = (await s.call("GET", "/threads/new?project=spread")).text.split('<dialog id="start-dialog"')[1]!.split("</dialog>")[0]!;
  assert.match(spread, /<option value="">auto \(project default\)<\/option>/);
  assert.match(textOf(spread), /Boots a pylon on the node with the most room left and checks out main \./, "a project whose default node is auto names no node");

  await s.call("POST", "/v1/images", image);
  s.registry.setCurrentImage(image.id as ImageId);
  const home = (await s.call("GET", "/")).text;
  assert.doesNotMatch(home, /data-autoopen/, "the dialog stays closed until asked for");
  assert.match(textOf(home.split('<dialog id="start-dialog"')[1]!.replace(/^[^>]*>/, "")), new RegExp(`^Start a thread ✕ Worker Claude Code .* Title \\(optional\\) Project acme .* Boots a pylon on rj-firebat from image ${image.id} and checks out main \\.`));
});

test("the start dialog offers the thread's size, with the chosen project's as placeholders, and each project radio carries its own", async (t) => {
  const s = await setup(t);
  await s.call("POST", "/v1/projects", project("acme"));
  await s.call("POST", "/v1/projects", { ...project("big"), resources: { cpus: 4, memoryGiB: 12, diskGiB: 40 } });
  const dialog = (await s.call("GET", "/threads/new?project=big")).text.split('<dialog id="start-dialog"')[1]!.split("</dialog>")[0]!;
  assert.deepEqual([...dialog.matchAll(/<label for="(start-(?:cpus|memory|disk))">([^<]*)<\/label><input id="\1" name="([^"]*)" type="number" min="1" step="1" inputmode="numeric" placeholder="([^"]*)">/g)].map((m) => [m[2], m[3], m[4]]),
    [["CPUs", "cpus", "4"], ["Memory (GiB)", "memoryGiB", "12"], ["Disk (GiB)", "diskGiB", "40"]], "empty, so a start without them takes the project's");
  assert.deepEqual([...dialog.matchAll(/name="project" required value="([^"]*)"[^>]* data-cpus="([^"]*)" data-memory-gib="([^"]*)" data-disk-gib="([^"]*)"/g)].map((m) => m.slice(1)),
    [["acme", "2", "4", "10"], ["big", "4", "12", "40"]], "client.js shows the picked project's size from these");
});

test("the start dialog picks Claude Code for a prompt unless the reader picks the Nexus agent, whose thread needs a title", async (t) => {
  const s = await seeded(t);
  const dialog = (await s.call("GET", "/threads/new")).text.split('<dialog id="start-dialog"')[1]!.split("</dialog>")[0]!;
  assert.deepEqual([...dialog.matchAll(/<input type="radio" name="worker" value="([^"]*)"( checked)?><span class="seg-name">([^<]*)<\/span><span class="seg-repo">([^<]*)</g)].map((m) => [m[1], m[2] !== undefined, m[3], m[4]]),
    [["claude", true, "Claude Code", "for code work"], ["harness", false, "Nexus agent", "the control plane's own harness"]]);
  const field = (name: string) => new RegExp(`<(?:input|textarea)[^>]* name="${name}"[^>]*>`).exec(dialog)?.[0];
  assert.match(field("claude")!, /^<textarea [^>]*required/, "Claude Code's prompt is required");
  assert.match(field("model")!, /placeholder="claude-opus-5-5"/);
  assert.doesNotMatch(field("title")!, /required/, "a Claude worker's title defaults to its prompt's first line");
  const claudeFields = textOf(dialog.split('<div id="start-claude-fields">')[1]!.split("</div>")[0]!);
  assert.equal(claudeFields, "Prompt Runs /poteto-mode with this prompt, as nexus start --claude does. Model (optional) Opus 5.5 unless you name another.");
});

/** Starts a Claude worker thread whose launch opened session s1, and stores these entries as its transcript's last read. */
async function claudeThread(s: Awaited<ReturnType<typeof seeded>>, entries: ClaudeEntry[], readAt = Date.now()): Promise<Thread> {
  const res = await s.call("POST", "/v1/threads", { project: "acme", title: "Count lines", claude: "count the lines" });
  assert.equal(res.status, 201, res.text);
  const thread = JSON.parse(res.text) as Thread;
  s.registry.setClaudeWorker(thread.id, "/poteto-mode count the lines", "started", undefined, "s1");
  assert.ok(s.registry.appendClaudeRead(thread.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt }));
  return thread;
}

test("a Claude worker's page stream names one view for one conversation, and another for any other entry", async (t) => {
  const s = await seeded(t);
  const thread = await claudeThread(s, []);
  const reply = (text: string): ClaudeEntry => ({ kind: "reply", at: 1, text });
  const view = (entries: ClaudeEntry[]): ClaudeConversation => ({ kind: "claude", session: "s1", entries, dropped: 0, readAt: 1, working: false, usageLimit: null });
  const shows = (entries: ClaudeEntry[]) => (liveFrames(thread)(view(entries)) as { shows: string }).shows;
  assert.equal(shows([reply("A"), reply("Z")]), shows([reply("A"), reply("Z")]), "the same entries in another array");
  assert.notEqual(shows([reply("A"), reply("Z")]), shows([reply("B"), reply("Z")]), "a replaced transcript that ends as the old one did");
  const frames = liveFrames(thread);
  const first = frames(view([reply("A")])) as { convo: string; shows: string };
  const named = frames({ ...view([reply("A")]), working: true });
  assert.deepEqual(Object.keys(named ?? {}), ["shows"], "a view whose region reads as before gets a frame of its name alone");
  assert.notEqual((named as { shows: string }).shows, first.shows);
  assert.equal(frames({ ...view([reply("A")]), working: true }), null, "and a view named before gets none");
});

test("an age the client ticks reads as a render of the page at the same time would", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-27T12:00:00Z") });
  const s = await seeded(t);
  const thread = await claudeThread(s, []);
  const { agoText } = await import(new URL("./dashboard/ago.js", import.meta.url).href);
  const ages: string[] = [];
  for (const after of [0, 44_499, 44_500, 89_000, 44 * 60_000 + 29_000, 44 * 60_000 + 30_000, 45 * 60_000, 36 * 3_600_000 - 1_000, 36 * 3_600_000, 30 * 86_400_000]) {
    t.mock.timers.setTime(thread.createdAt + after);
    const html = (await s.call("GET", `/threads/${thread.id}`)).text;
    const [, datetime, age] = /<p class="convo-meta">.*? · started <time datetime="([^"]+)" title="[^"]+" data-ago>([^<]*)<\/time>/.exec(html)!;
    assert.equal(agoText(Date.parse(datetime!), Date.now()), age, `${after} ms after the thread started`);
    ages.push(age!);
  }
  assert.deepEqual(ages, ["just now", "just now", "1 min ago", "1 min ago", "44 min ago", "45 min ago", "1 h ago", "36 h ago", "2 d ago", "30 d ago"]);
});

test("a Claude worker's transcript reads as its conversation: prompts by who sent them, replies, folded calls with their results and a subagent's finish, notes, unknown records and what Claude queued", async (t) => {
  const s = await seeded(t);
  const thread = await claudeThread(s, [
    { kind: "prompt", at: 1, text: "Write hello.py, then count its lines", from: "person" },
    { kind: "tool", at: 2, id: "t1", name: "Write", input: { file_path: "/repo/hello.py", content: 'print("hi")\n' } },
    { kind: "result", at: 3, toolUseId: "t1", output: "File created", isError: false },
    { kind: "tool", at: 4, id: "t2", name: "Bash", input: { command: "false" } },
    { kind: "result", at: 5, toolUseId: "t2", output: "Exit code 1", isError: true },
    { kind: "tool", at: 6, id: "t3", name: "Agent", input: { description: "Count lines", subagent_type: "general-purpose", prompt: "Count the lines of `hello.py`" } },
    { kind: "result", at: 7, toolUseId: "t3", output: "Started in the background", isError: false },
    { kind: "reply", at: 8, text: "Counting with `wc`:\n```\nwc -l <hello.py>\n```\n" },
    { kind: "task", at: 9, toolUseId: "t3", status: "completed", summary: 'Agent "Count lines" finished', result: "It has `1` line." },
    { kind: "task", at: 10, toolUseId: null, status: "failed", summary: "Background command failed", result: null },
    { kind: "turn", at: 11, durationMs: 72_000 },
    { kind: "record", at: null, type: "mystery", summary: '{"type":"mystery"}' },
    { kind: "prompt", at: 12, text: "/compact", from: "command" },
    { kind: "notice", at: 13, tone: "error", text: "The model failed" },
    { kind: "queue", at: 14, op: "enqueue", text: "taken first" },
    { kind: "queue", at: 15, op: "dequeue", text: null },
    { kind: "queue", at: 16, op: "enqueue", text: "and then <deploy>" },
    { kind: "queue", at: 17, op: "enqueue", text: "taken by its text" },
    { kind: "queue", at: 18, op: "remove", text: "taken by its text" },
  ]);

  const html = (await s.call("GET", `/threads/${thread.id}`)).text;
  const { rows, open, dock } = conversationOf(html);
  assert.deepEqual(rows, [
    "You Write hello.py, then count its lines",
    "Changed a file, ran a command, ran a subagent 1 failed ›",
    '› Write /repo/hello.py +1 −0 ✓ /repo/hello.py + print("hi")',
    "› Bash false 1 line exit 1 false Exit code 1",
    '› Agent Count lines 1 line ✓ Count lines Count the lines of hello.py { "subagent_type": "general-purpose" } Started in the background Background task completed: Agent "Count lines" finished It has 1 line.',
    "Counting with wc : wc -l <hello.py>",
    "! A background task failed: Background command failed",
    "Worked for 1m 12s.",
    '! Claude Code wrote a mystery record: {"type":"mystery"}',
    "Slash command /compact",
    "! The model failed",
    "You queued, Claude takes it at its next step and then <deploy>",
  ]);
  assert.deepEqual(open, [["steps-t1", true], ["tool-t1", true], ["tool-t2", true], ["tool-t3", false]], "a fold with a failure starts open, as do the failure and the write's diff");
  assert.ok(html.includes("and then &lt;deploy&gt;"), "transcript text is escaped");
  assert.match(textOf(html.split('<p class="convo-meta">')[1]!.split("</p>")[0]!), new RegExp(`^${thread.id} · started just now · Claude Code · claude-opus-5-5$`));
  assert.match(html, /<form id="prompt" class="composer" data-thread="[^"]+" data-claude>/);
  assert.match(html, /placeholder="Message Claude…"/);
  assert.equal(dock, "The pylon is not running, so the transcript is as of its last read, just now . Sending a message wakes it and resumes Claude. claude-opus-5-5 ⌘↵ to send Send");
  assert.match(html, new RegExp(`data-stream="/threads/${thread.id}/stream"`));
});

test("a pull request Claude opened shows once, as an escaped link to it, however often its transcript names it", async (t) => {
  const s = await seeded(t);
  const url = 'https://github.com/acme/shop/pull/7?x="><b>';
  const thread = await claudeThread(s, [
    { kind: "pull-request", at: 1, number: 7, url, repository: "acme/shop" },
    { kind: "reply", at: 2, text: "Opened it." },
    { kind: "pull-request", at: 3, number: 7, url, repository: "acme/shop" },
    { kind: "pull-request", at: 4, number: 8, url: "https://github.com/acme/shop/pull/8", repository: "acme/shop" },
  ]);
  const html = (await s.call("GET", `/threads/${thread.id}`)).text;
  assert.deepEqual(conversationOf(html).rows, ["Opened pull request #7 ↗", "Opened it.", "Opened pull request #8 ↗"]);
  assert.ok(html.includes('<a class="link" href="https://github.com/acme/shop/pull/7?x=&quot;&gt;&lt;b&gt;" target="_blank" rel="noopener">Opened pull request #7 ↗</a>'), "the URL is escaped");
  assert.ok(html.includes('<a class="link" href="https://github.com/acme/shop/pull/8" target="_blank" rel="noopener">'));
});

test("a Claude worker that works shows its turn's call running, the turn's clock and calls, and a box that queues for Claude", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const thread = await claudeThread(s, [
    { kind: "prompt", at: 1, text: "Earlier", from: "person" },
    { kind: "tool", at: 2, id: "old", name: "Bash", input: { command: "sleep 1" } },
    { kind: "turn", at: 3, durationMs: 1_000 },
    { kind: "prompt", at: Date.now() - 72_000, text: "Run the tests", from: "person" },
    { kind: "prompt", at: Date.now(), text: "/compact", from: "command" },
    { kind: "tool", at: 4, id: "t1", name: "Bash", input: { command: "npm test" } },
  ]);
  s.observe(thread);
  s.registry.reportSession(node, { sequence: 1, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "s1" } });

  const html = (await s.call("GET", `/threads/${thread.id}`)).text;
  assert.match(html, /<span data-pylon="running" data-turn="true" /, "the client reads the checkout's changes once the turn ends, not on each of its heartbeats");
  const { rows, dock } = conversationOf(html);
  assert.deepEqual(rows, [
    "You Earlier",
    "Ran a command ›",
    "› Bash sleep 1 no result sleep 1 No output.",
    "Worked for 1s.",
    "You Run the tests",
    "Slash command /compact",
    "Ran a command 1 running ›",
    "› Bash npm test running npm test No output yet.",
  ], "only a call of the running turn runs");
  assert.match(dock, /^Claude is working\. 0s · 1 tool this turn · new messages go in at its next step Claude Code takes a message sent during a turn at its next step\. claude-opus-5-5 ⌘↵ to queue Queue$/,
    "the turn is timed from when control heard it start, and Claude cannot be aborted");
  const since = s.registry.thread(thread.id)!.workingSince;
  assert.equal(html.split(`<time data-since="${since}">`).length - 1, 3, "the run bar, the sidebar row and the inspector tick the same clock");
  assert.doesNotMatch(html, /data-action="abort"/);
  assert.match(html, /placeholder="Queue for Claude…"/);
});

test("a Claude worker's folds say what their calls did by action, a changed file once, and count the tools past three actions", async (t) => {
  const s = await seeded(t);
  let id = 0;
  const tool = (name: string, input: Record<string, unknown> = {}): ClaudeEntry => ({ kind: "tool", at: id, id: `t${++id}`, name, input });
  const thread = await claudeThread(s, [
    { kind: "prompt", at: 0, text: "Fix it", from: "person" },
    tool("Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b" }), tool("MultiEdit", { file_path: "/r/a.ts", edits: [] }), tool("Write", { file_path: "/r/a.ts", content: "b" }),
    tool("Write", { file_path: "/r/b.ts", content: "c" }), tool("Bash", { command: "npm test" }), tool("Bash", { command: "npm test" }), tool("Bash", { command: "git status" }),
    tool("Agent", { description: "Review" }), tool("Read", { file_path: "/r/a.ts" }), tool("Agent", { description: "Check" }), tool("TodoWrite"), tool("WebSearch", { query: "q" }),
    tool("WebFetch", { url: "https://example.com" }), tool("mcp__x"),
    { kind: "notice", at: 1, tone: "error", text: "Interrupted" },
    tool("Read", { file_path: "/r/a.ts" }), tool("Read", { file_path: "/r/a.ts" }), tool("Read", { file_path: "/r/b.ts" }), tool("Grep", { pattern: "x" }), tool("Glob", { pattern: "*.ts" }), tool("WebSearch", { query: "r" }),
  ]);
  const { rows } = conversationOf((await s.call("GET", `/threads/${thread.id}`)).text);
  assert.deepEqual(rows.filter((row) => row.endsWith("›") && !row.startsWith("›")), [
    "Changed 2 files, ran 3 commands, ran 2 subagents, used 5 other tools ›",
    "Read 2 files, searched the code 2 times, searched the web ›",
  ]);
  assert.ok(rows.includes("! Interrupted"), "the interrupt stays between the two folds");
});

test("a turn's length reads as a padded clock: seconds, then minutes and seconds, then hours and minutes", async (t) => {
  const s = await seeded(t);
  const thread = await claudeThread(s, [45_000, 63_000, 3_900_000].flatMap((durationMs, i): ClaudeEntry[] => [
    { kind: "prompt", at: i, text: `turn ${i}`, from: "person" },
    { kind: "turn", at: i, durationMs },
  ]));
  const { rows } = conversationOf((await s.call("GET", `/threads/${thread.id}`)).text);
  assert.deepEqual(rows.filter((row) => row.startsWith("Worked")), ["Worked for 45s.", "Worked for 1m 03s.", "Worked for 1h 05m."]);
});

test("a Claude worker without a transcript says whether it was read, and an archived one's says how old it is", async (t) => {
  const s = await seeded(t);
  const res = await s.call("POST", "/v1/threads", { project: "acme", title: "Fresh", claude: "go" });
  const fresh = JSON.parse(res.text) as Thread;
  assert.match(conversationOf((await s.call("GET", `/threads/${fresh.id}`)).text).text, /Claude's transcript has not been read yet\. It is read while the pylon runs\.$/);
  const read = await claudeThread(s, [], Date.now() - 10 * 60_000);
  assert.match(conversationOf((await s.call("GET", `/threads/${read.id}`)).text).text, /Claude has not written a transcript yet\.$/);
  assert.equal((await s.call("POST", `/v1/threads/${read.id}/archive`, {})).status, 200);
  assert.equal(conversationOf((await s.call("GET", `/threads/${read.id}`)).text).dock,
    "An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one. The pylon is not running, so the transcript is as of its last read, 10 min ago .");
});

test("pages link their assets by hash, and a hashed asset is cached for good", async (t) => {
  const s = await setup(t);
  const page = (await s.call("GET", "/")).text;
  for (const [file, type] of [["style.css", "text/css"], ["client.js", "text/javascript"], ["favicon.svg", "image/svg+xml"]] as const) {
    const href = new RegExp(`/assets/${file.replace(".", "\\.")}\\?v=[0-9a-f]{12}`).exec(page)?.[0];
    assert.ok(href !== undefined, `the page links ${file} by hash`);
    const versioned = await s.call("GET", href);
    assert.equal(versioned.status, 200);
    assert.ok((versioned.headers["content-type"] as string).startsWith(type), `${file} is served as ${type}`);
    assert.match(versioned.headers["cache-control"] as string, /immutable/);
    assert.ok(versioned.text.length > 0);
    assert.equal((await s.call("GET", `/assets/${file}?v=stale`)).headers["cache-control"], "no-cache");
  }
  const chunk = (await readdir(new URL("../../dist/dashboard/", import.meta.url))).find((file) => file !== "client.js");
  assert.ok(chunk !== undefined, "the bundle has a chunk besides client.js");
  const served = await s.call("GET", `/assets/${chunk}`);
  assert.equal(served.status, 200);
  assert.ok((served.headers["content-type"] as string).startsWith("text/javascript"), "a chunk is served as JavaScript");
  assert.match(served.headers["cache-control"] as string, /immutable/, "a chunk's name has its hash, so it is cached for good");
  for (const name of ["secret.txt", "notifications.js", "chunk-NOSUCH.js", "..%2Fpackage.json"]) assert.equal((await s.call("GET", `/assets/${name}`)).status, 404, name);
});

test("pages are served under a content security policy that allows only the dashboard's own origin", async (t) => {
  const s = await setup(t);
  assert.equal((await s.call("GET", "/")).headers["content-security-policy"],
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
});

test("dashboard pages answer only allowed callers under the API's own names", async (t) => {
  const s = await setup(t);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("GET", "/")).status, 403);
  s.callAs(laptop);
  assert.equal((await s.call("GET", "/", undefined, { host: "evil.example" })).status, 403);
  assert.equal((await s.call("GET", "/")).status, 200);
  // Pages are read-only. Only the JSON API changes state.
  assert.equal((await s.call("POST", "/threads/new", {})).status, 404);
});

test("a job in flight shows on the thread page as its transition", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.apply({ record: "job", status: { jobId: "job-1" as JobId, subject: fix.pylonId, kind: "pause", state: "running", startedAt: new Date().toISOString() } });
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(textOf(sectionOf(page, "pylon-h")), /Observed pausing/);
  assert.deepEqual(sidebarOf(page).rows, ["pausing Fix checkout now"]);
});

test("a page's rendered reply marker cannot advance while its conversation is being read", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Old conversation");
  s.registry.recordReply(fix.id, 1000);
  const watch = s.fake.harness.watch;
  s.fake.harness.watch = async (id) => {
    const view = await watch(id);
    s.registry.recordReply(fix.id, 2000);
    return view;
  };
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(html, /id="convo" data-rendered-reply-at="1000"/);
  assert.equal(s.registry.thread(fix.id)!.lastReplyAt, 2000);
  await s.call("POST", `/v1/threads/${fix.id}/seen`, { lastReplyAt: 1000 });
  const detail = JSON.parse((await s.call("GET", `/v1/threads/${fix.id}`)).text);
  assert.equal(detail.attention, "reply");
});

test("PR outputs show GitHub metadata and automated entries are not labelled as the person", async (t) => {
  const s = await seeded(t);
  const thread = await s.start("acme", "Review");
  const pr = { repo: "acme/repo", number: 42, title: "Fix <checkout>", url: "https://github.com/acme/repo/pull/42", state: "merged", checks: "passing", review: "approved", conflict: false } as const;
  s.registry.savePrWatch(thread.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  s.fake.transcript(thread.id).entries = [{ id: 1, conversationId: 1, kind: "nexus.pr-watch", data: { sender: "Nexus PR watch" }, model: [{ role: "user", content: "Automated feedback", timestamp: 0 }] }] as never;
  const page = (await s.call("GET", `/threads/${thread.id}`)).text;
  const outputs = sectionOf(page, "outputs-h");
  assert.match(textOf(outputs), /PR #42: Fix <checkout> — merged, checks passing, review approved/);
  assert.ok(outputs.includes(`href="${pr.url}"`));
  assert.ok(outputs.includes("Fix &lt;checkout&gt;"));
  assert.equal((outputs.match(/PR watch: off/g) ?? []).length, 1);
  assert.match(conversationOf(page).text, /Nexus PR watch Automated feedback/);
  const detail = JSON.parse((await s.call("GET", `/v1/threads/${thread.id}`)).text);
  assert.deepEqual(detail.pullRequests, [pr]);
  assert.ok(detail.outputs.some((o: { kind: string; ref: string }) => o.kind === "pull-request" && o.ref === pr.url));
});

test("a failed Claude worker's dashboard agrees with its registry event and API detail", async (t) => {
  const s = await seeded(t);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "worker", claude: "fix it", model: "custom-model" });
  const id = JSON.parse(started.text).id;
  const message = "Claude launch did not complete: executable missing";
  s.registry.setClaudeWorker(id, "fix it", "failed", message);
  s.registry.appendEvent("thread.failed", id, { message });
  const detail = JSON.parse((await s.call("GET", `/v1/threads/${id}`)).text);
  assert.deepEqual(detail.claudeWorker, { state: "failed", model: "custom-model", message });
  assert.equal(detail.attention, "failed");
  assert.deepEqual(detail.sessions, []);
  const page = textOf((await s.call("GET", `/threads/${id}`)).text);
  assert.ok(page.includes("Claude worker failed · custom-model"));
  assert.ok(page.includes(message));
  assert.equal(s.registry.events().filter((e) => e.kind === "thread.failed").at(-1)?.payload.message, detail.claudeWorker.message);
});

test("a Claude worker stopped on its usage limit shows the stop and when the limit resets", async (t) => {
  const s = await seeded(t);
  const id = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "worker", claude: "fix it" })).text).id;
  s.registry.setClaudeWorker(id, "fix it", "started", undefined, "s1");
  const resetsAt = Date.now() + 3_600_000;
  const entries: ClaudeEntry[] = [{ kind: "notice", at: Date.now(), tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt } }];
  assert.ok(s.registry.appendClaudeRead(id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now() }));
  const page = textOf((await s.call("GET", `/threads/${id}`)).text);
  const until = new Date(resetsAt).toISOString().slice(11, 16);
  assert.ok(page.includes(`stopped on its usage limit until ${until} UTC`), page);
});

test("a queued and a blocked thread show in the sidebar and the overview as queued, and their page waits for their predecessors and offers Start now", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const spike = await s.start("acme", "Spike");
  const queue = async (title: string, after: Thread[], extra: Record<string, unknown> = {}) => {
    const res = await s.call("POST", "/v1/threads", { project: "acme", title, after: after.map((a) => a.id), ...extra });
    assert.equal(res.status, 201, res.text);
    return JSON.parse(res.text) as QueuedThread;
  };
  const next = await queue("Next step", [fix], { message: "Fix the **next** bug." });
  const stuck = await queue("Stuck step", [spike], { claude: "Do it", node: "auto" });
  s.registry.savePrWatch(fix.id, { links: [{ pr: { repo: "acme/acme", number: 3, title: "Fix", url: "", state: "open", checks: "none", review: "none", conflict: null }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  await s.call("POST", `/v1/threads/${spike.id}/archive`);

  const home = (await s.call("GET", "/")).text;
  const rows = sidebarOf(home).rows;
  assert.ok(rows.includes("queued Next step queued"), rows.join(" | "));
  assert.ok(rows.includes("blocked Stuck step blocked"), rows.join(" | "));
  assert.doesNotMatch(home, new RegExp(`class="row dim" href="/threads/${stuck.id}"`), "a blocked row is never dimmed");
  assert.match(textOf(sectionOf(home, "project-acme")), new RegExp(`Queued Thread Waits for Node Next step queued Fix checkout: PR #3 is open ${node} Stuck step blocked Spike: is archived and its pull request did not merge auto`));

  const page = await s.call("GET", `/threads/${stuck.id}`);
  assert.equal(page.status, 200);
  assert.equal(sidebarOf(page.text).active, stuck.id);
  assert.match(page.text, /<span class="chip chip-bad">.*?<span class="chip-label">blocked<\/span><\/span>/);
  assert.match(page.text, new RegExp(`<button type="button" class="btn" id="start-queued" data-action="start-queued" data-thread="${stuck.id}">Start now</button>`));
  assert.match(page.text, new RegExp(`id="archive" data-action="archive" data-thread="${stuck.id}"`));
  const body = textOf(page.text.split('id="queued"')[1]!.split('<div class="dock">')[0]!);
  assert.match(body, /Starts once these threads' pull requests merge blocked Spike : is archived and its pull request did not merge/, "each wait links its predecessor");
  assert.match(body, /Prompt Do it Worker Claude Code · claude-opus-5-5 Node auto Size 2 CPUs, 4 GiB memory, 10 GiB disk/);
  assert.doesNotMatch(page.text, /data-activity=/, "a queued thread's page counts no visit, as it has no pylon to wake");
  assert.match(textOf((await s.call("GET", `/threads/${next.id}`)).text), /queued .*Fix checkout : PR #3 is open .*Message Fix the next bug\./);

  assert.equal((await s.call("POST", `/v1/threads/${stuck.id}/archive`)).status, 200);
  const cancelled = (await s.call("GET", `/threads/${stuck.id}`)).text;
  assert.match(cancelled, /<span class="chip-label">cancelled<\/span>/);
  assert.match(cancelled, /id="unarchive" data-action="unarchive"/);
  assert.doesNotMatch(cancelled, /id="start-queued"/);
  assert.ok(!sidebarOf((await s.call("GET", "/")).text).rows.some((r) => r.includes("Stuck step")), "a cancelled thread leaves the sidebar");

  assert.equal((await s.call("POST", `/v1/threads/${next.id}/start`)).status, 201);
  const started = (await s.call("GET", `/threads/${next.id}`)).text;
  assert.match(started, /id="convo"/, "once started, its page is a thread's");
  assert.ok(sidebarOf(started).rows.some((r) => r.endsWith("Next step now")));
});

/** A usage table's rows as a reader takes them in, and the exact token counts each row carries for a script. */
function usageTableOf(html: string, id: string) {
  const table = html.split(`id="${id}">`)[1]?.split("</table>")[0];
  assert.ok(table !== undefined, `no table ${id}`);
  const rows = table.split("<tbody>")[1]!.split("</tr>").slice(0, -1);
  return { rows: rows.map((row) => textOf(row)), tokens: rows.map((row) => [...row.matchAll(/data-tokens="(\d+)"/g)].map((m) => Number(m[1]))) };
}

const hour = 3_600_000;
const day = 24 * hour;
const usageCall = (id: string, agent: AgentCall["agent"], model: string, at: number, [input, output, cacheWrite, cacheRead]: number[]): AgentCall =>
  ({ id, agent, model, at, input: input!, output: output!, cacheWrite: cacheWrite!, cacheRead: cacheRead! });

test("the Usage page shows the period's tokens in all and by model, project, agent, role and UTC day, each exact in its title", async (t) => {
  const now = Date.parse("2027-03-10T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const docs = await s.start("beta", "Write docs");
  s.registry.recordUsage(fix.id, [
    usageCall("claude:m1", "claude", "claude-opus-5-5", now - hour, [1_200, 300, 50_000, 1_250_000]),
    usageCall("claude:m2", "claude", "claude-opus-5-5", now - 2 * day, [800, 700, 0, 0]),
  ]);
  s.registry.recordUsage(docs.id, [
    usageCall("pi:r1", "pi", "gpt-6-astra", now - 3 * day, [10_000, 2_000, 0, 30_000]),
    usageCall("pi:r2", "pi", "gpt-6-astra", now - 20 * day, [5_000_000, 0, 0, 0]),
  ]);

  const page = (await s.call("GET", "/usage")).text;
  assert.match(page, /<a class="side-link active" href="\/usage" aria-current="page">/, "the sidebar marks Usage as the open page");
  assert.match(page, /<div class="page usage" id="usage" data-live>/, "the page refreshes with the poll");
  assert.deepEqual([...page.matchAll(/<a class="seg-tab" href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((m) => [m[3], m[1], m[2] !== undefined]), [
    ["Today", "/usage?period=today", false], ["7 days", "/usage?period=7d", true], ["30 days", "/usage?period=30d", false], ["All", "/usage?period=all", false],
    ["All projects", "/usage?period=7d", true], ["acme", "/usage?period=7d&amp;project=acme", false], ["beta", "/usage?period=7d&amp;project=beta", false],
  ], "the period is 7 days unless picked, over every project");
  assert.match(textOf(page), /Counting started \d{4}-\d\d-\d\d \d\d:\d\d UTC ?\. The calls of threads that ran then were counted from the transcripts their pylons had\. Threads deleted before then are not counted, as their Claude and pi transcripts went with their pylons, except for the Nexus agent's calls, which the harness keeps\./);
  assert.match(textOf(page), /The summaries the Nexus agent's compactions write, and model calls its tools make, are not counted\./);

  const totals = usageTableOf(page, "usage-totals");
  assert.deepEqual(totals.rows, ["7 days 12k 3k 50k 1.3M 1.3M 3"], "the call 20 days ago is outside the period");
  assert.deepEqual(totals.tokens, [[12_000, 3_000, 50_000, 1_280_000, 1_345_000]]);
  assert.match(page.split('id="usage-totals"')[1]!, /^[^]*?<td data-column="input" data-tokens="12000" title="12,000">12k<\/td>/, "the exact count is the title");
  assert.deepEqual(usageTableOf(page, "usage-by-model").rows, ["claude-opus-5-5 2k 1k 50k 1.3M 1.3M 2", "gpt-6-astra 10k 2k 0 30k 42k 1"]);
  assert.deepEqual(usageTableOf(page, "usage-by-project").rows, ["acme 2k 1k 50k 1.3M 1.3M 2", "beta 10k 2k 0 30k 42k 1"]);
  assert.match(page.split('id="usage-by-project"')[1]!, /<a class="link" href="\/usage\?period=7d&amp;project=acme">acme<\/a>/, "a project's row picks it");
  assert.deepEqual(usageTableOf(page, "usage-by-kind").rows, ["claude 2k 1k 50k 1.3M 1.3M 2", "pi 10k 2k 0 30k 42k 1"]);
  assert.deepEqual(usageTableOf(page, "usage-by-role").rows, ["builder 12k 3k 50k 1.3M 1.3M 3"], "a person's threads are builders");
  assert.deepEqual(usageTableOf(page, "usage-by-day").rows, ["2027-03-10 1.2k 300 50k 1.3M 1.3M 1", "2027-03-08 800 700 0 0 1.5k 1", "2027-03-07 10k 2k 0 30k 42k 1"], "days are UTC, newest first");
  assert.match(page.split('id="usage-totals"')[1]!.split("</thead>")[0]!, /<th>Input<\/th><th>Output<\/th><th class="wide">Cache write<\/th><th class="wide">Cache read<\/th><th>Total<\/th><th class="wide">Calls<\/th>/, "a phone hides the cache and call columns");

  const all = (await s.call("GET", "/usage?period=all")).text;
  assert.deepEqual(usageTableOf(all, "usage-totals").tokens, [[5_012_000, 3_000, 50_000, 1_280_000, 6_345_000]]);
  assert.deepEqual(usageTableOf(all, "usage-by-day").rows.at(-1), "2027-02-18 5M 0 0 0 5M 1");
  assert.deepEqual(usageTableOf((await s.call("GET", "/usage?period=today")).text, "usage-totals").rows, ["Today 1.2k 300 50k 1.3M 1.3M 1"]);

  const beta = (await s.call("GET", "/usage?period=30d&project=beta")).text;
  assert.match(beta, /<a class="seg-tab" href="\/usage\?period=30d&amp;project=beta" aria-current="page">beta<\/a>/);
  assert.deepEqual(usageTableOf(beta, "usage-totals").rows, ["30 days 5M 2k 0 30k 5M 2"], "the project narrows every table");
  assert.deepEqual(usageTableOf(beta, "usage-by-model").rows, ["gpt-6-astra 5M 2k 0 30k 5M 2"]);
  assert.deepEqual(usageTableOf((await s.call("GET", "/usage?period=fortnight")).text, "usage-totals").rows, ["7 days 12k 3k 50k 1.3M 1.3M 3"], "an unknown period is the default");

  const home = (await s.call("GET", "/")).text;
  assert.match(home, /<a class="side-link" href="\/usage">.*Usage<\/a>/, "every page links to Usage");
});

test("the Usage page says what the usage backfill did and does, with the threads it skipped and why", async (t) => {
  const s = await seeded(t);
  const old = await s.start("acme", "Old work");
  const gone = await s.start("acme", "Gone");
  for (const thread of [old, gone]) s.registry.setThreadStatus(thread.id, "archived");
  const note = async () => {
    const m = /<div id="usage-backfill" ([^>]*)>([^]*?)<\/div>/.exec((await s.call("GET", "/usage")).text);
    assert.ok(m !== null, "the backfill note is on the page");
    return { attributes: m[1]!, text: textOf(m[2]!), html: m[2]! };
  };
  const never = await note();
  assert.equal(never.attributes, 'data-backfill-state="never"');
  assert.equal(never.text, "The calls archived threads made before then are counted once a deployer runs nexus usage backfill , which wakes their pylons one at a time to read them.");

  s.registry.startUsageBackfill([old.id, gone.id], Date.now());
  s.registry.waitUsageBackfill("rj-firebat is busy with a job");
  const waiting = await note();
  assert.equal(waiting.attributes, 'data-backfill-state="running" data-read="0" data-of="2" data-recovered-calls="0" data-recovered-tokens="0"');
  assert.equal(waiting.text, "The backfill reads archived threads' pylons, one at a time: 0 of 2 threads read, 0 calls and 0 tokens recovered so far. It waits: rj-firebat is busy with a job.");
  s.registry.holdUsageBackfill(old.id, Date.now());
  assert.ok((await note()).html.includes(`It reads <a class="link" href="/threads/${old.id}">Old work</a>.`));
  assert.match(textOf((await s.call("GET", `/threads/${old.id}`)).text), /Desired reading/, "the thread's pylon wants to run for reading");
  s.registry.recordUsage(old.id, Array.from({ length: 1234 }, (_, i) => ({ id: `claude:msg_${i}`, agent: "claude" as const, model: "claude-opus-5-5", at: 1_000, input: i === 0 ? 5_600_000 - 1233 : 1, output: 0, cacheWrite: 0, cacheRead: 0 })), [], true);
  s.registry.finishUsageBackfillThread(old.id, "done", null, Date.now());
  assert.equal((await note()).text, "The backfill reads archived threads' pylons, one at a time: 1 of 2 threads read, 1,234 calls and 5.6M tokens recovered so far. It waits for the pylon of Old work to pause.");
  s.registry.stopUsageBackfill(Date.now());
  assert.equal((await note()).text, "The backfill stopped at 1 of 2 threads read, with 1,234 calls and 5.6M tokens recovered. A deployer goes on with nexus usage backfill .");

  s.registry.startUsageBackfill([gone.id], Date.now());
  s.registry.finishUsageBackfillThread(gone.id, "skipped", "rj-firebat holds no disk for its pylon", Date.now());
  s.registry.finishUsageBackfill(Date.parse("2027-03-10T12:00:00Z"));
  const done = await note();
  assert.equal(done.attributes, 'data-backfill-state="done" data-read="2" data-of="2" data-recovered-calls="1234" data-recovered-tokens="5600000"');
  assert.equal(textOf(done.html.split("<table")[0]!), "The backfill read archived threads' pylons and finished 2027-03-10 12:00 UTC : 2 of 2 threads read, 1 skipped, 1,234 calls and 5.6M tokens recovered.");
  assert.deepEqual(usageTableOf(done.html, "usage-backfill-skipped").rows, ["Gone rj-firebat holds no disk for its pylon"]);
  assert.ok(done.html.includes(`<a class="link" href="/threads/${gone.id}">Gone</a>`), "a skipped thread links to its page");
});

test("the Usage page with no calls in the period says so, and its totals are zero", async (t) => {
  const s = await seeded(t);
  const page = (await s.call("GET", "/usage?period=today")).text;
  assert.deepEqual(usageTableOf(page, "usage-totals"), { rows: ["Today 0 0 0 0 0 0"], tokens: [[0, 0, 0, 0, 0]] });
  assert.match(textOf(page), /No model calls were counted in this period\./);
  assert.ok(!page.includes('id="usage-by-model"'), "no breakdown is drawn empty");
});

test("a thread page's pylon pane says what tokens the thread's agents spent, refreshed with the poll", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const other = await s.start("acme", "Other");
  s.observe(fix);
  const tokens = async () => {
    const page = (await s.call("GET", `/threads/${fix.id}`)).text;
    const live = page.split('<div class="pane-live" id="inspect" data-live>')[1]!.split("</aside>")[0]!;
    const row = /<dd id="thread-usage" data-tokens="(\d+)">(.*?)<\/dd>/.exec(live);
    assert.ok(row !== null, "the tokens row is in the live inspector");
    return [Number(row[1]), textOf(row[2]!).replace(/\( /, "(").replace(/ \)/, ")")];
  };
  assert.deepEqual(await tokens(), [0, "none counted"]);
  s.registry.recordUsage(fix.id, [
    usageCall("claude:m1", "claude", "claude-opus-5-5", Date.now() - 40 * day, [300_000, 20_000, 100_000, 800_000]),
    usageCall("claude:m2", "claude", "claude-opus-5-5", Date.now(), [1_000, 500, 0, 0]),
  ]);
  s.registry.recordUsage(other.id, [usageCall("claude:m3", "claude", "claude-opus-5-5", Date.now(), [9_000_000, 0, 0, 0])]);
  assert.deepEqual(await tokens(), [1_221_500, "1.2M (in 301k · out 20.5k · cache write 100k · cache read 800k)"], "every call of the thread, however old, and no other thread's");
});
