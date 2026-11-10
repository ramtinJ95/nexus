/**
 * nexus show and the commands on a thread's pylon: ports, previews, files, diffs and sessions, against the control
 * plane's real API with a fake harness behind it. src/test-support/cli-kit.ts says when a test runs the CLI in its own
 * process and when as a child.
 */
import { checkoutReader } from "../checkout-files.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Thread } from "../control/thread-store.ts";
import type { ThreadDetail } from "../control/wire.ts";
import { detailText } from "./thread-text.ts";
import { personPhase } from "../control/review-model.ts";
import { reviewSaid } from "../control/wording.ts";
import type { Question } from "../control/questions.ts";
import { keptPastDay } from "../control/reconcile.ts";
import { testPr, testReview } from "../test-support/registry-kit.ts";
import type { Judgment } from "../control/judgment-store.ts";
import type { TemplateRecord } from "../control/templates.ts";
import { processStream } from "../process-stream.ts";
import { repoInitCommand } from "../backends/pylon-boot.ts";
import type { NodeName, ProjectId, TailnetNodeId } from "../ids.ts";
import type { ServiceFact } from "../protocol/observations.ts";
import { tempDir, testCapacity, testObservation, until } from "../test-support/kit.ts";
import { checkoutDir } from "../../images/pylon/nexus-contract.ts";
import { node, laptop, project, image, setup, observeRunning, observeAbsent } from "../test-support/cli-kit.ts";

test("show says why an archived thread's disk is kept past its 24 hours, and nothing under them, once it may go, or when its node has no disk", async (t) => {
  const s = await setup(t);
  const { id } = await s.json(["start", "--project", "acme", "--title", "Old spike"]);
  await s.json(["archive", id]);
  s.registry.usage.finishSettle(id, "its pylon did not boot within 10 minutes", Date.now());
  const detail: ThreadDetail = await s.json(["show", id]);
  assert.equal(detail.thread.settleFailure?.count, 1, "show --json carries the archive's settle");
  const disk = (d: ThreadDetail) => detailText(d).split("\n").filter((line) => line.startsWith("disk:"));
  assert.deepEqual(disk(detail), []);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 25 * 60 * 60_000 });
  const dayOld: ThreadDetail = await s.json(["show", id]);
  assert.deepEqual(disk(dayOld), ["disk: kept past its 24 hours, as its token usage is not read to its end yet, and reading it failed once, the last because its pylon did not boot within 10 minutes"]);
  observeAbsent(s);
  assert.deepEqual(disk(await s.json(["show", id])), [], "the API's keptPastDay is null for an absent pylon");
  const { settleFailure: _, ...unfailed } = dayOld.thread;
  assert.equal(keptPastDay({ ...unfailed, usageSettledAt: 1, backedUpAt: 2 }, Date.now()), null);
});

