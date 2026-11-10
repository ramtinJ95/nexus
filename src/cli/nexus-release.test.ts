/**
 * nexus deploy, release, image, review and land, against the control plane's real API with a fake harness behind it.
 * src/test-support/cli-kit.ts says when a test runs the CLI in its own process and when as a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { Thread } from "../control/thread-store.ts";
import type { ThreadDetail } from "../control/wire.ts";
import { personPhase, type Review } from "../control/review-model.ts";
import { reviewView } from "../control/review-view.ts";
import { reviewSaid } from "../control/wording.ts";
import type { Question } from "../control/questions.ts";
import { testReview } from "../test-support/registry-kit.ts";
import type { ReviewLoop } from "../control/review.ts";
import type { ImageManifest } from "../protocol/images.ts";
import type { ImageOperation } from "../contract/release.ts";
import { commands } from "./commands/index.ts";
import type { ImageId, JobId, NodeName, ThreadId } from "../ids.ts";
import type { ImageFetch } from "../control/image-store.ts";
import { testCapacity, testObservation, until } from "../test-support/kit.ts";
import { CliError } from "./transport.ts";
import type { Api, Result } from "./kit.ts";
import { answeredText, pressOf } from "./commands/release.ts";
import { version } from "../version.ts";
import { node, laptop, image, setup } from "../test-support/cli-kit.ts";

const approvedRound = { head: "1".repeat(40), verdict: { token: "a", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: null }, check: { passed: true, output: "ok" }, live: { kind: "ran" as const, thread: "th-0123456789ab" as ThreadId, passed: true, output: "ok" }, answers: null };

/** A terminal whose person types `answer`, or closes it without a line when null, and what it showed them. */
function confirmingTerminal(answer: string | null, isTTY = true) {
  const shown: string[] = [];
  const input = Object.assign(new PassThrough(), { isTTY });
  const output = Object.assign(new PassThrough(), { isTTY });
  output.on("data", (chunk: Buffer) => {
    shown.push(chunk.toString());
    if (answer === null) input.end();
    else input.write(`${answer}\n`);
  });
  return { terminal: { input, output }, shown: () => shown.join("") };
}

test("deploy and release use the shared release view and wait for both roles", async (t) => {
  const s = await setup(t);
  assert.equal((await s.nexus(["--version"])).stdout.trim(), `nexus ${version}`);
  assert.equal((await s.nexus(["deploy", "bad"])).code, 64);
  const requested = await s.json(["deploy", "main"]);
  assert.equal(requested.desired.commit, "a".repeat(40));
  assert.equal(requested.desired.requestedBy, laptop);
  for (const role of ["control", "probe"] as const) s.registry.releases.reportRelease({ node, role, commit: requested.desired.commit, target: requested.desired.commit, state: "healthy", reason: null, observedAt: Date.now() });
  assert.equal((await s.json(["deploy", "main", "--wait"])).nodes.every((r: { state: string }) => r.state === "healthy"), true);
  assert.equal((await s.json(["release"])).desired.commit, requested.desired.commit);
  s.registry.releases.reportRelease({ node, role: "probe", commit: requested.desired.commit, target: requested.desired.commit, state: "healthy", reason: null, worker: "bootstrap", observedAt: Date.now() });
  assert.match((await s.nexus(["release"])).stdout, new RegExp(`^${node} probe: ${requested.desired.commit} healthy \\(worker bootstrap\\)$`, "m"));
  assert.equal((await s.json(["release"])).nodes.find((r: { role: string }) => r.role === "probe").worker, "bootstrap");
  const rollback = { node, role: "control" as const, commit: "b".repeat(40), target: requested.desired.commit, state: "rolled-back" as const, reason: "failed to bind", observedAt: Date.now() };
  s.registry.releases.reportRelease(rollback);
  const asked = s.requests();
  const failing = s.nexus(["deploy", "main", "--wait", "--json"]);
  await until("the wait polled past the rollback of the earlier request", () => s.requests() >= asked + 4);
  s.registry.releases.reportRelease({ ...rollback, reason: "failed to bind again", observedAt: Date.now() });
  const failed = await failing;
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /failed to bind again/);
});

