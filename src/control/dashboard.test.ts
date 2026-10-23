import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { startApi } from "./api.ts";
import { fakeHarness } from "./fake-harness.ts";
import { openRegistry, type Thread } from "./registry.ts";
import type { JobId, NodeName, PylonObservation, TailnetNodeId } from "../protocol.ts";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

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
    registry.apply({ record: "node", node, state: "online", capacity });
    const pylons = threads.map((t): PylonObservation => ({
      pylonId: t.pylonId, phase: "running", liveHash: registry.pylon(t.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
      bootedFrom: { image: image.id as `img-${string}`, checkpoint: null },
      services: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    }));
    registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons }, []);
  }
  return { registry, fake, call, start, observe, callAs(id: TailnetNodeId | null) { caller = id; } };
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

/** The list item for one thread on the thread list. */
function rowOf(html: string, thread: Thread): string {
  const row = html.split('<li class="thread">').find((chunk) => chunk.includes(`href="/threads/${thread.id}"`));
  assert.ok(row !== undefined, `no row for ${thread.id}`);
  return textOf(row.split("</li>")[0]!);
}

const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): Message => ({
  role: "assistant", content, stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), api: "x", provider: "x", model: "x", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const bash = (id: string, command: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: { command } });
const result = (toolCallId: string, text: string, isError = false): Message => ({
  role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 0,
});

