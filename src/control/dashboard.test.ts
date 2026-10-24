import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { startApi } from "./api.ts";
import { readEvents } from "./event-reader.ts";
import { fakeHarness } from "./fake-harness.ts";
import { openRegistry, type Thread } from "./registry.ts";
import type { JobId, NodeName, PylonObservation, ServiceFact, TailnetNodeId } from "../protocol.ts";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const project = (id: string) => ({
  id, repoUrl: `git@example.com:${id}.git`, defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: "d", node: "24.22.1", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f",
  },
};
const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };

const dir = await mkdtemp(join(tmpdir(), "nexus-dashboard-"));
after(() => rm(dir, { recursive: true }));

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string }

async function setup(t: TestContext) {
  const registry = openRegistry(join(dir, `${randomUUID()}.db`));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  let caller: TailnetNodeId | null = laptop;
  const fake = fakeHarness();
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0,
    whois: async () => caller,
    allowed: new Set([laptop]),
    hostnames: new Set(["127.0.0.1"]),
    dotfiles: { repo: "git@github.com:ramtin/dotfiles.git", ref: "main" },
    harness: fake.harness,
    wake: () => {},
    probes: new Map(),
    previewPorts: { first: 10200, last: 10299 },
  });
  t.after(async () => {
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
    registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons, previewRoutes: [] }, []);
  }
  return {
    registry, fake, call, start, observe, observeWith, callAs(id: TailnetNodeId | null) { caller = id; },
    events: (path: string) => readEvents(api.port, path),
  };
}

async function seeded(t: TestContext) {
  const s = await setup(t);
  for (const id of ["acme", "beta"]) assert.equal((await s.call("POST", "/v1/projects", project(id))).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  assert.equal((await s.call("PUT", "/v1/images/current", { image: image.id })).status, 204);
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
  const row = html.split('id="overview"')[1]!.split("<tr>").find((chunk) => chunk.includes(`href="/threads/${thread.id}"`));
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
    rows: convo.split(/(?=<div class="msg |<p class="notice|<details class="tool|<details class="steps)/).slice(1).map((row) => textOf(`<x ${row}`).replace(/^<x /, "")),
    open: [...convo.matchAll(/<details class="(?:tool|steps)[^"]*" id="([^"]*)"( open)?>/g)].map((m) => [m[1], m[2] !== undefined]),
    text: textOf(convo.replace(/^[^>]*>/, "")),
    dock: textOf(dock),
  };
}

test("the overview lists each project's open threads with their phases, node and activity, and folds the archived", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const docs = await s.start("beta", "Write docs");
  const old = await s.start("acme", "Old spike");
  s.registry.recordActivity(docs.id, { agent: Date.now(), agentTurnRunning: true });
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
  assert.equal(overviewRow(res.text, docs), "Write docs running not on its node rj-firebat just now turn running");
  assert.match(textOf(acme!), /Thread Desired Observed Node Human Agent Fix checkout .* 1 archived Thread .* Old spike archived paused not on its node/);
  assert.match(acme!, /<details class="ov-closed"[^>]*><summary>1 archived<\/summary>/, "archived threads start folded away");
});