test("show prints why a builder needs no change while it has no pull request, and nothing for a control plane that omits it", async (t) => {
  const s = await setup(t);
  const { id } = await s.json(["start", "--project", "acme", "--title", "Already done"]);
  const outcome = (d: ThreadDetail) => detailText(d).split("\n").filter((line) => line.startsWith("outcome:"));
  const reason = "U55 (#545) already made every change this task asks for";
  s.registry.nudges.saveNudge(id, { state: "no-change", turn: 1, reason, archived: true });
  const detail: ThreadDetail = await s.json(["show", id]);
  assert.equal(detail.noChange, reason);
  assert.deepEqual(outcome(detail), [`outcome: needs no change, so it opened no pull request: ${reason}`]);
  const { noChange: _, ...older } = detail;
  assert.deepEqual(outcome(older as ThreadDetail), [], "a 0.74.0 control plane sends no noChange");
  s.registry.prWatches.savePrWatch(id, { links: [{ pr: testPr({ number: 546, title: "Do it after all" }), seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const linked: ThreadDetail = await s.json(["show", id]);
  assert.equal(linked.noChange, null, "a pull request linked since decides instead");
  assert.deepEqual(outcome(linked), []);
});

test("show says a pylon's guest is not answering, since when and what to do, and nothing while it answers", async (t) => {
  const s = await setup(t);
  const { id } = await s.json(["start", "--project", "acme", "--title", "Mute guest"]);
  const detail: ThreadDetail = await s.json(["show", id]);
  const guest = (d: ThreadDetail) => detailText(d).split("\n").filter((line) => line.startsWith("guest:"));
  assert.deepEqual(guest(detail), []);
  const since = new Date(Date.now() - 3 * 60_000).toISOString();
  observeRunning(s, detail.thread, [], [], { since, timeouts: 5 });
  assert.deepEqual(guest(await s.json(["show", id])), [
    `guest: not answering since 3m ago, as its last 5 guest commands got no answer, so messages, files and diffs fail. \`nexus archive ${id}\` and \`nexus unarchive ${id}\` give it a fresh VM. If the guest does not answer the pause either, the pylon breaks and \`nexus retry-pylon ${id}\` resumes its last saved disk, losing the changes since, so push or copy what you can first`,
  ]);
});

test("show prints a review's lines as the API words them, then what it needs from the person and its waiver", async (t) => {
  const s = await setup(t);
  const { id } = await s.json(["start", "--project", "acme", "--title", "Held review"]);
  const detail: ThreadDetail = await s.json(["show", id]);
  const pending = "The pull request's GitHub checks are pending.";
  const review = testReview({ builder: id, phase: personPhase("policy", { code: "github-checks", text: pending }), waiver: { head: "1".repeat(40), holds: ["Changes to auth."], codes: ["reserved-path:auth"], by: laptop, at: 0, change: null } });
  const shown = detailText({ ...detail, said: { ...detail.said, review: reviewSaid(review) } }).split("\n");
  const line = shown.findIndex((l) => l.startsWith("review rv-1 of PR #7: needs-person"));
  assert.deepEqual(shown.slice(line + 1, line + 4), [`needs you: ${pending}`, `waived by ${laptop} at ${"1".repeat(40)}, 1970-01-01T00:00:00.000Z:`, "  Changes to auth."], "the review's line, then its holds and waiver");
  const yolo = { ...review, waiver: { ...review.waiver!, yolo: "nexus" as ProjectId } };
  assert.match(reviewSaid(yolo).join("\n"), new RegExp(`^waived by ${laptop}, by project nexus's yolo setting, at 1{40}, `, "m"), "a yolo waiver names the project whose setting gave it");
});

test("show says an archived thread's usage is unread when its pylon could not be read, before and after its disk goes", async (t) => {
  const s = await setup(t);
  const { id } = await s.json(["start", "--project", "acme", "--title", "Failed spike"]);
  await s.json(["archive", id]);
  s.registry.threads.markUnread(id, "its pylon failed: gave up after 5 failed attempts");
  const detail: ThreadDetail = await s.json(["show", id]);
  assert.equal(detail.thread.usageUnread, "its pylon failed: gave up after 5 failed attempts", "show --json carries it");
  const lines = (d: ThreadDetail) => detailText(d).split("\n").filter((line) => line.startsWith("usage:") || line.startsWith("disk:"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 25 * 60 * 60_000 });
  const dayOld: ThreadDetail = await s.json(["show", id]);
  assert.deepEqual(lines(dayOld), ["usage: unread, as its pylon failed: gave up after 5 failed attempts, so its disk goes 24 hours after the archive without it"], "a disk whose usage cannot be read is not kept for it");
  observeAbsent(s);
  assert.deepEqual(lines(await s.json(["show", id])), ["usage: unread, as its pylon failed: gave up after 5 failed attempts, so its disk went without it"]);
});

test("ports lists what the pylon listens on, and preview publishes one and waits until it is served", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "ports"]);
  assert.deepEqual(await s.json(["ports", thread.id]), [], "a pylon that does not run listens on nothing");
  observeRunning(s, thread, [], [3000]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 3000, service: null, preview: null }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `3000  -  -\n\`nexus preview ${thread.id} <port>\` publishes a port.\n`);

  const preview = { pylon: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual(await s.json(["preview", thread.id, "3000"]), preview, "the reply names the URL before it is served");
  const asked = s.requests();
  const waiting = s.json(["preview", thread.id, "3000", "--wait"]);
  await until("the wait polls a published preview that is not served yet", () => s.requests() >= asked + 2);
  observeRunning(s, thread, [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], [3000]);
  s.registry.threads.apply({ record: "preview", pylonId: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: true });
  assert.deepEqual(await waiting, { ...preview, ready: true });
  assert.equal((await s.nexus(["preview", thread.id, "3000", "--wait"])).stdout, `${preview.url}\n`);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `3000  port-3000  ${preview.url}\n`);
  assert.equal((await s.nexus(["preview", thread.id, "http"])).code, 64);
});

