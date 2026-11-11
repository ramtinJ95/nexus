import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { StatementSync } from "node:sqlite";
import { request } from "node:http";
import { itemThread, type PipelineItem } from "../pipeline.ts";
import type { QueuedThread } from "../../contract/threads.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadDetail } from "../wire.ts";
import { addThread, observeNode, testPr, testReview, claudeWorkerAt, testThread, testPylon } from "../../test-support/registry-kit.ts";
import { personPhase, type Review } from "../review-model.ts";
import type { ReviewLoop } from "../review.ts";
import type { HoldsQuestion } from "../questions.ts";
import type { Judgment } from "../judgment-store.ts";
import type { AgentCall } from "../agent-usage.ts";
import { requestIds, type ImageId, type ItemId, type JobId, type NodeName, type ProjectId, type PylonId, type TailnetNodeId, type ThreadId } from "../../ids.ts";
import type { ServiceFact } from "../../protocol/observations.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import { recordingHealth, sampleOf } from "../node-metrics.ts";
import { defaultProjectResources } from "../project.ts";
import { githubTokenGrant } from "../../protocol/secret-grants.ts";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { parseRecord, transcriptStart, type ClaudeConversation, type ClaudeEntry } from "../claude-transcript.ts";
import { runningPylon, stoppedPylon, testCapacity, testImage, testObservation } from "../../test-support/kit.ts";
import { claudeItems, conversationItems, imagePaths } from "./items.ts";
import { liveFrames, liveStreams, type ItemsOf } from "./live-frames.ts";
import type { PromptSenders } from "../inbox.ts";
import type { Question } from "../questions.ts";
import { promptSenders, typeIntoClaude } from "../inbox.ts";
import { senders } from "../agent-protocol.ts";
import { startHint, type HintPart } from "./start-hint.ts";
import { agoText, clock } from "./elapsed.ts";
import { bundle } from "./assets.ts";
import { inlineSteps } from "./markdown.ts";
import { imageTypes } from "../../image-types.ts";
import { defaultClaudeModel } from "../../protocol/models.ts";
import { testApi, type TestApiOptions } from "../../test-support/api-kit.ts";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const project = (id: string) => ({
  id, repoUrl: `git@example.com:${id}.git`, defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const image = testImage();
const capacity = testCapacity();

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string }

async function setup(t: TestContext, options: TestApiOptions = {}) {
  const api = await testApi(t, { pipeline: true, planning: false, allowed: new Set([laptop]), probes: new Map(), ...options });
  const { registry, fake, startThread } = api;
  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request({
        // The API runs on this event loop, so a pooled socket idle past its keep-alive timeout can be reused before
        // either side's timer runs, and the server then resets it. A connection per call has nothing to reuse.
        host: "127.0.0.1", port: api.port, method, path, agent: false,
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
    registry.threads.apply({ record: "node", node, state: "online", capacity });
    const pylons = threads.map((t) => runningPylon(t.pylonId, {
      liveHash: registry.threads.pylon(t.pylonId)!.liveHash, bootedFrom: { image: image.id, checkpoint: null },
      services: facts.services ?? [], listening: (facts.listening ?? []).map((port) => ({ port })),
    }));
    registry.threads.ingested(testObservation(node, { pylons }), []);
  }
  return {
    registry, fake, call, start, startThread, observe, observeWith, callAs: api.callAs,
    events: api.events,
  };
}

async function seeded(t: TestContext, options: TestApiOptions = {}) {
  const s = await setup(t, options);
  for (const id of ["acme", "beta"]) assert.equal((await s.call("POST", "/v1/projects", project(id))).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.images.setCurrentImage(image.id as ImageId);
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

/** A tool row's mark, drawn as an icon, as a character, so a row reads as one line of text. */
const marks = { ok: "✓", bad: "✕", none: "–" };

/**
 * A thread page's conversation as a reader sees it: one row per message, notice, tool call and fold, which
 * tool calls, folds and clipped outputs start open, and the dock under it with the run bar and the prompt box.
 */
function conversationOf(html: string) {
  const convo = html.split('id="convo"')[1]!.split('<button type="button" class="btn btn-xs jump-end"')[0]!;
  const dock = html.split('<div class="dock">')[1]!.split("</main>")[0]!;
  return {
    rows: convo.replace(/<span class="t-mark (ok|bad|none)"[^>]*>/g, (mark, state: keyof typeof marks) => `${mark}${marks[state]}`)
      .split(/(?=<div class="msg |<p class="notice|<p class="note"|<details class="tool|<details class="steps)/).slice(1).map((row) => textOf(`<x ${row}`).replace(/^<x /, "")),
    open: [...convo.matchAll(/<details class="(?:tool|steps|t-more)[^"]*" id="([^"]*)"( open)?>/g)].map((m) => [m[1], m[2] !== undefined]),
    text: textOf(convo.replace(/^[^>]*>/, "")),
    dock: textOf(dock),
  };
}


/** A view's rows as the route reads them, with the questions and prompt senders a test gives a Claude transcript. */
const itemsWith = (thread: ThreadId, questions = (): readonly Question[] => [], senders = (): PromptSenders => () => null): ItemsOf => (view) =>
  view.kind === "claude" ? claudeItems(view.view, questions(), thread, senders()) : conversationItems(view.view, thread);

test("the overview lists each project's open threads with their phases, node and activity, and folds the archived", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const docs = await s.start("beta", "Write docs");
  const old = await s.start("acme", "Old spike");
  const started = Date.now() - 63_000;
  s.registry.threads.recordActivity(docs.id, { agent: started, agentTurnRunning: true });
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
  assert.match(textOf(acme!), /^acme .* Thread Desired Observed Node Human Agent Fix checkout .* 1 archived$/, "the archived thread is counted, not listed");
  assert.match(acme!, /<a href="\/threads\/closed\?project=acme">1 archived<\/a>/);
  const closed = sectionOf((await s.call("GET", "/threads/closed?project=acme")).text, "project-acme");
  assert.match(textOf(closed), /^acme 1 Thread Desired Observed Node Human Agent Old spike archived paused not on its node/, "the archived thread is listed on its fold's page");
  const far = await s.call("GET", "/threads/closed?project=acme&page=1e100");
  assert.equal(far.status, 200, "a page far past the last lists none");
  assert.match(textOf(sectionOf(far.text, "project-acme")), /^acme 1 Newer$/);
});

test("an archived thread's timeline says why its disk is kept past its 24 hours, until its usage was read and backed up", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const old = await s.start("acme", "Old spike");
  assert.equal((await s.call("POST", `/v1/threads/${old.id}/archive`)).status, 200);
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  s.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(old.pylonId)] }), []);
  const archived = async () => textOf((await s.call("GET", `/threads/${old.id}`)).text.split('id="tl-archived"')[1]!.split("</li>")[0]!);
  t.mock.timers.setTime(Date.now() + 23 * 60 * 60_000);
  assert.doesNotMatch(await archived(), /kept/, "under its 24 hours");
  t.mock.timers.setTime(Date.now() + 2 * 60 * 60_000);
  s.registry.usage.finishSettle(old.id, "its pylon did not boot within 10 minutes", Date.now());
  assert.match(await archived(), /Its pylon is paused\. Unarchive it to pick the work up again\. Its disk is kept past its 24 hours, as its token usage is not read to its end yet, and reading it failed once, the last because its pylon did not boot within 10 minutes\.$/);
  s.registry.usage.finishSettle(old.id, null, Date.now());
  assert.match(await archived(), /Its disk is kept past its 24 hours, as it waits for a backup that begins after its token usage was read\.$/);
  s.registry.threads.recordBackedUp(Date.now() + 1);
  assert.doesNotMatch(await archived(), /kept/);
});

test("an archive whose usage will not be read without the person needs them, as its reads keep failing, with a delete that loses the unread usage, and a pylon that cannot be read is shown as usage unread", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const old = await s.start("acme", "Old spike");
  assert.equal((await s.call("POST", `/v1/threads/${old.id}/archive`)).status, 200);
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  s.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(old.pylonId)] }), []);
  const card = async () => (await s.call("GET", "/")).text.split(`id="need-${old.id}-disk"`)[1]?.split("</article>")[0];
  const archived = async () => textOf((await s.call("GET", `/threads/${old.id}`)).text.split('id="tl-archived"')[1]!.split("</li>")[0]!);
  t.mock.timers.setTime(Date.now() + 25 * 60 * 60_000);
  for (let i = 0; i < 2; i++) s.registry.usage.finishSettle(old.id, "its pylon did not boot within 10 minutes", Date.now());
  assert.equal(await card(), undefined, "two failed reads are tried again on their own");
  s.registry.usage.finishSettle(old.id, "its pylon did not boot within 10 minutes", Date.now());
  const kept = (await card())!;
  assert.match(textOf(kept), /Disk kept/);
  assert.match(textOf(kept), /Its disk is kept past its 24 hours, as its token usage is not read to its end yet, and reading it failed 3 times in a row, the last because its pylon did not boot within 10 minutes\. Nexus tries the read again on its own, or delete the thread, which deletes the disk with the token usage on it unread\./);
  assert.match(kept, /data-action="delete"[^>]*data-confirm="Delete &quot;Old spike&quot;\? Its disk goes with the token usage on it unread\."/);

  s.registry.threads.markUnread(old.id, "its pylon failed: gave up after 5 failed attempts");
  assert.equal(await card(), undefined, "a disk whose usage cannot be read is not kept for it");
  assert.match(await archived(), /Usage unread: its disk goes 24 hours after the archive with the token usage on it unread, as its pylon failed: gave up after 5 failed attempts\.$/);
  assert.doesNotMatch(await archived(), /kept/);
});

test("every page's first stop for Tab skips the sidebar to the page, and the page has the list of its shortcuts", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  for (const path of ["/", `/threads/${fix.id}`, "/cluster"]) {
    const page = (await s.call("GET", path)).text;
    assert.match(page, /<body>\s*<a class="skip" href="#main">Skip to the page<\/a>\s*<div class="app/, `${path} opens with the skip link`);
    assert.match(page, /<main class="main" id="main" tabindex="-1"/, `${path}'s main takes the skip link's focus`);
    assert.match(page, /<dialog id="keys" class="modal keys" aria-labelledby="keys-h">.*<dl id="keys-list"><\/dl><\/dialog>/, `${path} has the shortcuts overlay ? opens`);
  }
});

test("the sidebar lists every project's threads with their state, counts the archived with a link to them and marks the open one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const docs = await s.start("beta", "Write docs");
  const old = await s.start("acme", "Old spike");
  const gone = await s.start("acme", "Gone");
  const started = Date.now() - 63_000;
  s.registry.threads.recordActivity(docs.id, { agent: started, agentTurnRunning: true });
  await s.call("POST", `/v1/threads/${old.id}/archive`);
  await s.call("DELETE", `/v1/threads/${gone.id}`);
  s.observe(fix);

  for (const path of ["/", `/threads/${fix.id}`, "/threads/new", "/threads/th-missing"]) {
    const html = (await s.call("GET", path)).text;
    const sidebar = sidebarOf(html);
    // Threads started in the same millisecond have no order between them.
    assert.deepEqual(sidebar.rows.toSorted(), ["agent idle Fix checkout now", "agent working Write docs working 1m 03s"], `${path} lists the open threads`);
    assert.match(sidebar.text, /^acme main Fix checkout now 1 archived, 1 deleted beta main Write docs working 1m 03s$/);
    assert.match(html, /<a class="archived-link" id="archived-acme" href="\/threads\/closed\?project=acme">1 archived, 1 deleted<\/a>/, `${path} links the closed threads' page`);
    assert.match(html, new RegExp(`<span class="row-at">working <time data-since="${started}">1m 03s</time></span>`), `${path} ticks the working thread's clock`);
  }
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.equal(sidebarOf(page).active, fix.id);
  const archived = sidebarOf((await s.call("GET", `/threads/${old.id}`)).text);
  assert.deepEqual([archived.active, archived.rows.includes("archived Old spike now"), archived.rows.includes("deleted Gone now")], [old.id, true, false], "an archived thread's page lists and marks it alone of the closed");
  assert.doesNotMatch(page, /id="side-nodes"/, "the sidebar leaves the nodes to the Cluster page");
  assert.match(textOf(await nodeHeads(s)), /rj-firebat/);
});

test("thousands of closed threads leave the home page small, and their page lists them newest first a hundred at a time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const title = (i: number) => `Closed ${String(i).padStart(4, "0")}`;
  const closed = Array.from({ length: 2000 }, (_, i) => addThread(s.registry, { thread: { title: title(i), status: i % 2 === 0 ? "archived" : "deleted", createdAt: Date.now() - (3000 - i) * 1000 } }));
  await s.start("acme", "Fix checkout");
  await s.start("acme", "Write docs");
  s.registry.queue.saveQueued({
    id: "th-cancelled01" as ThreadId, title: "Never ran", project: "acme" as ProjectId, startedBy: laptop, createdAt: Date.now(), after: [],
    request: { project: "acme", title: "Never ran", resources: defaultProjectResources }, message: "go", status: "archived", startNow: null, lastError: null, startedAt: null, firstMessage: null,
  });

  const home = (await s.call("GET", "/")).text;
  assert.ok(Buffer.byteLength(home) < 100_000, `GET / is ${Buffer.byteLength(home)} bytes`);
  assert.deepEqual(closed.filter((c) => home.includes(c.title)), [], "no closed thread's title is on the home page");
  assert.match(textOf(home), /Fix checkout/);
  assert.match(sectionOf(home, "project-acme"), /<a href="\/threads\/closed\?project=acme">1000 archived, 1000 deleted<\/a>/);

  const first = (await s.call("GET", "/threads/closed?project=acme")).text;
  const listed = (html: string) => [...sectionOf(html, "project-acme").matchAll(/>(Closed \d{4})</g)].map((m) => m[1]);
  assert.deepEqual(listed(first), Array.from({ length: 100 }, (_, i) => title(1999 - i)), "the newest hundred");
  assert.match(textOf(first), /Never started Thread Never ran cancelled/, "a queued thread cancelled before it started is listed with the closed");
  assert.match(first, /<a class="link" href="\/threads\/closed\?project=acme&amp;page=2">Show older<\/a>/);
  assert.doesNotMatch(first, />Newer</);
  assert.match(sectionOf(first, "project-acme"), /<span class="count">2000<\/span>/, "the closed page counts what the home page's line counts");
  assert.match(first, /<div class="page" id="fold-list" data-live>/, "the client's poll swaps the list as threads close");
  const second = (await s.call("GET", "/threads/closed?project=acme&page=2")).text;
  assert.deepEqual(listed(second), Array.from({ length: 100 }, (_, i) => title(1899 - i)), "the next hundred");
  assert.match(second, /<a class="link" href="\/threads\/closed\?project=acme">Newer<\/a>/);
  assert.equal(listed((await s.call("GET", "/threads/closed?project=acme&page=20")).text).at(-1), title(0), "the last page ends at the oldest");
  assert.equal((await s.call("GET", "/threads/closed?project=nosuch")).status, 404);

  const oldest = sidebarOf((await s.call("GET", `/threads/${closed[0]!.id}`)).text);
  assert.equal(oldest.active, closed[0]!.id, "a closed thread's page marks its row in the sidebar");
  assert.equal(oldest.rows.filter((r) => r.includes("Closed")).length, 1, "and lists no other closed thread");
});