test("the sidebar lists every project's threads with their state, folds the archived and marks the open one", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const docs = await s.start("beta", "Write docs");
  const old = await s.start("acme", "Old spike");
  const gone = await s.start("acme", "Gone");
  s.registry.recordActivity(docs.id, { agent: Date.now(), agentTurnRunning: true });
  await s.call("POST", `/v1/threads/${old.id}/archive`);
  await s.call("DELETE", `/v1/threads/${gone.id}`);
  s.observe(fix);

  for (const path of ["/", `/threads/${fix.id}`, "/threads/new", "/threads/th-missing"]) {
    const sidebar = sidebarOf((await s.call("GET", path)).text);
    // Threads started in the same millisecond have no order between them.
    assert.deepEqual(sidebar.rows.toSorted(), ["agent working Write docs now", "archived Old spike now", "deleted Gone now", "running Fix checkout now"], `${path} lists the threads`);
    assert.match(sidebar.text, /^acme 1 Fix checkout now 1 archived, 1 deleted (Gone now Old spike now|Old spike now Gone now) beta 1 Write docs now$/);
  }
  const page = (await s.call("GET", `/threads/${fix.id}`)).text;
  assert.equal(sidebarOf(page).active, fix.id);
  assert.match(page, /<details class="archived" id="archived-acme">/, "the archived fold starts closed");
  assert.match((await s.call("GET", `/threads/${old.id}`)).text, /<details class="archived" id="archived-acme" open>/, "an archived thread's page opens its fold");
  assert.match(textOf(page.split('id="side-nodes"')[1]!.split("</div>")[0]!), /rj-firebat/);
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

test("the thread page shows its pylon, sessions with how to attach, previews as tailnet links, and outputs", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  const pane = (herdrPane: string, harness: "claude-code" | "pi" | "shell", status: "working" | "idle", harnessSessionId: string | null = null) =>
    s.registry.apply({ record: "session", pylonId: fix.pylonId, herdrPane, fact: { herdrPane, harness, harnessSessionId, status } });
  pane("w1:p1", "claude-code", "working", "5f0c");
  pane("w2:p1", "pi", "idle", "/home/user/.pi/sessions/a.jsonl");
  pane("w3:p1", "shell", "idle");
  s.registry.allocatePreviews(fix.pylonId, ["web", "api"], { first: 8443, last: 8444 });
  s.registry.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  for (const [kind, ref] of [["branch", "nexus/fix-checkout"], ["diff", "abc1234"], ["preview", "web"], ["file", "out-1"]] as const) {
    s.registry.apply({ record: "output", pylonId: fix.pylonId, kind, ref });
  }

  const res = await s.call("GET", `/threads/${fix.id}`);
  assert.equal(res.status, 200);
  assert.equal(textOf(res.text.split('id="bar"')[1]!.split("</header>")[0]!.replace(/^[^>]*>/, "")), "☰ acme / Fix checkout running Archive Delete ⋯");
  assert.match(conversationOf(res.text).text, new RegExp(`^${fix.id} · started just now`));
  assert.equal(textOf(sectionOf(res.text, "pylon-h")), `Pylon Desired running Observed running Node rj-firebat Last seen just now Human just now Agent never ${fix.pylonId}`);

  const sessions = textOf(sectionOf(res.text, "sessions-h"));
  assert.match(sessions, /^Sessions 3 /);
  assert.match(sessions, /Claude Code working w1:p1 session 5f0c/);
  assert.match(sessions, /pi idle w2:p1 session \/home\/user\/\.pi\/sessions\/a\.jsonl/);
  assert.match(sessions, /Shell idle w3:p1 Attach from a shell in the pylon herdr --session nexus Copy$/);

  const previews = sectionOf(res.text, "previews-h");
  assert.ok(previews.includes('href="https://rj-firebat.tail.ts.net:8443/"'), "a ready preview links to its tailnet HTTPS URL");
  assert.equal(textOf(previews), "Previews 2 api starting rj-firebat.tail.ts.net:8444 web Open ↗ rj-firebat.tail.ts.net:8443");
  assert.ok(!previews.includes(":8444/"), "a preview that is not ready has no link yet");

  const outputs = sectionOf(res.text, "outputs-h");
  assert.equal(textOf(outputs), "Outputs 3 branch nexus/fix-checkout diff abc1234 file out-1", "web's preview is listed once, under Previews");

  const strip = textOf(res.text.split('id="strip"')[1]!.split("</div>")[0]!.replace(/^[^>]*>/, ""));
  assert.equal(strip, "running · rj-firebat api, starting web ↗ 3 outputs", "the phone's strip names the pylon, each preview and the outputs");


  assert.match(res.text, new RegExp(`<main[^>]* data-activity="${fix.id}"`), "an open thread page records the visit as human activity");

  s.registry.releasePreviews(fix.pylonId);
  const released = sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "outputs-h");
  assert.equal(textOf(released), "Outputs 4 branch nexus/fix-checkout diff abc1234 file out-1 preview web", "a preview the control plane no longer has stays an output");
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
  assert.equal(textOf(after.ports), "Ports 0 Every port that listens is under Previews. A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1.");
  assert.equal(after.previews, "Previews 2 port-3000 starting rj-firebat.tail.ts.net:8444 web starting rj-firebat.tail.ts.net:8443");

  s.observeWith({ listening: [] }, fix);
  assert.equal(textOf((await page()).ports), "Ports 0 Nothing listens yet. A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1.");
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

  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [{ pylonId: fix.pylonId, phase: "stopped", checkpoint: null }], previewRoutes: [] }, []);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused Open ↗ rj-firebat.tail.ts.net:8443 Opening it wakes the pylon.", linked: true });

  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused rj-firebat.tail.ts.net:8443 Unarchive the thread to open it.", linked: false }, "an archived thread's visit cannot wake its pylon");

  // Right after the archive, before the pylon pauses, the preview still serves but is about to sleep for good.
  s.observe(fix);
  s.registry.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  assert.match(textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "pylon-h")), /Observed running/);
  assert.deepEqual(await previews(), { previews: "Previews 1 web paused rj-firebat.tail.ts.net:8443 Unarchive the thread to open it.", linked: false }, "an archived thread's running pylon offers no link");
});

