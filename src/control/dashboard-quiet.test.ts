import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { Thread } from "./thread-store.ts";
import type { ImageId, NodeName, TailnetNodeId } from "../ids.ts";
import { runningPylon, testCapacity, testImage, testObservation } from "../test-kit.ts";
import { testApi } from "./api-test-kit.ts";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const image = testImage();
const capacity = testCapacity();
const hour = 60 * 60 * 1000;

/** A control plane with project acme and its image, and the clock stopped at now. */
async function seeded(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const api = await testApi(t, { pipeline: true, planning: false, allowed: new Set([laptop]), probes: new Map() });
  const { registry } = api;
  function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: api.port, method, path, agent: false,
        headers: { host: `127.0.0.1:${api.port}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const project = {
    id: "acme", repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  };
  assert.equal((await call("POST", "/v1/projects", project)).status, 201);
  assert.equal((await call("POST", "/v1/images", image)).status, 201);
  registry.setCurrentImage(image.id as ImageId);
  async function start(title: string): Promise<Thread> {
    const res = await call("POST", "/v1/threads", { project: "acme", title });
    assert.equal(res.status, 201, res.text);
    return JSON.parse(res.text) as Thread;
  }
  /** Reports the node online with these pylons running and every other pylon absent. */
  function observe(...threads: Thread[]) {
    registry.apply({ record: "node", node, state: "online", capacity });
    const pylons = threads.map((th) => runningPylon(th.pylonId, { liveHash: registry.pylon(th.pylonId)!.liveHash, bootedFrom: { image: image.id, checkpoint: null } }));
    registry.ingested(testObservation(node, { pylons }), []);
  }
  const page = async (path = "/") => (await call("GET", path)).text;
  return { registry, start, observe, page, tick: (ms: number) => t.mock.timers.tick(ms) };
}

/** The page as a reader sees it: tags dropped, entities decoded, whitespace collapsed. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/** Acme's overview as a reader takes it in: the titles its table lists, the quiet fold's tag and summary, and the titles in it. */
function overviewOf(html: string) {
  const section = html.split("<section").find((chunk) => chunk.includes('aria-labelledby="project-acme"'))!.split("</section>")[0]!;
  const [listed, fold = ""] = section.split(/(?=<details class="ov-closed" id="quiet-acme")/);
  const quiet = fold.split("</details>")[0]!;
  const titles = (part: string) => [...part.matchAll(/<a href="\/threads\/[^"]+">([^<]*)<\/a>/g)].map((m) => m[1]).toSorted();
  return { listed: titles(listed!), tag: /^<details[^>]*>/.exec(quiet)?.[0], summary: /<summary>([^<]*)<\/summary>/.exec(quiet)?.[1], folded: titles(quiet), text: textOf(section) };
}

/** Acme's sidebar group the same way, each row read as its status dot's name, then its text. */
function sidebarOf(html: string) {
  const nav = html.split('id="side-threads"')[1]!.split("</nav>")[0]!;
  const [listed, fold = ""] = nav.split(/(?=<details class="archived" id="side-quiet-acme")/);
  const quiet = fold.split("</details>")[0]!;
  const rows = (part: string) => [...part.matchAll(/<a class="row[^"]*" href="\/threads\/[^"]+"[^>]*>(.*?)<\/a>/g)].map((m) => `${/aria-label="([^"]*)"/.exec(m[1]!)![1]} ${textOf(m[1]!)}`).toSorted();
  return { listed: rows(listed!), tag: /^<details[^>]*>/.exec(quiet)?.[0], summary: /<summary>([^<]*)<\/summary>/.exec(quiet)?.[1], folded: rows(quiet) };
}

test("a thread quiet for over 8 hours folds away in the overview and the sidebar, and one active 7 hours ago stays listed", async (t) => {
  const s = await seeded(t);
  const fresh = await s.start("Fresh");
  await s.start("Old");
  s.tick(2 * hour);
  s.registry.recordActivity(fresh.id, { human: Date.now() });
  s.tick(7 * hour);
  s.observe();

  const html = await s.page();
  assert.deepEqual(overviewOf(html).listed, ["Fresh"], "the overview's table lists the thread active 7 hours ago");
  assert.deepEqual(overviewOf(html).folded, ["Old"], "the overview folds the thread quiet for 9 hours");
  assert.deepEqual(sidebarOf(html).listed, ["not on its node Fresh 7 h"]);
  assert.deepEqual(sidebarOf(html).folded, ["not on its node Old 9 h"]);
});