test("a thread's row names it in full and carries what a search matches, and ?q= searches the closed and quiet pages on the server", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  // IDs of their own, since a random one may hold the digits a query below searches for.
  const cache = addThread(s.registry, { thread: { id: "th-c0000000000a" as ThreadId, title: "Review of #88: feat(checkout) cache the cart", status: "archived" } });
  const retries = addThread(s.registry, { thread: { id: "th-c0000000000b" as ThreadId, title: "Review of #88: feat(checkout) retry the charge", status: "deleted" } });
  const docs = addThread(s.registry, { thread: { id: "th-c0000000000c" as ThreadId, title: "Write the docs", project: "beta" as ProjectId, status: "archived" } });
  s.registry.prWatches.savePrWatch(docs.id, { links: [{ pr: testPr({ repo: "acme/nexus", number: 412 }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const fix = await s.start("acme", "Fix checkout");
  s.registry.prWatches.savePrWatch(fix.id, { links: [{ pr: testPr({ repo: "acme/nexus", number: 7 }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });

  const listed = JSON.parse((await s.call("GET", "/v1/threads")).text) as { id: string; pullRequestNumbers: number[] }[];
  assert.deepEqual(Object.fromEntries(listed.map((r) => [r.id, r.pullRequestNumbers])), { [cache.id]: [], [retries.id]: [], [docs.id]: [412], [fix.id]: [7] }, "the list's rows carry their linked pull requests' numbers, which the switcher matches");
  const home = (await s.call("GET", "/")).text;
  const row = new RegExp(`<a class="row[^"]*" href="/threads/${fix.id}" title="Fix checkout" data-find="fix checkout acme ${fix.id} #7"`);
  assert.match(home, row, "the row's title names the thread in full, and its data-find holds its title, project, ID and pull request");
  assert.match(home, /<form id="filter-form" action="\/threads\/closed" role="search"><label class="filter">.*?<input id="filter" name="q"/, "Enter in the filter searches the closed threads");

  const closed = async (query: string) => {
    const html = (await s.call("GET", `/threads/closed?${query}`)).text;
    return { html, titles: [...html.split('id="fold-list"')[1]!.matchAll(/<a href="\/threads\/[^"]+">([^<]*)<\/a>/g)].map((m) => m[1]).toSorted() };
  };
  assert.deepEqual((await closed("q=")).titles, [cache.title, retries.title, docs.title].toSorted(), "an empty query lists every closed thread");
  assert.deepEqual((await closed("q=checkout+retry")).titles, [retries.title], "each word of the query matches the title");
  assert.deepEqual((await closed("q=%23412")).titles, [docs.title], "a pull request's number matches its thread");
  assert.deepEqual((await closed("q=412")).titles, [docs.title], "and without its #");
  assert.deepEqual((await closed("q=beta")).titles, [docs.title], "a project's name matches its threads");
  assert.deepEqual((await closed(`q=${cache.id}`)).titles, [cache.title], "a thread's ID matches it");
  assert.deepEqual((await closed("project=acme&q=88")).titles, [cache.title, retries.title].toSorted(), "the query narrows a project's page");
  const none = await closed("project=acme&q=nothing+like+it");
  assert.deepEqual(none.titles, []);
  assert.match(textOf(sectionOf(none.html, "project-acme")), /No threads match “nothing like it”\./);
  assert.match(none.html, /<form class="bar-end fold-search" method="get" action="\/threads\/closed" role="search"><input type="hidden" name="project" value="acme"><input type="search" name="q" value="nothing like it"/, "the search box holds the query and keeps the project");

  const day = Date.now() - 24 * 60 * 60_000;
  const quiet = (i: number, title: string) => addThread(s.registry, { thread: { title, createdAt: day + i, lastHumanActivityAt: day } });
  const old = Array.from({ length: 101 }, (_, i) => quiet(i, `Quiet spike ${i}`));
  quiet(200, "Quiet docs pass");
  observeNode(s.registry);
  const quietPage = (await s.call("GET", "/threads/quiet?project=acme&q=spike")).text.split('id="fold-list"')[1]!;
  assert.equal([...quietPage.matchAll(/>Quiet spike \d+</g)].length, 100, "the quiet page matches on the server, a hundred to a page");
  assert.doesNotMatch(quietPage, /Quiet docs pass/);
  assert.match(quietPage, /<a class="link" href="\/threads\/quiet\?project=acme&amp;page=2&amp;q=spike">Show older<\/a>/, "its next page keeps the query");
  assert.match((await s.call("GET", "/threads/quiet?project=acme&page=2&q=spike")).text.split('id="fold-list"')[1]!, new RegExp(`>${old[0]!.title}<`), "the oldest match is on the next page");
});

test("a quiet fold lists its newest hundred, and the open one past them, and links the rest", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const title = (i: number) => `Quiet ${String(i).padStart(3, "0")}`;
  const day = Date.now() - 24 * 60 * 60_000;
  const quiet = Array.from({ length: 150 }, (_, i) => addThread(s.registry, { thread: { title: title(i), createdAt: day + i * 1000, lastHumanActivityAt: day } }));
  observeNode(s.registry);

  const listed = (html: string) => [...html.matchAll(/>(Quiet \d{3})</g)].map((m) => m[1]);
  const home = (await s.call("GET", "/")).text;
  const newest = Array.from({ length: 100 }, (_, i) => title(149 - i));
  assert.deepEqual(listed(sectionOf(home, "project-acme")), newest, "the overview's fold");
  assert.deepEqual(listed(home.split('id="side-threads"')[1]!.split("</nav>")[0]!), newest, "the sidebar's fold");
  assert.match(sectionOf(home, "project-acme"), /<a class="link" href="\/threads\/quiet\?project=acme">All 150 quiet<\/a>/);
  assert.match(home, /<a class="archived-link" href="\/threads\/quiet\?project=acme">All 150 quiet<\/a><\/details>/);
  const page = sidebarOf((await s.call("GET", `/threads/${quiet[0]!.id}`)).text);
  assert.equal(page.active, quiet[0]!.id, "an old quiet thread's page still marks its row");
  assert.deepEqual(listed((await s.call("GET", "/threads/quiet?project=acme&page=2")).text.split('id="project-acme"')[1]!), Array.from({ length: 50 }, (_, i) => title(49 - i)));
});

test("a review the person cancelled says which thread they archived, and asks nothing of them", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.registry.reviews.saveReview(testReview({ builder: fix.id, phase: { kind: "cancelled", who: "reviewer", status: "archived" } }));
  const page = textOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.match(page, /Nexus review rv-1 of PR #7: cancelled, round 1 of 5, reviewer th-reviewer on gpt-6-astra, the reviewer thread th-reviewer was archived/);
});

test("a running review's line offers to cancel it behind a confirm, and one that ended or began deploying offers nothing", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const review = testReview({ builder: fix.id });
  s.registry.reviews.saveReview(review);
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(page, new RegExp(`<button type="button" class="btn btn-xs btn-ghost danger" data-action="cancel-review" data-thread="${fix.id}" data-confirm="Cancel review rv-1 of pull request #7\\? Its reviewer thread is archived, and this thread stays as it is\\.">Cancel review</button>`));
  for (const phase of [{ kind: "deploying", commit: "m".repeat(40), previous: null, requested: true, deadline: 0 }, { kind: "approved" }] as const) {
    s.registry.reviews.saveReview({ ...review, phase });
    assert.doesNotMatch((await s.call("GET", `/threads/${fix.id}`)).text, /data-action="cancel-review"/, phase.kind);
  }
  s.registry.reviews.saveReview({ ...review, phase: { kind: "cancelled", who: "person", by: "nPHONE" } });
  assert.match(textOf((await s.call("GET", `/threads/${fix.id}`)).text), /Nexus review rv-1 of PR #7: cancelled, round 1 of 5, reviewer th-reviewer on gpt-6-astra, cancelled by nPHONE/);
});

const phone = "nPHONE" as TailnetNodeId;
/** A control plane whose deployers are the laptop only, with a review loop whose PRs from acme/nexus deploy. */
const landingOptions = (landed: string[] = []): TestApiOptions => ({
  allowed: new Set([laptop, phone]),
  deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {} },
  reviews: {
    deploys: (r: Review) => r.pr.repo === "acme/nexus",
    land(builder: ThreadId) { landed.push(builder); return testReview({ builder }); },
  } as never as ReviewLoop,
});
const head = "9f".repeat(20);
/** A review of PR #7 whose reviewer approved `head` with one P3 note and whose check passed there. */
const approvedReview = (builder: ThreadId, phase: Review["phase"], extra: Partial<Review> = {}): Review => testReview({
  builder, pr: { repo: "acme/nexus", number: 7, url: "https://github.com/acme/nexus/pull/7", title: "Cache", branch: "cache" }, sent: 3,
  rounds: [
    { head: "1".repeat(40), verdict: { token: "a", verdict: "changes", findings: [{ id: "F1", priority: "P1", where: "src/cache.ts:12", summary: "The cache never expires" }], reserved: [], notCheckedLive: null }, check: null, answers: [{ id: "F1", action: "fixed", reason: "" }] },
    { head, verdict: { token: "b", verdict: "approve", findings: [{ id: "F2", priority: "P3", where: null, summary: "Name the TTL" }], reserved: [], notCheckedLive: "The cache's behaviour under load could not be checked live." }, check: { passed: true, output: "ok 412 tests" }, live: { kind: "absent" }, answers: null },
  ],
  phase, ...extra,
});
const landingOf = (page: string) => /<div id="landing" data-live>([\s\S]*?)<\/div>\n<div id="run"/.exec(page)![1]!;

test("a review held for the person says why on its builder's page, and a deployer can land it after confirming the PR and commit", async (t) => {
  const landed: string[] = [];
  const s = await seeded(t, landingOptions(landed));
  const fix = await s.start("acme", "Fix checkout");
  s.registry.reviews.saveReview(approvedReview(fix.id, personPhase("policy", { code: "github-checks", text: "The pull request's GitHub checks are pending." }), { land: { requestedBy: laptop } }));
  const region = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(textOf(region), `Held for you #7 Cache ↗ Head ${head.slice(0, 12)} · approved by gpt-6-astra (harness) in round 2 of 5 · .nexus/check passed · no .nexus/verify, so no live check `
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

  s.registry.reviews.saveReview(approvedReview(fix.id, { kind: "approved" }));
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

test("an approved review's card shows the path hold recorded at its head, and its Land waives it", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  const egress = "Always needs the person: changes to the egress allowlist, as it changes src/control/threads.ts.";
  const review = approvedReview(fix.id, { kind: "approved" });
  s.registry.reviews.saveReview({ ...review, rounds: [review.rounds[0]!, { ...review.rounds[1]!, heldAt: { base: "main", holds: [{ code: "reserved-path:egress", text: egress }] } }] });
  const region = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.match(textOf(region), new RegExp(`^Approved, not landed .* ${egress.replace(/[.]/g, "\\.")} you may waive `));
  const button = /<button [^>]*data-action="land"[^>]*>/.exec(region)![0];
  assert.match(textOf(/data-confirm="([^"]*)"/.exec(button)![1]!), /waiving the hold the merge policy reserves for you\?/);
});

test("a held landing whose live check passed says so with its output, and the review's line says how the live check went", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  const review = approvedReview(fix.id, personPhase("policy", { code: "github-checks", text: "The pull request's GitHub checks are pending." }), { land: { requestedBy: laptop } });
  s.registry.reviews.saveReview({ ...review, rounds: [review.rounds[0]!, { ...review.rounds[1]!, live: { kind: "ran", thread: "th-0123456789ab" as ThreadId, passed: true, output: "verify-nexus: thread started, answered, archived" } }] });
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  const card = textOf(landingOf(page));
  assert.match(card, new RegExp(`· \\.nexus/check passed · live check passed Why it waits`));
  assert.match(card, new RegExp(`The live check passed at ${head.slice(0, 12)} verify-nexus: thread started, answered, archived`));
  assert.match(textOf(page), new RegExp(`live check passed at ${head.slice(0, 12)}`));
});

const questionsOf = (page: string) => /<div id="questions" data-live>([\s\S]*?)<\/div>\n<div id="nudge"/.exec(page)![1]!;

test("an open question is a card with a button per option, disabled with the reason for a device that may not answer, and an answered question is one line", async (t) => {
  const answerHolds = (q: HoldsQuestion, option: string, by: TailnetNodeId) => s.registry.questions.answerQuestion(q, { option, by, at: Date.now() });
  const s = await seeded(t, { ...landingOptions(), reviews: { ...landingOptions().reviews, answerHolds } as never as ReviewLoop });
  const fix = await s.start("acme", "Fix checkout");
  assert.equal(questionsOf((await s.call("GET", `/threads/${fix.id}`)).text), "", "a thread that asked nothing shows no question region");
  s.registry.questions.askQuestion({ kind: "holds", id: "qn-image", thread: fix.id, text: "Rebuild the pylon image?\n\nIt changes the **base layer**.", options: ["Rebuild", "Not now"], reserved: "image-rebuild", answerer: "deployer", askedAt: Date.now(), holds: { review: "rv-1", head: "h", base: null, holds: [] } });

  const card = questionsOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.match(card, /<section class="landing question" data-question="qn-image"/);
  assert.equal(textOf(card), "Needs your decision reserved: pylon image rebuilds Rebuild the pylon image? It changes the base layer . Asked just now . A deployer answers, as the answer may deploy. Rebuild Not now");
  assert.match(card, /<strong>base layer<\/strong>/, "the text renders as the conversation's markdown does");
  const buttons = card.match(/<button [^>]*>/g)!;
  assert.deepEqual(buttons.map((b) => /data-option="([^"]*)"/.exec(b)![1]), ["Rebuild", "Not now"]);
  for (const button of buttons) {
    assert.match(button, /data-action="answer"/);
    assert.match(button, new RegExp(`data-thread="${fix.id}" data-question="qn-image"`));
    assert.ok(!button.includes("disabled"));
  }
  assert.equal(textOf(/data-confirm="([^"]*)"/.exec(buttons[0]!)![1]!), 'Answer "Rebuild"? The answer cannot be changed.');

  s.callAs(phone);
  const refused = questionsOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!refused.includes("data-action"), "a device that is not a deployer gets no working button");
  assert.equal(refused.match(/<button [^>]*disabled>/g)?.length, 2);
  assert.match(textOf(refused), /Rebuild Not now This device cannot answer: the answer may deploy, so only the control plane's deployers may, and this device \(tailnet node nPHONE\) is not one\./);

  s.callAs(laptop);
  assert.equal((await s.call("POST", "/v1/questions/qn-image/answer", { option: "Not now" })).status, 200);
  const answered = questionsOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.match(answered, /<section class="landing question answered" data-question="qn-image"/);
  assert.equal(textOf(answered), `Rebuild the pylon image? It changes the base layer . Answered "Not now" from ${laptop}, just now`);
  assert.ok(!answered.includes("<button"));
});

test("an archived thread's withdrawn failure question and its attention read the same on its page, in the API and in the event stream", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  s.registry.threads.savePylon({ ...s.registry.threads.pylon(fix.pylonId)!, failed: "setup exited 128: fatal: 'origin/feat/gone' is not a commit" });
  s.registry.questions.askQuestion({ kind: "judgment", id: "judgment:7", thread: fix.id, failure: 7, text: "The pylon failed on rj-firebat.", options: ["Retry", "Leave it failed"], reserved: null, answerer: "person", askedAt: Date.now() });
  const archivedFrom = Date.now();
  assert.equal((await s.call("POST", `/v1/threads/${fix.id}/archive`)).status, 200);

  const detail = JSON.parse((await s.call("GET", `/v1/threads/${fix.id}`)).text) as ThreadDetail;
  assert.equal(detail.attention, null);
  assert.equal(detail.questions[0]?.withdrawn?.by, "archive");
  assert.ok(detail.questions[0]!.withdrawn!.at >= archivedFrom && detail.questions[0]!.withdrawn!.at <= Date.now(), "withdrawn at the archive");
  const card = questionsOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(textOf(card), "The pylon failed on rj-firebat. Withdrawn when the thread was archived, just now");
  assert.ok(!card.includes("<button"));
  const events = JSON.parse((await s.call("GET", `/v1/events?thread=${fix.id}&kind=attention.changed`)).text) as { payload: { attention: string | null } }[];
  assert.deepEqual(events.map((e) => e.payload.attention), ["failed", null]);
  assert.deepEqual(JSON.parse((await s.call("POST", "/v1/questions/judgment:7/answer", { option: "Retry" })).text), { error: "question judgment:7 was withdrawn when its thread was archived", code: null, retryable: false });
});

const drink = { question: "Which drink?", header: "Drink", multiSelect: false, options: [{ label: "Tea", description: "Hot", preview: "a cup of tea" }, { label: "Coffee", description: "Strong" }] };
const extras = { question: "What goes in it?", header: "Extras", multiSelect: true, options: [{ label: "Milk", description: "" }, { label: "Sugar", description: "" }] };
const askCall = (id: string, at: number): ClaudeEntry => ({ kind: "tool", at, id, name: "AskUserQuestion", input: { questions: [drink, extras] } });
const waitingAsk = (toolUseId: string, at: number) => ({ ask: { session: "s1", toolUseId, questions: [drink, extras] }, at });
/** Each AskUserQuestion card of the conversation as a reader sees it, by its call. */
const askCardsOf = (page: string) => Object.fromEntries([...page.split('id="convo"')[1]!.matchAll(/<section class="ask-card" id="ask-([^"]+)"[\s\S]*?<\/section>/g)].map((m) => [m[1], textOf(m[0])]));

test("a Claude worker's open AskUserQuestion is a form in the dock from the pylon's report alone, with each question's options and previews, an answer of one's own and notes, disabled with the reason for a device that may not answer", async (t) => {
  const s = await seeded(t, { ...landingOptions(), allowed: new Set([laptop, phone, "nFIREBAT" as TailnetNodeId]) });
  const at = Date.now();
  const thread = await claudeThread(s, [{ kind: "prompt", at, text: "Make me a drink", from: "person" }]);
  s.registry.questions.setWaitingAsks(thread.id, [waitingAsk("toolu_1", at + 1)]);

  const asked = (await s.call("GET", `/threads/${thread.id}`)).text;
  assert.match(questionsOf(asked), /<form class="ask" data-thread="[^"]+" data-question="ask-toolu_1">/, "the pylon's report alone, before Claude writes the call");
  assert.deepEqual(askCardsOf(asked), {});
  assert.ok(s.registry.threads.appendClaudeRead(thread.id, { session: "s1", from: { ...transcriptStart, offset: 1 }, readAt: Date.now(), reset: false, cursor: { ...transcriptStart, offset: 2 }, entries: [askCall("toolu_1", at + 1)] }));

  const page = (await s.call("GET", `/threads/${thread.id}`)).text;
  const card = questionsOf(page);
  assert.match(card, /<section class="landing question ask" data-question="ask-toolu_1" aria-label="Claude asks">/);
  assert.match(card, new RegExp(`<form class="ask" data-thread="${thread.id}" data-question="ask-toolu_1">`));
  assert.equal(textOf(card), "Claude asks Drink Which drink? Tea Hot a cup of tea Coffee Strong Your own answer Extras What goes in it? Milk Sugar And your own answer Asked just now . Answer here or in the pylon's terminal, whichever comes first. Answer");
  const fields = card.match(/<input [^>]*>/g)!.map((input) => [/type="([^"]+)"/.exec(input)![1], /name="([^"]+)"/.exec(input)![1], /value="([^"]*)"/.exec(input)?.[1] ?? null]);
  assert.deepEqual(fields, [
    ["radio", "picked-0", "Tea"], ["radio", "picked-0", "Coffee"], ["radio", "picked-0", ""], ["text", "own-0", null], ["text", "notes-0", null],
    ["checkbox", "picked-1", "Milk"], ["checkbox", "picked-1", "Sugar"], ["text", "own-1", null], ["text", "notes-1", null],
  ], "a single-select question's own answer is one of its radios, and a multi-select one's goes with the boxes");
  assert.match(card, /<pre class="ask-preview">a cup of tea<\/pre>/);
  assert.ok(!card.includes("disabled"));
  assert.equal(askCardsOf(page)["toolu_1"], "Claude asked Drink Which drink? Tea Hot Coffee Strong Extras What goes in it? Milk Sugar Waits for your answer below.");

  s.callAs("nFIREBAT" as TailnetNodeId);
  const refused = questionsOf((await s.call("GET", `/threads/${thread.id}`)).text);
  assert.match(refused, /<fieldset class="ask-all" disabled>/);
  assert.match(refused, /<button type="submit" class="btn" disabled>Answer<\/button>/);
  assert.match(textOf(refused), /Answer This device cannot answer: tailnet node nFIREBAT is the control plane or one of its nodes, whose pylons call under its identity, and only a person's device may answer\./);
});

test("an answered AskUserQuestion leaves the dock and shows in the conversation with what was picked, one's own answer, notes and the device, or with what Claude got from the terminal", async (t) => {
  const s = await seeded(t);
  const thread = await claudeThread(s, [askCall("toolu_1", 2)]);
  s.registry.questions.setWaitingAsks(thread.id, [waitingAsk("toolu_1", 2)]);
  s.registry.questions.answerQuestion(s.registry.questions.question("ask-toolu_1")!, { option: "Drink: Tea; Extras: Milk, Oat cream", by: laptop, at: Date.now(), choices: [{ picked: ["Tea"], notes: "no rush" }, { picked: ["Milk"], own: "Oat cream" }] });
  const terminal = 'User has answered your questions: "Which drink?"="Coffee", "What goes in it?"="Sugar".';
  assert.ok(s.registry.threads.appendClaudeRead(thread.id, { session: "s1", from: { ...transcriptStart, offset: 1 }, readAt: Date.now(), reset: false, cursor: { ...transcriptStart, offset: 2 }, entries: [
    { kind: "result", at: 3, toolUseId: "toolu_1", output: 'User has answered your questions: "Which drink?"="Tea".', isError: false },
    askCall("toolu_2", 4), { kind: "result", at: 5, toolUseId: "toolu_2", output: terminal, isError: false },
  ] }));

  const page = (await s.call("GET", `/threads/${thread.id}`)).text;
  assert.equal(questionsOf(page), "", "neither waits in the dock");
  assert.deepEqual(askCardsOf(page), {
    toolu_1: `Claude asked Drink Which drink? ✓ Tea Hot a cup of tea Coffee Strong Notes: no rush Extras What goes in it? ✓ Milk Sugar Own answer: Oat cream Answered from ${laptop}, just now .`,
    toolu_2: `Claude asked Drink Which drink? Tea Hot Coffee Strong Extras What goes in it? Milk Sugar ${terminal} Answered in the terminal.`,
  });
  const frame = liveFrames(thread, null, itemsWith(thread.id, () => s.registry.questions.questions(thread.id)))({ kind: "claude", session: "s1", entries: s.registry.threads.claudeEntries(thread.id), dropped: 0, readAt: 1, working: false, usageLimit: null });
  assert.equal(askCardsOf(`id="convo"${(frame as { convo: string }).convo}`)["toolu_1"], askCardsOf(page)["toolu_1"], "the page's stream shows the answer as the page does");
});

const judgmentsOf = (page: string) => /<div id="judgments" data-live>([\s\S]*?)<\/div>\n<div id="questions"/.exec(page)![1]!;

test("each judgment of a failed pylon is a card above the questions: what failed, the verdict and who gave it, what Nexus did, and what it was asked and answered", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  assert.equal(judgmentsOf((await s.call("GET", `/threads/${fix.id}`)).text), "", "a thread with no judgment shows no judgment region");
  const judgment = (failure: number, phase: Judgment["phase"], reply: string | null): Judgment => ({
    failure, thread: fix.id, node, failed: "pylon is broken: the controller exited\nqemu: terminating <on signal 15>", startedAt: Date.now(),
    request: { brief: "Is it the node?", token: "t" }, conversation: 3, reply, phase,
  });
  s.registry.judgments.saveJudgment(judgment(812, { kind: "done", verdict: { answer: "retry", why: "The node was swapping.", by: "judgment" }, outcome: { kind: "retried", node, on: "verdict" } }, "It was the node.\n```nexus-judgment\n{}\n```"), null);
  s.registry.judgments.saveJudgment(judgment(813, { kind: "asked", verdict: { answer: "person", why: "the judgment did not answer within 15 minutes", by: "control plane" } }, null), null);

  const region = judgmentsOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.deepEqual([...region.matchAll(/<section class="landing judgment" data-judgment="(\d+)"/g)].map((m) => m[1]), ["812", "813"]);
  const [done, asked] = region.split("</section>").map(textOf);
  assert.equal(done, `Failed on ${node} judged just now pylon is broken: the controller exited retry , by the judgment: The node was swapping. Nexus retried the pylon on ${node}. What the judgment was asked and answered Is it the node? It was the node. \`\`\`nexus-judgment {} \`\`\``);
  assert.equal(asked, `Failed on ${node} judged just now pylon is broken: the controller exited person , by the control plane: the judgment did not answer within 15 minutes It waits for your answer below. What the judgment was asked and answered Is it the node?`);
});

test("a review is not offered for landing when its PR closed, or when the control plane has no review loop", async (t) => {
  const s = await seeded(t, { ...landingOptions(), reviews: null });
  const fix = await s.start("acme", "Fix checkout");
  s.registry.reviews.saveReview(approvedReview(fix.id, { kind: "approved" }));
  const off = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!off.includes('data-action="land"'));
  assert.match(textOf(off), /Land #7 Nexus cannot land it now: the review loop needs the control plane's GitHub token \(github\.tokenFile\), which is not configured\.$/);

  const pr = testPr({ repo: "acme/nexus", number: 7, title: "Cache", state: "closed", checks: "passing" });
  s.registry.prWatches.savePrWatch(fix.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  assert.equal(landingOf((await s.call("GET", `/threads/${fix.id}`)).text), "", "a closed PR has nothing to land");
  s.registry.prWatches.savePrWatch(fix.id, { links: [{ pr: { ...pr, state: "merged" }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  assert.equal(landingOf((await s.call("GET", `/threads/${fix.id}`)).text), "", "a PR merged outside the review has nothing to land");
});

test("a held review whose PR the watch read at a new head offers no Land for the old one, and its new round says why it started", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  const held = approvedReview(fix.id, personPhase("policy", { code: "reserved-path:auth", text: "Always needs the person: changes to login or auth, as it changes src/control/api.ts." }), { land: { requestedBy: laptop } });
  s.registry.reviews.saveReview(held);
  const moved = "b3".repeat(20);
  const pr = testPr({ repo: "acme/nexus", number: 7, title: "Cache", checks: "passing", head: moved });
  s.registry.prWatches.savePrWatch(fix.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const card = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!card.includes("<button"), "no Land for a head that is no longer the PR's");
  assert.match(textOf(card), new RegExp(`The PR watch last read the pull request at ${moved.slice(0, 12)} , not ${head.slice(0, 12)} , so ${head.slice(0, 12)} is not offered for landing\\.`));

  s.registry.prWatches.savePrWatch(fix.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 10, pending: null, error: null });
  assert.match(landingOf((await s.call("GET", `/threads/${fix.id}`)).text), /data-action="land"/, "a stopped watch's head takes no Land away");
  s.registry.prWatches.savePrWatch(fix.id, { links: [{ pr: { ...pr, head: "1".repeat(40) }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  assert.ok(!landingOf((await s.call("GET", `/threads/${fix.id}`)).text).includes("<button"), "a force-push back to the head an earlier round reviewed takes Land away too");

  s.registry.reviews.saveReview({ ...held, rounds: [...held.rounds, { head: moved, verdict: null, check: null, answers: null }], phase: { kind: "reviewing" } });
  const page = textOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.match(page, new RegExp(`Nexus review rv-1 of PR #7: reviewing, round 3 of 5, .* a new round reviews ${moved.slice(0, 12)}, since the pull request's head moved from ${head.slice(0, 12)} after its approval`));
});

test("a hold the policy reserves for the person is marked waivable, and pressing Land waives it", async (t) => {
  const reserved = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  s.registry.reviews.saveReview(approvedReview(fix.id, personPhase("policy", { code: "github-checks", text: "The pull request's GitHub checks are pending." }, { code: "reserved-path:auth", text: reserved }), { land: { requestedBy: laptop } }));
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
  assert.match(region, /Land #7 Pressing Land waives what is marked "you may waive", for commit 9f9f9f9f9f9f and any rebase of it that leaves the change as it is\. Landing checks everything else again\.$/);
  s.callAs(phone);
  const refused = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!refused.includes("data-action"), "a device that is not a deployer gets no working button");
  assert.match(textOf(refused), /Land #7 This device cannot land/);
  s.callAs(laptop);

  s.registry.reviews.saveReview(approvedReview(fix.id, { kind: "approved" }, { land: { requestedBy: laptop } }));
  assert.ok(!landingOf((await s.call("GET", `/threads/${fix.id}`)).text).includes("data-holds"), "a card with nothing to waive waives nothing");

  s.registry.reviews.saveReview(approvedReview(fix.id, { kind: "approved" }, { reviewerKind: "claude" }));
  const claude = textOf(landingOf((await s.call("GET", `/threads/${fix.id}`)).text));
  assert.match(claude, /A Claude reviewer approved it\..* holds again Nothing here stands in for a harness reviewer's approval.* holds every landing of this commit\. Only you can get past it, by merging the pull request on GitHub and deploying it with nexus deploy\.$/, "an approval the policy never lands is marked before any landing tries");
  assert.ok(!claude.includes("Land #7"));
});

/** The home page's Needs you cards as a reader takes them in: what each is, its thread, and the card's text. */
function needsOf(page: string) {
  const region = page.split('id="needs-you"')[1]!.split('<div class="split-peek" id="peek"')[0]!;
  return {
    cards: [...region.matchAll(/<article class="need need-(\w+)(?: picked)?" id="([^"]+)" data-thread="([^"]+)" data-attention="(\w+)"[\s\S]*?<\/article>/g)].map((m) => ({ kind: m[1], id: m[2], thread: m[3], attention: m[4], text: textOf(m[0]), html: m[0] })),
    text: textOf(region.replace(/^[^>]*>/, "")),
  };
}
/** Each node's card head on the Cluster page, where the sidebar's nodes block went: its name, marks, memory and release lines. */
const nodeHeads = async (s: { call(method: string, path: string): Promise<{ text: string }> }) =>
  [...(await s.call("GET", "/cluster")).text.matchAll(/<header class="node-card-h">([\s\S]*?)<\/header>/g)].map((m) => m[1]!).join("\n");
const needsCount = (page: string) => /<span class="side-count" id="needs-count" data-live>([^<]*)<\/span>/.exec(page)![1];

test("Needs you lists, oldest first, each held review, open question and ask, and each thread stopped where only the person moves it, with the action on its card", async (t) => {
  const s = await seeded(t, landingOptions());
  const empty = (await s.call("GET", "/")).text;
  assert.equal(needsOf(empty).text, "Needs you Nothing waits on you.");
  assert.equal(needsCount(empty), "", "the sidebar counts nothing");

  const now = Date.now();
  const reserved = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const held = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(held.id, personPhase("policy", { code: "github-checks", text: "The pull request's GitHub checks are pending." }, { code: "reserved-path:auth", text: reserved }), { land: { requestedBy: laptop } }));
  s.registry.prWatches.savePrWatch(held.id, { links: [{ pr: testPr({ repo: "acme/nexus", number: 7, title: "Cache", checks: "pending", summary: "Caches the thread list between polls." }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const asked = await s.start("acme", "Rebuild the image");
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-image", thread: asked.id, text: "Rebuild the pylon image?", options: ["Rebuild", "Not now"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  const claude = await claudeThread(s, [{ kind: "prompt", at: now, text: "Make me a drink", from: "person" }]);
  s.registry.questions.setWaitingAsks(claude.id, [waitingAsk("toolu_1", Date.now())]);
  const dialog = await s.start("acme", "Run the migration");
  s.observe(dialog);
  s.registry.threads.reportSession(node, { sequence: 1, pylon: dialog.pylonId, time: now, event: { kind: "session.waiting", session: "s1", at: now, message: "Claude needs your permission to use Bash" } });
  s.registry.threads.recordReply(dialog.id, now);
  const failed = JSON.parse((await s.call("POST", "/v1/threads", { project: "beta", title: "Port the CLI", claude: "port it" })).text) as Thread;
  claudeWorkerAt(s.registry, failed.id, "failed", { message: "Claude launch did not complete: executable missing" });
  const limited = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Write the docs", claude: "write them" })).text) as Thread;
  claudeWorkerAt(s.registry, limited.id, "started", { session: "s1" });
  const resetsAt = now + 3_600_000;
  assert.ok(s.registry.threads.appendClaudeRead(limited.id, { session: "s1", from: transcriptStart, entries: [{ kind: "notice", at: Date.now(), tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt } }], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: now }));
  const replied = await s.start("acme", "Answer a reply");
  s.registry.threads.recordReply(replied.id, now);
  await s.start("acme", "Quiet");

  const page = (await s.call("GET", "/")).text;
  const { cards } = needsOf(page);
  assert.deepEqual(cards.slice(0, 3).map((c) => [c.kind, c.thread, c.attention]), [["review", held.id, "decision"], ["question", asked.id, "decision"], ["question", claude.id, "decision"]], "the oldest waits first");
  assert.deepEqual(new Set(cards.slice(3).map((c) => `${c.thread} ${c.attention}`)), new Set([`${dialog.id} waiting`, `${failed.id} failed`, `${limited.id} limited`]));
  assert.ok(!cards.some((c) => c.thread === replied.id), "a new reply waits on no one");
  assert.equal(needsCount(page), "6");
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
  for (const c of cards) assert.match(c.html, new RegExp(`<a class="need-thread" href="/threads/${c.thread}"[ >]`), "each card links its thread");

  const land = cards[0]!;
  assert.match(land.text, /^Review needs you acme \/ Cache the list just now The pull request's GitHub checks are pending\. Planned Queued Building In review held for you Landing Deployed #7 round 2 of 5 .* Open thread Caches the thread list between polls\. Not checked live The cache's behaviour under load could not be checked live\. Head /);
  assert.match(land.text, /pending\. not waivable .* src\/control\/api\.ts\. you may waive /);
  const button = /<button [^>]*data-action="land"[^>]*>/.exec(land.html)![0];
  assert.match(button, new RegExp(`id="land-${held.id}" data-action="land" data-thread="${held.id}" data-head="${head}"`), "the thread page's Land button, under an ID of the card's own");
  assert.deepEqual(JSON.parse(textOf(/data-holds="([^"]*)"/.exec(button)![1]!)), [reserved], "it waives what the thread page's would");
  assert.ok(!/id="(land|landing-h|land-why)"/.test(page), "no card takes the thread page's IDs");

  assert.match(cards[1]!.text, /^Needs your decision acme \/ Rebuild the image .* Needs your decision Rebuild the pylon image\? .* Rebuild Not now$/);
  assert.match(cards[1]!.html, /data-action="answer" data-thread="[^"]+" data-question="qn-image" data-option="Rebuild"/);
  assert.match(cards[2]!.html, new RegExp(`<form class="ask" data-thread="${claude.id}" data-question="ask-toolu_1">`), "an ask is the thread page's form");
  const by = (thread: ThreadId) => cards.find((c) => c.thread === thread)!;
  assert.match(by(dialog.id).text, /^Dialog in its terminal acme \/ Run the migration .* Claude needs your permission to use Bash, in the pylon's terminal\. Open terminal$/, "a dialog shows though a reply outranks it");
  assert.match(by(dialog.id).html, new RegExp(`href="/threads/${dialog.id}#terminal"`));
  assert.match(by(failed.id).text, /^Failed beta \/ Port the CLI .* The Claude worker failed: Claude launch did not complete: executable missing Archive$/);
  assert.match(by(failed.id).html, new RegExp(`data-action="archive" data-thread="${failed.id}"`));
  assert.match(by(limited.id).text, new RegExp(`^Usage limit acme / Write the docs .* It stopped on its usage limit until ${new Date(resetsAt).toISOString().slice(11, 16)} UTC\\. Nexus has it continue once the limit resets, or archive it to stop it\\. Archive$`));
});

test("a thread in Needs you has its call to action once, in its card, with where its work is, and its line in the work in flight leads to that card instead of a preview", async (t) => {
  const s = await seeded(t, landingOptions());
  const held = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(held.id, personPhase("policy", { code: "reserved-path:auth", text: "Always needs the person: changes to login or auth, as it changes src/control/api.ts." }), { land: { requestedBy: laptop } }));
  s.registry.prWatches.savePrWatch(held.id, { links: [{ pr: testPr({ repo: "acme/nexus", number: 7, title: "Cache", summary: "Caches the thread list." }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  s.fake.transcript(held.id).messages.push({ role: "user", content: "Cache the list", timestamp: 0 }, assistant([{ type: "text", text: "Opened #7.\n\n```ts\nconst ttl = 5;\n```\n\nIt waits for you to land." }]));
  const asked = await s.start("acme", "Rebuild the image");
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-image", thread: asked.id, text: "Rebuild the pylon image?", options: ["Rebuild", "Not now"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  const failed = JSON.parse((await s.call("POST", "/v1/threads", { project: "beta", title: "Port the CLI", claude: "port it" })).text) as Thread;
  claudeWorkerAt(s.registry, failed.id, "failed", { message: "Claude launch did not complete: executable missing" });
  const approved = await s.start("acme", "Name the TTL");
  s.registry.reviews.saveReview(approvedReview(approved.id, { kind: "approved" }, { id: "rv-8", reviewer: "th-reviewer-8" as ThreadId, pr: { repo: "acme/nexus", number: 8, url: "https://github.com/acme/nexus/pull/8", title: "TTL", branch: "ttl" } }));
  s.registry.prWatches.savePrWatch(approved.id, { links: [{ pr: testPr({ repo: "acme/nexus", number: 8, title: "TTL", state: "closed" }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const quiet = await s.start("acme", "Quiet");
  const actions: [Thread, RegExp][] = [[held, new RegExp(`data-action="land" data-thread="${held.id}"`, "g")], [asked, new RegExp(`data-action="answer" data-thread="${asked.id}"`, "g")], [failed, new RegExp(`data-action="archive" data-thread="${failed.id}"`, "g")]];

  for (const [thread, action] of actions) {
    const page = (await s.call("GET", `/?peek=${thread.id}`)).text;
    const peek = page.split('id="peek"')[1]!.split('id="in-flight"')[0]!;
    assert.doesNotMatch(peek, /class="peek"|Waits on you/, `${thread.title} has no preview beside its card`);
    assert.match(page, /<div class="split" id="split">/, "and the page does not make room for one");
    const card = needsOf(page).cards.find((c) => c.thread === thread.id)!;
    const all = [...page.matchAll(action)].length;
    assert.ok(all > 0 && [...card.html.matchAll(action)].length === all, `${thread.title}'s action is on its card alone`);
    assert.match(card.html, /<article class="need need-\w+ picked"/, "the card is marked as picked");
    assert.match(card.html, /<details class="need-fold" id="fold-[^"]+" open>/, "and a fresh load of the link renders it open");
    assert.ok(needsOf(page).cards.filter((c) => c.thread !== thread.id).every((c) => !/<details class="need-fold" id="fold-[^"]+" open>/.test(c.html)), "and only it");
    assert.match(card.html, /<ol class="life" aria-label="Where this work is">.*<li class="life-held" aria-current="step">/s, "its steps mark where it waits on the person");
    assert.match(card.html, new RegExp(`<a class="link" href="/threads/${thread.id}">Open thread</a>`));
    const flight = page.split('id="flight"')[1]!.split('id="overview"')[0]!;
    assert.match(flight, new RegExp(`<a class="fl-row" href="/\\?peek=${thread.id}" data-peek="${thread.id}" aria-current="true">`), "its line leads to its card");
  }
  const land = needsOf((await s.call("GET", `/?peek=${held.id}`)).text).cards.find((c) => c.thread === held.id)!;
  assert.match(land.text, /^Review needs you acme \/ Cache the list just now Always needs the person: changes to login or auth, as it changes src\/control\/api\.ts\. Planned Queued Building In review held for you Landing Deployed #7 round 2 of 5 .* Open thread Latest reply (.* )?Opened #7\. It waits for you to land\. Caches the thread list\./, "the strip has the pull request, its round and the latest reply in a line");
  assert.doesNotMatch(land.text, /#7 Cache|Held for you/, "nor names the pull request again under a title of its own");
  assert.equal(land.text.match(/Not checked live/g)!.length, 1);
  assert.match(land.html, /<details id="land-why-[^"]+"><summary>Findings and checks<\/summary>/, "the findings and checks are folded");
  assert.match(land.html, /<li><details id="land-hold-0-[^"]+"><summary>Always needs the person: .*you may waive<\/span><\/summary><span class="dim">The policy reserves this for you/, "each hold says what it is, and folds why it is waivable");
  assert.match(land.html, /<div class="land-act"><button type="button" class="btn btn-primary" id="land-[^"]+" data-action="land"/, "and Land is outside every fold");
  assert.doesNotMatch(needsOf((await s.call("GET", `/?peek=${asked.id}`)).text).cards.find((c) => c.thread === held.id)!.html, /Latest reply/, "a card the person did not pick reads no conversation");

  const waiting = (await s.call("GET", `/?peek=${approved.id}`)).text;
  assert.doesNotMatch(waiting.split('id="peek"')[1]!.split('id="in-flight"')[0]!, /class="peek"/, "an approved review that cannot land previews in its card too");
  const heldCard = waiting.split(`id="need-${approved.id}-review"`)[1]!.split("</article>")[0]!;
  assert.match(textOf(heldCard.replace(/^[^>]*>/, "")), /^Review needs you acme \/ Name the TTL just now Approved, and lands once you press Land Planned Queued Building In review held for you Landing Deployed #8 round 2 of 5 .* Open thread It cannot land, as pull request #8 is closed on GitHub outside this review, so there is nothing to land\.$/, "with where its work is and why it cannot land");
  assert.equal([...heldCard.matchAll(/Open thread/g)].length, 1);

  const page = (await s.call("GET", `/?peek=${quiet.id}`)).text;
  assert.match(page, /<div class="split peeking" id="split">/);
  assert.match(page.split('id="peek"')[1]!.split('id="in-flight"')[0]!, new RegExp(`<section class="peek" aria-labelledby="peek-h" data-peek-key="${quiet.id}">`), "work that needs nothing keeps its preview");
  assert.match(page, new RegExp(`<a class="fl-row( dim)?" href="/\\?peek=${quiet.id}" data-peek="${quiet.id}" aria-current="true">`), "and its line in the work in flight previews it");
});

test("a card's strip links the pull request its review lands, whichever pull requests the PR watch follows", async (t) => {
  const s = await seeded(t, landingOptions());
  const two = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(two.id, personPhase("policy", { code: "reserved-path:auth", text: "Always needs the person." }), { land: { requestedBy: laptop } }));
  s.registry.prWatches.savePrWatch(two.id, { links: [9, 7].map((number) => ({ pr: testPr({ repo: "acme/nexus", number, title: `PR ${number}` }), seen: [], failed: false })), commentWakes: 0, pending: null, error: null });
  const unwatched = await s.start("acme", "Name the TTL");
  s.registry.reviews.saveReview(approvedReview(unwatched.id, { kind: "approved" }, { id: "rv-8", reviewer: "th-reviewer-8" as ThreadId }));
  const { cards } = needsOf((await s.call("GET", "/")).text);
  for (const thread of [two, unwatched]) {
    const strip = /<p class="need-facts">([\s\S]*?)<\/p>/.exec(cards.find((c) => c.thread === thread.id)!.html)![1]!;
    assert.match(strip, /<a class="link" href="https:\/\/github\.com\/acme\/nexus\/pull\/7" [^>]*>#7<\/a>/, `${thread.title}'s strip links #7, which Land merges`);
    assert.doesNotMatch(strip, /#9/);
  }
});

test("a thread with several cards says where its work is once, on its first card, which is the one a link to it picks", async (t) => {
  const s = await seeded(t, landingOptions());
  const held = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(held.id, personPhase("policy", { code: "reserved-path:auth", text: "Always needs the person." }), { land: { requestedBy: laptop } }));
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-ttl", thread: held.id, text: "Expire after 5 minutes?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  s.fake.transcript(held.id).messages.push({ role: "user", content: "Cache the list", timestamp: 0 }, assistant([{ type: "text", text: "Opened #7." }]));
  const { cards } = needsOf((await s.call("GET", `/?peek=${held.id}`)).text);
  assert.deepEqual(cards.map((c) => c.kind), ["review", "question"]);
  assert.deepEqual(cards.map((c) => (c.html.match(/class="need-ctx"/g) ?? []).length), [1, 0], "one strip, on the first card");
  assert.deepEqual(cards.map((c) => /Latest reply/.test(c.html)), [true, false], "and one latest reply");
  assert.deepEqual(cards.map((c) => /<article class="need need-\w+ picked"/.test(c.html)), [true, false], "only the first card is picked");
  assert.deepEqual(cards.map((c) => /<details class="need-fold" id="fold-[^"]+" open>/.test(c.html)), [true, false], "and opened");
});

test("a thread's card the person picked keeps the mark and the strip across a poll, and a review card without the strip still links its pull request", async (t) => {
  const s = await seeded(t, landingOptions());
  const held = await s.start("acme", "Cache the list");
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-ttl", thread: held.id, text: "Expire after 5 minutes?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: Date.now() - 60_000, failure: 0 });
  s.registry.reviews.saveReview(approvedReview(held.id, personPhase("policy", { code: "reserved-path:auth", text: "Always needs the person." }), { land: { requestedBy: laptop } }));
  s.fake.transcript(held.id).messages.push({ role: "user", content: "Cache the list", timestamp: 0 }, assistant([{ type: "text", text: "Opened #7." }]));
  const pr = /<a class="link" href="https:\/\/github\.com\/acme\/nexus\/pull\/7" [^>]*>#7<\/a>/;
  const first = needsOf((await s.call("GET", `/?peek=${held.id}`)).text).cards;
  assert.deepEqual(first.map((c) => c.kind), ["question", "review"], "the question waited first");
  assert.match(first[1]!.html, pr, "the review's card links the pull request Land merges, though the strip is on the question's");
  const review = first[1]!.id;
  const { cards } = needsOf((await s.call("GET", `/?peek=${held.id}&card=${review}`)).text);
  assert.deepEqual(cards.map((c) => /<article class="need need-\w+ picked"/.test(c.html)), [false, true], "the card the person picked stays picked");
  assert.deepEqual(cards.map((c) => /<details class="need-fold" id="fold-[^"]+" open>/.test(c.html)), [false, true], "and open");
  assert.deepEqual(cards.map((c) => (c.html.match(/class="need-ctx"/g) ?? []).length), [0, 1], "with the strip");
  assert.deepEqual(cards.map((c) => /Latest reply/.test(c.html)), [false, true]);
  assert.equal([...cards[1]!.html.matchAll(new RegExp(pr, "g"))].length, 1, "which links the pull request once");
});

test("a card's strip links the thread's open pull request once its review ended", async (t) => {
  const s = await seeded(t, landingOptions());
  const thread = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(thread.id, { kind: "landed", commit: head }));
  s.registry.prWatches.savePrWatch(thread.id, { links: [{ pr: testPr({ repo: "acme/nexus", number: 8, title: "TTL" }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-ttl", thread: thread.id, text: "Expire after 5 minutes?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  const strip = /<p class="need-facts">([\s\S]*?)<\/p>/.exec(needsOf((await s.call("GET", "/")).text).cards.find((c) => c.thread === thread.id)!.html)![1]!;
  assert.match(strip, /href="https:\/\/github\.com\/acme\/nexus\/pull\/8" [^>]*>#8<\/a><\/span>/, "the open #8, without the ended review's round");
  assert.doesNotMatch(strip, /#7/);
});

const chipOf = (page: string) => /<span class="chip-label">([^<]*)<\/span>/.exec(page)![1];
const dockOf = (page: string) => page.split('<div class="dock">')[1]!.split('<div id="run"')[0]!;
const actionsOf = (html: string) => [...html.matchAll(/data-action="([^"]+)"|<a [^>]*href="([^"]+)"[^>]*data-write/g)].map((m) => m[1] ?? m[2]);

test("each project in the overview shows its auto-review setting, and a deployer switches it between off, review, land and yolo", async (t) => {
  const s = await seeded(t, landingOptions());
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { autoReview: { mode: "yolo" } })).status, 200);
  const buttons = async () => [...sectionOf((await s.call("GET", "/")).text, "project-acme").matchAll(/<button [^>]*data-action="auto-review"[^>]*>/g)].map((m) => m[0]);
  const shown = (all: string[]) => all.map((b) => [/data-mode="(\w+)"/.exec(b)![1], b.includes('aria-pressed="true"'), b.includes(" disabled")]);
  const deployer = await buttons();
  assert.deepEqual(shown(deployer), [["off", false, false], ["review", false, false], ["land", false, false], ["yolo", true, true]], "the setting is pressed, and every other one is a press away");
  assert.ok(deployer.every((b) => b.includes('data-project="acme"')));
  assert.match(textOf(/data-confirm="([^"]*)"/.exec(deployer[3]!)![1]!), /^Turn on yolo for project acme\? .* until you switch it off\.$/);
  assert.match(sectionOf((await s.call("GET", "/")).text, "project-acme"), new RegExp(`aria-label="Auto review for acme, set by ${laptop}"`));
  s.callAs(phone);
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { autoReview: { mode: "review" } })).status, 200, "the press a device that is not a deployer may make");
  assert.deepEqual(shown(await buttons()), [["off", false, false], ["review", true, true], ["land", false, true], ["yolo", false, true]], "it cannot turn on landing, which deploys");
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { autoReview: { mode: "yolo" } })).status, 403, "and the route refuses it whatever the page shows");
});

test("every source of a thread's decision has a card on its page with the action that resolves it, and Needs you shows that card with the same actions", async (t) => {
  const s = await seeded(t, landingOptions());
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: true } })).status, 200);
  const link = (number: number, state: "open" | "merged" | "closed") => ({ links: [{ pr: testPr({ repo: "acme/nexus", number, title: "Cache", state, checks: "passing" }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const silent = await s.start("acme", "Silent reviewer");
  const unread = "The reviewer ended 3 turns in a row without an answer Nexus could read, in round 1.";
  const first = approvedReview(silent.id, personPhase("agent", unread), { land: { requestedBy: laptop, fromProject: true } });
  s.registry.reviews.saveReview({ ...first, rounds: [{ head, verdict: null, check: null, answers: null }] });
  s.registry.prWatches.savePrWatch(silent.id, link(7, "open"));
  const merged = await s.start("acme", "Merged by hand");
  s.registry.reviews.saveReview(approvedReview(merged.id, personPhase("policy", { code: "reserved-path:auth", text: "Always needs the person: changes to login or auth, as it changes src/control/api.ts." }), { reviewer: "th-reviewer2" as ThreadId }));
  s.registry.prWatches.savePrWatch(merged.id, link(7, "merged"));
  const undeployed = await s.start("acme", "Rolled back");
  s.registry.reviews.saveReview(approvedReview(undeployed.id, personPhase("deploy", "The deploy of 4444 failed.", "Rolled back to the previous release."), { merged: "4".repeat(40), land: { requestedBy: laptop }, reviewer: "th-reviewer3" as ThreadId }));
  const held = await s.start("acme", "Held for checks");
  s.registry.reviews.saveReview(approvedReview(held.id, personPhase("policy", { code: "github-checks", text: "The pull request's GitHub checks are pending." }), { land: { requestedBy: laptop }, reviewer: "th-reviewer4" as ThreadId }));
  const nudged = await s.start("acme", "Stopped short");
  s.registry.nudges.saveNudge(nudged.id, { state: "person", turn: Date.now() });
  const asked = await s.start("acme", "Rebuild the image");
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-image", thread: asked.id, text: "Rebuild the pylon image?", options: ["Rebuild", "Not now"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });

  const sources = [silent, merged, undeployed, held, nudged, asked];
  const inbox = (await s.call("GET", "/")).text;
  assert.equal(needsCount(inbox), String(sources.length), "Needs you counts one card per source");
  const docks = new Map<ThreadId, string>();
  for (const th of sources) {
    const page = (await s.call("GET", `/threads/${th.id}`)).text;
    assert.equal(chipOf(page), "needs your decision", th.title);
    const dock = dockOf(page);
    docks.set(th.id, dock);
    assert.ok(actionsOf(dock).length > 0, `${th.title}: the page has a card with an action`);
    const card = needsOf(inbox).cards.filter((c) => c.thread === th.id);
    assert.equal(card.length, 1, th.title);
    assert.deepEqual(actionsOf(card[0]!.html), actionsOf(dock), `${th.title}: its Needs you card offers the page's actions`);
  }

  const silentCard = textOf(docks.get(silent.id)!);
  assert.match(silentCard, new RegExp(`Review needs you #7 Cache ↗ Ended in round 1 of 5 · reviewer th-reviewer on gpt-6-astra \\(harness\\) ${unread} Review again Cancel review`));
  assert.match(docks.get(silent.id)!, /<a href="\/threads\/th-reviewer">th-reviewer<\/a>/, "the reviewer thread is linked");
  const again = /<button [^>]*data-action="review-again"[^>]*>/.exec(docks.get(silent.id)!)![0];
  assert.match(again, new RegExp(`data-thread="${silent.id}" data-pr="7" data-land="true"`), "a project that lands its reviews lands this one too");
  assert.equal(textOf(/data-confirm="([^"]*)"/.exec(again)![1]!), `Review pull request #7, "Cache", again? A new reviewer thread starts at round 1, and Nexus lands the pull request once it approves, as this project lands its reviews.`);
  assert.deepEqual(actionsOf(docks.get(merged.id)!), ["cancel-review"], "a merged PR has nothing to review again");
  assert.match(textOf(docks.get(merged.id)!), /^Merged outside its review #7 Cache ↗ .* Pull request #7 merged on GitHub outside this review, so nothing is left to review or land\. Nexus deploys only what it lands, so deploy the merge commit with nexus deploy if it should run\./);
  assert.match(textOf(docks.get(undeployed.id)!), /^Merged, not deployed .* The merge commit 444444444444 is on the default branch, but not deployed\. Deploy it from a deployer with nexus deploy 4444444444444444444444444444444444444444, or leave the fleet where it is, and cancel the review once nothing more is needed\. Cancel review$/);
  assert.deepEqual(actionsOf(docks.get(held.id)!), ["land"]);
  assert.deepEqual(actionsOf(docks.get(nudged.id)!), [`/threads/${nudged.id}#write`]);
  assert.match(textOf(docks.get(nudged.id)!), /^Stopped short of a pull request Its turn ended without a pull request after two nudges, so Nexus stopped nudging it\. Write to it/);
  assert.deepEqual(actionsOf(docks.get(asked.id)!), ["answer", "answer"]);

  s.callAs(phone);
  const refused = dockOf((await s.call("GET", `/threads/${silent.id}`)).text);
  assert.ok(!refused.includes('data-action="review-again"'), "a device that may not land cannot review again a review that lands");
  assert.match(textOf(refused), /Review again Cancel review This device cannot land/);
  s.callAs(laptop);

  s.registry.reviews.saveReview({ ...s.registry.reviews.review(silent.id)!, phase: { kind: "cancelled", who: "person", by: laptop } });
  const after = (await s.call("GET", `/threads/${silent.id}`)).text;
  assert.notEqual(chipOf(after), "needs your decision");
  assert.equal(actionsOf(dockOf(after)).length, 0, "a cancelled review has no card");
  assert.match(textOf(after), /Nexus review rv-1 of PR #7: cancelled, round 1 of 5, .* cancelled by nLAPTOP/);
  assert.equal(needsCount((await s.call("GET", "/")).text), String(sources.length - 1));
});

test("a Claude worker Nexus stopped resuming has a card on its page and in Needs you that says why and writes to it", async (t) => {
  const s = await seeded(t, landingOptions());
  const th = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Kept dying", claude: "fix it" })).text) as Thread;
  claudeWorkerAt(s.registry, th.id, "started", { session: "s1" });
  const why = "Its turn died 4 times in a row (last: API Error: Request timed out.), so Nexus stopped resuming it.";
  s.registry.threads.saveClaudeResume(th.id, { state: "person", turn: Date.now(), count: 3, why });
  const page = (await s.call("GET", `/threads/${th.id}`)).text;
  assert.equal(chipOf(page), "needs your decision");
  const dock = dockOf(page);
  assert.deepEqual(actionsOf(dock), [`/threads/${th.id}#write`]);
  assert.ok(textOf(dock).startsWith(`Stopped resuming its turns ${why} Write to it to resume it`), textOf(dock));
  const inbox = (await s.call("GET", "/")).text;
  const card = needsOf(inbox).cards.filter((c) => c.thread === th.id);
  assert.equal(card.length, 1);
  assert.deepEqual(actionsOf(card[0]!.html), actionsOf(dock));
});
test("a held review waits from when it was held, not from when its review last messaged an agent, so a question asked before that comes first", async (t) => {
  const s = await seeded(t, landingOptions());
  const held = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(held.id, { kind: "reviewing" }, { since: Date.now() - 3_600_000 }));
  const asked = await s.start("acme", "Rebuild the image");
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-image", thread: asked.id, text: "Rebuild the pylon image?", options: ["Rebuild", "Not now"], reserved: null, answerer: "person", askedAt: Date.now() - 1, failure: 0 });
  const review = approvedReview(held.id, personPhase("policy", { code: "github-checks", text: "The pull request's GitHub checks are pending." }), { since: Date.now() - 3_600_000 });
  s.registry.reviews.saveReview(review);
  s.registry.reviews.saveReview({ ...review, phase: { ...review.phase, label: { state: "added" } } as Review["phase"] });
  const { cards } = needsOf((await s.call("GET", "/")).text);
  assert.deepEqual(cards.map((c) => c.thread), [asked.id, held.id], "the label added after it was held does not date it again");
  assert.match(cards[1]!.text, /^Review needs you acme \/ Cache the list just now /);
});

test("acting on a card through the route its button calls takes the card off the list and the count down", async (t) => {
  const landed: string[] = [];
  const s = await seeded(t, landingOptions(landed));
  const held = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(held.id, personPhase("policy", { code: "github-checks", text: "The pull request's GitHub checks are pending." }), { land: { requestedBy: laptop } }));
  const asked = await s.start("acme", "Rebuild the image");
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-image", thread: asked.id, text: "Rebuild the pylon image?", options: ["Rebuild", "Not now"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  const failed = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Port the CLI", claude: "port it" })).text) as Thread;
  claudeWorkerAt(s.registry, failed.id, "failed", { message: "Claude launch did not complete" });
  assert.equal(needsCount((await s.call("GET", "/")).text), "3");

  assert.equal((await s.call("POST", "/v1/questions/qn-image/answer", { option: "Not now" })).status, 200);
  assert.deepEqual(needsOf((await s.call("GET", "/")).text).cards.map((c) => c.thread).sort(), [held.id, failed.id].sort(), "the answered question is gone");
  assert.equal((await s.call("POST", `/v1/threads/${failed.id}/archive`)).status, 200);
  assert.equal((await s.call("POST", `/v1/threads/${held.id}/land`, { head })).status, 200);
  assert.deepEqual(landed, [held.id]);
  s.registry.reviews.saveReview(approvedReview(held.id, { kind: "checking", startedAt: Date.now(), thread: null }, { land: { requestedBy: laptop } }));
  const after = (await s.call("GET", "/")).text;
  assert.equal(needsOf(after).text, "Needs you Nothing waits on you.", "a landing on its way and an archived thread wait on no one");
  assert.equal(needsCount(after), "");
});

test("every page links Needs you with its count in the sidebar, and on a phone from its bar, and no page's title counts it", async (t) => {
  const s = await seeded(t);
  const failed = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Port the CLI", claude: "port it" })).text) as Thread;
  claudeWorkerAt(s.registry, failed.id, "failed", { message: "Claude launch did not complete" });
  for (const path of ["/", "/usage", "/cluster", `/threads/${failed.id}`, "/threads/th-000000000000"]) {
    const page = (await s.call("GET", path)).text;
    assert.match(page, /<a class="side-link" href="\/#needs-you">[\s\S]*?Needs you<span class="side-count" id="needs-count" data-live>1<\/span><\/a>/, path);
    assert.match(page, /<a class="icon-btn phone-only" href="\/#needs-you" aria-label="Needs you"/, path);
    assert.doesNotMatch(/<title>([^<]*)<\/title>/.exec(page)![1]!, /\d|Needs/, path);
  }
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
    s.registry.reviews.saveReview(approvedReview(fix.id, phase, { land: { requestedBy: laptop }, ...extra }));
    const region = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
    return { states: [...region.matchAll(/<li class="land-step land-(\w+)"/g)].map((m) => m[1]).join(" "), text: textOf(region).replace(/ ([,.])(?= |$)/g, "$1") };
  };
  const merge = "4".repeat(40);
  const { live: _, ...unchecked } = approvedReview(fix.id, { kind: "approved" }).rounds[1]!;
  assert.deepEqual(await steps({ kind: "checking", startedAt: 0, thread: null }, { rounds: [unchecked] }), {
    states: "now todo todo todo todo", text: `Landing #7 Cache ↗ Check Live check Merge Deploy Landed .nexus/check runs at ${head.slice(0, 12)}, unless it passed there already.` });
  assert.equal((await steps({ kind: "merging", authorized: head })).states, "done skipped now todo todo", "a head with no .nexus/verify skips the live check");
  assert.equal((await steps({ kind: "merging", authorized: null, waiting: "rv-other deploys" })).text,
    `Landing #7 Cache ↗ Check Live check (no .nexus/verify) Merge Deploy Landed Waiting while rv-other deploys, since landings deploy one at a time, then merging ${head.slice(0, 12)}.`);
  assert.deepEqual(await steps({ kind: "deploying", commit: merge, previous: "3".repeat(40), requested: true, deadline: 0 }, { merged: merge }), {
    states: "done skipped done now todo", text: `Landing #7 Cache ↗ Check Live check (no .nexus/verify) Merge Deploy Landed Deploying the merge commit ${merge.slice(0, 12)} until every service reports it healthy.` });
  assert.deepEqual(await steps({ kind: "rolling-back", commit: merge, previous: "3".repeat(40), why: "The deploy of 4444 failed: rj-firebat control failed.", requested: true, deadline: 0 }, { merged: merge }), {
    states: "done skipped done failed todo", text: `Rolling back #7 Cache ↗ Check Live check (no .nexus/verify) Merge Deploy Landed The deploy of 4444 failed: rj-firebat control failed. Rolling back to ${"3".repeat(12)}.` });
  assert.deepEqual(await steps(personPhase("deploy", "The deploy of 4444 failed.", "Rolled back to the previous release, 3333, which every service reports healthy."), { merged: merge }), {
    states: "done skipped done failed todo", text: "Merged, not deployed #7 Cache ↗ Check Live check (no .nexus/verify) Merge Deploy Landed The deploy of 4444 failed. Rolled back to the previous release, 3333, which every service reports healthy. The merge commit 444444444444 is on the default branch, but not deployed. Deploy it from a deployer with nexus deploy 4444444444444444444444444444444444444444, or leave the fleet where it is, and cancel the review once nothing more is needed. Cancel review" });
  assert.deepEqual(await steps({ kind: "landed", commit: merge }, { merged: merge }), {
    states: "done skipped done done done", text: `Landed #7 Cache ↗ Check Live check (no .nexus/verify) Merge Deploy Landed Merged as ${merge.slice(0, 12)}, deployed, and every service reports it healthy.` });
  const other = await steps({ kind: "landed", commit: merge }, { merged: merge, pr: { repo: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", title: "Cache", branch: "cache" } });
  assert.deepEqual(other, { states: "done skipped done skipped done", text: `Landed #7 Cache ↗ Check Live check (no .nexus/verify) Merge Deploy (nothing to deploy) Landed Merged as ${merge.slice(0, 12)}.` }, "a PR that does not deploy skips the step");
  const verifier = "th-0123456789ab" as ThreadId;
  assert.deepEqual(await steps({ kind: "verifying", startedAt: 0, thread: verifier }, { rounds: [unchecked] }), {
    states: "done now todo todo todo", text: `Landing #7 Cache ↗ Check Live check Merge Deploy Landed .nexus/verify runs at ${head.slice(0, 12)} in a verify pylon, ${verifier}.` });
  assert.equal((await steps({ kind: "verifying", startedAt: 0, thread: null, refused: "no node can run this pylon: rj-firebat is offline" }, { rounds: [unchecked] })).text,
    "Landing #7 Cache ↗ Check Live check Merge Deploy Landed No node can take the verify pylon yet: no node can run this pylon: rj-firebat is offline");
  const verified = (live: Review["rounds"][number]["live"]): Partial<Review> => ({ rounds: [{ ...unchecked, ...live === undefined ? {} : { live } }] });
  assert.equal((await steps({ kind: "merging", authorized: head }, verified({ kind: "ran", thread: verifier, passed: true, output: "fleet ok" }))).states, "done done now todo todo", "a live check that passed is done");
  assert.equal((await steps({ kind: "merging", authorized: head }, verified(undefined))).text, `Landing #7 Cache ↗ Check Live check (not run) Merge Deploy Landed Checking the merge policy again with what GitHub says now, then merging ${head.slice(0, 12)}.`, "a landing from before live checks says it ran none");
  assert.equal((await steps({ kind: "fixing" })).text, "", "a review that is not landing has nothing to land");
});

test("a waiting session's message replaces the waiting label, such as a background command still running at the cap", async (t) => {
  const s = await seeded(t);
  const [quiet, held] = await Promise.all(["Asks", "Serves"].map((title) => s.start("acme", title)));
  let sequence = 0;
  for (const [thread, message] of [[quiet!, undefined], [held!, "A background command was still running after 2 hours"]] as const) {
    s.registry.threads.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "c1" } });
    s.registry.threads.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.waiting", session: "c1", ...(message === undefined ? {} : { message }) } });
  }
  const page = (await s.call("GET", `/threads/${held!.id}`)).text;
  assert.match(page, /A background command was still running after 2 hours/);
  assert.match((await s.call("GET", `/threads/${quiet!.id}`)).text, /waiting for input/);
});

test("rows of threads that need the person stay bright, and the rest dim unless open", async (t) => {
  const s = await seeded(t);
  const [failed, parked, reply, working, waiting, idle, open] = await Promise.all(["Failed", "Parked", "Reply", "Working", "Waiting", "Idle", "Open"].map((title) => s.start("acme", title)));
  s.registry.threads.savePylon({ ...s.registry.threads.pylon(failed!.pylonId)!, failed: "setup exited 1" });
  s.fake.park(parked!.id, 1);
  s.registry.threads.recordReply(reply!.id, Date.now());
  s.registry.threads.recordActivity(working!.id, { agent: Date.now(), agentTurnRunning: true });
  s.registry.threads.reportSession(node, { sequence: 1, pylon: waiting!.pylonId, time: Date.now(), event: { kind: "session.waiting", session: "c1" } });
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

test("a paused thread's unread reply has a dot of its own, so it never looks like a running pylon", async (t) => {
  const s = await seeded(t);
  const [live, replied, busy] = [await s.start("acme", "Live"), await s.start("acme", "Replied"), await s.start("acme", "Busy")];
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  s.registry.threads.ingested(testObservation(node, { pylons: [runningPylon(live.pylonId), stoppedPylon(replied.pylonId, { sessions: null }), runningPylon(busy.pylonId)] }), []);
  s.registry.threads.recordReply(replied.id, Date.now());
  s.registry.threads.recordActivity(busy.id, { agent: Date.now(), agentTurnRunning: true });

  const home = (await s.call("GET", "/")).text;
  /** Each thread's dot in rows split this way, as its name and its tone. */
  const dots = (rows: string[]) => [live, replied, busy].map((thread) => {
    const dot = /class="dot dot-(\w+)" role="img" aria-label="([^"]+)"/.exec(rows.find((row) => row.includes(`href="/threads/${thread.id}"`)) ?? "");
    assert.ok(dot !== null, `a dot for ${thread.title}`);
    return `${dot[2]} ${dot[1]}`;
  });
  const want = ["agent idle ok", "new reply reply", "agent working work"];
  assert.deepEqual(dots(home.split('id="overview"')[1]!.split("<tr")), want, "the home table, which the phone lists too");
  assert.deepEqual(dots(home.split('id="side-threads"')[1]!.split("</nav>")[0]!.split("<li>")), want, "the sidebar");
  assert.match((await s.call("GET", `/threads/${replied.id}`)).text, /<span class="chip chip-reply"><span class="dot dot-reply" aria-hidden="true"><\/span><span class="chip-label">new reply<\/span><\/span>/, "the thread page's header");
});

test("a thread's state reads the same in its sidebar row, the home table and its page's header, and each red state has a shape of its own", async (t) => {
  const s = await seeded(t);
  const now = Date.now();
  const start = (title: string) => s.start("acme", title);
  const [idle, working, replied, waiting, failed, decision, parked, paused, archived] = [
    await start("Idle"), await start("Working"), await start("Replied"), await start("Waiting"), await start("Failed"),
    await start("Decision"), await start("Parked"), await start("Paused"), await start("Archived"),
  ];
  const limited = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Limited", claude: "write them" })).text) as Thread;
  claudeWorkerAt(s.registry, limited.id, "started", { session: "s1" });
  const resetsAt = now + 3_600_000;
  assert.ok(s.registry.threads.appendClaudeRead(limited.id, { session: "s1", from: transcriptStart, entries: [{ kind: "notice", at: now, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt } }], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: now }));
  const running = [idle, working, replied, waiting, decision, parked];
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  s.registry.threads.ingested(testObservation(node, { pylons: [...running.map((th) => runningPylon(th.pylonId)), stoppedPylon(paused.pylonId, { sessions: null })] }), []);
  s.registry.threads.recordActivity(working.id, { agent: now, agentTurnRunning: true });
  s.registry.threads.recordReply(replied.id, now);
  s.registry.threads.reportSession(node, { sequence: 1, pylon: waiting.pylonId, time: now, event: { kind: "session.waiting", session: "s1" } });
  s.registry.threads.savePylon({ ...s.registry.threads.pylon(failed.pylonId)!, failed: "setup exited 1" });
  s.registry.nudges.saveNudge(decision.id, { state: "person", turn: now });
  s.registry.threads.recordParked(parked.id, true);
  assert.equal((await s.call("POST", `/v1/threads/${archived.id}/archive`)).status, 200);

  const want: [Thread, string][] = [
    [idle, "agent idle ok"], [working, "agent working work"], [replied, "new reply reply"], [waiting, "waiting for input idle"],
    [failed, "failed bad"], [decision, "needs your decision decide"], [parked, "parked stuck"],
    [limited, `stopped on its usage limit until ${new Date(resetsAt).toISOString().slice(11, 16)} UTC limit`],
    [paused, "paused idle"], [archived, "archived muted"],
  ];
  const dotIn = (html: string, thread: Thread) => {
    const dot = /class="dot dot-(\w+)" role="img" aria-label="([^"]+)"/.exec(html);
    assert.ok(dot !== null, `a dot for ${thread.title}`);
    return `${dot[2]} ${dot[1]}`;
  };
  const home = (await s.call("GET", "/")).text.split('id="overview"')[1]!.split("<tr");
  for (const [thread, state] of want) {
    const page = (await s.call("GET", `/threads/${thread.id}`)).text;
    const chip = /<span class="chip chip-(\w+)"><span class="dot dot-(\w+)" aria-hidden="true"><\/span><span class="chip-label">([^<]*)<\/span>/.exec(page);
    assert.ok(chip !== null && chip[1] === chip[2], `${thread.title}'s header has a chip`);
    assert.equal(`${chip[3]} ${chip[1]}`, state, `${thread.title}'s header`);
    const row = page.split('id="side-threads"')[1]!.split("<li>").find((li) => li.includes(`href="/threads/${thread.id}"`));
    assert.equal(dotIn(row ?? "", thread), state, `${thread.title}'s sidebar row`);
    const inHome = home.find((tr) => tr.includes(`href="/threads/${thread.id}"`));
    if (thread !== archived) assert.equal(dotIn(inHome ?? "", thread), state, `${thread.title}'s row in the home table`);
  }
});

test("the side nodes show each node's committed memory, mark an overcommitted one, and say what its paused pylons need to wake", async (t) => {
  const s = await seeded(t);
  const [fix, docs] = [await s.start("acme", "Fix checkout"), await s.start("acme", "Write docs")];
  const over = testCapacity({ memoryGiB: 22.8, committedMemoryGiB: 40, committedDiskGiB: 20 });
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: over });
  const stopped = (t: Thread) => stoppedPylon(t.pylonId, { sessions: null });
  s.registry.threads.ingested(testObservation(node, { capacity: over, pylons: [stopped(fix), stopped(docs)] }), []);
  assert.equal((await s.call("POST", `/v1/threads/${docs.id}/archive`)).status, 200);
  const nodes = (await nodeHeads(s));
  assert.match(nodes, /<em>overcommitted<\/em>/, "the marker uses the offline marker's style");
  assert.match(textOf(nodes), /rj-firebat overcommitted 40\/22\.8 GiB memory · 4 GiB to wake paused/, "only the paused pylon whose thread is not archived needs memory to wake");

  s.observe();
  const fits = textOf((await nodeHeads(s)));
  assert.match(fits, /rj-firebat 0\/64 GiB memory/);
  assert.doesNotMatch(fits, /overcommitted|to wake/);
});

test("an offline node shows its pylons as unknown, and the last observation as stale", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.nodes.markOffline(node);

  const list = (await s.call("GET", "/")).text;
  assert.equal(overviewRow(list, fix), "Fix checkout running unknown rj-firebat offline just now never");
  assert.match(textOf(await nodeHeads(s)), /rj-firebat offline/);
  const pylon = textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "pylon-h"));
  assert.match(pylon, /Observed unknown Node rj-firebat offline Last seen just now \(stale\)/);
});

test("a running pylon whose node reports its guest not answering says so in its detail, by the composer and in the pylon pane, until its node reports it answers", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const since = new Date(Date.now() - 3 * 60_000).toISOString();
  const report = (notAnswering?: { since: string; timeouts: number }) => s.registry.threads.ingested(testObservation(node, { pylons: [runningPylon(fix.pylonId, {
    liveHash: s.registry.threads.pylon(fix.pylonId)!.liveHash, bootedFrom: { image: image.id, checkpoint: null }, ...notAnswering === undefined ? {} : { notAnswering },
  })] }), []);
  s.observe(fix);
  report({ since, timeouts: 5 });
  assert.deepEqual((JSON.parse((await s.call("GET", `/v1/threads/${fix.id}`)).text) as ThreadDetail).pylon.notAnswering, { since, timeouts: 5 });
  const page = textOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.match(page, /The pylon's guest has not answered its commands since 3 min ago ?, so a message may fail\. Archive and unarchive the thread to give it a fresh VM\. If the guest does not answer the pause either, the changes since its last saved disk are lost, so push or copy what you can first\./);
  assert.match(page, /The guest has not answered its last 5 commands, since 3 min ago ?\. Archive and unarchive the thread to give it a fresh VM\. If the guest does not answer the pause either, the changes since its last saved disk are lost, so push or copy what you can first\./);
  report();
  assert.equal("notAnswering" in (JSON.parse((await s.call("GET", `/v1/threads/${fix.id}`)).text) as ThreadDetail).pylon, false);
  assert.doesNotMatch(textOf((await s.call("GET", `/threads/${fix.id}`)).text), /has not answered/);
});

test("the thread page shows a paused session as resuming on wake, or on unarchive, and a failed one with why", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.threads.apply({ record: "sessions", pylonId: fix.pylonId, sessions: [
    { id: "w1:p1", state: "paused", terminal: "w1:p1", harness: "claude-code", harnessSessionId: null, title: "review", status: null, message: null },
    { id: "failed-0123456789ab", state: "failed", terminal: null, harness: "pi", harnessSessionId: null, title: "plan", status: null, message: "pi exited 1" },
  ] });
  const sessions = async () => {
    const section = sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "sessions-h");
    return { section, text: textOf(section) };
  };
  const shown = await sessions();
  assert.match(shown.text, /Claude Code review paused, resumes on wake w1:p1/);
  assert.match(shown.text, /pi plan failed It did not come back from the last wake, which the next tries again: pi exited 1/);
  assert.ok(!shown.text.includes("failed-0123456789ab"), "a session in no terminal shows no terminal");
  assert.equal((await s.call("POST", `/v1/threads/${fix.id}/archive`)).status, 200);
  assert.match((await sessions()).text, /Claude Code review paused, resumes on unarchive w1:p1/);
});

test("the thread page's sessions open, show in the terminal and close from the page, but not the Claude worker's own, and an archived thread's do none", async (t) => {
  const s = await seeded(t);
  const worker = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Port the CLI", claude: "port it" })).text) as Thread;
  claudeWorkerAt(s.registry, worker.id, "started", { session: "5f0c" });
  s.observe(worker);
  s.registry.threads.apply({ record: "sessions", pylonId: worker.pylonId, sessions: [
    { id: "w1:p1", state: "running", terminal: "w1:p1", harness: "claude-code", harnessSessionId: "5f0c", title: "Port the CLI", status: "working", message: null },
    { id: "w2:p1", state: "running", terminal: "w2:p1", harness: "shell", harnessSessionId: null, title: "shell", status: "idle", message: null },
    { id: "w3:p1", state: "paused", terminal: "w3:p1", harness: "pi", harnessSessionId: null, title: "plan", status: null, message: null },
    { id: "failed-0123456789ab", state: "failed", terminal: null, harness: "claude-code", harnessSessionId: "9a1b", title: "review", status: null, message: "claude exited 1" },
  ] });
  const buttons = async () => [...sectionOf((await s.call("GET", `/threads/${worker.id}`)).text, "sessions-h").matchAll(/<button [^>]*data-action="([^"]+)"[^>]*>/g)]
    .map(([button, action]) => [action, ...["harness", "terminal", "session", "confirm"].flatMap((key) => new RegExp(`data-${key}="([^"]*)"`).exec(button!)?.slice(1).map(textOf) ?? [])].join(" "));
  assert.deepEqual(await buttons(), [
    'close-session failed-0123456789ab Close the Claude Code session "review"? No wake tries it again.',
    "show-session w1:p1",
    "show-session w2:p1",
    'close-session w2:p1 Close the Shell session "shell"? Its terminal closes, and what runs there ends.',
    "open-session shell",
    "open-session pi",
    "open-session claude-code",
  ]);
  assert.equal((await s.call("POST", `/v1/threads/${worker.id}/archive`)).status, 200);
  assert.deepEqual(await buttons(), []);

  const plain = await s.start("acme", "Fix checkout");
  s.observe(plain);
  s.registry.threads.apply({ record: "sessions", pylonId: plain.pylonId, sessions: [
    { id: "w1:p1", state: "running", terminal: "w1:p1", harness: "claude-code", harnessSessionId: null, title: "login", status: "blocked", message: null },
  ] });
  const closes = [...sectionOf((await s.call("GET", `/threads/${plain.id}`)).text, "sessions-h").matchAll(/data-action="close-session" [^>]*data-session="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(closes, ["w1:p1"], "a Claude session with no ID yet closes on a thread with no Claude worker");
});

test("the thread page lists a session of a harness this control plane does not know, such as a newer probe's, with no label", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.threads.apply({ record: "sessions", pylonId: fix.pylonId, sessions: [
    { id: "w1:p1", state: "running", terminal: "w1:p1", harness: "codex" as never, harnessSessionId: null, title: "agent", status: "working", message: null },
  ] });
  const res = await s.call("GET", `/threads/${fix.id}`);
  assert.equal(res.status, 200);
  assert.match(sectionOf(res.text, "sessions-h"), /<span class="o-kind"><\/span><span class="s-title">agent<\/span>/);
});

test("the thread page shows its pylon, sessions with how to attach, previews as tailnet links, and outputs", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  const running = (terminal: string, harness: "claude-code" | "pi" | "shell", status: "working" | "idle", harnessSessionId: string | null = null, title: string | null = null) =>
    ({ id: terminal, state: "running", terminal, harness, harnessSessionId, status, title, message: null }) as const;
  s.registry.threads.apply({ record: "sessions", pylonId: fix.pylonId, sessions: [
    running("w1:p1", "claude-code", "working", "5f0c", "review"),
    running("w2:p1", "pi", "idle", "/home/user/.pi/sessions/a.jsonl"),
    running("w3:p1", "shell", "idle"),
  ] });
  s.registry.threads.allocatePreviews(fix.pylonId, ["web", "api"], { first: 8443, last: 8444 });
  s.registry.threads.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  for (const [kind, ref] of [["branch", "nexus/fix-checkout"], ["diff", "abc1234"], ["preview", "web"], ["file", "out-1"]] as const) {
    s.registry.threads.apply({ record: "output", pylonId: fix.pylonId, kind, ref });
  }

  const res = await s.call("GET", `/threads/${fix.id}`);
  assert.equal(res.status, 200);
  assert.equal(textOf(res.text.split('id="bar"')[1]!.split("</header>")[0]!.replace(/^[^>]*>/, "")), "☰ acme / Fix checkout agent idle Archive Delete ⋯");
  assert.match(conversationOf(res.text).text, new RegExp(`^${fix.id} · started just now`));
  assert.equal(textOf(sectionOf(res.text, "pylon-h")), `Pylon Desired running Observed running Node rj-firebat Last seen just now Human just now Agent never Tokens none counted ${fix.pylonId}`);

  const sessions = textOf(sectionOf(res.text, "sessions-h"));
  assert.match(sessions, /^Sessions 3 /);
  assert.match(sessions, /Claude Code review working w1:p1 session 5f0c/);
  assert.match(sessions, /pi idle w2:p1 session \/home\/user\/\.pi\/sessions\/a\.jsonl/);
  assert.match(sessions, /Shell idle w3:p1 Show in terminal Close New shell New pi New Claude Show in terminal attaches the terminal tab to that session alone\. herdr-app shows them all\. Attach from a shell in the pylon hc Copy$/);

  const previews = sectionOf(res.text, "previews-h");
  assert.ok(previews.includes('href="https://rj-firebat.tail.ts.net:8443/"'), "a ready preview links to its tailnet HTTPS URL");
  assert.equal(textOf(previews), "Previews 2 api starting rj-firebat.tail.ts.net:8444 web Open ↗ rj-firebat.tail.ts.net:8443");
  assert.ok(!previews.includes('href="https://rj-firebat.tail.ts.net:8444/"'), "a preview that is not ready has no link yet");
  assert.ok(previews.includes('<div class="pv-url" title="https://rj-firebat.tail.ts.net:8444/">rj-firebat.tail.ts.net:8444</div>'), "the URL the inspector cuts is whole on hover");

  const outputs = sectionOf(res.text, "outputs-h");
  assert.equal(textOf(outputs), "Outputs 3 PR watch: off (no control-plane GitHub token configured). branch nexus/fix-checkout diff abc1234 file out-1", "web's preview is listed once, under Previews");

  const strip = textOf(res.text.split('id="strip"')[1]!.split("</div>")[0]!.replace(/^[^>]*>/, ""));
  assert.equal(strip, "running · rj-firebat api, starting web ↗ Changes 3 outputs", "the phone's strip names the pylon, each preview, the changes and the outputs");


  assert.match(res.text, new RegExp(`<main[^>]* data-activity="${fix.id}"`), "an open thread page records the visit as human activity");

  s.registry.threads.releasePreviews(fix.pylonId);
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
  assert.match(page, /<div id="facts" data-live hidden><span data-pylon="running" data-turn="false" data-agent-at="0" data-thread-status="(active|idle)" data-open="true"><\/span><\/div>/, "the client learns when the pylon runs and a turn ends");
  assert.match(page, /<div class="tabs" id="tabs" role="tablist" aria-label="Open views" data-thread="[^"]+"><button type="button" class="tab active" role="tab" aria-selected="true" aria-controls="scroll" data-tab="convo">.*Fix checkout<\/span><\/button><button type="button" class="tab tab-tl" role="tab" aria-selected="false" aria-controls="timeline-view" data-tab="timeline">.*Timeline<\/span><\/button><button type="button" class="tab tab-term" role="tab" aria-selected="false" aria-controls="term-view" data-tab="term"[^>]*>.*Terminal<\/span><\/button><\/div>/, "the conversation is the first tab, and the terminal is one click away beside it");
});

test("the inspector lists each listening port once: under Ports with a Publish button until it has a preview, then under Previews", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const page = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    return { ports: sectionOf(html, "ports-h"), previews: textOf(sectionOf(html, "previews-h")) };
  };
  assert.equal(textOf((await page()).ports), "Ports 0 Ports show while the pylon runs.");
  s.observeWith({ services: [{ name: "web", state: "ready", port: 5173, declared: true, wantsPreview: true }, { name: "db", state: "ready", port: 5432, declared: true, wantsPreview: false }], listening: [3000, 5173, 5432] }, fix);
  s.registry.threads.allocatePreviews(fix.pylonId, ["web"], { first: 8443, last: 8443 });
  const before = await page();
  assert.equal(textOf(before.ports), "Ports 2 3000 Publish 5432 db", "web's port is under Previews, and db's has no preview to publish");
  assert.ok(before.ports.includes(`<button type="button" class="btn btn-xs" data-action="link-port" data-thread="${fix.id}" data-port="3000" aria-label="Publish port 3000">Publish</button>`), "a port no service owns offers to publish it");
  assert.equal(before.previews, "Previews 1 web starting rj-firebat.tail.ts.net:8443");

  // Publishing 3000 links it, and the node's next read lists its service.
  s.registry.threads.allocatePreviews(fix.pylonId, ["web", "port-3000"], { first: 8443, last: 8444 });
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
  s.registry.threads.allocatePreviews(fix.pylonId, ["web"], { first: 8443, last: 8443 });
  s.observe(fix);
  const url = "https://rj-firebat.tail.ts.net:8443/";
  const previews = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    const section = sectionOf(html, "previews-h");
    return { previews: textOf(section), linked: section.includes(`href="${url}"`) };
  };
  assert.deepEqual(await previews(), { previews: "Previews 1 web starting rj-firebat.tail.ts.net:8443", linked: false }, "a running pylon's preview that is not ready has no link yet");

  s.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(fix.pylonId, { sessions: null })] }), []);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused Open ↗ rj-firebat.tail.ts.net:8443 Opening it wakes the pylon.", linked: true });

  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused rj-firebat.tail.ts.net:8443 Unarchive the thread to open it.", linked: false }, "an archived thread's visit cannot wake its pylon");

  // Right after the archive, before the pylon pauses, the preview still serves but is about to sleep for good.
  s.observe(fix);
  s.registry.threads.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  assert.match(textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "pylon-h")), /Observed running/);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused rj-firebat.tail.ts.net:8443 Unarchive the thread to open it.", linked: false }, "an archived thread's running pylon offers no link");
});

test("a published preview whose service is starting shows starting and one whose service failed shows failed, with why, neither with a link", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const web = (state: ServiceFact["state"]): ServiceFact => ({ name: "web", state, port: 8003, declared: true, wantsPreview: true });
  s.registry.threads.allocatePreviews(fix.pylonId, ["web"], { first: 8443, last: 8443 });
  s.registry.threads.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
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

test("a lone tool call is its own line, and a run of calls folds under a line that says what it did, over rows where only failures and edits start open", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `ok ${from + i} test`).join(" ");
  const long = lines(1, 40).replace(/ (?=ok)/g, "\n");
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
    { ...assistant([{ type: "text", text: "All 40 pass." }]), timestamp: 1_700_000_000_000 },
  );

  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(page, /<div class="msg agent" data-at="1700000000000"><div class="text"><p>All 40 pass\.<\/p>/, "an answer carries its time, which the page titles in the reader's zone");
  const { rows, open } = conversationOf(page);
  assert.deepEqual(rows, [
    "You Run the tests",
    "Running them with npm test .",
    `✓ Bash npm test 40 lines › npm test ${lines(1, 12)} Show all 40 lines ${lines(13, 40)}`,
    "One more.",
    "Ran a command, changed a file, read a file 1 failed 3 calls ›",
    "✕ Bash git status 2 lines exit 128 › git status fatal: not a git repository Command exited with code 128",
    "✓ Edit src/a.ts +1 −2 › src/a.ts − const a = 1; − const b = 2; + const a = 2;",
    `– Read src/b.ts › src/b.ts { "offset": 10 } No output.`,
    "! Aborted.",
    "! The model failed: rate limited",
    "You Look at this",
    "All 40 pass.",
  ]);
  assert.deepEqual(open, [["tool-c1", false], ["more-c1", false], ["steps-c2", true], ["tool-c2", true], ["tool-c3", true], ["tool-c4", false]], "only a short fold, the failure and the edit start open");
});

test("a fold counts each kind of call, a file once however often it is read, and opens itself for a failure", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  const steps = (prefix: string, failing: boolean): Message[] => [
    assistant([call(`${prefix}1`, "read", { path: "src/checkout/total.ts" }), call(`${prefix}2`, "grep", { pattern: "applyCoupon" }), bash(`${prefix}3`, "npm test -- --watch=false"), bash(`${prefix}4`, "npm test -- --watch=false"), call(`${prefix}5`, "read", { path: "src/checkout/cart.ts" }), call(`${prefix}6`, "read", { path: "src/checkout/total.ts" })]),
    result(`${prefix}1`, "x"), result(`${prefix}2`, "y"), result(`${prefix}3`, "ok"), result(`${prefix}4`, "1 failed\nCommand exited with code 1", failing), result(`${prefix}5`, "z"), result(`${prefix}6`, "x"),
  ];
  transcript.messages.push({ role: "user", content: "Look", timestamp: 0 }, ...steps("a", false), assistant([{ type: "text", text: "Found it." }]), ...steps("b", true));
  transcript.messages.push(assistant([{ type: "text", text: "Now the rest." }, bash("c1", "ls"), bash("c2", "pwd"), bash("c3", "id")]), result("c1", "a"), result("c2", "b"), result("c3", "c"));

  const { rows, open } = conversationOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(rows[1], "Ran 2 commands, read 2 files, searched the code 6 calls ›");
  assert.equal(rows[9], "Ran 2 commands, read 2 files, searched the code 1 failed 6 calls ›");
  assert.equal(rows[16], "Now the rest.");
  assert.equal(rows[17], "Ran 3 commands 3 calls ›");
  assert.equal(rows[18], "✓ Bash ls 1 line › ls a");
  assert.deepEqual(open.filter(([id]) => String(id).startsWith("steps-")), [["steps-a1", false], ["steps-b1", true], ["steps-c1", true]], "a fold of more than five calls starts open only with a failure");
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
    "Changed 2 files, ran a command, read a file, used 3 other tools 9 calls ›",
    "Ran a command, searched the code, used frob 3 calls ›",
    "Ran a command, read a file, searched the code 2 times, used another tool 5 calls ›",
  ]);
  assert.ok(rows.includes("! Aborted."), "a notice between two runs stays between their folds");
});

test("a running turn shows its tool's output so far, the partial answer, queued messages and what the run has done", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push({ role: "user", content: "Build it", timestamp: 0 }, assistant([bash("c1", "npm run build")], "toolUse"));
  s.registry.threads.recordActivity(fix.id, { agent: Date.now() - 72_000, agentTurnRunning: true });
  transcript.docs["pi.live"] = {
    run: { taskId: 1, inputs: [1] },
    tools: [{ callId: "c1", name: "bash", status: "running", output: "compiling\n" }],
    generation: { attempt: 2, message: assistant([{ type: "text", text: "Half an ans" }], "pending") as never, retry: { at: 0, error: "overloaded" } },
  };
  transcript.docs["pi.inbox"] = { items: [{ id: 2, mode: "followUp", content: "then deploy" }, { id: 3, mode: "write", entry: {} }, { id: 4, mode: "steer", content: "skip the docs" }] };

  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  const { rows, open, dock } = conversationOf(html);
  assert.deepEqual(rows, [
    "You Build it",
    "Bash npm run build 1 line › npm run build compiling",
    "Half an ans",
    "! The model request failed and will be retried: overloaded",
    "You queued, sends after this run then deploy",
    "You queued, joins after this tool round skip the docs",
  ]);
  assert.deepEqual(open, [["tool-c1", true]]);
  assert.match(html, /<span class="t-mark run" role="img" aria-label="running" title="running"><span class="spin"><\/span><\/span>/, "its mark spins, and a screen reader hears it runs");
  assert.match(dock, new RegExp(`^Working 1m 12s · 1 tool this turn Abort nexus attach ${fix.id} Copy gpt-test Steer joins the run after its current tool round\\. Queue ⌥↵ Alt\\+↵ Steer ⌘↵ Ctrl\\+↵$`));
  assert.match(html, /placeholder="Steer the run…"/);
  assert.match(html, /<button type="submit" class="btn btn-ghost send-alt" id="queue" name="mode" value="followUp"[^>]*>/, "⌥↵ queues a follow-up after the run");
  assert.match(html, /<button type="submit" class="send send-steer" id="send" name="mode" value="steer"[^>]*>/, "⌘↵ steers the run that works");
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
  const grew = async () => {
    const { grow, shows } = await stream.next();
    assert.equal(typeof shows, "string", "each frame names the view it shows");
    return { grow };
  };
  const first = await stream.next();
  assert.ok(page.includes(`data-stream="/threads/${fix.id}/stream">${first.convo}</div><button type="button" class="btn btn-xs jump-end"`), "the first event is the region the page holds");
  assert.deepEqual(conversationOf(`<div id="convo" ${first.convo}<div class="dock"></main>`).rows.slice(1), ["Bash npm run build 1 line › npm run build compiling", "Hal"]);

  transcript.docs["pi.live"] = live("Half an <answer>", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await grew(), { grow: [[0, "2 lines"], [1, "compiling\nlinking\n"], [2, '<p>Half an &lt;answer&gt;<span class="caret" aria-hidden="true"></span></p>']] },
    "the line count, the output and the answer grow in place, escaped as the page escapes them");
  transcript.docs["pi.live"] = live("Half an <answer> and more", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await grew(), { grow: [[2, '<p>Half an &lt;answer&gt; and more<span class="caret" aria-hidden="true"></span></p>']] }, "only the parts that grew");
  transcript.docs["pi.live"] = live("Half an <answer> and more\n\n- **one**\n```sh\nnpm te <!--/grow-->", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await grew(), {
    grow: [[2, '<p>Half an &lt;answer&gt; and more</p><ul><li><p><strong>one</strong></p></li></ul><pre class="code">npm te &lt;!--/grow--&gt;<span class="caret" aria-hidden="true"></span></pre>']],
  }, "markdown blocks grow in place, an open fence is code so far, the caret trails the last character, and text cannot close the part");

  transcript.messages.push(result("c1", "built"), assistant([{ type: "text", text: "Built." }]));
  transcript.docs["pi.live"] = {};
  s.fake.commit(fix.id);
  const done = await stream.next();
  assert.deepEqual(conversationOf(`<div id="convo" ${done.convo}<div class="dock"></main>`).rows.slice(1), ["✓ Bash npm run build 1 line › npm run build built", "Built."], "a finished call and a committed answer send the region whole");
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
      running: html.includes('data-state="working"'),
      visit: html.includes("data-activity="),
      chip: textOf(html.split('<span class="chip chip-')[1]!.split("</span></span>")[0]!.replace(/^[^>]*>/, "")),
      ...conversationOf(html),
    };
  };

  const fresh = await state();
  assert.deepEqual([fresh.actions, fresh.prompt, fresh.running, fresh.visit, fresh.text], [["archive", "delete"], true, false, true, `${fix.id} · started just now No messages yet.`]);
  assert.equal(fresh.dock, `Idle nexus attach ${fix.id} Copy Send ⌘↵ Ctrl+↵`);
  assert.match((await s.call("GET", `/threads/${fix.id}`)).text, /title="Send"><svg[^]*?<\/svg><span class="send-label">Send<\/span> <kbd><span class="k-mac">⌘↵<\/span><span class="k-other">Ctrl\+↵<\/span><\/kbd><\/button>/, "the send key shows as the device's platform names it");
  assert.match(fresh.dock, /^Idle /, "an idle agent says so");

  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  s.registry.threads.recordActivity(fix.id, { agent: Date.now(), agentTurnRunning: true });
  const running = await state();
  assert.deepEqual(running.actions, ["abort", "archive", "delete"]);
  assert.ok(running.prompt && running.running);
  assert.equal(running.chip, "agent working");

  // The harness reports a parked run as no running turn, so its pylon may sleep. It can still be aborted.
  s.fake.park(fix.id, 2);
  s.registry.threads.recordActivity(fix.id, { agent: Date.now(), agentTurnRunning: false });
  const parked = await state();
  assert.deepEqual(parked.actions, ["abort", "archive", "delete", "retry"]);
  assert.ok(parked.prompt && !parked.running, "a parked run is not shown as working");
  assert.match(parked.dock, /^Stuck 2 tasks hit the restart limit and hold the run\. Retry runs them again\. Retry Abort nexus attach /);

  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  const archived = await state();
  assert.deepEqual(archived.actions, ["abort", "delete", "unarchive"], "an archived thread can still abort, but not retry");
  assert.match((await s.call("GET", `/threads/${fix.id}`)).text, /<button type="button" class="tab tab-term" hidden role="tab"/, "its terminal tab waits, hidden, for an unarchive");
  assert.ok(!archived.prompt && !archived.visit);
  assert.equal(archived.chip, "parked");
  assert.equal(archived.dock, "Stuck 2 tasks hit the restart limit and hold the run. Unarchive the thread to retry them. Abort An archived thread takes no messages, because its pylon stays paused. Unarchive the thread to send one.", "nor attach, since its pylon stays paused");

  await s.call("POST", `/v1/threads/${fix.id}/unarchive`);
  assert.deepEqual((await state()).actions, ["abort", "archive", "delete", "retry"]);

  await s.call("DELETE", `/v1/threads/${fix.id}`);
  s.fake.calls.length = 0;
  const deleted = await state();
  assert.deepEqual([deleted.actions, deleted.prompt, deleted.running, deleted.visit, deleted.chip, deleted.dock], [[], false, false, false, "deleted", ""]);
  assert.equal(deleted.text, `${fix.id} · started just now The thread is deleted, so its conversation is gone.`);
  assert.deepEqual(s.fake.calls, [], "a deleted thread's conversation is not read");
});

