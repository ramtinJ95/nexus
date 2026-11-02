import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Thread } from "./thread-store.ts";
import type { Review, Round } from "./review-model.ts";
import type { ImageId, NodeName, TailnetNodeId } from "../ids.ts";
import { checkCaller, reviewerCaller, verifyCaller } from "../agent-protocol.ts";
import { runningPylon, stoppedPylon, testCapacity, testImage, testObservation } from "../test-kit.ts";
import { testReview } from "./test-kit.ts";
import { testApi } from "./api-test-kit.ts";

const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
const image = testImage();

async function setup(t: TestContext) {
  const s = await testApi(t, { pipeline: true, planning: true, allowed: new Set([laptop]), probes: new Map() });
  assert.equal((await s.call("POST", "/v1/projects", {
    id: "acme", repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  })).status, 201);
  assert.equal((await s.call("POST", "/v1/images", image)).status, 201);
  s.registry.setCurrentImage(image.id as ImageId);
  const start = async (body: Record<string, unknown>) => {
    const res = await s.call("POST", "/v1/threads", { project: "acme", ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as Thread;
  };
  const page = async (path: string) => (await s.raw(path)).body.toString("utf8");
  /** Reports the node online with these pylons, as an ingested probe snapshot would. */
  const observe = (running: readonly Thread[], paused: readonly Thread[] = []) => {
    s.registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
    s.registry.ingested(testObservation(node, {
      pylons: [
        ...running.map((th) => runningPylon(th.pylonId, { liveHash: s.registry.pylon(th.pylonId)!.liveHash, bootedFrom: { image: image.id, checkpoint: null } })),
        ...paused.map((th) => stoppedPylon(th.pylonId, { checkpoint: `ck-${th.id}` as never })),
      ],
    }), []);
  };
  return { ...s, start, page, observe };
}

const approve = () => ({ token: "t", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: null });

/** A builder with PR #7 under review, the review's reviewer, the check it runs now and the live check of an earlier round. */
async function reviewed(t: TestContext) {
  const s = await setup(t);
  const builder = await s.start({ title: "Cache the totals" });
  const reviewer = await s.startThread({ project: "acme", title: "Review of #7: Cache", branch: "cache" }, reviewerCaller);
  const check = await s.startThread({ project: "acme", title: "Check of cache at 222222222222", branch: "cache", commit: "2".repeat(40), bare: true }, checkCaller);
  const verify = await s.startThread({ project: "acme", title: "Live check of cache at 111111111111", branch: "cache", commit: "1".repeat(40), bare: true }, verifyCaller);
  const rounds: Round[] = [
    { head: "1".repeat(40), verdict: approve(), check: { passed: true, output: "ok" }, live: { kind: "ran", thread: verify.id, passed: false, output: "boot failed" }, answers: [] },
    { head: "2".repeat(40), verdict: approve(), check: null, answers: null },
  ];
  const review = testReview({
    builder: builder.id, reviewer: reviewer.id, rounds, phase: { kind: "checking", startedAt: Date.now(), thread: check.id },
    pr: { repo: "acme/repo", number: 7, url: "https://github.com/acme/repo/pull/7", title: "Cache", branch: "cache" },
  });
  s.registry.saveReview(review);
  return { s, builder, reviewer, check, verify, review };
}

/** The page as a reader sees it: tags dropped, entities decoded, whitespace collapsed. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
/** What sits under a thread page's bar, where a builder's track is. */
const underBar = (page: string) => page.split('id="life"')[1]!.split('<div class="tabs"')[0]!;
const flightOf = (page: string) => page.split('id="flight"')[1]!.split('id="overview"')[0]!;
const peekOf = (page: string) => page.split('id="peek"')[1]!.split('id="in-flight"')[0]!;
const chipOf = (page: string) => /<span class="chip-label">([^<]*)<\/span>/.exec(page)![1];
const dockOf = (page: string) => textOf(page.split('id="agent-state"')[1]!.split("</div>")[0]!.replace(/^[^>]*>/, ""));

test("a reviewer, check or verify thread's page says in one line whose pull request it serves and where that is, with no track or timeline", async (t) => {
  const { s, builder, reviewer, check, verify, review } = await reviewed(t);
  const lines = {
    [reviewer.id]: "Reviewer of PR #7 for Cache the totals running the checks",
    [check.id]: "Check of PR #7 for Cache the totals running",
    [verify.id]: "Live check of PR #7 for Cache the totals failed",
  };
  for (const [id, line] of Object.entries(lines)) {
    const page = await s.page(`/threads/${id}`);
    const under = underBar(page);
    assert.equal(textOf(under.replace(/^[^>]*>/, "")), line);
    assert.match(under, new RegExp(`href="/threads/${builder.id}"`), "it links its builder");
    assert.match(under, /href="https:\/\/github\.com\/acme\/repo\/pull\/7"/);
    assert.doesNotMatch(page, /class="life"|Building/, "no builder track");
    assert.doesNotMatch(page, /id="timeline-view"|data-tab="timeline"/, "no timeline of builder steps");
  }
  s.registry.saveReview({ ...review, phase: { kind: "reviewing" }, rounds: [...review.rounds, { head: "3".repeat(40), verdict: null, check: null, answers: null }] });
  assert.equal(textOf(underBar(await s.page(`/threads/${reviewer.id}`)).replace(/^[^>]*>/, "")), "Reviewer of PR #7 for Cache the totals reviewing round 3");
  const carried: Round = { head: "4".repeat(40), verdict: approve(), check: null, answers: null, carried: { from: "3".repeat(40) } };
  s.registry.saveReview({ ...review, phase: { kind: "reviewing" }, rounds: [review.rounds[0]!, carried, { head: "5".repeat(40), verdict: null, check: null, answers: null }] });
  assert.equal(textOf(underBar(await s.page(`/threads/${reviewer.id}`)).replace(/^[^>]*>/, "")), "Reviewer of PR #7 for Cache the totals reviewing round 2", "a carried approval spends no round");
  s.registry.saveReview({ ...review, phase: { kind: "landed", commit: "3".repeat(40) } } satisfies Review);
  assert.equal(textOf(underBar(await s.page(`/threads/${reviewer.id}`)).replace(/^[^>]*>/, "")), "Reviewer of PR #7 for Cache the totals landed");

  const own = await s.page(`/threads/${builder.id}`);
  assert.match(underBar(own), /<ol class="life"/, "its builder keeps the track");
  assert.match(own, /id="timeline-view"/);
});

test("a planning thread's page says what it is in place of the track", async (t) => {
  const s = await setup(t);
  const plan = await s.start({ title: "Plan the wave", planning: true });
  const page = await s.page(`/threads/${plan.id}`);
  assert.equal(textOf(underBar(page).replace(/^[^>]*>/, "")), "Planning thread. Each item it proposes waits for you to accept it.");
  assert.doesNotMatch(page, /class="life"|id="timeline-view"/);
});

test("home's In flight lists only builder threads, with no line for a review's reviewer, check or verify thread or a planning thread", async (t) => {
  const { s, builder, reviewer, check, verify } = await reviewed(t);
  const plan = await s.start({ title: "Plan the wave", planning: true });
  s.observe([builder, reviewer, check, verify, plan]);
  const home = await s.page("/");
  const flight = flightOf(home);
  assert.match(flight.split('id="phase-review"')[1]!.split("</section>")[0]!, new RegExp(`data-peek="${builder.id}"`), "the builder is in review");
  for (const other of [reviewer, check, verify, plan]) assert.doesNotMatch(flight, new RegExp(other.id), other.title);
  assert.doesNotMatch(flight.split('id="phase-building"')[1]!.split("</section>")[0]!, /fl-row/, "nothing is building");
  assert.match(home, /<span class="count" id="flight-n" data-live>1<\/span>/, "only the builder is in flight");

  const peek = peekOf(await s.page(`/?peek=${reviewer.id}`));
  assert.doesNotMatch(peek, /class="life"/, "a reviewer's preview has no track");
  assert.match(textOf(peek), /Reviewer of PR #7 for Cache the totals running the checks/);
});

test("the header and the dock agree: an idle agent on a running pylon reads agent idle, and the pylon's state shows once it is not running", async (t) => {
  const s = await setup(t);
  const fix = await s.start({ title: "Fix checkout" });
  s.observe([fix]);
  const running = await s.page(`/threads/${fix.id}`);
  assert.equal(chipOf(running), "agent idle");
  assert.match(dockOf(running), /^Idle /);

  s.observe([], [fix]);
  const paused = await s.page(`/threads/${fix.id}`);
  assert.equal(chipOf(paused), "paused");
  assert.match(dockOf(paused), /^Idle .*the pylon is paused/);
});

test("the header reads agent working while the agent works on a running pylon, as the dock does", async (t) => {
  const s = await setup(t);
  const fix = await s.start({ title: "Fix checkout" });
  s.observe([fix]);
  s.registry.recordActivity(fix.id, { agent: Date.now(), agentTurnRunning: true });
  s.fake.transcript(fix.id).docs["pi.live"] = { run: { taskId: 1, inputs: [1] } };
  const page = await s.page(`/threads/${fix.id}`);
  assert.equal(chipOf(page), "agent working");
  assert.match(dockOf(page), /^Working /);
});

test("a thread started by neither a person's node nor the review loop is a builder, in flight with its track", async (t) => {
  const s = await setup(t);
  const fix = await s.startThread({ project: "acme", title: "Fix checkout" }, "nexus-queue");
  s.observe([fix]);
  const home = await s.page("/");
  assert.match(flightOf(home).split('id="phase-building"')[1]!.split("</section>")[0]!, new RegExp(`data-peek="${fix.id}"`));
  assert.match(underBar(await s.page(`/threads/${fix.id}`)), /<ol class="life"/);
});