test("deploy --wait on a terminal writes each change of the release to stderr, and Ctrl-C says the deployment carries on", async (t) => {
  const s = await setup(t);
  const target = (await s.json(["deploy", "main"])).desired.commit as string;
  const waiting = s.onTerminal(["deploy", "main", "--wait"]);
  await until("the wait shows the release it waits for", () => waiting.stderr().includes(`Desired: ${target}`));
  s.registry.releases.reportRelease({ node, role: "control", commit: "b".repeat(40), target, state: "installing", reason: null, observedAt: Date.now() });
  await until("the wait shows the release's change", () => waiting.stderr().includes(`${node} control: ${"b".repeat(40)} installing`));
  waiting.child.kill("SIGINT");
  const stopped = await waiting.exited;
  assert.deepEqual([stopped.code, stopped.stdout], [130, ""], stopped.stderr);
  assert.equal(stopped.stderr.split("\n").filter((line) => line.startsWith("Desired: ")).length, 2, "each state is written once, when it changes");
  assert.ok(stopped.stderr.endsWith("Stopped waiting. The deployment carries on, and `nexus release` shows where it is\n"), stopped.stderr);

  const asked = s.requests();
  const quiet = s.nexus(["deploy", "main", "--wait"]);
  await until("the wait off a terminal polls", () => s.requests() >= asked + 3);
  for (const role of ["control", "probe"] as const) s.registry.releases.reportRelease({ node, role, commit: target, target, state: "healthy", reason: null, observedAt: Date.now() });
  const done = await quiet;
  assert.deepEqual([done.code, done.stderr], [0, ""], "off a terminal the wait writes nothing to stderr");
});

test("image build --wait ends with the rollout to run next, which stays a command of its own", async () => {
  const built: ImageOperation = { kind: "build", release: null, image: image.id, requestedBy: laptop, requestedAt: 1, steps: [{ node, state: "running", job: null, reason: null }], state: "running" };
  const asked: string[] = [];
  const api: Api = async (method, path) => {
    asked.push(`${method} ${path}`);
    if (method === "POST") return built;
    return { current: image.id, previous: null, images: [], operation: { ...built, steps: [{ node, state: "done", job: null, reason: null }], state: "done", finishedAt: 2 } };
  };
  const result = await commands["image build"]!.run(api, [], { wait: true }, null as never, { connect: null as never, versions: null as never, io: process });
  assert.deepEqual(asked, ["POST /v1/images/build", "GET /v1/images"], "it rolls nothing out");
  assert.equal((result as Result).text, `No images.\nbuild ${image.id}: done\n  ${node}: done\nRoll it out to every online node with: nexus image rollout ${image.id} --wait`);
});