test("the state bar says the agent waits for the person while a question is open or a dialog waits in its terminal, which it opens", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  const bar = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    return { state: /data-state="([a-z]+)"/.exec(html)?.[1], text: textOf(html.split('<div id="run" data-live>')[1]!.split('<div id="composer"')[0]!), send: /id="send" name="mode" value="([a-zA-Z]+)"/.exec(html)?.[1] };
  };
  assert.deepEqual(await bar(), { state: "idle", text: `Idle nexus attach ${fix.id} Copy`, send: "followUp" });

  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-ship", thread: fix.id, text: "Ship it?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  assert.deepEqual(await bar(), { state: "waiting", text: `Waiting for you A question waits for your answer, above. nexus attach ${fix.id} Copy`, send: "followUp" });

  // A question that does not stop the run, as a planning thread's, leaves a run that works working.
  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  assert.equal((await bar()).state, "working");
  assert.equal((await bar()).send, "steer");
  s.fake.transcript(fix.id).docs["pi.live"] = {};
  s.registry.questions.answerQuestion(s.registry.questions.question("qn-ship")!, { option: "Yes", by: laptop, at: Date.now() });

  s.registry.threads.reportSession(node, { sequence: 1, pylon: fix.pylonId, time: Date.now(), event: { kind: "session.waiting", session: "s1", at: Date.now(), message: "Claude needs your permission to use Bash" } });
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.deepEqual(await bar(), { state: "waiting", text: `Waiting for you Claude needs your permission to use Bash, in the pylon's terminal. Open terminal nexus attach ${fix.id} Copy`, send: "followUp" });
  assert.match(html, /<button type="button" class="btn btn-xs" data-terminal>/, "the dialog's terminal is one click away");
  s.registry.threads.recordReply(fix.id, Date.now());
  assert.equal(JSON.parse((await s.call("GET", `/v1/threads/${fix.id}`)).text).attention, "reply");
  assert.equal((await bar()).state, "waiting", "an unread reply outranks the wait in attention, but the dialog still waits");
});