test("show reports a published preview whose service is starting as not ready, and one whose service failed as not ready, and why", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "failed web"]);
  const web = (state: ServiceFact["state"]): ServiceFact => ({ name: "web", state, port: 8003, declared: true, wantsPreview: true });
  observeRunning(s, thread, [web("ready")], [8003]);
  s.registry.threads.allocatePreviews(thread.pylonId, ["web"], { first: 10200, last: 10299 });
  s.registry.threads.apply({ record: "preview", pylonId: thread.pylonId, service: "web", httpsPort: 10200, ready: true });
  const preview = { pylon: thread.pylonId, service: "web", httpsPort: 10200, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual((await s.json(["show", thread.id])).previews, [preview]);

  observeRunning(s, thread, [web("starting")], [8003]);
  assert.deepEqual((await s.json(["show", thread.id])).previews, [{ ...preview, ready: false }], "the node publishes it, but it answers 502 until the service is ready");
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^preview: web at ${preview.url}, not ready$`, "m"));
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `8003  web  ${preview.url} (not served yet)\n`);
  s.probeAnswers(async () => ({ kind: "link-port", service: "web" })); // a port a declared service owns is previewed under it
  const asked = s.requests();
  const waiting = s.json(["preview", thread.id, "8003", "--wait"]);
  await until("the wait polls while the service starts", () => s.requests() >= asked + 2);
  observeRunning(s, thread, [web("ready")], [8003]);
  assert.deepEqual(await waiting, preview, "--wait returns once the service is ready");

  observeRunning(s, thread, [web("failed")], []);
  const failed = "the service web failed. `nexus service logs web` in the pylon shows why";
  assert.deepEqual((await s.json(["show", thread.id])).previews, [{ ...preview, ready: false, failed }], "the node still publishes it, but nothing answers");
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^preview: web at ${preview.url}, not ready: the service web failed\\. \`nexus service logs web\` in the pylon shows why$`, "m"));

  // A service that listens but fails its health check is failed too.
  observeRunning(s, thread, [web("failed")], [8003]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 8003, service: "web", preview: { ...preview, ready: false, failed } }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `8003  web  ${preview.url} (not ready: ${failed})\n`);

  observeRunning(s, thread, [web("ready")], [8003]);
  assert.deepEqual((await s.json(["show", thread.id])).previews, [preview], "a restarted service's preview is ready again");

  // A ready service whose port has no route into the pylon answers nothing either, and says why.
  const unrouted = "the relay cannot listen on its relay port 127.0.0.1:700: [Errno 98] Address already in use";
  observeRunning(s, thread, [{ ...web("ready"), unrouted }], [8003]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 8003, service: "web", preview: { ...preview, ready: false, failed: unrouted } }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `8003  web  ${preview.url} (not ready: ${unrouted})\n`);
});

test("files, changes and diff read the pylon's checkout, and wait for a paused pylon to run", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "checkout"]);
  const repo = await tempDir("nexus-cli-checkout-", t);
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  // Enough lines stay the same that the renamed file is still similar enough for git to call it a rename.
  const kept = "keep\n".repeat(4);
  await writeFile(join(repo, "app.txt"), `one\n${kept}`);
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-q", "-m", "first");
  await git("update-ref", "refs/nexus/base", "HEAD");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(repo, "app.txt"), `two\n${kept}`);
  await git("commit", "-q", "-am", "agent work");
  await git("mv", "app.txt", "main.txt");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "x.ts"), "x\n");
  let refusals = 2;
  s.probePipes(async (argv) => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {});
  });

  const listed = await s.nexus(["files", thread.id]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stdout, ".git/\nmain.txt  24\nsrc/\n", "a paused pylon is woken and asked again until it runs");
  assert.equal(listed.stderr, "", "off a terminal the wait writes nothing to stderr");
  assert.deepEqual((await s.json(["files", thread.id, "src"])).entries, [{ name: "x.ts", kind: "file", size: 2 }]);

  assert.equal((await s.nexus(["changes", thread.id])).stdout, [
    `Changes since the commit the pylon booted at, ${base.slice(0, 12)}:`,
    "renamed  +1 -1  main.txt (from app.txt)",
    "added    +1 -0  src/x.ts",
    "",
  ].join("\n"));
  const uncommitted = await s.json(["changes", thread.id, "--uncommitted"]);
  assert.equal(uncommitted.base.kind, "head");
  assert.deepEqual(uncommitted.files.map((f: { path: string; status: string }) => [f.status, f.path]), [["renamed", "main.txt"], ["added", "src/x.ts"]]);

  const diff = await s.nexus(["diff", thread.id, "src/x.ts"]);
  assert.equal(diff.stdout, "diff --git a/src/x.ts b/src/x.ts\nnew file mode 100644\nindex 0000000..587be6b\n--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+x\n");
  assert.equal((await s.nexus(["diff", thread.id, "nothing-here"])).stdout, "No changes.\n");
  const renamed = await s.json(["diff", thread.id, "--uncommitted", "app.txt", "main.txt"]);
  assert.match(renamed.diff, /rename from app.txt\nrename to main.txt/, "a rename shows as one when both paths are named");

  s.fake.harness.latestTurn = async () => "42";
  assert.equal((await s.nexus(["changes", thread.id, "--turn", "--json"])).code, 1);
  await checkoutReader(async (argv) => processStream(argv[0]!, argv.slice(1), () => {}), repo).snapshot("42");
  await writeFile(join(repo, "turn.txt"), "latest reply\n");
  const turn = await s.json(["changes", thread.id, "--turn"]);
  assert.equal(turn.base.kind, "turn");
  assert.deepEqual(turn.files.map((f: { path: string }) => f.path), ["turn.txt"]);
  const turnDiff = await s.json(["diff", thread.id, "--turn", "turn.txt"]);
  assert.deepEqual(turnDiff.base, turn.base);
  assert.match(turnDiff.diff, /\+latest reply/);
  assert.equal((await s.nexus(["changes", thread.id, "--turn", "--uncommitted"])).code, 64);

  const missing = await s.nexus(["files", thread.id, "nope", "--json"]);
  assert.equal(missing.code, 4);
  assert.match(JSON.parse(missing.stderr).error, /nope does not exist/);
});