test("a quiet thread with an unread reply still folds away, and a reply 7 hours ago keeps one listed", async (t) => {
  const s = await seeded(t);
  const replied = await s.start("Replied");
  const answered = await s.start("Answered");
  s.registry.recordReply(replied.id, Date.now());
  s.tick(2 * hour);
  s.registry.recordReply(answered.id, Date.now());
  s.tick(7 * hour);
  s.observe();

  const html = await s.page();
  assert.deepEqual(overviewOf(html).listed, ["Answered"]);
  assert.deepEqual(overviewOf(html).folded, ["Replied"]);
  assert.deepEqual(sidebarOf(html).listed, ["new reply Answered 7 h"]);
  assert.deepEqual(sidebarOf(html).folded, ["new reply Replied 9 h"]);
});

test("a running pylon or a working agent keeps a thread listed however old its activity", async (t) => {
  const s = await seeded(t);
  const running = await s.start("Running");
  const working = await s.start("Working");
  await s.start("Idle");
  s.registry.recordActivity(working.id, { agent: Date.now(), agentTurnRunning: true });
  s.tick(30 * hour);
  s.observe(running);

  const html = await s.page();
  assert.deepEqual(overviewOf(html).listed, ["Running", "Working"]);
  assert.deepEqual(overviewOf(html).folded, ["Idle"], "only the idle thread with its pylon absent folds");
  assert.deepEqual(sidebarOf(html).listed, ["agent working Working working 30h 00m", "running Running 30 h"]);
  assert.deepEqual(sidebarOf(html).folded, ["not on its node Idle 30 h"]);
});

test("the overview's quiet fold counts its threads, lists them in its own table, and starts closed", async (t) => {
  const s = await seeded(t);
  await s.start("Old spike");
  await s.start("Older spike");
  s.tick(9 * hour);
  s.observe();

  const overview = overviewOf(await s.page());
  assert.deepEqual(overview.listed, [], "no table lists threads above the fold");
  assert.doesNotMatch(overview.text, /No open threads/, "the project does not claim it has no open threads");
  assert.equal(overview.summary, "2 quiet for over 8 hours");
  assert.equal(overview.tag, '<details class="ov-closed" id="quiet-acme">', "the fold starts closed");
  assert.match(overview.text, /2 quiet for over 8 hours Thread Desired Observed Node Human Agent (Old spike|Older spike) .* (Old spike|Older spike) /);
  assert.deepEqual(overview.folded, ["Old spike", "Older spike"]);
});

test("the sidebar folds quiet threads closed, and a quiet thread's page opens the fold", async (t) => {
  const s = await seeded(t);
  const old = await s.start("Old spike");
  await s.start("Older spike");
  s.tick(9 * hour);
  const fresh = await s.start("Fresh");
  s.observe();

  const home = sidebarOf(await s.page());
  assert.deepEqual(home.listed, ["not on its node Fresh now"]);
  assert.equal(home.summary, "2 quiet for over 8 hours");
  assert.deepEqual(home.folded, ["not on its node Old spike 9 h", "not on its node Older spike 9 h"]);
  assert.equal(home.tag, '<details class="archived" id="side-quiet-acme">', "the fold starts closed");
  assert.equal(sidebarOf(await s.page(`/threads/${fresh.id}`)).tag, '<details class="archived" id="side-quiet-acme">', "a recent thread's page keeps the fold closed");
  assert.equal(sidebarOf(await s.page(`/threads/${old.id}`)).tag, '<details class="archived" id="side-quiet-acme" open>', "a quiet thread's page opens the fold");
});

test("a thread moves into the fold on the render after it turns quiet, and out on the one after it wakes", async (t) => {
  const s = await seeded(t);
  const old = await s.start("Old spike");
  s.observe();
  s.tick(8 * hour);
  assert.deepEqual(overviewOf(await s.page()).listed, ["Old spike"], "8 hours exactly is not over 8 hours");
  s.tick(1);
  assert.deepEqual(overviewOf(await s.page()).folded, ["Old spike"]);

  s.registry.recordActivity(old.id, { human: Date.now() });
  const html = await s.page();
  assert.deepEqual(overviewOf(html).listed, ["Old spike"]);
  assert.equal(overviewOf(html).tag, undefined);
  assert.deepEqual(sidebarOf(html).listed, ["not on its node Old spike now"]);
  assert.equal(sidebarOf(html).tag, undefined);
});