test("a paused pylon's prompt box says a message wakes it", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.threads.ingested(testObservation(node, { pylons: [stoppedPylon(fix.pylonId, { sessions: null })] }), []);
  assert.equal(conversationOf((await s.call("GET", `/threads/${fix.id}`)).text).dock, `Idle the pylon is paused, and a message wakes it nexus attach ${fix.id} Copy Send ⌘↵ Ctrl+↵`);
});

test("a thread deleted while its conversation is read shows no conversation", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.fake.transcript(fix.id).messages.push({ role: "user", content: "secret plan", timestamp: 0 });
  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  const watch = s.fake.harness.watch;
  s.fake.harness.watch = async (threadId) => {
    const view = await watch(threadId);
    s.registry.threads.setThreadStatus(fix.id, "deleted");
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

test("a reply's inline markdown renders in work linear in its length, whatever openers it leaves unclosed", async (t) => {
  const s = await seeded(t);
  const stepsFor = async (unit: string, size: number) => {
    const fix = await s.start("acme", `Render ${unit} at ${size}`);
    const reply = `${unit.repeat(Math.ceil(size / unit.length)).slice(0, size)}\n\nend of reply`;
    s.fake.transcript(fix.id).messages.push(assistant([{ type: "text", text: reply }]));
    const before = inlineSteps;
    const res = await s.call("GET", `/threads/${fix.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("<p>end of reply</p>"), "the whole reply renders");
    return inlineSteps - before;
  };
  for (const unit of ["*a ", "_a ", "**a ", "__a ", "`a ", "[a](", "[*a](", "[a](b(c)", "*_**__[`a ", "**a _b [*c*](https://x) `d`_** "]) {
    const [half, full] = [await stepsFor(unit, 32 * 1024), await stepsFor(unit, 64 * 1024)];
    assert.ok(half >= 32 * 1024 && full >= 64 * 1024, `${unit}: every character is scanned`);
    assert.ok(full <= 2.2 * half && full <= 4 * 64 * 1024, `${unit}: doubling the reply about doubles the work (${half} then ${full} steps)`);
  }
});

test("strings from humans and probes are escaped, never markup", async (t) => {
  const s = await seeded(t);
  const evil = await s.start("acme", `<img src=x onerror="alert(1)">`);
  s.registry.threads.apply({ record: "output", pylonId: evil.pylonId, kind: "branch", ref: `"><script>alert(2)</script>` });
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
  s.registry.threads.savePylon({ ...s.registry.threads.pylon(fix.pylonId)!, failed: reason });
  s.fake.park(fix.id, 1);
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.ok(!html.includes('<form id="prompt"'), "a failed pylon cannot serve a message");
  assert.equal(conversationOf(html).dock, `Stuck 1 task hit the restart limit and hold the run. Retry runs them again. Retry nexus attach ${fix.id} Copy The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages. Fix the cause, such as the project's git access, and retry, or start again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk. ${reason.replace("\n", " ")} Retry Start again`);
  assert.ok(html.includes(`<button type="button" class="btn" id="retry-pylon" data-action="retry-pylon" data-thread="${fix.id}">Retry</button>`), "the retry goes through the client's action handler, which disables it while it is sent");
  assert.match(html, /<button type="button" class="btn" data-start="acme" data-title="Fix checkout">Start again<\/button>/, "starting again opens the dialog on the same project and title");

  assert.equal((await s.call("POST", `/v1/threads/${fix.id}/pylon/retry`)).status, 204);
  const retried = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.ok(retried.includes('<form id="prompt"') && !retried.includes('id="retry-pylon"'), "a retried pylon takes messages again");
});

test("a failed pylon whose disk holds a failed setup offers no retry, and says to start again", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.registry.threads.ingested(testObservation(node, { pylons: [{ pylonId: fix.pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause: "saved-setup", logTail: "" }] }), []);
  s.registry.threads.savePylon({ ...s.registry.threads.pylon(fix.pylonId)!, failed: "pylon is broken: Setup exited 128. Read controller logs" });
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
  assert.equal(conversationOf(html).rows[0], "Ran a command, searched the code 2 calls ›");
  assert.equal(conversationOf(html).rows[1], `✓ Bash for f in src/*.ts; do … 1 line › ${command.replace(/\s+/g, " ")} ok`, "the row shows a command's first line");
  assert.equal(conversationOf(html).rows[2], `✓ Grep a|b<c> 1 line › a|b<c> { "path": "src" } src/a.ts:1`);
});

/** The line each tool call shows, before its body: mark, tool, subject, size and time. */
const toolLines = (rows: readonly string[]) => rows.filter((row) => /^[✓✕–] /.test(row)).map((row) => row.split(" › ")[0]);

test("a call shows how long it took, a harness call from its result's duration and a Claude call from its result's time less its call's", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const timed = (id: string, durationMs?: number) => ({ ...result(id, "ok"), ...(durationMs === undefined ? {} : { durationMs }) }) as Message;
  s.fake.transcript(fix.id).messages.push(
    assistant([bash("c1", "a"), bash("c2", "b"), bash("c3", "c"), bash("c4", "d")]),
    timed("c1", 840), timed("c2", 2_440), timed("c3", 75_000), timed("c4"),
  );
  assert.deepEqual(toolLines(conversationOf((await s.call("GET", `/threads/${fix.id}`)).text).rows), [
    "✓ Bash a 1 line 840 ms", "✓ Bash b 1 line 2.4 s", "✓ Bash c 1 line 1m 15s", "✓ Bash d 1 line",
  ]);

  const thread = await claudeThread(s, [
    { kind: "tool", at: 1_000, id: "t1", name: "Bash", input: { command: "npm test" } },
    { kind: "result", at: 2_234, toolUseId: "t1", output: "ok", isError: false },
    { kind: "tool", at: 3_000, id: "t2", name: "Bash", input: { command: "date" } },
    { kind: "result", at: 2_990, toolUseId: "t2", output: "ok", isError: false },
    { kind: "tool", at: 4_000, id: "t3", name: "Bash", input: { command: "sleep 1" } },
  ]);
  assert.deepEqual(toolLines(conversationOf((await s.call("GET", `/threads/${thread.id}`)).text).rows), [
    "✓ Bash npm test 1 line 1.2 s", "✓ Bash date 1 line", "– Bash sleep 1",
  ], "a result stamped before its call and a call without a result show no time");
});

test("pi's bash and Claude's Bash read as one tool, and a path in the checkout reads relative, as pi gives it", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.fake.transcript(fix.id).messages.push(
    assistant([bash("c1", "npm test"), call("c2", "read", { path: "src/a.ts" }), call("c3", "ls", { path: "src" }), call("c4", "mcp__notes__write_file", { path: "a.md" })]),
    result("c1", "ok"), result("c2", "x", false, "read"), result("c3", "a.ts", false, "ls"), result("c4", "done", false, "mcp__notes__write_file"),
  );
  const thread = await claudeThread(s, [
    { kind: "tool", at: 1, id: "t1", name: "Bash", input: { command: "npm test" } },
    { kind: "tool", at: 1, id: "t2", name: "Read", input: { file_path: "/home/user/workspace/repo/src/a.ts" } },
    { kind: "result", at: 1, toolUseId: "t1", output: "ok", isError: false },
    { kind: "result", at: 1, toolUseId: "t2", output: "x", isError: false },
  ]);
  const harness = (await s.call("GET", `/threads/${fix.id}`)).text;
  const claude = (await s.call("GET", `/threads/${thread.id}`)).text;
  assert.deepEqual(toolLines(conversationOf(harness).rows), ["✓ Bash npm test 1 line", "✓ Read src/a.ts 1 line", "✓ List src 1 line", "✓ write_file a.md 1 line"]);
  assert.deepEqual(toolLines(conversationOf(claude).rows), ["✓ Bash npm test 1 line 0 ms", "✓ Read src/a.ts 1 line 0 ms"]);
  assert.match(claude, /<pre class="t-full">\/home\/user\/workspace\/repo\/src\/a\.ts<\/pre>/, "the expanded body keeps the path whole");
  assert.match(harness, /<span class="t-name" title="ls">List<\/span>/, "a renamed tool's own name is a hover away");
  assert.match(harness, /<span class="t-name" title="mcp__notes__write_file">write_file<\/span>/);
});

test("a long output shows its first lines with the rest one click away, while a short one and a running one show whole", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push(
    { role: "user", content: "Go", timestamp: 0 },
    assistant([bash("c1", "long"), bash("c2", "short"), call("c3", "write", { path: "big.txt", content: numbered(40).join("\n") }), bash("c4", "build")], "toolUse"),
    result("c1", `${numbered(31).join("\n")}\n`), result("c2", numbered(30).join("\n")), result("c3", "Wrote big.txt", false, "write"),
  );
  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [1] }, tools: [{ callId: "c4", name: "bash", status: "running", output: numbered(50).join("\n") }] };
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  const { rows, open } = conversationOf(html);
  assert.equal(rows[2], `✓ Bash long 31 lines › long ${numbered(12).join(" ")} Show all 31 lines ${numbered(31).slice(12).join(" ")}`, "the whole output is in the page");
  assert.equal(rows[3], `✓ Bash short 30 lines › short ${numbered(30).join(" ")}`);
  assert.match(rows[4]!, /^✓ Write big\.txt \+40 −0 › big\.txt (\+ line \d+ ){12}Show all 40 lines (\+ line \d+ ?){28}$/, "a long change is clipped too");
  assert.ok(rows[5]!.endsWith(numbered(50).join(" ")) && !rows[5]!.includes("Show all"), "a running call's output grows whole");
  const [, head, rest] = /<pre class="t-out t-head">([^<]*)<\/pre><details class="t-more" id="more-c1"><summary data-more>Show all 31 lines<\/summary><pre class="t-out t-rest">([^<]*)<\/pre><\/details>/.exec(html)!;
  assert.deepEqual([head, rest], [numbered(12).join("\n"), numbered(31).slice(12).join("\n")]);
  assert.deepEqual(open.filter(([id]) => String(id).startsWith("more-")), [["more-c1", false], ["more-c3-diff", false]]);
});

test("a lone call has no fold line, a run of two starts open, and a run of six starts closed unless a call failed", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const run = (prefix: string, n: number, failing = false): Message[] => {
    const ids = Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
    return [assistant(ids.map((id) => bash(id, "ls"))), ...ids.map((id, i) => result(id, "ok", failing && i === n - 1))];
  };
  s.fake.transcript(fix.id).messages.push(
    ...run("a", 1), assistant([{ type: "text", text: "Two." }]), ...run("b", 2), assistant([{ type: "text", text: "Six." }]),
    ...run("c", 6), assistant([{ type: "text", text: "Six, one failing." }]), ...run("d", 6, true),
  );
  const { rows, open } = conversationOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(rows[0], "✓ Bash ls 1 line › ls ok");
  assert.deepEqual(rows.filter((row) => !row.startsWith("✓ ")), ["Two.", "Ran 2 commands 2 calls ›", "Six.", "Ran 6 commands 6 calls ›", "Six, one failing.", "Ran 6 commands 1 failed 6 calls ›", "✕ Bash ls 1 line failed › ls ok"]);
  assert.deepEqual(open.filter(([id]) => String(id).startsWith("steps-")), [["steps-b1", true], ["steps-c1", false], ["steps-d1", true]]);
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
  s.registry.nodes.upsertNode({ name: tower, tailnetHost: "tower.tail.ts.net", tailnetNodeId: "nTOWER" as TailnetNodeId });
  s.registry.threads.apply({ record: "node", node: tower, state: "online", capacity });
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
  assert.match(textOf(dialog), /Each pylon gets 2 CPUs, 4 GiB of memory and 10 GiB of disk\. nexus project add can set those, allowed hosts, logins and other secrets\./);
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
  assert.deepEqual(JSON.parse(form[1]!.replace(/&quot;/g, '"')), defaultProjectResources, "the resources nexus project add gives");
  const added = await add("acme", node);
  assert.equal(added.status, 201, added.text);
  assert.deepEqual(JSON.parse(added.text), { ...project("acme"), resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } }, "the same project as the CLI's defaults");
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
  assert.match(dialog, /name="project" required value="sketch" data-node="rj-firebat" data-branch="main"[^>]* data-scratch[ >]/, "client.js says the thread starts an empty repository from these");
  assert.match(textOf(sectionOf(page, "project-sketch")), /^sketch scratch, no remote Auto review Off Review Land Yolo New thread/);
});