test("image list and current print each image's role, build, release and nodes, and rollout --wait follows the rollout until it is done", async (t) => {
  const s = await setup(t);
  const older: ImageManifest = { ...image, id: "img-00000000000a" as ImageId, builtAt: "2026-12-01T00:00:00Z" };
  s.registry.images.saveImage(older, "f".repeat(40));
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  s.registry.threads.ingested(testObservation(node, { artifacts: [image.id, older.id] }), []);
  const entry = { ...image, release: null, nodes: [node] };
  const olderEntry = { ...older, release: "f".repeat(40), nodes: [node] };

  assert.equal((await s.nexus(["image", "list"])).stdout, [
    "img-0123456789ab  current  built 2027-01-01T00:00:00Z on rj-firebat  release unknown       on rj-firebat",
    "img-00000000000a  -        built 2026-12-01T00:00:00Z on rj-firebat  release ffffffffffff  on rj-firebat",
  ].join("\n") + "\n");
  assert.deepEqual(await s.json(["image", "list"]), { current: image.id, previous: null, images: [entry, olderEntry], operation: null, fetches: [] });
  const fetches: ImageFetch[] = [
    { node: "infra-testbench" as NodeName, image: image.id, state: "running", job: { id: "j-fetch" as JobId, notAfter: new Date().toISOString() }, failures: 0, failedAt: null, reason: null },
    { node: "rj-nuc" as NodeName, image: image.id, state: "failed", job: null, failures: 3, failedAt: Date.now(), reason: "backend: the copy hashes to 0000, so it was thrown away" },
  ];
  s.registry.images.saveImageFetches(fetches);
  assert.equal((await s.nexus(["image", "list"])).stdout, [
    "img-0123456789ab  current  built 2027-01-01T00:00:00Z on rj-firebat  release unknown       on rj-firebat",
    "img-00000000000a  -        built 2026-12-01T00:00:00Z on rj-firebat  release ffffffffffff  on rj-firebat",
    "Fetches of the current image img-0123456789ab:",
    "  infra-testbench: running",
    "  rj-nuc: failed, 3 failed: backend: the copy hashes to 0000, so it was thrown away",
  ].join("\n") + "\n");
  assert.deepEqual((await s.json(["image", "list"])).fetches, fetches);
  assert.equal((await s.nexus(["image", "current"])).stdout, "img-0123456789ab  current  built 2027-01-01T00:00:00Z on rj-firebat  release unknown  on rj-firebat\n");

  const rolled = await s.nexus(["image", "rollout", older.id, "--wait"]);
  assert.equal(rolled.code, 0, rolled.stderr);
  assert.equal(rolled.stderr, "", "off a terminal the wait writes nothing to stderr");
  assert.equal(rolled.stdout, [
    "img-0123456789ab  previous  built 2027-01-01T00:00:00Z on rj-firebat  release unknown       on rj-firebat",
    "img-00000000000a  current   built 2026-12-01T00:00:00Z on rj-firebat  release ffffffffffff  on rj-firebat",
    "rollout img-00000000000a: done",
    "  rj-firebat: done",
  ].join("\n") + "\n");
  assert.deepEqual(await s.json(["image", "current"]), { current: olderEntry, previous: entry });

  const unknown = await s.nexus(["image", "rollout", "img-ffffffffffff", "--json"]);
  assert.deepEqual([unknown.code, JSON.parse(unknown.stderr)], [4, { error: "no image img-ffffffffffff is recorded", kind: "not-found", status: 404, code: null }]);
});