test("changes and diff of a scratch thread are against the empty tree, before its first commit and after", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "scratch"]);
  const scratch = await tempDir("nexus-cli-scratch-", t);
  const repo = join(scratch, "repo");
  await promisify(execFile)("sh", ["-c", repoInitCommand({ kind: "empty", branch: "main" }, repo)]);
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {}));
  const output = async (args: string[]) => {
    const res = await s.nexus(args);
    assert.equal(res.code, 0, res.stderr);
    return res.stdout;
  };
  await writeFile(join(repo, "README.md"), "# sketch\n");

  const sinceBoot = "Changes since the pylon booted an empty repository:\nadded  +1 -0  README.md\n";
  assert.equal(await output(["changes", thread.id]), sinceBoot);
  assert.equal(await output(["changes", thread.id, "--uncommitted"]), "Changes since HEAD, which names no commit yet:\nadded  +1 -0  README.md\n");
  const firstDiff = await output(["diff", thread.id]);
  assert.match(firstDiff, /^diff --git a\/README.md b\/README.md\nnew file mode 100644\n[^]*\n\+# sketch\n$/);
  assert.equal(await output(["diff", thread.id, "--uncommitted"]), firstDiff);

  await git("add", "-A");
  await git("commit", "-q", "-m", "first");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  assert.equal(await output(["changes", thread.id]), sinceBoot, "the agent's commit is a change since the start too");
  assert.equal(await output(["diff", thread.id]), firstDiff);
  assert.equal(await output(["changes", thread.id, "--uncommitted"]), `No changes since HEAD, ${head.slice(0, 12)}.\n`);
});

test("preview --wait and a read of a paused pylon on a terminal say what they wait for", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "ports"]);
  observeRunning(s, thread, [], [3000]);
  const { url } = await s.json(["preview", thread.id, "3000"]);
  const previewing = s.onTerminal(["preview", thread.id, "3000", "--wait"]);
  await until("the wait says the preview is not served", () => previewing.stderr().includes(`${url} is published, and not served yet\n`));
  s.registry.threads.apply({ record: "preview", pylonId: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: true });
  const served = await previewing.exited;
  assert.deepEqual([served.code, served.stdout, served.stderr], [0, `${url}\n`, `${url} is published, and not served yet\n`]);

  let paused = true;
  s.probeAnswers(async () => {
    if (paused) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return { kind: "unlink-port", refused: null };
  });
  const unpreviewing = s.onTerminal(["unpreview", thread.id, "3000"]);
  const waking = `Waiting up to 120 s for the pylon of ${thread.id} to run: pylon ${thread.pylonId} is not running yet. This request wakes it, so ask again once it runs\n`;
  await until("the wait says the pylon wakes", () => unpreviewing.stderr().includes(waking));
  paused = false;
  const unpublished = await unpreviewing.exited;
  assert.deepEqual([unpublished.code, unpublished.stderr], [0, waking]);
});