test("every page has somewhere to say a refresh failed", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  for (const path of ["/", "/threads/new", `/threads/${fix.id}`, "/threads/th-missing", "/usage", "/cluster"]) {
    assert.equal([...(await s.call("GET", path)).text.matchAll(/<p id="refresh-state" class="refresh-state" role="status"><\/p>/g)].length, 1, `${path} has one refresh status`);
  }
});

test("every page has one alert for what failed where the person acted, outside the dock a diff shrinks and every live region a swap replaces", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const alert = '<div class="notices"><p id="refresh-state" class="refresh-state" role="status"></p><div id="action-error" class="error alert" role="alert" hidden></div></div>';
  for (const path of ["/", `/threads/${fix.id}`, "/cluster", "/usage"]) {
    const page = (await s.call("GET", path)).text;
    assert.equal(page.split('id="action-error"').length, 2, `${path} has one alert`);
    assert.ok(page.split("</main>")[1]!.includes(alert), `${path} says it beside the page's refresh status, outside main`);
  }
  const css = await readFile(new URL("./style.css", import.meta.url), "utf8");
  assert.match(css, /\.main\[data-view="file"\] \.dock > :not\(#run\) \{ display: none; \}/, "a diff shrinks the dock to the agent's state, where the alert was");
  assert.match(css, /\n\.notices \{ position: fixed;/);
});

test("Archive asks first only when it loses something, and names the open questions and the running turn", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const archive = async () => /<button[^>]* id="archive"[^>]*>/.exec((await s.call("GET", `/threads/${fix.id}`)).text)![0];
  const confirmOf = async () => {
    const said = /data-confirm="([^"]*)"/.exec(await archive());
    return said === null ? null : textOf(said[1]!);
  };
  assert.equal(await confirmOf(), null, "an idle thread with nothing open archives at once");
  s.registry.questions.askQuestion({ kind: "holds", id: "qn-holds", thread: fix.id, text: "Land with these holds?", options: ["Land", "Leave it"], reserved: null, answerer: "person", askedAt: Date.now(), holds: { review: "rv-1", head: "h", base: null, holds: [] } });
  assert.equal(await confirmOf(), null, "an archive leaves a holds question open");
  s.registry.questions.askQuestion({ kind: "judgment", id: "judgment:7", thread: fix.id, failure: 7, text: "The pylon failed on rj-firebat.\n\nRetry it?", options: ["Retry", "Leave it failed"], reserved: null, answerer: "person", askedAt: Date.now() });
  assert.equal(await confirmOf(), 'Archive "Fix checkout"? Its open question "The pylon failed on rj-firebat." is withdrawn.');
  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  s.registry.threads.recordActivity(fix.id, { agent: Date.now(), agentTurnRunning: true });
  assert.equal(await confirmOf(), 'Archive "Fix checkout"? Its open question "The pylon failed on rj-firebat." is withdrawn. Its agent is in a turn, and its pylon goes to sleep at once.');
  s.registry.questions.answerQuestion(s.registry.questions.question("judgment:7")!, { option: "Leave it failed", by: laptop, at: Date.now() });
  assert.equal(await confirmOf(), 'Archive "Fix checkout"? Its agent is in a turn, and its pylon goes to sleep at once.', "an answered question is not lost");
  s.fake.park(fix.id, 2);
  assert.equal(await confirmOf(), 'Archive "Fix checkout"? Its agent is in a turn, and its pylon goes to sleep at once.', "parked tasks beside a turn still running");
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
  assert.match(textOf(dialog), /No image is current yet/);
  assert.match(dialog, /<p class="hint" id="start-hint" data-image=""><\/p>/, "client.js writes the hint, here naming no image");

  await s.call("POST", "/v1/projects", { ...project("spread"), defaultNode: "auto" });
  const spread = (await s.call("GET", "/threads/new?project=spread")).text.split('<dialog id="start-dialog"')[1]!.split("</dialog>")[0]!;
  assert.match(spread, /<option value="">auto \(project default\)<\/option>/);
  assert.match(spread, /name="project" required value="spread" data-node="auto" data-branch="main"/, "client.js names no node for a project whose default node is auto");

  await s.call("POST", "/v1/images", image);
  s.registry.images.setCurrentImage(image.id as ImageId);
  const home = (await s.call("GET", "/")).text;
  assert.doesNotMatch(home, /data-autoopen/, "the dialog stays closed until asked for");
  assert.match(textOf(home.split('<dialog id="start-dialog"')[1]!.replace(/^[^>]*>/, "")), /^Start a thread ✕ Worker Claude Code .* Title \(optional\) Project acme /);
  assert.match(home, new RegExp(`<p class="hint" id="start-hint" data-image="${image.id}"></p>`), "client.js writes the hint with the current image");
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
  assert.equal(/placeholder="([^"]*)"/.exec(field("model")!)?.[1], defaultClaudeModel, "the model the loop runs unless named");
  assert.doesNotMatch(field("title")!, /required/, "a Claude worker's title defaults to its prompt's first line");
  const claudeFields = textOf(dialog.split('<div id="start-claude-fields">')[1]!.split("</div>")[0]!);
  assert.equal(claudeFields, "Prompt Runs /poteto-mode with this prompt, as nexus start --claude does. Model (optional) claude-opus-5-5 unless you name another.");
  const harnessFields = dialog.split('<div id="start-harness-fields" hidden>')[1]!.split("</div>")[0]!;
  assert.match(harnessFields, /<input type="checkbox" id="start-planning" name="planning" value="true" disabled> Planning thread/, "the Nexus agent's planning box, sent only once that worker is picked");
});