/** Each row of a thread page's conversation as a reader sees it, and which tool calls start open. */
function conversationOf(html: string) {
  const list = sectionOf(html, "Conversation").split('<ol class="conversation">')[1]?.split("</ol>")[0] ?? "";
  return {
    rows: list.split(/<li class="/).slice(1).map((row) => textOf(`<li class="${row}`)),
    open: [...list.matchAll(/<details id="tool-([^"]*)"( open)?>/g)].map((m) => [m[1], m[2] !== undefined]),
  };
}

/** The section under the heading `name` on a thread page. */
function sectionOf(html: string, name: string): string {
  const section = html.split("<section").find((chunk) => chunk.includes(`>${name}</h2>`));
  assert.ok(section !== undefined, `no ${name} section`);
  return section.split("</section>")[0]!;
}

test("the thread list groups threads by project with their phases, node and activity", async (t) => {
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

  const [acme, beta] = ["acme", "beta"].map((id) => sectionOf(res.text, id));
  assert.ok(acme!.includes(fix.id) && !acme!.includes(docs.id), "each thread is listed under its own project");
  assert.ok(beta!.includes(docs.id));
  assert.equal(rowOf(res.text, fix), "Fix checkout Desired running Observed running Node rj-firebat Human just now Agent never");
  assert.equal(rowOf(res.text, docs), "Write docs Desired running Observed not on its node Node rj-firebat Human just now Agent turn running");

  assert.ok(!res.text.includes(old.id), "archived threads are hidden by default");
  assert.match(textOf(acme!), /1 archived or deleted\. Show all threads/);
  const all = await s.call("GET", "/?all");
  assert.equal(rowOf(all.text, old), "Old spike archived Desired paused Observed not on its node Node rj-firebat Human just now Agent never");
});

test("a new thread whose node does not have its pylon yet reads as absent, not deleted", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe();

  const detail = await s.call("GET", `/v1/threads/${fix.id}`);
  assert.equal(JSON.parse(detail.text).pylon.actualState, "absent");
  assert.match(textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "Pylon")), /Observed not on its node Node rj-firebat Last observed just now/);
  assert.equal(rowOf((await s.call("GET", "/")).text, fix), "Fix checkout Desired running Observed not on its node Node rj-firebat Human just now Agent never");
});

test("an offline node shows its pylons as unknown, and the last observation as stale", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.observe(fix);
  s.registry.markOffline(node);

  const list = await s.call("GET", "/");
  assert.equal(rowOf(list.text, fix), "Fix checkout Desired running Observed unknown Node rj-firebat offline Human just now Agent never");
  const pylon = textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "Pylon"));
  assert.match(pylon, /Observed unknown Node rj-firebat offline Last observed just now \(stale\)/);
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
  const page = textOf(res.text);
  assert.match(page, new RegExp(`Fix checkout Archive Delete active acme · ${fix.id} · started just now`));
  assert.match(textOf(sectionOf(res.text, "Pylon")), new RegExp(`Desired running Observed running Node rj-firebat Last observed just now Human just now Agent never ${fix.pylonId}`));

  const sessions = textOf(sectionOf(res.text, "Sessions"));
  assert.match(sessions, /Claude Code working pane w1:p1 · session 5f0c/);
  assert.match(sessions, /pi idle pane w2:p1 · session \/home\/user\/\.pi\/sessions\/a\.jsonl/);
  assert.match(sessions, /Shell idle pane w3:p1 Attach/);
  assert.match(sessions, /herdr --session nexus/);

  const previews = sectionOf(res.text, "Previews");
  assert.ok(previews.includes('href="https://rj-firebat.tail.ts.net:8443/"'), "a ready preview links to its tailnet HTTPS URL");
  assert.match(textOf(previews), /api starting/);
  assert.ok(!previews.includes(":8444/"), "a preview that is not ready has no link yet");

  const outputs = sectionOf(res.text, "Outputs");
  assert.equal(textOf(outputs).replace(/^.*?Outputs /, ""), "Branch nexus/fix-checkout Uncommitted diff abc1234 File out-1 Preview web");
  assert.match(outputs, /href="https:\/\/rj-firebat\.tail\.ts\.net:8443\/"[^>]*>web</);

  assert.match(res.text, new RegExp(`<main[^>]* data-activity="${fix.id}"`), "an open thread page records the visit as human activity");
});

test("a paused pylon's preview keeps its link, labelled paused, unless the thread is archived", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.registry.allocatePreviews(fix.pylonId, ["web"], { first: 8443, last: 8443 });
  s.registry.apply({ record: "output", pylonId: fix.pylonId, kind: "preview", ref: "web" });
  s.observe(fix);
  const url = "https://rj-firebat.tail.ts.net:8443/";
  const previews = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    return { previews: textOf(`<section${sectionOf(html, "Previews")}`), linked: sectionOf(html, "Previews").includes(`href="${url}"`), output: sectionOf(html, "Outputs").includes(`href="${url}"`) };
  };
  assert.deepEqual(await previews(), { previews: "Previews web starting", linked: false, output: false }, "a running pylon's preview that is not ready has no link yet");

  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [{ pylonId: fix.pylonId, phase: "stopped", checkpoint: null }] }, []);
  assert.deepEqual(await previews(), { previews: `Previews web ${url} paused Opening it wakes the pylon.`, linked: true, output: true });

  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  assert.deepEqual(await previews(), { previews: "Previews web paused Unarchive the thread to open it.", linked: false, output: false }, "an archived thread's visit cannot wake its pylon");

  // Right after the archive, before the pylon pauses, the preview still serves but is about to sleep for good.
  s.observe(fix);
  s.registry.apply({ record: "preview", pylonId: fix.pylonId, service: "web", httpsPort: 8443, ready: true });
  assert.match(textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "Pylon")), /Observed running/);
  assert.deepEqual(await previews(), { previews: "Previews web paused Unarchive the thread to open it.", linked: false, output: false }, "an archived thread's running pylon offers no link");
});

test("the thread page shows the conversation, with each tool call's result and long output collapsed", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const long = Array.from({ length: 40 }, (_, i) => `ok ${i + 1} test`).join("\n");
  s.fake.transcript(fix.id).messages.push(
    { role: "user", content: "Run the tests", timestamp: 0 },
    assistant([{ type: "thinking", thinking: "not shown" }, { type: "text", text: "Running them." }, bash("c1", "npm test")]),
    result("c1", long),
    assistant([bash("c2", "git status")]),
    result("c2", "fatal: not a git repository\n", true),
    assistant([{ type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] } }], "aborted"),
    assistant([], "error", "rate limited"),
    { role: "user", content: [{ type: "text", text: "Look at this " }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 0 },
    assistant([{ type: "text", text: "All 40 pass." }]),
  );

  const { rows, open } = conversationOf((await s.call("GET", `/threads/${fix.id}`)).text);
  assert.deepEqual(rows, [
    "You Run the tests",
    "Agent Running them.",
    `bash npm test 40 lines ${long.replace(/\n/g, " ")}`,
    "bash git status failed 1 line fatal: not a git repository",
    `edit src/a.ts no result { "edits": [ { "oldText": "a", "newText": "b" } ] } No output.`,
    "Aborted.",
    "The model failed: rate limited",
    "You Look at this [image/png image]",
    "Agent All 40 pass.",
  ]);
  assert.deepEqual(open, [["c1", false], ["c2", true], ["c3", false]], "long output starts collapsed");
});

test("a running turn shows its tool's output so far, the partial answer and queued messages", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const transcript = s.fake.transcript(fix.id);
  transcript.messages.push({ role: "user", content: "Build it", timestamp: 0 }, assistant([bash("c1", "npm run build")], "toolUse"));
  transcript.docs["pi.live"] = {
    run: { taskId: 1, inputs: [1] },
    tools: [{ callId: "c1", name: "bash", status: "running", output: "compiling\n" }],
    generation: { attempt: 2, message: assistant([{ type: "text", text: "Half an ans" }], "pending") as never, retry: { at: 0, error: "overloaded" } },
  };
  transcript.docs["pi.inbox"] = { items: [{ id: 2, mode: "followUp", content: "then deploy" }, { id: 3, mode: "write", entry: {} }] };

  const html = (await s.call("GET", `/threads/${fix.id}`)).text;
  const { rows, open } = conversationOf(html);
  assert.deepEqual(rows, [
    "You Build it",
    "bash npm run build running 1 line compiling",
    "Agent Half an ans",
    "The model request failed and will be retried: overloaded",
    "You queued then deploy",
  ]);
  assert.deepEqual(open, [["c1", true]]);
  assert.match(textOf(sectionOf(html, "Conversation")), /The agent is working\. Message the agent It waits for the agent's current run\. Send/);
});

test("each thread state offers only the actions and prompt box that apply", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  const state = async () => {
    const html = (await s.call("GET", `/threads/${fix.id}`)).text;
    const conversation = textOf(`<section${sectionOf(html, "Conversation")}`);
    return {
      actions: [...html.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]),
      prompt: html.includes('<form id="prompt"'),
      running: conversation.includes("The agent is working."),
      visit: html.includes("data-activity="),
      conversation,
    };
  };

  assert.deepEqual(await state(), { actions: ["archive", "delete"], prompt: true, running: false, visit: true, conversation: "Conversation No messages yet. Message the agent Send" });

  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  const running = await state();
  assert.deepEqual(running.actions, ["archive", "delete", "abort"]);
  assert.ok(running.prompt && running.running);

  // The harness reports a parked run as no running turn, so its pylon may sleep. It can still be aborted.
  s.fake.park(fix.id, 2);
  const parked = await state();
  assert.deepEqual(parked.actions, ["archive", "delete", "abort", "retry"]);
  assert.ok(parked.prompt && !parked.running, "a parked run is not shown as working");
  assert.match(parked.conversation, /2 tasks hit the restart limit and hold the run\. Retry runs them again\./);

  await s.call("POST", `/v1/threads/${fix.id}/archive`);
  const archived = await state();
  assert.deepEqual(archived.actions, ["unarchive", "delete", "abort"], "an archived thread can still abort, but not retry");
  assert.ok(!archived.prompt && !archived.visit);
  assert.match(archived.conversation, /An archived thread takes no messages, because its pylon stays paused\. Unarchive the thread to send one\./);
  assert.match(archived.conversation, /Unarchive the thread to retry them\./);

  await s.call("POST", `/v1/threads/${fix.id}/unarchive`);
  assert.deepEqual((await state()).actions, ["archive", "delete", "abort", "retry"]);

  await s.call("DELETE", `/v1/threads/${fix.id}`);
  s.fake.calls.length = 0;
  assert.deepEqual(await state(), {
    actions: [], prompt: false, running: false, visit: false, conversation: "Conversation The thread is deleted, so its conversation is gone.",
  });
  assert.deepEqual(s.fake.calls, [], "a deleted thread's conversation is not read");
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
  assert.equal(textOf(`<section${sectionOf(html, "Conversation")}`), "Conversation The thread is deleted, so its conversation is gone.");
});

test("a conversation that cannot be read says why, and the rest of the page still renders", async (t) => {
  const s = await seeded(t);
  const fix = await s.start("acme", "Fix checkout");
  s.fake.harness.watch = async () => { throw new Error("the harness has no conversation for thread x"); };
  const res = await s.call("GET", `/threads/${fix.id}`);
  assert.equal(res.status, 200);
  assert.match(textOf(sectionOf(res.text, "Conversation")), /The conversation could not be read: the harness has no conversation for thread x/);
  assert.match(textOf(sectionOf(res.text, "Pylon")), /Desired running/);
});

test("strings from humans and probes are escaped, never markup", async (t) => {
  const s = await seeded(t);
  const evil = await s.start("acme", `<img src=x onerror="alert(1)">`);
  s.registry.apply({ record: "output", pylonId: evil.pylonId, kind: "branch", ref: `"><script>alert(2)</script>` });
  const transcript = s.fake.transcript(evil.id);
  transcript.messages.push(
    { role: "user", content: "<script>alert(3)</script>", timestamp: 0 },
    assistant([
      { type: "text", text: "<script>alert(4)</script>" },
      { type: "toolCall", id: `"><script>alert(5)</script>`, name: "<script>alert(6)</script>", arguments: { command: "</code><script>alert(7)</script>", x: "<script>alert(8)</script>" } },
    ]),
    { ...result(`"><script>alert(5)</script>`, "<script>alert(9)</script>"), toolName: "<script>alert(6)</script>" } as Message,
  );
  transcript.docs["pi.inbox"] = { items: [{ id: 1, mode: "followUp", content: "<script>alert(10)</script>" }] };
  for (const path of ["/", `/threads/${evil.id}`]) {
    const { text } = await s.call("GET", path);
    assert.ok(!text.includes("<img src=x") && !text.includes("<script>alert"), `${path} renders the strings as text`);
    assert.ok(textOf(text).includes(`<img src=x onerror="alert(1)">`), `${path} still shows the title`);
  }
  const page = textOf((await s.call("GET", `/threads/${evil.id}`)).text);
  // alert(5) is the call's ID, which is only an attribute.
  for (const i of [3, 4, 6, 7, 8, 9, 10]) assert.ok(page.includes(`<script>alert(${i})</script>`), `the conversation shows alert(${i}) as text`);
});

test("an unknown thread page is a 404 page", async (t) => {
  const s = await setup(t);
  const res = await s.call("GET", "/threads/th-missing");
  assert.equal(res.status, 404);
  assert.match(res.headers["content-type"] as string, /^text\/html/);
  assert.match(textOf(res.text), /No thread th-missing\./);
});

test("the start page offers every project and node, and warns when no image is current", async (t) => {
  const s = await setup(t);
  assert.match(textOf((await s.call("GET", "/threads/new")).text), /No projects yet/);
  for (const id of ["acme", "beta"]) await s.call("POST", "/v1/projects", project(id));

  const page = (await s.call("GET", "/threads/new?project=beta")).text;
  assert.deepEqual([...page.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]), ["acme", "beta", "", node]);
  assert.match(page, /<option value="beta" selected>/);
  assert.match(textOf(page), /No image is current yet/);

  await s.call("POST", "/v1/images", image);
  await s.call("PUT", "/v1/images/current", { image: image.id });
  assert.doesNotMatch(textOf((await s.call("GET", "/threads/new")).text), /No image is current yet/);
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
  assert.match(textOf(sectionOf((await s.call("GET", `/threads/${fix.id}`)).text, "Pylon")), /Observed pausing/);
});