test("unpreview unpublishes a port, waits for a paused pylon to run, and fails with the contract's exit codes", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "unpreview"]);
  observeRunning(s, thread, [], [3000]);
  const preview = await s.json(["preview", thread.id, "3000"]);
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 3000, service: null, preview: null }]);
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null, "a port with no linked preview succeeds");
  assert.equal((await s.nexus(["unpreview", thread.id, "3000"])).stdout, `Unpublished port 3000 of ${thread.id}.\n`);
  assert.deepEqual(await s.json(["preview", thread.id, "3000"]), preview, "the port can be published again");

  let refusals = 2;
  s.probeAnswers(async (command) => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return { kind: "unlink-port", refused: null };
  });
  s.commands.length = 0;
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null, "a paused pylon is woken and asked again until it runs");
  assert.deepEqual(s.commands, Array(3).fill({ kind: "unlink-port", port: 3000 }));

  const fails = async (args: string[], code: number) => {
    const res = await s.nexus([...args, "--json"]);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    return JSON.parse(res.stderr) as { error: string; kind: string; status: number | null };
  };
  const reason = "Port 5173 is the preview of service web, not a linked port. Remove the preview from /home/user/workspace/repo/.nexus/services.yaml to unpublish it";
  s.probeAnswers(async () => ({ kind: "unlink-port", refused: reason }));
  s.commands.length = 0;
  assert.deepEqual(await fails(["unpreview", thread.id, "5173"], 1), { error: reason, kind: "failed", status: 422, code: null }, "the refusal is the pylon's reason alone, and is not tried again");
  assert.equal(s.commands.length, 1);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  await fails(["unpreview", thread.id, "3000"], 1);
  s.commands.length = 0;
  for (const port of ["http", "0", "70000"]) await fails(["unpreview", thread.id, port], 64);
  assert.deepEqual(s.commands, [], "a bad port never reaches the API");
  await s.json(["archive", thread.id]);
  await fails(["unpreview", thread.id, "3000"], 5);
  await s.json(["delete", thread.id]);
  await fails(["unpreview", thread.id, "3000"], 5);
});

test("session open opens Claude Code by default, waits for a paused pylon, and session close closes a pane or says why not", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "sessions"]);
  assert.deepEqual(await s.json(["session", "open", thread.id]), { herdrPane: "w1:p1", harness: "claude-code", title: "claude-code" });
  assert.equal((await s.nexus(["session", "open", thread.id, "--harness", "pi", "--title", "plan"])).stdout,
    `Opened pi session "plan" in pane w1:p1 of ${thread.id}. \`nexus attach ${thread.id}\` attaches to it.\n`);
  assert.deepEqual(s.commands, [{ kind: "open-session", harness: "claude-code", title: "claude-code" }, { kind: "open-session", harness: "pi", title: "plan" }]);

  s.commands.length = 0;
  assert.equal((await s.nexus(["session", "close", thread.id, "w1:p1"])).stdout, `Closed session w1:p1 of ${thread.id}.\n`);
  assert.deepEqual(s.commands, [{ kind: "close-session", herdrPane: "w1:p1" }]);

  // Not asked again: after the wake the pane may name another session.
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.commands.length = 0;
  const waking = await s.nexus(["session", "close", thread.id, "w1:p1"]);
  assert.equal(waking.code, 5);
  assert.match(waking.stderr, /is not running yet. This request wakes it/);
  assert.equal(s.commands.length, 1);
  s.probeAnswers(async () => ({ kind: "close-session", outcome: "not-open" }));
  const stale = await s.nexus(["session", "close", thread.id, "w1:p1"]);
  assert.equal(stale.code, 4);
  assert.match(stale.stderr, /no session is open in pane w1:p1 .* A wake may have moved it/);

  // A paused session is refused at once, and its pylon is not asked.
  s.registry.threads.apply({ record: "sessions", pylonId: thread.pylonId, sessions: [
    { id: "w1:p1", state: "paused", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: null, title: "review", status: null, message: null },
    { id: "failed-0123456789ab", state: "failed", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan", status: null, message: "pi exited 1" },
  ] });
  s.commands.length = 0;
  const paused = await s.nexus(["session", "close", thread.id, "w1:p1"]);
  assert.equal(paused.code, 5);
  assert.match(paused.stderr, /session w1:p1 is paused with its pylon and resumes when its pylon wakes/);
  assert.deepEqual(s.commands, []);
  const shown = (await s.nexus(["show", thread.id])).stdout;
  assert.match(shown, /^session: claude-code "review" in pane w1:p1, paused, resumes on wake$/m);
  assert.match(shown, /^session: pi "plan" as failed-0123456789ab, failed: pi exited 1$/m);
  s.probeAnswers(async () => ({ kind: "drop-failed-session", dropped: true }));
  assert.equal((await s.nexus(["session", "close", thread.id, "failed-0123456789ab"])).code, 0);
  assert.deepEqual(s.commands, [{ kind: "drop-failed-session", id: "failed-0123456789ab" }]);

  assert.equal((await s.nexus(["session", "open", thread.id, "--harness", "codex"])).code, 64);
  assert.equal((await s.nexus(["session", "close", thread.id])).code, 64);
  await s.json(["archive", thread.id]);
  s.commands.length = 0;
  const archived = await s.nexus(["session", "open", thread.id]);
  assert.equal(archived.code, 5);
  assert.match(archived.stderr, /is archived, so its pylon stays paused/);
  assert.deepEqual(s.commands, []);
  assert.match((await s.nexus(["show", thread.id])).stdout, /^session: claude-code "review" in pane w1:p1, paused, resumes on unarchive$/m);
});