/** Starts a Claude worker thread whose launch opened session s1, and stores these entries as its transcript's last read. */
async function claudeThread(s: Awaited<ReturnType<typeof seeded>>, entries: ClaudeEntry[], readAt = Date.now()): Promise<Thread> {
  const res = await s.call("POST", "/v1/threads", { project: "acme", title: "Count lines", claude: "count the lines" });
  assert.equal(res.status, 201, res.text);
  const thread = JSON.parse(res.text) as Thread;
  claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
  assert.ok(s.registry.threads.appendClaudeRead(thread.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt }));
  return thread;
}

test("a Claude worker's page stream names one view for one conversation, and another for any other entry", async (t) => {
  const s = await seeded(t);
  const thread = await claudeThread(s, []);
  const reply = (text: string): ClaudeEntry => ({ kind: "reply", at: 1, text });
  const view = (entries: ClaudeEntry[]): ClaudeConversation => ({ kind: "claude", session: "s1", entries, dropped: 0, readAt: 1, working: false, usageLimit: null });
  const shows = (entries: ClaudeEntry[]) => (liveFrames(thread, null, itemsWith(thread.id))(view(entries)) as { shows: string }).shows;
  assert.equal(shows([reply("A"), reply("Z")]), shows([reply("A"), reply("Z")]), "the same entries in another array");
  assert.notEqual(shows([reply("A"), reply("Z")]), shows([reply("B"), reply("Z")]), "a replaced transcript that ends as the old one did");
  const frames = liveFrames(thread, null, itemsWith(thread.id));
  const first = frames(view([reply("A")])) as { convo: string; shows: string };
  const named = frames({ ...view([reply("A")]), working: true });
  assert.deepEqual(Object.keys(named ?? {}), ["shows"], "a view whose region reads as before gets a frame of its name alone");
  assert.notEqual((named as { shows: string }).shows, first.shows);
  assert.equal(frames({ ...view([reply("A")]), working: true }), null, "and a view named before gets none");
});

test("the page streams of one thread render each view once between them, and the last to leave drops the render", async (t) => {
  const s = await seeded(t);
  const thread = await claudeThread(s, []);
  const view = (text: string): ClaudeConversation => ({ kind: "claude", session: "s1", entries: [{ kind: "reply", at: 1, text }], dropped: 0, readAt: 1, working: false, usageLimit: null });
  let renders = 0;
  const reader = liveStreams();
  const join = () => reader(thread, null, (view) => { renders++; return itemsWith(thread.id)(view); });
  const [a, b] = [join(), join()];
  const first = view("A");
  assert.deepEqual(a.frames(first), b.frames(first));
  assert.equal(renders, 1, "the second reader's frame reuses the first's render");
  const next = view("B");
  const frame = a.frames(next);
  assert.deepEqual(b.frames(next), frame);
  assert.ok(frame !== null && "convo" in frame && frame.convo.includes("B"));
  assert.equal(renders, 2);
  a.leave();
  b.frames(view("C"));
  assert.equal(renders, 3, "a reader that stays renders on its own");
  b.leave();
  const c = join();
  c.frames(next);
  assert.equal(renders, 4, "once every reader left, a new one renders afresh rather than reusing a dropped render");
});

test("an age reads as just now under 45 seconds, then in minutes, hours and days", () => {
  const at = Date.parse("2026-10-27T12:00:00Z");
  const ages = [0, 44_499, 44_500, 89_000, 44 * 60_000 + 29_000, 44 * 60_000 + 30_000, 45 * 60_000, 36 * 3_600_000 - 1_000, 36 * 3_600_000, 30 * 86_400_000]
    .map((after) => agoText(at, at + after));
  assert.deepEqual(ages, ["just now", "just now", "1 min ago", "1 min ago", "44 min ago", "45 min ago", "1 h ago", "36 h ago", "2 d ago", "30 d ago"]);
});

test("a run's length reads as a clock across the minute and the hour", () => {
  assert.deepEqual([0, 999, 59_999, 60_000, 61_000, 3_599_999, 3_600_000, 3_660_000, 25 * 3_600_000].map(clock),
    ["0s", "0s", "59s", "1m 00s", "1m 01s", "59m 59s", "1h 00m", "1h 01m", "25h 00m"]);
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
  assert.match(html, /<div class="msg user" data-at="1">/, "a prompt carries its time, which the page titles in the reader's zone");
  assert.match(html, /<div class="msg agent" data-at="8"><div class="text"><p>Counting with/, "so does Claude's reply");
  const { rows, open, dock } = conversationOf(html);
  assert.deepEqual(rows, [
    "You Write hello.py, then count its lines",
    "Changed a file, ran a command, ran a subagent 1 failed 3 calls ›",
    '✓ Write /repo/hello.py +1 −0 1 ms › /repo/hello.py + print("hi")',
    "✕ Bash false 1 line exit 1 1 ms › false Exit code 1",
    '✓ Agent Count lines 1 line 1 ms › Count lines Count the lines of hello.py { "subagent_type": "general-purpose" } Started in the background Background task completed: Agent "Count lines" finished It has 1 line.',
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
  assert.match(html, /<form id="prompt" class="composer composer-send" data-thread="[^"]+" data-claude>/);
  assert.match(html, /placeholder="Message Claude…"/);
  assert.equal(dock, `Idle nexus attach ${thread.id} Copy The pylon is not running, so the transcript is as of its last read, just now . Sending a message wakes it and resumes Claude. claude-opus-5-5 Send ⌘↵ Ctrl+↵`);
  assert.match(html, new RegExp(`data-stream="/threads/${thread.id}/stream"`));
});

test("a pull request Claude opened shows once, as a link to it, however often its transcript names it, and one of another repository is no Nexus note", async (t) => {
  const s = await seeded(t);
  s.registry.projects.editProject("acme" as ProjectId, (p) => ({ ...p, repoUrl: "git@github.com:acme/shop.git" }));
  const url = "https://github.com/acme/shop/pull/7";
  const thread = await claudeThread(s, [
    { kind: "pull-request", at: 1, number: 7, url, repository: "acme/shop" },
    { kind: "reply", at: 2, text: "Opened it." },
    { kind: "pull-request", at: 3, number: 7, url, repository: "acme/shop" },
    { kind: "pull-request", at: 4, number: 8, url: "https://github.com/acme/shop/pull/8", repository: "acme/shop" },
    { kind: "pull-request", at: 5, number: 9, url: "https://evil.example/login", repository: "acme/shop" },
  ]);
  const html = (await s.call("GET", `/threads/${thread.id}`)).text;
  assert.deepEqual(conversationOf(html).rows, ["Opened pull request #7 ↗", "Opened it.", "Opened pull request #8 ↗", "! Claude Code wrote a pr-link record: a pull request link that is not of the project's repository"]);
  assert.ok(html.includes(`<a class="link" href="${url}" target="_blank" rel="noopener">Opened pull request #7 ↗</a>`));
  assert.ok(!html.includes("evil.example"), "a link of another repository shows nowhere");
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
  s.registry.threads.reportSession(node, { sequence: 1, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "s1" } });

  const html = (await s.call("GET", `/threads/${thread.id}`)).text;
  assert.match(html, /<span data-pylon="running" data-turn="true" /, "the client reads the checkout's changes once the turn ends, not on each of its heartbeats");
  const { rows, dock } = conversationOf(html);
  assert.deepEqual(rows, [
    "You Earlier",
    "– Bash sleep 1 › sleep 1 No output.",
    "Worked for 1s.",
    "You Run the tests",
    "Slash command /compact",
    "Bash npm test › npm test No output yet.",
  ], "only a call of the running turn runs");
  assert.match(dock, new RegExp(`^Claude is working 0s · 1 tool this turn Interrupt nexus attach ${thread.id} Copy claude-opus-5-5 Claude takes it at its next step\\. Steer ⌘↵ Ctrl\\+↵$`),
    "the turn is timed from when control heard it start, and Interrupt stops it");
  const since = s.registry.threads.thread(thread.id)!.workingSince;
  assert.equal(html.split(`<time data-since="${since}">`).length - 1, 4, "the run bar, the sidebar row, the inspector and the timeline tick the same clock");
  assert.match(html, new RegExp(`<div class="state-bar state-working" id="agent-state" data-state="working" role="status">.*<span aria-hidden="true"><time data-since="${since}">`), "the run bar announces its state, and not its clock each second");
  assert.match(html, new RegExp(`<button [^>]*data-action="abort" data-thread="${thread.id}"[^>]*>Interrupt</button>`), "Interrupt takes the abort route, which presses Esc in Claude's terminal");
  assert.match(html, /placeholder="Steer the run…"/);
  assert.doesNotMatch(html, /id="queue"/, "Claude takes a message at its next step whatever its mode, so nothing queues after the turn");
  s.registry.threads.reportSession(node, { sequence: 2, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.waiting", session: "s1", message: "Claude needs your permission to use Bash" } });
  assert.doesNotMatch((await s.call("GET", `/threads/${thread.id}`)).text, />Interrupt</, "a dialog outranks the turn, and Esc would cancel it");
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
    "Changed 2 files, ran 3 commands, ran 2 subagents, used 5 other tools 14 calls ›",
    "Read 2 files, searched the code 2 times, searched the web 6 calls ›",
  ]);
  assert.ok(rows.includes("! Interrupted"), "the interrupt stays between the two folds");
});

test("a real Claude Code transcript's calls read as one line each: the tool, the subject relative to the checkout, how it went and how long it took", async (t) => {
  const s = await seeded(t);
  const fixture = await readFile(new URL("../../fixtures/claude-transcript.jsonl", import.meta.url), "utf8");
  const thread = await claudeThread(s, fixture.split("\n").filter((line) => line !== "").flatMap((line) => parseRecord(line)));
  const html = (await s.call("GET", `/threads/${thread.id}`)).text;
  const { rows } = conversationOf(html);
  assert.ok(rows.includes("Changed a file, ran 3 commands, ran a subagent 2 failed 5 calls ›"));
  assert.deepEqual(toolLines(rows), [
    "✓ Write hello.py +1 −0 109 ms",
    "✓ Bash python3 hello.py 1 line 118 ms",
    "✕ Bash false 1 line exit 1 24 ms",
    "✓ Agent Count lines in hello.py 1 line 106 ms",
    "✕ Bash sleep 40 1 line failed 12 ms",
    "✓ tool 1 line",
    "✓ Shell echo bang-mode 1 line 22 ms",
    "✕ tool 1 line failed",
    "✓ notes checkpoint/session-state.md 1 line 33 ms",
  ], "a result whose call the transcript does not hold shows as a bare tool");
  assert.match(html, /<span class="t-name" title="mcp__notes-compaction__notes">notes<\/span>/);
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
  const chunk = (await readdir(bundle)).find((file) => file.endsWith(".js") && file !== "client.js");
  assert.ok(chunk !== undefined, "the bundle has a chunk besides client.js");
  const served = await s.call("GET", `/assets/${chunk}`);
  assert.equal(served.status, 200);
  assert.ok((served.headers["content-type"] as string).startsWith("text/javascript"), "a chunk is served as JavaScript");
  assert.match(served.headers["cache-control"] as string, /immutable/, "a chunk's name has its hash, so it is cached for good");
  for (const name of ["secret.txt", "metafile.json", "notifications.js", "chunk-NOSUCH.js", "..%2Fpackage.json"]) assert.equal((await s.call("GET", `/assets/${name}`)).status, 404, name);
});

test("pages are served under a content security policy that allows only the dashboard's own origin and the page's one inline script", async (t) => {
  const s = await setup(t);
  const page = await s.call("GET", "/");
  const inline = [...page.text.matchAll(/<script>([^<]*)<\/script>/g)].map(([, script]) => script!);
  assert.equal(inline.length, 1, "the head script that applies the theme is the page's one inline script");
  assert.equal(page.headers["content-security-policy"],
    `default-src 'none'; style-src 'self'; script-src 'self' 'sha256-${createHash("sha256").update(inline[0]!).digest("base64")}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
});

test("dashboard pages answer only allowed callers under the API's own names", async (t) => {
  const s = await setup(t);
  s.callAs("nSTRANGER" as TailnetNodeId);
  assert.equal((await s.call("GET", "/")).status, 403);
  s.callAs(laptop);
  assert.equal((await s.call("GET", "/", undefined, { host: "evil.example" })).status, 403);
  assert.equal((await s.call("GET", "/")).status, 200);
  // Pages are read-only. Only the JSON API changes state.
  assert.equal((await s.call("POST", "/threads/new", {})).status, 405);
});

test("a job in flight shows on the thread page as its transition", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.threads.apply({ record: "job", status: { jobId: "job-1" as JobId, subject: fix.pylonId, kind: "pause", state: "running", startedAt: new Date().toISOString() } });
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(textOf(sectionOf(page, "pylon-h")), /Observed pausing/);
  assert.deepEqual(sidebarOf(page).rows, ["pausing Fix checkout now"]);
});

test("a page's rendered reply marker cannot advance while its conversation is being read", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Old conversation");
  s.registry.threads.recordReply(fix.id, 1000);
  const watch = s.fake.harness.watch;
  s.fake.harness.watch = async (id) => {
    const view = await watch(id);
    s.registry.threads.recordReply(fix.id, 2000);
    return view;
  };
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.match(html, /id="convo" data-rendered-reply-at="1000"/);
  assert.equal(s.registry.threads.thread(fix.id)!.lastReplyAt, 2000);
  await s.call("POST", `/v1/threads/${fix.id}/seen`, { lastReplyAt: 1000 });
  const detail = JSON.parse((await s.call("GET", `/v1/threads/${fix.id}`)).text);
  assert.equal(detail.attention, "reply");
});

test("PR outputs show GitHub metadata and automated entries are not labelled as the person", async (t) => {
  const s = await seeded(t);
  const thread = await s.start("acme", "Review");
  const pr = testPr({ number: 42, title: "Fix <checkout>", state: "merged", checks: "passing", review: "approved" });
  s.registry.prWatches.savePrWatch(thread.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  s.fake.transcript(thread.id).entries = [{ id: 1, conversationId: 1, kind: "nexus.pr-watch", data: { sender: "Nexus PR watch" }, model: [{ role: "user", content: "Automated feedback", timestamp: 0 }] },
    { id: 2, conversationId: 1, kind: "nexus.nudge", data: { sender: "Nexus nudge" }, model: [{ role: "user", content: "Open a pull request", timestamp: 0 }] }] as never;
  const page = (await s.call("GET", `/threads/${thread.id}`)).text;
  const outputs = sectionOf(page, "outputs-h");
  assert.match(textOf(outputs), /PR #42: Fix <checkout> — merged, checks passing, review approved/);
  assert.ok(outputs.includes(`href="${pr.url}"`));
  assert.ok(outputs.includes("Fix &lt;checkout&gt;"));
  assert.equal((outputs.match(/PR watch: off/g) ?? []).length, 1);
  assert.match(conversationOf(page).text, /Nexus PR watch Automated feedback/);
  assert.match(conversationOf(page).text, /Nexus nudge Open a pull request/);
  const detail = JSON.parse((await s.call("GET", `/v1/threads/${thread.id}`)).text);
  assert.deepEqual(detail.pullRequests, [pr]);
  assert.ok(detail.outputs.some((o: { kind: string; ref: string }) => o.kind === "pull-request" && o.ref === pr.url));
});

test("a Claude worker's prompt is Nexus's only when Nexus typed it, the usage limit's continue too, and one the person typed like Nexus's is theirs", async (t) => {
  const s = await seeded(t);
  const continued = `${senders["usage-limit"].prefix} The usage limit reset. Continue where you stopped.`;
  const theirs = "[Nexus review] got this wrong, so leave the cache as it is.";
  const entries: ClaudeEntry[] = [{ kind: "prompt", at: 1, text: continued, from: "person" }, { kind: "prompt", at: 2, text: theirs, from: "person" }];
  const thread = await claudeThread(s, entries);
  const typed = await typeIntoClaude(s.registry, thread.id, "s1", null, "usage-limit:s1:1", continued, async () => ({ kind: "send-claude", outcome: "sent", terminal: "w1:p1", resumed: false }), "usage-limit");
  assert.equal(typed.kind, "sent");
  const rows = conversationOf((await s.call("GET", `/threads/${thread.id}`)).text).rows;
  assert.ok(rows.includes(`Nexus usage limit ${continued}`), rows.join("\n"));
  assert.ok(rows.includes(`You ${theirs}`), rows.join("\n"));
  const frame = liveFrames(thread, null, itemsWith(thread.id, () => [], () => promptSenders(s.registry, thread.id)))({ kind: "claude", session: "s1", entries, dropped: 0, readAt: 1, working: false, usageLimit: null });
  assert.deepEqual(conversationOf(`id="convo"${(frame as { convo: string }).convo}<div class="dock"></main>`).rows, rows, "the page's stream names them as the page does");
});

test("a failed Claude worker's dashboard agrees with its registry event and API detail", async (t) => {
  const s = await seeded(t);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "worker", claude: "fix it", model: "custom-model" });
  const id = JSON.parse(started.text).id;
  const message = "Claude launch did not complete: executable missing";
  claudeWorkerAt(s.registry, id, "failed", { message });
  const detail = JSON.parse((await s.call("GET", `/v1/threads/${id}`)).text);
  assert.deepEqual(detail.claudeWorker, { state: "failed", model: "custom-model", message });
  assert.equal(detail.attention, "failed");
  assert.deepEqual(detail.sessions, []);
  const page = textOf((await s.call("GET", `/threads/${id}`)).text);
  assert.ok(page.includes("Claude worker failed · custom-model"));
  assert.ok(page.includes(message));
  assert.equal(s.registry.threads.events().filter((e) => e.kind === "thread.failed").at(-1)?.payload.message, detail.claudeWorker.message);
});

test("a Claude worker stopped on its usage limit shows the stop and when the limit resets", async (t) => {
  const s = await seeded(t);
  const id = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "worker", claude: "fix it" })).text).id;
  claudeWorkerAt(s.registry, id, "started", { session: "s1" });
  const resetsAt = Date.now() + 3_600_000;
  const entries: ClaudeEntry[] = [{ kind: "notice", at: Date.now(), tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt } }];
  assert.ok(s.registry.threads.appendClaudeRead(id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now() }));
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
  s.registry.prWatches.savePrWatch(fix.id, { links: [{ pr: { repo: "acme/acme", number: 3, title: "Fix", url: "", state: "open", checks: "none", review: "none", conflict: null }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
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
  assert.match(page.text, new RegExp(`id="archive" data-action="archive" data-thread="${stuck.id}">Cancel</button>`), "archiving a queued thread cancels it, so its button says so");
  const body = textOf(page.text.split('id="queued"')[1]!.split('<div class="dock">')[0]!);
  assert.match(body, /Starts once these threads' pull requests merge blocked Spike : is archived and its pull request did not merge/, "each wait links its predecessor");
  assert.match(body, /Prompt Do it Worker Claude Code · claude-opus-5-5 Node auto Size 2 CPUs, 4 GiB memory, 10 GiB disk/);
  assert.doesNotMatch(page.text, /data-activity=/, "a queued thread's page counts no visit, as it has no pylon to wake");
  assert.match(textOf((await s.call("GET", `/threads/${next.id}`)).text), /queued .*Fix checkout : PR #3 is open .*Message Fix the next bug\./);

  assert.equal((await s.call("POST", `/v1/threads/${stuck.id}/archive`)).status, 200);
  const cancelled = (await s.call("GET", `/threads/${stuck.id}`)).text;
  assert.match(cancelled, /<span class="chip-label">cancelled<\/span>/);
  assert.match(cancelled, new RegExp(`id="unarchive" data-action="unarchive" data-thread="${stuck.id}">Queue again</button>`));
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
  s.registry.usage.recordUsage(fix.id, [
    usageCall("claude:m1", "claude", "claude-opus-5-5", now - hour, [1_200, 300, 50_000, 1_250_000]),
    usageCall("claude:m2", "claude", "claude-opus-5-5", now - 2 * day, [800, 700, 0, 0]),
  ]);
  s.registry.usage.recordUsage(docs.id, [
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
  for (const thread of [old, gone]) s.registry.threads.setThreadStatus(thread.id, "archived");
  const note = async () => {
    const m = /<div id="usage-backfill" ([^>]*)>([^]*?)<\/div>/.exec((await s.call("GET", "/usage")).text);
    assert.ok(m !== null, "the backfill note is on the page");
    return { attributes: m[1]!, text: textOf(m[2]!), html: m[2]! };
  };
  const never = await note();
  assert.equal(never.attributes, 'data-backfill-state="never"');
  assert.equal(never.text, "The calls archived threads made before then are counted once a deployer runs nexus usage backfill , which wakes their pylons one at a time to read them.");

  s.registry.usage.startUsageBackfill([old.id, gone.id], Date.now());
  s.registry.usage.waitUsageBackfill("rj-firebat is busy with a job");
  const waiting = await note();
  assert.equal(waiting.attributes, 'data-backfill-state="running" data-read="0" data-of="2" data-recovered-calls="0" data-recovered-tokens="0"');
  assert.equal(waiting.text, "The backfill reads archived threads' pylons, one at a time: 0 of 2 threads read, 0 calls and 0 tokens recovered so far. It waits: rj-firebat is busy with a job.");
  s.registry.usage.holdUsageBackfill(old.id, Date.now());
  assert.ok((await note()).html.includes(`It reads <a class="link" href="/threads/${old.id}">Old work</a>.`));
  assert.match(textOf((await s.call("GET", `/threads/${old.id}`)).text), /Desired reading/, "the thread's pylon wants to run for reading");
  s.registry.usage.recordUsage(old.id, Array.from({ length: 1234 }, (_, i) => ({ id: `claude:msg_${i}`, agent: "claude" as const, model: "claude-opus-5-5", at: 1_000, input: i === 0 ? 5_600_000 - 1233 : 1, output: 0, cacheWrite: 0, cacheRead: 0 })), [], true);
  s.registry.usage.finishUsageBackfillThread(old.id, "done", null, Date.now());
  assert.equal((await note()).text, "The backfill reads archived threads' pylons, one at a time: 1 of 2 threads read, 1,234 calls and 5.6M tokens recovered so far. It waits for the pylon of Old work to pause.");
  s.registry.usage.stopUsageBackfill(Date.now());
  assert.equal((await note()).text, "The backfill stopped at 1 of 2 threads read, with 1,234 calls and 5.6M tokens recovered. A deployer goes on with nexus usage backfill .");

  s.registry.usage.startUsageBackfill([gone.id], Date.now());
  s.registry.usage.finishUsageBackfillThread(gone.id, "skipped", "rj-firebat holds no disk for its pylon", Date.now());
  s.registry.usage.finishUsageBackfill(Date.parse("2027-03-10T12:00:00Z"));
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
  s.registry.usage.recordUsage(fix.id, [
    usageCall("claude:m1", "claude", "claude-opus-5-5", Date.now() - 40 * day, [300_000, 20_000, 100_000, 800_000]),
    usageCall("claude:m2", "claude", "claude-opus-5-5", Date.now(), [1_000, 500, 0, 0]),
  ]);
  s.registry.usage.recordUsage(other.id, [usageCall("claude:m3", "claude", "claude-opus-5-5", Date.now(), [9_000_000, 0, 0, 0])]);
  assert.deepEqual(await tokens(), [1_221_500, "1.2M (in 301k · out 20.5k · cache write 100k · cache read 800k)"], "every call of the thread, however old, and no other thread's");
});

test("a harness, a Claude worker and a bare thread each show the conversation, stream and composer of their kind", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await seeded(t);
  const harness = await s.start("acme", "Harness");
  const claude = await claudeThread(s, [{ kind: "reply", at: 1, text: "Done." }]);
  const bare = await s.startThread({ request: { project: "acme", title: "Check" }, caller: laptop, role: "check" });
  s.observe(harness, claude, bare);
  /** What the thread page shows of its agent: the conversation region's stream, its text, the run bar and the composer. */
  const agentParts = async (thread: Thread) => {
    const html = (await s.call("GET", `/threads/${thread.id}`)).text;
    const convo = html.split('id="convo"')[1]!;
    return {
      stream: /^[^>]*data-stream="([^"]*)"/.exec(convo)?.[1]?.replace(thread.id, "<id>") ?? null,
      convo: textOf(convo.split('<button type="button" class="btn btn-xs jump-end"')[0]!.replace(/^[^>]*>/, "")).replace(thread.id, "<id>"),
      run: textOf(html.split('<div id="run" data-live>')[1]!.split('<div id="composer"')[0]!).replace(thread.id, "<id>"),
      composer: /<div id="composer" data-live>\s*(<[^/>][^>]*>)?/.exec(html)?.[1] ?? null,
    };
  };
  assert.deepEqual(await agentParts(harness), {
    stream: "/threads/<id>/stream", convo: "<id> · started just now No messages yet.", run: "Idle nexus attach <id> Copy",
    composer: `<form id="prompt" class="composer composer-send" data-thread="${harness.id}">`,
  });
  assert.deepEqual(await agentParts(claude), {
    stream: "/threads/<id>/stream", convo: "<id> · started just now · Claude Code · claude-opus-5-5 Done.", run: "Idle nexus attach <id> Copy",
    composer: `<form id="prompt" class="composer composer-send" data-thread="${claude.id}" data-claude>`,
  });
  assert.deepEqual(await agentParts(bare), { stream: null, convo: "<id> · started just now This thread has no agent conversation.", run: "Idle nexus attach <id> Copy", composer: null }, "a bare thread has no agent to message, but a terminal");

  s.fake.transcript(harness.id).docs["pi.live"] = { run: { taskId: 1, inputs: [] } };
  s.registry.threads.reportSession(node, { sequence: 1, pylon: claude.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "s1", at: Date.now() } });
  assert.equal((await agentParts(harness)).run, "Working 0 tools this turn Abort nexus attach <id> Copy");
  assert.equal((await agentParts(claude)).run, "Claude is working 0s · 0 tools this turn Interrupt nexus attach <id> Copy");
  for (const thread of [harness, claude, bare]) assert.equal((await s.call("DELETE", `/v1/threads/${thread.id}`)).status, 200);
  for (const thread of [harness, claude, bare]) {
    // A Claude worker's model comes from its worker, which outlives the delete.
    const model = thread === claude ? " · claude-opus-5-5" : "";
    assert.deepEqual(await agentParts(thread), { stream: null, convo: `<id> · started just now${model} The thread is deleted, so its conversation is gone.`, run: "", composer: null }, thread.title);
  }
});

test("the side nodes mark a node with a low filesystem, and its page lists each filesystem with its paths", async (t) => {
  const disks = [
    { paths: ["/var/lib/nexus/pylons", "/var/lib/nexus/artifacts"], totalGiB: 100, freeGiB: 15, pylons: true as const },
    { paths: ["/opt/nexus/releases"], totalGiB: 500, freeGiB: 400 },
  ];
  const health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: null, memory: null, disk: { path: "/var/lib/nexus/pylons", totalGiB: 100, freeGiB: 15 }, disks, temperatures: null, pylons: [],
  };
  const probe = { command: () => Promise.reject(new Error("unused")), stream: () => Promise.reject(new Error("unused")), health: async () => health };
  const s = await seeded(t, { ...landingOptions(), probes: new Map([[node, probe]]) });
  const capacity = testCapacity({ diskFreeGiB: 15, disks });
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  const nodes = (await nodeHeads(s));
  assert.match(nodes, /<em title="15\.0 of 100\.0 GiB free at \/var\/lib\/nexus\/pylons, \/var\/lib\/nexus\/artifacts, low">disk low<\/em>/);
  const text = textOf((await s.call("GET", `/nodes/${node}`)).text.split('id="node-health"')[1]!);
  assert.ok(text.includes("Disk 15 of 100 GiB free at /var/lib/nexus/pylons , /var/lib/nexus/artifacts low 400 of 500 GiB free at /opt/nexus/releases Temperatures"), text);
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity({ disks: [{ ...disks[0]!, freeGiB: 20 }] }) });
  assert.doesNotMatch((await nodeHeads(s)), /disk low/, "20 GiB of 100 is not low");
});

test("a node's page shows its health as its probe reads it, unknown where the host exposes nothing, and only to a deployer", async (t) => {
  let health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
    memory: { totalGiB: 62.8, availableGiB: 40.24, swapTotalGiB: 0, swapFreeGiB: 0 }, disk: { path: "/var/lib/nexus", totalGiB: 457.1, freeGiB: 180.33 },
    temperatures: null, pylons: [],
  };
  const probe = { command: () => Promise.reject(new Error("unused")), stream: () => Promise.reject(new Error("unused")), health: async () => health };
  const s = await seeded(t, { ...landingOptions(), probes: new Map([[node, probe]]) });
  const started = await s.start("acme", "Busy thread");
  assert.match((await nodeHeads(s)), /<a class="link" href="\/nodes\/rj-firebat"/, "the Cluster page's card for the node links its page");
  health = { ...health, pylons: [{ pylonId: started.pylonId, processes: 2, cpuPercent: 112.46, residentGiB: 6.25 }, { pylonId: "pylon-orphan" as PylonId, processes: 1, cpuPercent: 0, residentGiB: 0.1 }] };
  const page = await s.call("GET", `/nodes/${node}`);
  assert.equal(page.status, 200);
  const text = textOf(page.text.split('id="node-health"')[1]!);
  for (const shown of ["2.50 · 1.75 · 1.00 over 1, 5 and 15 minutes, on 16 CPUs", "40.2 of 62.8 GiB available", "Swap none", "180.3 of 457.1 GiB free at /var/lib/nexus", "Temperatures unknown", `${started.pylonId} Busy thread 2 112.5% 6.3 GiB`, "pylon-orphan pylon-orphan, not in the registry 1 0.0% 0.1 GiB"]) {
    assert.ok(text.includes(shown), `${shown} in: ${text}`);
  }
  s.callAs(phone);
  assert.match(textOf((await s.call("GET", `/nodes/${node}`)).text.split('id="node-health"')[1]!), /caller may not read a node's health: only deployers may/);
  s.callAs(laptop);
  assert.equal((await s.call("GET", "/nodes/nowhere")).status, 404);
});

test("a node's page frames its graphs outside the live region, with a range picker, a figure per chart and the sample the registry recorded of the read, even when the read fails", async (t) => {
  let health: NodeHealth | Error = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
    memory: { totalGiB: 62.8, availableGiB: 40.25, swapTotalGiB: 8, swapFreeGiB: 6 }, disk: { path: "/var/lib/nexus", totalGiB: 457, freeGiB: 180.5 },
    temperatures: [{ sensor: "Composite", celsius: 41 }, { sensor: "Composite", celsius: 39.5 }], pylons: [],
  };
  let record = (_: NodeHealth) => {};
  // As main.ts wraps every probe client.
  const probe = recordingHealth({ command: () => Promise.reject(new Error("unused")), stream: () => Promise.reject(new Error("unused")), health: async () => { if (health instanceof Error) throw health; return health; } }, (h) => record(h), () => {});
  const s = await seeded(t, { ...landingOptions(), probes: new Map([[node, probe]]) });
  record = (h) => s.registry.nodeMetrics.recordHealthSample(node, sampleOf(h, Date.now(), (p) => s.registry.threads.pylon(p)?.thread ?? null));
  const started = await s.start("acme", "Busy thread");
  health = { ...health, pylons: [{ pylonId: started.pylonId, processes: 2, cpuPercent: 112.5, residentGiB: 6.25 }, { pylonId: "pylon-orphan" as PylonId, processes: 1, cpuPercent: 0, residentGiB: 0.1 }] };
  const before = Date.now();
  const html = (await s.call("GET", `/nodes/${node}`)).text;
  const graphs = /<section id="node-graphs"[^>]*>/.exec(html)?.[0];
  assert.ok(graphs !== undefined, "the page has a graphs section");
  assert.match(graphs, new RegExp(`data-node="${node}"`));
  const region = html.slice(html.indexOf('id="node-health"'), html.indexOf('<section id="node-graphs"'));
  assert.ok(region.split("</div>").length > region.split("<div").length, "the live region closes before the graphs begin, so a poll's swap leaves them be");
  assert.deepEqual([...html.matchAll(/<button type="button" data-range="([^"]+)" aria-pressed="false">/g)].map((m) => m[1]), ["15m", "1h", "6h", "24h", "7d", "30d"]);
  assert.deepEqual([...html.matchAll(/<figure class="graph" data-chart="[^"]+"><figcaption><span class="graph-title">([^<]+)/g)].map((m) => m[1]),
    ["Load per CPU", "Load against CPUs", "Memory", "Swap", "Disk free", "Temperatures", "Pylon CPU", "Pylon memory"]);
  const sample = JSON.parse(textOf(/data-sample="([^"]*)"/.exec(region)![1]!)) as { at: number; values: Record<string, number>; labels: Record<string, string> };
  assert.ok(sample.at >= before && sample.at <= Date.now(), "the sample is timed by the control plane's clock");
  assert.deepEqual({ at: sample.at, values: sample.values }, s.registry.nodeMetrics.latestHealthSample(node), "the page carries what the registry recorded");
  const busy = `${started.pylonId}:${started.id}`;
  assert.deepEqual(sample.values, {
    cpus: 16, diskTotal: 457, diskFree: 180.5, load1: 2.5, load5: 1.75, load15: 1, memTotal: 62.8, memAvailable: 40.25, swapTotal: 8, swapUsed: 2,
    "temp:Composite": 41, "temp:Composite (2)": 39.5,
    [`pylonCpu:${busy}`]: 112.5, [`pylonResident:${busy}`]: 6.25, "pylonCpu:pylon-orphan:": 0, "pylonResident:pylon-orphan:": 0.1,
  });
  assert.deepEqual(sample.labels, { [`pylonCpu:${busy}`]: "Busy thread", [`pylonResident:${busy}`]: "Busy thread", "pylonCpu:pylon-orphan:": "pylon-orphan", "pylonResident:pylon-orphan:": "pylon-orphan" });
  const soon = (await s.call("GET", `/nodes/${node}`)).text;
  assert.equal(JSON.parse(textOf(/data-sample="([^"]*)"/.exec(soon)![1]!)).at, sample.at, "a read too soon after the last to be recorded carries the recorded one, which the graphs already hold");
  health = new Error("the probe did not answer");
  const failed = (await s.call("GET", `/nodes/${node}`)).text;
  assert.match(failed, /<section id="node-graphs"/, "history still shows when this read fails");
  assert.doesNotMatch(failed, /data-sample=/);
});

test("the work in flight lists each item at its phase, an item held for the person is in Needs you with Approve and Cancel, its card says what it is after, and no page links /pipeline", async (t) => {
  const s = await seeded(t, { deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set(), keys: {} } });
  assert.doesNotMatch((await s.call("GET", "/")).text, /href="\/pipeline"/, "no page links it");
  s.registry.projects.editProject("acme" as ProjectId, (p) => ({ ...p, pipeline: { autoStart: false } }));
  const add = async (title: string, after: string[] = []) => {
    const res = await s.call("POST", "/v1/items", { project: "acme", title, message: `Build ${title}.`, after });
    assert.equal(res.status, 201, res.text);
    return JSON.parse(res.text) as PipelineItem;
  };
  const a = await add("Greet by name");
  const b = await add("Greet in French", [a.id]);
  const c = await add("Greet in Dutch", [b.id]);
  assert.equal((await s.call("POST", `/v1/items/${a.id}/approve`, {})).status, 200);
  const thread = itemThread(s.registry, a.id)!;
  const page = (await s.call("GET", "/")).text;
  const flight = page.split('id="flight"')[1]!.split('id="overview"')[0]!;
  const phaseOf = (key: string) => /<section class="phase[^"]*" id="phase-(\w+)"/.exec(flight.slice(0, flight.indexOf(`data-peek="${key}"`)).split("</section>").at(-1)!)?.[1];
  assert.equal(phaseOf(c.id), "planned", "an item waiting for the one it is after is planned");
  assert.match(flight, new RegExp(`<a class="fl-row" href="/\\?peek=${c.id}" data-peek="${c.id}">`));
  assert.match(flight, new RegExp(`data-peek="${c.id}">.*?<span class="fl-why" title="([^"]+)">\\1</span>`), "a line's why, which the stack cuts, is whole on hover");
  assert.match(phaseOf(thread) ?? "", /^(queued|building)$/, "an item that became a thread shows as its thread");
  assert.doesNotMatch(flight, new RegExp(`data-peek="${a.id}"`), "nor as itself");
  assert.match(flight, new RegExp(`<a class="fl-row" href="/\\?peek=${b.id}" data-peek="${b.id}">.*<span class="tag tag-bad">needs you</span>`), "held work is in Needs you, and its line leads to its card");
  assert.equal(phaseOf(b.id), "planned");
  const needs = page.split('id="needs-you"')[1]!.split('id="peek"')[0]!;
  const card = needs.split(`id="need-${b.id}"`)[1]!.split("</article>")[0]!;
  assert.equal(textOf(card.replace(/^[^>]*>/, "")), `Approve item acme / Greet in French item project acme waits for the person to approve each item: nexus item approve ${b.id} Planned held for you Queued Building In review Landing Deployed project acme waits for the person to approve each item: nexus item approve ${b.id}. After Greet by name Brief Build Greet in French. Approve Cancel`);
  assert.match(card, new RegExp(`<a class="link" href="/\\?peek=${thread}" data-peek="${thread}">Greet by name</a>`), "what it is after links its preview, as the thread it became");
  assert.match(card, new RegExp(`<button type="button" class="btn btn-xs" data-action="approve-item" data-item="${b.id}">Approve</button>`));
  assert.match(card, new RegExp(`data-action="cancel-item" data-item="${b.id}"`));
  const peek = async (key: string) => (await s.call("GET", `/?peek=${key}`)).text.split('id="peek"')[1]!.split('id="in-flight"')[0]!;
  assert.doesNotMatch(await peek(b.id), /class="peek"/, "held work previews in its card, not beside it");
  assert.match((await s.call("GET", `/?peek=${c.id}`)).text, new RegExp(`<a class="fl-row" href="/\\?peek=${c.id}" data-peek="${c.id}" aria-current="true">`), "the stack marks the line it previews");
  assert.match(await peek(thread), new RegExp(`<a class="btn btn-xs[^"]*" href="/threads/${thread}">Open thread</a>`), "the preview of the item's thread opens its page");
  assert.doesNotMatch(await peek(thread), /data-action="(approve|cancel)-item"/, "an item that is a thread has no item actions");
  assert.doesNotMatch(await peek("it-000000000000"), /class="peek"/, "an unknown key previews nothing");
  assert.match(await peek(a.id), /class="peek"/, "an item that became a thread previews as it");
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-greet", thread, text: "Greet in Welsh too?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: Date.now(), failure: 0 });
  assert.doesNotMatch(await peek(a.id), /class="peek"/, "until that thread waits on the person, whose card says so instead");
});