test("tool calls are one-line rows where only failures and edits start open, with the exit code and the edit's diff", async (t) => {
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
    `› bash npm test 40 lines ✓ npm test ${long.replace(/\n/g, " ")}`,
    "One more.",
    "› bash git status 2 lines exit 128 git status fatal: not a git repository Command exited with code 128",
    "› edit src/a.ts +1 −2 ✓ src/a.ts − const a = 1; − const b = 2; + const a = 2;",
    `› read src/b.ts no result src/b.ts { "offset": 10 } No output.`,
    "! Aborted.",
    "! The model failed: rate limited",
    "You Look at this [image/png image]",
    "All 40 pass.",
  ]);
  assert.deepEqual(open, [["tool-c1", false], ["tool-c2", true], ["tool-c3", true], ["tool-c4", false]], "only the failure and the edit start open");
});

test("a long run of tool calls folds into one line that names its steps, and opens itself for a failure", async (t) => {
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
  assert.equal(rows[1], "› 5 steps · read total.ts, searched applyCoupon, ran npm test, read cart.ts");
  assert.equal(rows[8], "› 5 steps · read total.ts, searched applyCoupon, ran npm test, read cart.ts · 1 failed");
  assert.equal(rows[14], "Now the rest.");
  assert.equal(rows[15], "› bash ls 1 line ✓ ls a", "three calls in a row stay as rows");
  assert.deepEqual(open.filter(([id]) => String(id).startsWith("steps-")), [["steps-a1", false], ["steps-b1", true]], "a fold with a failure starts open");
  assert.deepEqual(open.filter(([id]) => ["tool-b4", "tool-a4"].includes(String(id))), [["tool-a4", false], ["tool-b4", true]]);
});