test("start --node auto picks the node with room, show says why, and nodes prints what pylons hold", async (t) => {
  const s = await setup(t);
  s.registry.nodes.upsertNode({ name: "spare" as NodeName, tailnetHost: "spare.tail.ts.net", tailnetNodeId: "nSPARE" as TailnetNodeId });
  const capacity = testCapacity({ committedCpus: 6, memoryGiB: 62.75, committedMemoryGiB: 16, diskFreeGiB: 180.25, committedDiskGiB: 120 });
  s.registry.threads.apply({ record: "node", node, state: "online", capacity });
  s.registry.threads.ingested(testObservation(node, { capacity, artifacts: [image.id] }), []);
  assert.match((await s.nexus(["nodes"])).stdout, /^rj-firebat +online +observed .+ {2}6\/16 CPUs, 16\/62\.8 GiB memory committed, 120 GiB disk committed, 180\.3 GiB disk free$/m);

  const plain: Thread = await s.json(["start", "--project", "acme", "--title", "default"]);
  assert.match((await s.nexus(["show", plain.id])).stdout, /^placement: rj-firebat, the project's default node$/m);
  const auto: Thread = await s.json(["start", "--project", "acme", "--title", "auto", "--node", "auto"]);
  assert.match((await s.nexus(["show", auto.id])).stdout,
    /^placement: auto chose rj-firebat, which had the most room left after this pylon; rj-firebat had 38\.8 GiB memory, 6 CPUs and 160\.3 GiB disk left; spare is offline$/m,
    "the default thread's pylon, which the node has yet to report, counts against it");
});

test("show says how the pylon got its setup: fresh and why, with the build it asked for, or from a template its node holds", async (t) => {
  const s = await setup(t);
  const shown = async (title: string) => {
    const thread: Thread = await s.json(["start", "--project", "acme", "--title", title]);
    return { thread, line: (await s.nexus(["show", thread.id])).stdout.split("\n").find((l) => l.startsWith("setup: ")) };
  };
  assert.equal((await shown("unread")).line, "setup: fresh boot runs .nexus/setup, because the control plane could not read .nexus/setup at main: this test has no remote");

  s.remoteReads(async () => ({ commit: "2".repeat(40), setupBlob: "b".repeat(40) }));
  const built = await shown("built");
  const [building] = s.registry.images.templates(project.id) as Extract<TemplateRecord, { state: "building" }>[];
  assert.equal(built.line, `setup: fresh boot runs .nexus/setup, because no template of this setup is on rj-firebat yet; ${building!.id} builds for the next thread`);

  const log = `the setup of template ${building!.id} failed: Setup exited 1\nnpm ERR! 404`;
  s.registry.images.saveTemplate({ id: building!.id, key: building!.key, state: "failed", on: node, failedAt: Date.now(), logTail: log });
  const failed = await shown("failed");
  assert.equal(failed.line, `setup: fresh boot runs .nexus/setup, because the build of template ${building!.id} failed on rj-firebat: the setup of template ${building!.id} failed: Setup exited 1`, "the log stays out of the text");
  assert.equal((await s.json(["show", failed.thread.id])).thread.setup.reason, `the build of template ${building!.id} failed on rj-firebat: ${log}`);

  s.registry.images.saveTemplate({ id: building!.id, key: building!.key, state: "ready", builtOn: node, builtAt: Date.now() - 3 * 60_000, commit: "2".repeat(40) });
  s.registry.threads.ingested(testObservation(node, { artifacts: [image.id, building!.id] }), []);
  assert.equal((await shown("reused")).line, `setup: from template ${building!.id}, built 3m ago, then checked out 222222222222`);
});

test("start --cpus, --memory and --disk size the thread over its project's, and show prints the size", async (t) => {
  const s = await setup(t);
  const sized: Thread = await s.json(["start", "--project", "acme", "--title", "sized", "--memory", "12", "--cpus", "4"]);
  assert.deepEqual(s.registry.threads.pylon(sized.pylonId)!.boot.resources, { cpus: 4, memoryGiB: 12, diskGiB: 10 }, "the disk it leaves out is the project's");
  assert.match((await s.nexus(["show", sized.id])).stdout, /^size: 4 CPUs, 12 GiB memory, 10 GiB disk$/m);
  const disk: Thread = await s.json(["start", "--project", "acme", "--title", "disk", "--disk", "40"]);
  assert.deepEqual(s.registry.threads.pylon(disk.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 4, diskGiB: 40 });
  const plain: Thread = await s.json(["start", "--project", "acme", "--title", "plain"]);
  assert.match((await s.nexus(["show", plain.id])).stdout, /^size: 2 CPUs, 4 GiB memory, 10 GiB disk$/m, "a thread started without them has its project's size");
  const pylon = s.registry.threads.pylon(plain.pylonId)!;
  s.registry.threads.savePylon({ ...pylon, boot: { ...pylon.boot, resources: { ...pylon.boot.resources, memoryGiB: 8, nestedVirtualization: true } } });
  assert.match((await s.nexus(["show", plain.id])).stdout, /^size: 2 CPUs, 8 GiB memory, 10 GiB disk, nested virtualization$/m, "a verify pylon's size says it nests");

  for (const [flag, value, status] of [["--memory", "0", 400], ["--cpus", "-2", null], ["--disk", "1.5", null], ["--memory", "lots", null]] as const) {
    const res = await s.nexus(["start", "--project", "acme", "--title", "wrong", flag, value, "--json"]);
    assert.equal(res.code, 64, `${flag} ${value}: ${res.stderr}`);
    assert.deepEqual((({ kind, status }) => ({ kind, status }))(JSON.parse(res.stderr)), { kind: "invalid", status }, `${flag} ${value}`);
  }
  assert.deepEqual((await s.json(["threads"])).map((r: Thread) => r.title).toSorted(), ["disk", "plain", "sized"], "no refused start made a thread");
});

test("show prints PR metadata and one disabled-watch notice without waking the pylon", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "PR"]);
  const pr = testPr({ number: 12, title: "Fix build", checks: "failed", review: "changes_requested" });
  s.registry.prWatches.savePrWatch(thread.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const before = s.registry.threads.thread(thread.id)!.lastHumanActivityAt;
  const shown = await s.nexus(["show", thread.id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /PR #12: Fix build — open, checks failed, review changes_requested/);
  assert.equal((shown.stdout.match(/PR watch: off/g) ?? []).length, 1);
  const detail = await s.json(["show", thread.id]);
  assert.deepEqual(detail.pullRequests, [pr]);
  assert.equal(detail.prWatch.enabled, false);
  assert.equal(s.registry.threads.thread(thread.id)!.lastHumanActivityAt, before);
});

test("show prints each question with its options, its reserved case, and who must answer it or how it was answered", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Image"]);
  s.registry.questions.askQuestion({ kind: "holds", id: "qn-image", thread: thread.id, text: "Rebuild the pylon image?\nIt changes the base layer.", options: ["Rebuild", "Not now"], reserved: "image-rebuild", answerer: "deployer", askedAt: 1, holds: { review: "rv-1", head: "h", base: null, holds: [] } });
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-brief", thread: thread.id, text: "Start the next brief?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: 2, failure: 0 });
  const shown = await s.nexus(["show", thread.id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^attention: decision$/m);
  assert.match(shown.stdout, /^question qn-image: Rebuild the pylon image\?\n {2}options: "Rebuild", "Not now"\n {2}reserved: pylon image rebuilds\n {2}needs a deployer\nquestion qn-brief: Start the next brief\?\n {2}options: "Yes", "No"\n {2}needs you$/m);
  s.registry.questions.answerQuestion(s.registry.questions.question("qn-brief")!, { option: "Yes", by: laptop, at: Date.UTC(2026, 9, 28, 9) });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^question qn-brief: Start the next brief\?\n {2}options: "Yes", "No"\n {2}answered "Yes" by nLAPTOP at 2026-10-28T09:00:00.000Z$/m);
  assert.deepEqual((await s.json(["show", thread.id])).questions.map((q: { id: string }) => q.id), ["qn-image", "qn-brief"]);
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-failed", thread: thread.id, text: "The pylon failed.", options: ["Retry"], reserved: null, answerer: "person", askedAt: 3, failure: 1 });
  await s.json(["archive", thread.id]);
  const { at } = (await s.json(["show", thread.id])).questions.find((q: Question) => q.id === "qn-failed").withdrawn;
  assert.ok((await s.nexus(["show", thread.id])).stdout.includes(`question qn-failed: The pylon failed.\n  options: "Retry"\n  withdrawn when the thread was archived at ${new Date(at).toISOString()}\n`), "archiving withdraws an open failure question, at the time the API records");
});