test("/pipeline sends the reader to the home page's work in flight, where its items show", async (t) => {
  const s = await seeded(t);
  const gone = await s.call("GET", "/pipeline");
  assert.equal(gone.status, 303);
  assert.equal(gone.headers.location, "/#in-flight");
  assert.match((await s.call("GET", "/")).text, /<section class="split-flight" id="in-flight" aria-labelledby="flight-h">/);
});

test("the home page holds two columns, Needs you before the work in flight by phase, and on a phone two tabs with Needs you picked first", async (t) => {
  const s = await seeded(t);
  const page = (await s.call("GET", "/")).text;
  const split = page.split('<div class="split" id="split">')[1]!;
  const needs = split.indexOf('<section class="split-needs" id="needs-you"');
  const flight = split.indexOf('<section class="split-flight" id="in-flight"');
  assert.ok(needs >= 0 && flight > needs, "Needs you comes first, the work in flight after it");
  assert.deepEqual([...split.matchAll(/<section class="phase[^"]*" id="phase-(\w+)"/g)].map((m) => m[1]), ["planned", "queued", "building", "review", "landing", "deployed"], "held work is in Needs you, not a phase");
  const tabs = [...page.matchAll(/<input type="radio" name="home-side" value="(\w+)" id="side-\w+"( checked)?>/g)].map((m) => `${m[1]}${m[2] ?? ""}`);
  assert.deepEqual(tabs, ["needs checked", "flight"]);
});

test("the sidebar's Needs you count, the phone's tab and the list count the same things, work held for approval included", async (t) => {
  const s = await seeded(t);
  s.registry.projects.editProject("acme" as ProjectId, (p) => ({ ...p, pipeline: { autoStart: false } }));
  assert.equal((await s.call("POST", "/v1/items", { project: "acme", title: "Greet by name", message: "Build it.", after: [] })).status, 201);
  const failed = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Port the CLI", claude: "port it" })).text) as Thread;
  claudeWorkerAt(s.registry, failed.id, "failed", { message: "Claude launch did not complete" });
  const page = (await s.call("GET", "/")).text;
  const list = page.split('id="needs-you"')[1]!.split('id="peek"')[0]!;
  assert.deepEqual([...list.matchAll(/<article class="need need-(\w+)"/g)].map((m) => m[1]), ["thread", "held"]);
  assert.match(list, /<h2 id="needs-h">Needs you<\/h2><span class="count">2<\/span>/);
  assert.equal(/<span class="seg-n" id="seg-needs-n" data-live>([^<]*)<\/span>/.exec(page)![1], "2");
  for (const path of ["/", "/usage"]) assert.equal(needsCount((await s.call("GET", path)).text), "2", path);
});

test("/nodes/<name> is the Cluster page with that node picked, and /cluster picks the first", async (t) => {
  const s = await seeded(t, landingOptions());
  const tower = "tower" as NodeName;
  s.registry.nodes.upsertNode({ name: tower, tailnetHost: "tower.tail.ts.net", tailnetNodeId: "nTOWER" as TailnetNodeId });
  const picked = (page: string) => [...page.matchAll(/<article class="node-card( picked)?" data-node="([^"]+)"/g)].map((m) => `${m[2]}${m[1] ?? ""}`);
  const page = await s.call("GET", `/nodes/${tower}`);
  assert.equal(page.status, 200);
  assert.deepEqual(picked(page.text), [node, `${tower} picked`], "every node has its card, and the one named is picked");
  assert.match(page.text, /<h2 class="node-detail-h">tower<\/h2>/);
  assert.match(page.text, /<title>Cluster: tower · Nexus<\/title>/);
  assert.match(page.text, /<a class="side-link active" href="\/cluster" aria-current="page">/);
  assert.deepEqual(picked((await s.call("GET", "/cluster")).text), [`${node} picked`, tower]);
  assert.equal((await s.call("GET", "/nodes/nowhere")).status, 404);
});

test("the Cluster page asks only the picked node's probe, and shows each other node's newest recorded sample", async (t) => {
  const health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
    memory: { totalGiB: 62.8, availableGiB: 40.24, swapTotalGiB: 0, swapFreeGiB: 0 }, disk: { path: "/var/lib/nexus", totalGiB: 457.1, freeGiB: 180.33 },
    temperatures: null, pylons: [],
  };
  const unused = { command: () => Promise.reject(new Error("unused")), stream: () => Promise.reject(new Error("unused")) };
  const asked: string[] = [];
  const tower = "tower" as NodeName;
  const attic = "attic" as NodeName;
  const probes = new Map([node, tower, attic].map((name) => [name, { ...unused, health: async () => { asked.push(name); return health; } }] as const));
  const s = await seeded(t, { ...landingOptions(), probes });
  for (const [name, id] of [[tower, "nTOWER"], [attic, "nATTIC"]] as const) s.registry.nodes.upsertNode({ name, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: id as TailnetNodeId });
  s.registry.nodeMetrics.recordHealthSample(tower, sampleOf({ ...health, cpus: 8, load: { one: 6.25, five: 1, fifteen: 1 } }, Date.now() - 30_000, () => null));
  s.registry.nodeMetrics.recordHealthSample(attic, sampleOf(health, Date.now() - 10 * 60_000, () => null));
  const page = await s.call("GET", `/nodes/${node}`);
  assert.equal(page.status, 200);
  const card = (name: string) => textOf(page.text.split(`data-node="${name}"`)[1]!.split("</article>")[0]!);
  assert.match(card(node), /Load 2\.50 on 16 CPUs Memory 40\.2 of 62\.8 GiB free Disk 180\.3 of 457\.1 GiB free/, "the picked node's card is the read its page made");
  assert.match(card(tower), /Load 6\.25 on 8 CPUs Memory 40\.2 of 62\.8 GiB free/, "another node's card is its newest sample");
  assert.match(card(attic), /Load no reading in 5 minutes/, "a sample older than 5 minutes is not shown");
  assert.deepEqual(asked, [node], "only the picked node's probe is asked");
});

test("a node card says why it has no reading: its probe failed, or the caller may not read a node's health", async (t) => {
  const unused = { command: () => Promise.reject(new Error("unused")), stream: () => Promise.reject(new Error("unused")) };
  const tower = "tower" as NodeName;
  const probes = new Map([node, tower].map((name) => [name, { ...unused, health: () => Promise.reject(new Error(`${name} is unreachable`)) }] as const));
  const s = await seeded(t, { ...landingOptions(), probes });
  s.registry.nodes.upsertNode({ name: tower, tailnetHost: "tower.tail.ts.net", tailnetNodeId: "nTOWER" as TailnetNodeId });
  const load = (page: string, name: string) => /<dt>Load<\/dt><dd>[\s\S]*?<span class="meter-words">([\s\S]*?)<\/span><\/dd>/.exec(page.split(`data-node="${name}"`)[1]!)![1]!;
  const failed = (await s.call("GET", `/nodes/${node}`)).text;
  assert.equal(load(failed, node), `<span class="dim" title="${node} is unreachable">not read</span>`, "a failed read names its error");
  assert.equal(load(failed, tower), `<span class="dim">no reading in 5 minutes</span>`);
  s.callAs(phone);
  const refused = (await s.call("GET", `/nodes/${node}`)).text;
  assert.match(refused, /<p class="error" role="alert">caller may not read a node&#39;s health/, "the picked node says the read was refused");
  assert.equal(load(refused, tower), `<span class="dim" title="Only a deployer reads a node&#39;s health">not read</span>`, "another node's card says only a deployer reads it");
});

test("a queued thread's preview says once what it waits for", async (t) => {
  const s = await seeded(t);
  const first = await s.start("acme", "Fix checkout");
  const queued = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Then the receipts", after: [first.id] })).text) as QueuedThread;
  const peek = textOf((await s.call("GET", `/?peek=${queued.id}`)).text.split('id="peek"')[1]!.split('id="in-flight"')[0]!);
  assert.equal(peek.split("Fix checkout").length - 1, 1, peek);
});

test("Deployed lists a landed thread for a day after its archive, and the work in flight's count leaves it out", async (t) => {
  const s = await seeded(t, landingOptions());
  const landed = await s.start("acme", "Landed");
  const dropped = await s.start("acme", "Archived unlanded");
  const building = await s.start("acme", "Still building");
  s.registry.reviews.saveReview(approvedReview(landed.id, { kind: "landed", commit: "c".repeat(40) }, { merged: "c".repeat(40) }));
  for (const th of [landed, dropped]) s.registry.threads.setThreadStatus(th.id, "archived");
  const home = async () => {
    const page = (await s.call("GET", "/")).text;
    return { page, deployed: page.split('id="phase-deployed"')[1]!.split("</section>")[0]!, flight: page.split('id="flight"')[1]!.split('id="overview"')[0]! };
  };
  const now = await home();
  assert.match(now.deployed, new RegExp(`data-peek="${landed.id}"`));
  assert.doesNotMatch(now.flight, new RegExp(dropped.id), "an archived thread that never landed is not in flight");
  assert.match(now.flight.split('id="phase-building"')[1]!.split("</section>")[0]!, new RegExp(`data-peek="${building.id}"`));
  assert.match(now.page, /<span class="count" id="flight-n" data-live>1<\/span>/, "only the building thread is on its way");
  assert.match(now.page, /<span class="seg-n" id="seg-flight-n" data-live>1<\/span>/);
  const real = Date.now();
  t.mock.method(Date, "now", () => real + 25 * 60 * 60 * 1000);
  assert.doesNotMatch((await home()).deployed, new RegExp(landed.id), "a day after its archive it has left Deployed");
});

test("an archived thread whose review still holds for the person is not in Needs you", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Rolled back");
  s.registry.reviews.saveReview(approvedReview(fix.id, personPhase("deploy", "The deploy of 4444 failed.", "Rolled back to the previous release."), { merged: "4".repeat(40), land: { requestedBy: laptop } }));
  assert.equal(needsCount((await s.call("GET", "/")).text), "1");
  assert.equal((await s.call("POST", `/v1/threads/${fix.id}/archive`)).status, 200);
  const page = (await s.call("GET", "/")).text;
  assert.equal(needsCount(page), "");
  assert.equal(needsOf(page).text, "Needs you Nothing waits on you.");
});

test("a queued thread's page shows its track of steps without links to a timeline it does not have", async (t) => {
  const s = await seeded(t);
  const first = await s.start("acme", "Fix checkout");
  const queued = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Then the receipts", after: [first.id] })).text) as QueuedThread;
  const page = (await s.call("GET", `/threads/${queued.id}`)).text;
  const track = page.split('<nav class="life-bar" id="life"')[1]!.split("</nav>")[0]!;
  assert.equal([...track.matchAll(/<span class="life-step">/g)].length, 6, "each step is a plain step");
  assert.doesNotMatch(track, /data-tab-go|href="#tl-/);
  assert.doesNotMatch(page, /id="timeline-view"/);
});

test("a queued thread whose waits all landed previews why it did not start yet", async (t) => {
  const s = await seeded(t);
  const first = await s.start("acme", "Fix checkout");
  const queued = JSON.parse((await s.call("POST", "/v1/threads", { project: "acme", title: "Then the receipts", after: [first.id] })).text) as QueuedThread;
  s.registry.reviews.saveReview(approvedReview(first.id, { kind: "landed", commit: "c".repeat(40) }, { merged: "c".repeat(40) }));
  s.registry.queue.saveQueued({ ...s.registry.queue.queuedThread(queued.id)!, lastError: "not enough memory on rj-firebat" });
  const peek = textOf((await s.call("GET", `/?peek=${queued.id}`)).text.split('id="peek"')[1]!.split('id="in-flight"')[0]!);
  assert.match(peek, /Next did not start yet: not enough memory on rj-firebat\. Starts on rj-firebat/);
});

/** The images a page shows, as each link and image name them, with any caption. */
const shotsOf = (html: string) => [...html.matchAll(/<a class="shot" href="([^"]*)" target="_blank" rel="noopener"><img src="([^"]*)" alt="([^"]*)" loading="lazy">(?:<span class="shot-cap">([^<]*)<\/span>)?<\/a>/g)]
  .map(([, href, src, alt, caption]) => {
    assert.equal(href, src, "each image links to itself at full size");
    const url = new URL(src!.replaceAll("&amp;", "&"), "http://nexus");
    return { route: url.pathname, query: Object.fromEntries(url.searchParams), alt, caption: caption ?? null };
  });

test("a Claude worker's pasted image, a Read's image and an image file it names show as linked images, with no placeholder text", async (t) => {
  const s = await seeded(t);
  const png = Buffer.from("png bytes").toString("base64");
  const [prompt] = parseRecord(JSON.stringify({
    type: "user", timestamp: "2026-10-28T10:00:00.000Z", origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "Why is `shots/home.png` blank?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] },
  }));
  const read = parseRecord(JSON.stringify({
    type: "user", timestamp: "2026-10-28T10:00:02.000Z",
    message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: [{ type: "image", source: { type: "base64", data: png, media_type: "image/png" } }] }] },
  }));
  const thread = await claudeThread(s, [
    prompt!,
    { kind: "tool", at: Date.parse("2026-10-28T10:00:01.000Z"), id: "toolu_1", name: "Read", input: { file_path: "/home/user/workspace/repo/shots/home.png" } },
    ...read,
    { kind: "reply", at: Date.parse("2026-10-28T10:00:03.000Z"), text: "It renders before the data loads. Fixed in ![after](/home/user/workspace/repo/shots/fixed.png), not /tmp/x.png." },
  ]);
  const html = (await s.call("GET", `/threads/${thread.id}`)).text;
  const { rows, open } = conversationOf(html);
  assert.doesNotMatch(rows.join("\n"), /\[image\]/);
  assert.doesNotMatch(rows.join("\n"), /No output/, "a call that returned only an image has output to show");
  const [pasted] = (prompt as Extract<ClaudeEntry, { kind: "prompt" }>).images!;
  const [shot] = (read[0] as Extract<ClaudeEntry, { kind: "result" }>).images!;
  const route = `/v1/threads/${thread.id}/image`;
  const placed = (image: typeof pasted) => ({ source: "transcript", offset: String(image!.offset), bytes: String(image!.bytes), sha256: image!.sha256, index: String(image!.index) });
  assert.deepEqual(shotsOf(html), [
    { route, query: placed(pasted), alt: "Image 1", caption: null },
    { route, query: { source: "file", path: "shots/home.png" }, alt: "shots/home.png", caption: "shots/home.png" },
    { route, query: placed(shot), alt: "Image 1", caption: null },
    { route, query: { source: "file", path: "shots/fixed.png" }, alt: "shots/fixed.png", caption: "shots/fixed.png" },
  ]);
  assert.deepEqual(open, [["tool-toolu_1", true]], "a call with an image starts open");
});