test("a running turn shows its tool's output so far, the partial answer, queued messages and what the run has done", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push({ role: "user", content: "Build it", timestamp: Date.now() - 72_000 }, assistant([bash("c1", "npm run build")], "toolUse"));
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
    "› bash npm run build 1 line running npm run build compiling",
    "Half an ans",
    "! The model request failed and will be retried: overloaded",
    "You queued, sends after this run then deploy",
  ]);
  assert.deepEqual(open, [["tool-c1", true]]);
  assert.match(dock, /^The agent is working\. 1m 1[2-3]s · 1 tool this turn · new messages queue Abort gpt-test ⌘↵ to queue Queue$/);
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
  assert.match(page, new RegExp(`<div class="convo" id="convo" data-live data-stream="/threads/${fix.id}/stream">`));

  const stream = s.events(`/threads/${fix.id}/stream`);
  const first = await stream.next();
  assert.ok(page.includes(`data-stream="/threads/${fix.id}/stream">${first.convo}</div></div>`), "the first event is the region the page holds");
  assert.deepEqual(conversationOf(`<div id="convo" ${first.convo}<div class="dock"></main>`).rows.slice(1), ["› bash npm run build 1 line running npm run build compiling", "Hal"]);

  transcript.docs["pi.live"] = live("Half an <answer>", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await stream.next(), { grow: [[0, "2 lines"], [1, "compiling\nlinking\n"], [2, 'Half an &lt;answer&gt;<span class="caret" aria-hidden="true"></span>']] },
    "the line count, the output and the answer grow in place, escaped as the page escapes them");
  transcript.docs["pi.live"] = live("Half an <answer> and more", "compiling\nlinking\n");
  s.fake.commit(fix.id);
  assert.deepEqual(await stream.next(), { grow: [[2, 'Half an &lt;answer&gt; and more<span class="caret" aria-hidden="true"></span>']] }, "only the parts that grew");

  transcript.messages.push(result("c1", "built"), assistant([{ type: "text", text: "Built." }]));
  transcript.docs["pi.live"] = {};
  s.fake.commit(fix.id);
  const done = await stream.next();
  assert.deepEqual(conversationOf(`<div id="convo" ${done.convo}<div class="dock"></main>`).rows.slice(1), ["› bash npm run build 1 line ✓ npm run build built", "Built."], "a finished call and a committed answer send the region whole");
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
  assert.equal(archived.chip, "archived");
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
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [{ pylonId: fix.pylonId, phase: "stopped", checkpoint: null }], previewRoutes: [] }, []);
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
    node, observedAt: new Date().toISOString(), probeBootId: "b", capacity: { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 }, artifacts: [], jobs: [],
    pylons: [{ pylonId: fix.pylonId, phase: "broken", detail: "Setup exited 128. Read controller logs", cause: "saved-setup" }], previewRoutes: [],
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
  assert.equal(conversationOf(html).rows[1], `› grep a|b<c> 1 line ✓ a|b<c> { "path": "src" } src/a.ts:1`);
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
  assert.match(await region("/"), /^No image is current yet, .* Title Project acme git@example\.com:acme\.git Node/, "a refresh brings the form once a project exists");
  await s.call("POST", "/v1/projects", project("beta"));
  assert.match(await region("/threads/th-missing"), /Project acme git@example\.com:acme\.git beta git@example\.com:beta\.git Node/);
});

test("every page has somewhere to say a refresh failed", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  for (const path of ["/", "/threads/new", `/threads/${fix.id}`, "/threads/th-missing"]) {
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
  assert.deepEqual([...dialog.matchAll(/<option value="([^"]*)">([^<]*)</g)].map((m) => [m[1], m[2]]), [["", "rj-firebat (project default)"], [node, `${node}, offline`]]);
  assert.match(textOf(dialog), /No image is current yet.* Boots a pylon on rj-firebat and checks out main \./);

  await s.call("POST", "/v1/images", image);
  await s.call("PUT", "/v1/images/current", { image: image.id });
  const home = (await s.call("GET", "/")).text;
  assert.doesNotMatch(home, /data-autoopen/, "the dialog stays closed until asked for");
  assert.match(textOf(home.split('<dialog id="start-dialog"')[1]!.replace(/^[^>]*>/, "")), new RegExp(`^Start a thread ✕ Title Project acme .* Boots a pylon on rj-firebat from image ${image.id} and checks out main \\.`));
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
  assert.equal((await s.call("GET", "/assets/secret.txt")).status, 404);
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