test("review and land reach the review loop's routes, and show prints a review and what it needs from the person", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Cache"]);
  const refused = await s.nexus(["review", thread.id, "--json"]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /github.tokenFile/);
  assert.equal((await s.nexus(["land", thread.id])).code, 5);
  assert.equal((await s.nexus(["review", thread.id, "--rounds", "two"])).code, 64);
  assert.equal((await s.nexus(["review", thread.id, "--rounds", "6"])).code, 64, "a review runs at most 5 rounds");
  const review = testReview({
    builder: thread.id, pr: { repo: "octocat/Spoon-Knife", number: 7, url: "https://github.com/octocat/Spoon-Knife/pull/7", title: "Cache", branch: "cache" }, reviewerKind: "claude",
    models: { builder: "gpt-6-astra", reviewer: "claude-opus-5-5" },
    phase: { ...personPhase("rounds", "The reviewer still requests changes after 5 rounds, the most this review allows.", "Nexus could not add the label \"needs human review\" to pull request #7 (GitHub answered 403: Forbidden)."), label: { state: "failed", why: "GitHub answered 403: Forbidden" } },
  });
  s.registry.reviews.saveReview(review);
  const shown = await s.nexus(["show", thread.id]);
  assert.match(shown.stdout, /^attention: decision$/m);
  assert.match(shown.stdout, /^review rv-1 of PR #7: needs-person, round 1 of 5, reviewer th-reviewer on claude-opus-5-5, label "needs human review" not added$/m);
  assert.match(shown.stdout, /^needs you: The reviewer still requests changes after 5 rounds, the most this review allows\.$/m);
  assert.match(shown.stdout, /^needs you: Nexus could not add the label "needs human review" to pull request #7 \(GitHub answered 403: Forbidden\)\.$/m);
  const json: ThreadDetail = await s.json(["show", thread.id]);
  assert.ok(!("review" in json), "show --json sends no stored review, and so no token");
  assert.deepEqual(json.reviewView, reviewView(review, []));

  s.registry.reviews.saveReview({ ...review, phase: { kind: "cancelled", who: "reviewer", status: "archived" } });
  const cancelled = await s.nexus(["show", thread.id]);
  assert.match(cancelled.stdout, /^review rv-1 of PR #7: cancelled, round 1 of 5, reviewer th-reviewer on claude-opus-5-5, the reviewer thread th-reviewer was archived$/m);
  assert.doesNotMatch(cancelled.stdout, /^attention: decision$|^needs you:/m);
  s.registry.reviews.saveReview({ ...review, phase: { kind: "merged" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^review rv-1 of PR #7: merged, round 1 of 5, reviewer th-reviewer on claude-opus-5-5$/m);

  const head = "1".repeat(40);
  const checked = { ...review.rounds[0]!, check: { passed: true, output: "ok" } };
  s.registry.reviews.saveReview({ ...review, rounds: [checked], phase: { kind: "verifying", startedAt: 0, thread: "th-0123456789ab" as ThreadId } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^review rv-1 of PR #7: verifying, .*\nlive check running \.nexus\/verify at 111111111111 in verify pylon th-0123456789ab$/m);
  s.registry.reviews.saveReview({ ...review, rounds: [{ ...checked, live: { kind: "ran", thread: "th-0123456789ab" as ThreadId, passed: false, output: "booting the fleet\nthe thread never reported running" } }], phase: { kind: "fixing" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^live check failed at 111111111111\n {2}booting the fleet\n {2}the thread never reported running$/m);
  s.registry.reviews.saveReview({ ...review, rounds: [{ ...checked, live: { kind: "ran", thread: "th-0123456789ab" as ThreadId, passed: true, output: "fleet ok" } }], phase: { kind: "approved" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^live check passed at 111111111111$/m);
  s.registry.reviews.saveReview({ ...review, rounds: [checked], phase: personPhase("no-verdict", { code: "live-failed", text: `The live check could not run at ${head}.` }) });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^no live check ran at 111111111111$/m, "a live check that gave no verdict is not a missing script");
  s.registry.reviews.saveReview({ ...review, rounds: [{ ...checked, live: { kind: "absent" } }], phase: { kind: "approved" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^no live check: ${head.slice(0, 12)} has no \\.nexus/verify, so the landing reads the pull request's statement of what could not be checked live$`, "m"));

  const approval = { ...checked, verdict: { token: "a", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: null } };
  s.registry.reviews.saveReview({ ...review, rounds: [approval, { head: "2".repeat(40), verdict: null, check: null, answers: null }], phase: { kind: "reviewing" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^review rv-1 of PR #7: reviewing, round 2 of 5, .*\na new round reviews 222222222222, since the pull request's head moved from 111111111111 after its approval$/m);

  const hold = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  s.registry.reviews.saveReview({ ...review, land: { requestedBy: "nLAPTOP" }, phase: { kind: "landed", commit: "4".repeat(40) }, waiver: { head: "1".repeat(40), holds: [hold], codes: ["reserved-path:auth"], by: "nLAPTOP", at: Date.UTC(2026, 9, 27, 9), change: null } });
  const waived = await s.nexus(["show", thread.id]);
  assert.match(waived.stdout, new RegExp(`^waived by nLAPTOP at ${"1".repeat(40)}, 2026-10-27T09:00:00.000Z:\n  ${hold.replace(/[.()]/g, "\\$&")}$`, "m"));
  const events = await s.nexus(["events", "--thread", thread.id, "--kind", "review.waived"]);
  assert.match(events.stdout, /review.waived/);
});

test("show says when a review's approval and the person's waiver carried to a rebased head, and why a waiver did not", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Cache"]);
  const [a, b] = ["1".repeat(40), "2".repeat(40)];
  const verdict = { token: "a", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: null };
  const hold = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  const review = testReview({
    builder: thread.id, pr: { repo: "octocat/Spoon-Knife", number: 7, url: "https://github.com/octocat/Spoon-Knife/pull/7", title: "Cache", branch: "cache" },
    rounds: [{ head: a, verdict, check: { passed: true, output: "ok" }, answers: null }, { head: b, verdict, check: null, answers: null, carried: { from: a } }],
    phase: { kind: "checking", startedAt: 0, thread: null },
    waiver: { head: b, from: a, holds: [hold], codes: ["reserved-path:auth"], by: "nLAPTOP", at: Date.UTC(2026, 10, 1, 9), change: { kind: "known", base: "main", files: [] } },
  });
  s.registry.reviews.saveReview(review);
  const shown = (await s.nexus(["show", thread.id])).stdout;
  assert.match(shown, /^review rv-1 of PR #7: checking, round 1 of 5, .*\napproval carried from 111111111111 to 222222222222: same change after a rebase$/m, "a carried approval spends no round");
  assert.match(shown, new RegExp(`^waived by nLAPTOP at ${b} \\(carried from ${a}\\), 2026-11-01T09:00:00.000Z:$`, "m"));

  const differs = "The change at 222222222222 differs from the one nLAPTOP pressed Land for at 111111111111, in src/control/api.ts, so that waiver does not carry over. Look at that file again, and press Land to waive the holds at 222222222222.";
  s.registry.reviews.saveReview({ ...review, phase: personPhase("policy", { code: "waiver-not-carried", text: differs }, { code: "reserved-path:auth", text: hold }) });
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^needs you: ${differs.replace(/[.()]/g, "\\$&")}$`, "m"));
});

test("review --cancel ends the thread's running review through its route, and prints who cancelled it", async (t) => {
  const asked: unknown[][] = [];
  let review: Review | null = null;
  const reviews = { cancel(builder: ThreadId, by: string) { asked.push([builder, by]); return { ...review!, phase: { kind: "cancelled", who: "person", by } }; } } as never as ReviewLoop;
  const s = await setup(t, { reviews });
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Cache"]);
  review = testReview({ builder: thread.id, pr: { repo: "octocat/Spoon-Knife", number: 7, url: "https://github.com/octocat/Spoon-Knife/pull/7", title: "Cache", branch: "cache" } });
  assert.equal((await s.nexus(["review", "--cancel", thread.id])).stdout, `Cancelled review rv-1 of PR #7: cancelled, round 1 of 5, reviewer th-reviewer on gpt-6-astra, cancelled by ${laptop}\n`);
  assert.deepEqual((await s.json(["review", thread.id, "--cancel"])).phase, { kind: "cancelled", who: "person", by: laptop });
  assert.deepEqual(asked, [[thread.id, laptop], [thread.id, laptop]]);
  for (const extra of [["--land"], ["--pr", "7"], ["--rounds", "2"]]) assert.equal((await s.nexus(["review", "--cancel", thread.id, ...extra])).code, 64, `--cancel with ${extra[0]}`);
  assert.equal(asked.length, 2, "a refused flag sends nothing");
});

test("land --waive without a terminal refuses before it reads or sends anything, and land alone sends no waiver", async (t) => {
  const asked: unknown[][] = [];
  const reviews = { land(builder: ThreadId, by: string, head?: string, waive?: readonly string[]) { asked.push([builder, by, head, waive]); return s.registry.reviews.review(builder)!; } } as never as ReviewLoop;
  const s = await setup(t, { reviews });
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Cache"]);
  const egress = { code: "reserved-path:egress" as const, text: "Always needs the person: changes to the egress allowlist, as it changes src/control/threads.ts." };
  s.registry.reviews.saveReview(testReview({ builder: thread.id, phase: { kind: "approved" }, rounds: [{ ...approvedRound, heldAt: { base: "main", holds: [egress] } }] }));
  const refused = await s.nexus(["land", thread.id, "--waive"]);
  assert.equal(refused.code, 64);
  assert.match(refused.stderr, /stdin or stderr is not a terminal/);
  assert.equal((await s.nexus(["land", thread.id])).code, 0);
  assert.deepEqual(asked, [[thread.id, laptop, undefined, undefined]], "the refused waiver sent nothing");
});

test("land --waive shows the head and every hold it waives, and sends them only once the person types yes", async () => {
  const egress = "Always needs the person: changes to the egress allowlist, as it changes src/control/threads.ts.";
  const check = "The pull request changes .nexus/check, the check this policy relies on.";
  const review = testReview({ phase: { kind: "approved" }, rounds: [{ ...approvedRound, heldAt: { base: "main", holds: [{ code: "reserved-path:egress", text: egress }, { code: "check-changed", text: check }] } }] });
  const api = (async (method: string, path: string) => {
    assert.deepEqual([method, path], ["GET", "/v1/threads/th-builder"]);
    return { reviewView: reviewView(review, []), questions: [] };
  }) as Api;
  const yes = confirmingTerminal("yes");
  assert.deepEqual(await pressOf(api, "th-builder", yes.terminal), { head: approvedRound.head, waive: [egress, check] });
  assert.equal(yes.shown(), `Land pull request #7 at ${approvedRound.head}, waiving the holds the merge policy reserves for you:\n  ${egress}\n  ${check}\nType yes to waive them and land: `);
  for (const answer of ["y", "", null]) {
    await assert.rejects(pressOf(api, "th-builder", confirmingTerminal(answer).terminal), (err: CliError) => err.kind === "failed" && /did not confirm/.test(err.message), `answered ${JSON.stringify(answer)}`);
  }
  await assert.rejects(pressOf(api, "th-builder", confirmingTerminal("yes", false).terminal), (err: CliError) => err.kind === "invalid");
  const nothing = confirmingTerminal("yes");
  const unheldReview = { ...review, rounds: [{ ...approvedRound, heldAt: { base: "main", holds: [] } }] };
  const unheld = (async () => ({ reviewView: reviewView(unheldReview, []), questions: [] })) as Api;
  assert.deepEqual(await pressOf(unheld, "th-builder", nothing.terminal), { head: approvedRound.head }, "nothing to waive asks nothing");
  assert.equal(nothing.shown(), "");
});

test("land --waive answers the review's question about its holds, once the person confirmed the holds it names, while the review still runs too", async () => {
  const egress = "Always needs the person: changes to the egress allowlist, as it changes src/control/threads.ts.";
  const review = testReview({ phase: { kind: "reviewing" }, rounds: [{ head: approvedRound.head, verdict: null, check: null, answers: null }] });
  const question: Question = { kind: "holds", id: "holds-rv-1-a", thread: "th-builder" as ThreadId, text: "Land?", options: ["Land", "Leave it"], reserved: "egress", answerer: "deployer", askedAt: 1, answer: null,
    holds: { review: review.id, head: approvedRound.head, base: "main", holds: [{ code: "reserved-path:egress", text: egress }] } };
  const api = (async () => ({ reviewView: reviewView(review, [question]), questions: [question] })) as Api;
  const yes = confirmingTerminal("yes");
  assert.deepEqual(await pressOf(api, "th-builder", yes.terminal), { question: question.id, running: true });
  assert.match(answeredText(reviewView(review, []), reviewSaid(review), true), /^Waived the holds at 111111111111\. It lands once the reviewer approves and its checks pass\.\nreview rv-\S+ of PR #7: reviewing,/, "a review still under way is not landing yet");
  const checking: Review = { ...review, phase: { kind: "checking", startedAt: 1, thread: null } };
  assert.match(answeredText(reviewView(checking, []), reviewSaid(checking), false), /^Landing review /);
  assert.equal(yes.shown(), `Land pull request #7 at ${approvedRound.head}, waiving the holds the merge policy reserves for you:\n  ${egress}\nType yes to waive them and land: `);
  await assert.rejects(pressOf(api, "th-builder", confirmingTerminal("no").terminal), (err: CliError) => err.kind === "failed");
  const answeredQuestion: Question = { ...question, answer: { option: "Leave it", by: laptop, at: 2 } };
  const answered = (async () => ({ reviewView: reviewView(review, [answeredQuestion]), questions: [answeredQuestion] })) as Api;
  assert.deepEqual(await pressOf(answered, "th-builder", confirmingTerminal("yes").terminal), { head: approvedRound.head }, "an answered question is not asked again");
});

test("deploy --wait polls over one connection through the proxy, and its PUT opens its own", async (t) => {
  const s = await setup(t);
  const asked = s.requests();
  const waiting = s.nexus(["deploy", "main", "--wait", "--json"]);
  await until("the wait polled a few times", () => s.requests() >= asked + 4);
  for (const role of ["control", "probe"] as const) s.registry.releases.reportRelease({ node, role, commit: "a".repeat(40), target: "a".repeat(40), state: "healthy", reason: null, observedAt: Date.now() });
  const done = await waiting;
  assert.equal(done.code, 0, done.stderr);
  assert.ok(s.requests() >= asked + 5);
  assert.equal(s.proxy.connects.length, 2, "one CONNECT for the PUT, and one the polls share");
});