test("show prints a Claude worker's ask with a line per question it asks, and the choices that answered it in one line", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Ask"]);
  const option = (label: string) => ({ label, description: "" });
  const questions = [
    { question: "Which drink?", header: "Drink", multiSelect: false, options: [option("Tea"), option("Coffee")] },
    { question: "What goes in it?", header: "Extras", multiSelect: true, options: [option("Milk"), option("Sugar")] },
  ];
  s.registry.questions.askQuestion({ kind: "ask", id: "ask-toolu_1", thread: thread.id, text: "Drink: Which drink?\nExtras: What goes in it?", options: [], reserved: null, answerer: "person", askedAt: 1, ask: { session: "s1", toolUseId: "toolu_1", questions } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^question ask-toolu_1: Drink: Which drink\?\n {2}Extras: What goes in it\?\n {2}needs you$/m);
  s.registry.questions.answerQuestion(s.registry.questions.question("ask-toolu_1")!, { option: "Drink: Tea; Extras: Milk, Oat cream", by: laptop, at: Date.UTC(2026, 9, 28, 9), choices: [{ picked: ["Tea"] }, { picked: ["Milk"], own: "Oat cream" }] });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^question ask-toolu_1: Drink: Which drink\?\n {2}Extras: What goes in it\?\n {2}answered "Drink: Tea; Extras: Milk, Oat cream" by nLAPTOP at 2026-10-28T09:00:00.000Z$/m);
});