test("a harness tool result's image part and a written image file show as linked images", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const data = Buffer.from("png bytes").toString("base64");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push(
    { role: "user", content: "Take a screenshot", timestamp: 0 },
    assistant([call("c1", "screenshot", {}), call("c2", "write", { path: "out/chart.webp", content: "…" })]),
    { role: "toolResult", toolCallId: "c1", toolName: "screenshot", content: [{ type: "text", text: "taken" }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp: 0 },
    result("c2", "Wrote out/chart.webp", false, "write"),
  );
  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.doesNotMatch(conversationOf(html).text, /image\/png image/);
  const { createHash } = await import("node:crypto");
  assert.deepEqual(shotsOf(html), [
    { route: `/v1/threads/${fix.id}/image`, query: { source: "harness", entry: "3", message: "0", part: "1", sha256: createHash("sha256").update(data).digest("hex") }, alt: "Image 1", caption: null },
    { route: `/v1/threads/${fix.id}/image`, query: { source: "file", path: "out/chart.webp" }, alt: "out/chart.webp", caption: "out/chart.webp" },
  ]);
});

test("the harness image link a thread page renders serves the image", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push({ role: "toolResult", toolCallId: "c1", toolName: "screenshot", content: [{ type: "text", text: "taken" }, { type: "image", data: png, mimeType: "image/png" }], isError: false, timestamp: 0 });
  s.fake.commit(fix.id);
  const [shot] = shotsOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(shot?.query.source, "harness");
  const served = await s.call("GET", `${shot!.route}?${new URLSearchParams(shot!.query)}`);
  assert.equal(served.status, 200, served.text);
  assert.equal(served.headers["content-type"], "image/png");
});

test("image paths in prose are the checkout's, each once, at most six", () => {
  assert.deepEqual(imagePaths("Saved `shots/home.png`, see ![home](./docs/a.JPG) and /home/user/workspace/repo/out/b.webp. Again: shots/home.png"),
    ["shots/home.png", "docs/a.JPG", "out/b.webp"]);
  assert.deepEqual(imagePaths("Not https://example.com/x.png, /tmp/c.png, ../d.png, ~/e.png, src/../../f.gif or a.png.bak"), []);
  assert.deepEqual(imagePaths("1.png 2.gif 3.jpeg 4.jpg 5.webp 6.png 7.png"), ["1.png", "2.gif", "3.jpeg", "4.jpg", "5.webp", "6.png"]);
  for (const extension of Object.keys(imageTypes)) assert.deepEqual(imagePaths(`See shots/a${extension}.`), [`shots/a${extension}`], extension);
  assert.deepEqual(imagePaths("See .png and shots/.jpg, not shots.png/x"), [".png", "shots/.jpg"], "a name that is only the extension");
  assert.deepEqual(imagePaths(`${"x".repeat(1 << 20)} ${"a.".repeat(1 << 19)}`), [], "a long word takes one pass, as a reply's base64 would");
});

test("a page reads the threads, the queue and the release reports as often whatever the count of projects and nodes", async (t) => {
  const reads = async (projects: number, nodes: number) => {
    const s = await setup(t);
    assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
    s.registry.images.setCurrentImage(image.id as ImageId);
    for (let n = 1; n < nodes; n++) s.registry.nodes.upsertNode({ name: `node-${n}` as NodeName, tailnetHost: `node-${n}.tail.ts.net`, tailnetNodeId: `nNODE${n}` as TailnetNodeId });
    let thread: Thread | undefined;
    for (let p = 0; p < projects; p++) {
      assert.equal((await s.call("POST", "/v1/projects", project(`p${p}`))).status, 201);
      thread = await s.start(`p${p}`, `Thread ${p}`);
      assert.equal((await s.call("POST", "/v1/threads", { project: `p${p}`, title: `Queued ${p}`, after: [thread.id] })).status, 201);
    }
    const counted = [["threads", t.mock.method(s.registry.threads, "threads")], ["queuedThreads", t.mock.method(s.registry.queue, "queuedThreads")],
      ["releaseReports", t.mock.method(s.registry.releases, "releaseReports")]] as const;
    const counts: Record<string, Record<string, number>> = {};
    for (const path of ["/", `/threads/${thread!.id}`, "/cluster"]) {
      for (const [, mock] of counted) mock.mock.resetCalls();
      assert.equal((await s.call("GET", path)).status, 200);
      counts[path.replace(thread!.id, "<id>")] = Object.fromEntries(counted.map(([name, mock]) => [name, mock.mock.callCount()]));
    }
    return counts;
  };
  const one = await reads(1, 1);
  assert.deepEqual(await reads(5, 4), one);
  assert.deepEqual(one["/"], { threads: 1, queuedThreads: 1, releaseReports: 0 }, "the home page shows no release, which the Cluster page does");
  assert.deepEqual(one["/cluster"], { threads: 1, queuedThreads: 1, releaseReports: 2 }, "the release view reads the reports again after the control node is found");
});

test("a page reads as often however many threads closed before it, and reads no transcript of a closed thread it does not show", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const reads = async (closed: number) => {
    const s = await seeded(t);
    // Each thread is a pipeline item's Claude worker with a transcript, as a builder is.
    const claudeThread = (i: number) => {
      const item = `it-${String(i).padStart(12, "0")}` as ItemId;
      s.registry.pipeline.saveItem({ id: item, project: "acme" as ProjectId, title: `Item ${i}`, request: { project: "acme", title: `Item ${i}`, claude: "Build it" }, message: null,
        after: [], addedBy: laptop, addedAt: Date.now(), approved: null, cancelled: null, lastError: null });
      const thread = testThread({ title: `Item ${i}` });
      s.registry.threads.createThread(thread, testPylon(thread), { claude: { prompt: "Build it" }, key: { requestId: requestIds.pipeline(item), body: "{}" } });
      claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
      s.registry.threads.appendClaudeRead(thread.id, { session: "s1", from: transcriptStart, entries: [{ kind: "reply", at: Date.now(), text: "Done." }], cursor: { ...transcriptStart, offset: 1 }, reset: false, readAt: Date.now() });
      return thread;
    };
    const gone = Array.from({ length: closed }, (_, i) => {
      const thread = claudeThread(i);
      s.registry.threads.setThreadStatus(thread.id, i % 2 === 0 ? "archived" : "deleted");
      if (i % 2 === 0) s.registry.usage.finishSettle(thread.id, null, Date.now());
      return thread.id;
    });
    t.mock.timers.setTime(Date.now() + 2 * 24 * 60 * 60_000);
    const open = claudeThread(closed);
    const executed = (["get", "all", "iterate"] as const).map((name) => t.mock.method(StatementSync.prototype, name));
    const counts: Record<string, number> = {};
    for (const path of ["/", `/threads/${open.id}`, "/threads/quiet?project=acme"]) {
      for (const mock of executed) mock.mock.resetCalls();
      assert.equal((await s.call("GET", path)).status, 200);
      const calls = executed.flatMap((mock) => mock.mock.calls);
      counts[path.replace(open.id, "<id>")] = calls.length;
      const transcripts = calls.filter((c) => (c.this as StatementSync).sourceSQL.includes("claude_entries"));
      assert.ok(transcripts.length > 0, `${path} reads the transcript of the thread it shows`);
      assert.deepEqual(gone.filter((id) => transcripts.some((c) => c.arguments.some((a) => typeof a === "string" && a.includes(id)))), [], `${path} reads no closed thread's transcript`);
    }
    for (const mock of executed) mock.mock.restore();
    return counts;
  };
  assert.deepEqual(await reads(12), await reads(2));
});

test("the sidebar's release lines read as the release view does: stale and missing reports pending, and a control line only for the node that reported one", async (t) => {
  const s = await seeded(t);
  const tower = "tower" as NodeName;
  s.registry.nodes.upsertNode({ name: tower, tailnetHost: "tower.tail.ts.net", tailnetNodeId: "nTOWER" as TailnetNodeId });
  const commit = "a".repeat(40);
  const report = (role: "control" | "probe", observedAt: number) => s.registry.releases.reportRelease({ node, role, commit, target: commit, state: "healthy", reason: null, observedAt });
  report("control", Date.now());
  report("probe", Date.now() - 90_000);
  const lines = (await nodeHeads(s)).split(/<span><svg class="i i-server"/).slice(1)
    .map((n) => [textOf(/<a [^>]*>([^<]*)<\/a>/.exec(n)![1]!), ...[...n.matchAll(/<small title="([^"]*)">([^<]*)<\/small>/g)].map((m) => `${m[2]} (${m[1]})`)]);
  assert.deepEqual(lines, [
    [node, "control: aaaaaaaaaaaa · healthy ()", "probe: aaaaaaaaaaaa · pending (deployer report is stale)"],
    [tower, "probe: unknown · pending (no deployer report)"],
  ]);
});

/** The page's conversation region: its named view, and what it renders. */
function convoRegion(html: string) {
  const tag = /<div class="convo" id="convo" data-rendered-reply-at="\d*"(?: data-shows="([^"]+)")? data-live[^>]*>/.exec(html)!;
  return { named: tag[1], inside: html.slice(tag.index + tag[0].length).split('<button type="button" class="btn btn-xs jump-end"')[0]!.replace(/<\/div>$/, "") };
}

test("a poll of a streaming harness thread's page names the view its stream shows rather than render it", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push({ role: "user", content: "Build it", timestamp: Date.now() }, assistant([bash("c1", "npm run build")], "toolUse"));
  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [1] }, tools: [{ callId: "c1", name: "bash", status: "running", output: "compiling\n" }] };
  const stream = s.events(`/threads/${fix.id}/stream`);
  t.after(() => stream.close());
  const first = await stream.next();
  const polled = convoRegion((await s.call("GET", `/threads/${fix.id}?streaming=1`)).text);
  assert.deepEqual(polled, { named: first.shows, inside: "" }, "the poll names the view the stream's frame shows and renders none");
  const unstreamed = convoRegion((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.equal(unstreamed.named, undefined);
  assert.match(unstreamed.inside, /npm run build/, "a poll from a page that does not stream renders the conversation");

  transcript.docs["pi.live"] = { run: { taskId: 1, inputs: [1] }, tools: [{ callId: "c1", name: "bash", status: "running", output: "compiling\nlinking\n" }] };
  s.fake.commit(fix.id);
  const grew = await stream.next();
  assert.ok(grew.grow !== undefined && grew.shows !== first.shows, "output that grew is another view");
  assert.equal(convoRegion((await s.call("GET", `/threads/${fix.id}?streaming=1`)).text).named, grew.shows);
});

test("a finished text renders as it did uncached, and a streaming answer keeps its caret whatever was rendered of the same text", async (t) => {
  const s = await seeded(t);
  const thread = await s.start("acme", "Fix checkout");
  const text = `Done: **${randomUUID()}** and \`code\`.\n\n- one\n- two`;
  const reply = (entries: ClaudeEntry[]): ClaudeConversation => ({ kind: "claude", session: "s1", entries, dropped: 0, readAt: 1, working: false, usageLimit: null });
  const rendered = (liveFrames(thread, null, itemsWith(thread.id))(reply([{ kind: "reply", at: 1, text }])) as { convo: string }).convo;
  assert.equal((liveFrames(thread, null, itemsWith(thread.id))(reply([{ kind: "reply", at: 1, text }])) as { convo: string }).convo, rendered, "a render from the cache is the render it keeps");
  assert.match(rendered, /<strong>[^<]+<\/strong> and <code>code<\/code>\.<\/p><ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul>/);

  const caret = '<span class="caret" aria-hidden="true"></span>';
  const harness = (committed: string | null, streaming: string | null) => ({
    conversation: { id: 1 },
    entries: committed === null ? [] : [{ id: 1, conversationId: 1, kind: "pi.assistant", model: [assistant([{ type: "text", text: committed }])] }],
    docs: streaming === null ? {} : { "pi.live": { run: { taskId: 1, inputs: [1] }, tools: [], generation: { attempt: 1, message: assistant([{ type: "text", text: streaming }], "pending") } } },
  }) as never;
  const streamed = `Streaming ${randomUUID()}`;
  const carets = (view: never) => (liveFrames(thread, null, itemsWith(thread.id))(view) as { convo: string }).convo.split(caret).length - 1;
  assert.equal(carets(harness(null, streamed)), 1);
  assert.equal(carets(harness(streamed, null)), 0, "the finished text is not the streaming render");
  assert.equal(carets(harness(streamed, streamed)), 1, "nor the streaming render the finished one");
});

test("the start dialog's hint says where the pylon boots, from what image, and what it checks out", () => {
  const said = (parts: HintPart[]) => parts.map(({ text, look }) => look === undefined ? text : `<${look}>${text}</${look}>`).join("");
  assert.equal(said(startHint({ node: "rj-firebat", image: "img-1", branch: "main", scratch: false })), "Boots a pylon on <b>rj-firebat</b> from image <code>img-1</code> and checks out <code>main</code>.");
  assert.equal(said(startHint({ node: "rj-firebat", image: "img-1", branch: "main", scratch: true })), "Boots a pylon on <b>rj-firebat</b> from image <code>img-1</code> and starts an empty repository on <code>main</code>.");
  assert.equal(said(startHint({ node: "rj-firebat", image: null, branch: "main", scratch: false })), "Boots a pylon on <b>rj-firebat</b> and checks out <code>main</code>.", "no image is current");
  assert.equal(said(startHint({ node: "auto", image: "img-1", branch: "dev", scratch: false })), "Boots a pylon on the node with the most room left from image <code>img-1</code> and checks out <code>dev</code>.");
});

test("a page's icon template holds only the icons client.js clones", async (t) => {
  const s = await seeded(t);
  const template = /<template id="icons">(.*?)<\/template>/.exec((await s.call("GET", "/")).text)![1]!;
  assert.deepEqual([...template.matchAll(/class="i i-([a-z]+)"/g)].map((m) => m[1]), ["chevron", "folder"]);
  const dir = new URL("./", import.meta.url);
  const scripts = (await readdir(dir)).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"));
  const client = (await Promise.all(scripts.map((name) => readFile(new URL(name, dir), "utf8")))).join("\n");
  assert.deepEqual([...new Set([...client.matchAll(/iconOf\("([a-z]+)"\)/g)].map((m) => m[1]))].sort(), ["chevron", "folder"]);
});

test("Needs you lists an approval the project leaves to the person to land, with the Land button, until it lands", async (t) => {
  const s = await seeded(t, landingOptions());
  assert.equal((await s.call("PATCH", "/v1/projects/acme", { autoReview: { land: false } })).status, 200);
  const fix = await s.start("acme", "Cache the list");
  s.registry.reviews.saveReview(approvedReview(fix.id, { kind: "approved" }, { auto: true }));
  const { cards } = needsOf((await s.call("GET", "/")).text);
  assert.deepEqual(cards.map((c) => [c.kind, c.thread, c.attention]), [["review", fix.id, "decision"]], "the approval waits on the person");
  assert.match(cards[0]!.text, /^Approved, yours to land acme \/ Cache the list /);
  assert.match(cards[0]!.html, new RegExp(`data-action="land" data-thread="${fix.id}" data-head="${head}"`));

  s.registry.reviews.saveReview(approvedReview(fix.id, { kind: "landed", commit: "m".repeat(40) }, { auto: true, merged: "m".repeat(40) }));
  assert.equal(needsOf((await s.call("GET", "/")).text).text, "Needs you Nothing waits on you.", "a landed review waits on no one");
});

test("a held review offers Land only where a press can land, and shows a hold no press gets past with what clears it", async (t) => {
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  const reserved = { code: "reserved:auth", text: "Always needs the person: changes to login or auth, by the reviewer's reading (it changes the login)." } as const;
  const unchecked = { code: "not-checked-live", text: "No live check ran, and the pull request does not say what could not be checked live." } as const;
  const save = (...holds: Parameters<typeof personPhase>[1][]) => s.registry.reviews.saveReview(approvedReview(fix.id, personPhase("policy", ...holds), { land: { requestedBy: laptop } }));
  const card = async () => landingOf((await s.call("GET", `/threads/${fix.id}`)).text);

  save({ code: "same-model", text: "The reviewer ran the builder's own model, gpt-6-astra." });
  assert.ok(!(await card()).includes('data-action="land"'), "the builder's own model as reviewer holds every press");

  save(unchecked, reserved);
  const page = await card();
  assert.match(textOf(page), /could not be checked live\. not waivable A live check that passed at this commit clears it, or a description that says what could not be checked live: add that section to the pull request's description, then press Land, and Nexus asks the reviewer to quote it at this commit\./);
  const button = /<button [^>]*data-action="land"[^>]*>/.exec(page)![0];
  assert.deepEqual(JSON.parse(textOf(/data-holds="([^"]*)"/.exec(button)![1]!)), [reserved.text]);
  assert.match(textOf(/data-confirm="([^"]*)"/.exec(button)![1]!), /Nexus first asks the reviewer to quote, from the description as it is now, what could not be checked live/);
});

test("a review that asks about its holds has one card in Needs you, the question's, and its Land card points to it rather than waive them itself", async (t) => {
  const reserved = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  const review = approvedReview(fix.id, personPhase("policy", { code: "reserved-path:auth", text: reserved }), { land: { requestedBy: laptop } });
  s.registry.reviews.saveReview(review);
  s.registry.questions.replaceQuestions(fix.id, "holds-", {
    kind: "holds", id: "holds-rv-1-a", thread: fix.id, text: `Land pull request #7, "Cache", at ${head.slice(0, 12)}, waiving changes to login or auth?\n- ${reserved}`, options: ["Land", "Leave it"],
    reserved: "auth", answerer: "deployer", askedAt: Date.now(), holds: { review: review.id, head, base: null, holds: [{ code: "reserved-path:auth", text: reserved }] },
  });
  const page = (await s.call("GET", "/")).text;
  const mine = needsOf(page).cards.filter((c) => c.thread === fix.id);
  assert.deepEqual(mine.map((c) => c.kind), ["question"], "one card, not the review's and the question's");
  assert.match(mine[0]!.text, /^Holds to waive acme \/ Fix checkout .* Land pull request #7, "Cache", at 9f9f9f9f9f9f, waiving changes to login or auth\? .* Land Leave it .* Answer the question about its holds to waive them and land it\.$/);
  const land = /<button [^>]*data-option="Land"[^>]*>/.exec(mine[0]!.html)![0];
  assert.equal(textOf(/data-confirm="([^"]*)"/.exec(land)![1]!), `Land pull request #7, "Cache", at ${head.slice(0, 12)}, waiving changes to login or auth? The answer cannot be changed.`);
  assert.ok(!mine[0]!.html.includes("data-holds"), "no second way to waive");

  const card = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(!card.includes("data-action=\"land\""));
  assert.match(textOf(card), /Answer the question about its holds above to waive them and land it\.$/);
});

test("a holds question asked at the review's head on another base is another change, so the Land card offers its own press", async (t) => {
  const reserved = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const s = await seeded(t, landingOptions());
  const fix = await s.start("acme", "Fix checkout");
  const review = approvedReview(fix.id, personPhase("policy", { code: "reserved-path:auth", text: reserved }), { land: { requestedBy: laptop } });
  s.registry.reviews.saveReview(review);
  s.registry.questions.replaceQuestions(fix.id, "holds-", {
    kind: "holds", id: "holds-rv-1-b", thread: fix.id, text: `Land pull request #7, "Cache", at ${head.slice(0, 12)}, waiving changes to login or auth?\n- ${reserved}`, options: ["Land", "Leave it"],
    reserved: "auth", answerer: "deployer", askedAt: Date.now(), holds: { review: review.id, head, base: "main", holds: [{ code: "reserved-path:auth", text: reserved }] },
  });
  const card = landingOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.ok(card.includes("data-action=\"land\""), "the card's own Land press");
  assert.doesNotMatch(textOf(card), /Answer the question about its holds/);
});