test("show prints each judgment of a failed pylon: its verdict and who gave it, then what Nexus did or what it waits for", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Flaky node"]);
  const judgment = (failure: number, phase: Judgment["phase"]): Judgment => ({
    failure, thread: thread.id, node, failed: "pylon is broken: the controller exited\nqemu: terminating", startedAt: Date.UTC(2026, 9, 28, 9), request: { brief: "Is it the node?", token: "t" },
    conversation: 3, reply: null, phase,
  });
  s.registry.judgments.saveJudgment(judgment(812, { kind: "done", verdict: { answer: "retry", why: "The controller died while the node was swapping.", by: "judgment" }, outcome: { kind: "retried", node, on: "verdict" } }), null);
  s.registry.judgments.saveJudgment(judgment(813, { kind: "asked", verdict: { answer: "person", why: "the judgment did not answer within 15 minutes", by: "control plane" } }), null);
  s.registry.judgments.saveJudgment(judgment(814, { kind: "judging", deadline: null }), null);
  const shown = await s.nexus(["show", thread.id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`^judgment of failure 812 on ${node}: retry, by the judgment: The controller died while the node was swapping\\.\n {2}retried the pylon on ${node}
judgment of failure 813 on ${node}: person, by the control plane: the judgment did not answer within 15 minutes\n {2}waits for your answer to question judgment:813
judgment of failure 814 on ${node}: no verdict yet\n {2}judging since 2026-10-28T09:00:00\\.000Z$`, "m"));
  const [done] = (await s.json(["show", thread.id])).judgments;
  assert.deepEqual(done, { failure: 812, node, failed: "pylon is broken: the controller exited\nqemu: terminating", startedAt: Date.UTC(2026, 9, 28, 9), phase: "done",
    verdict: { answer: "retry", why: "The controller died while the node was swapping.", by: "judgment" }, outcome: `retried the pylon on ${node}`, question: null, brief: "Is it the node?", reply: null });
});

test("show prints a failed pylon's log under its reason, indented, and --json carries the failure whole", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "x"]);
  const failed = "pylon is broken: the controller failed to boot the VM\nqemu: booting\nError: Guest command got no answer within 13000 ms";
  s.registry.threads.savePylon({ ...s.registry.threads.pylon(thread.pylonId)!, failed });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^failed: pylon is broken: the controller failed to boot the VM\n {2}qemu: booting\n {2}Error: Guest command got no answer within 13000 ms$/m);
  assert.equal((await s.json(["show", thread.id])).pylon.failed, failed);
});

test("preview --wait rides through a restart of the control plane and prints the preview once it is served", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "ports"]);
  observeRunning(s, thread, [], [3000]);
  const { url } = await s.json(["preview", thread.id, "3000"]);
  const asked = s.requests();
  const waiting = s.nexus(["preview", thread.id, "3000", "--wait"]);
  await until("the wait polls a preview that is not served yet", () => s.requests() >= asked + 2);
  const restart = await s.stop();
  const tried = s.proxy.connects.length;
  await until("a poll met the stopped control plane", () => s.proxy.connects.length > tried);
  await restart();
  observeRunning(s, thread, [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], [3000]);
  s.registry.threads.apply({ record: "preview", pylonId: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: true });
  const served = await waiting;
  assert.deepEqual([served.code, served.stdout], [0, `${url}\n`], served.stderr);
});
