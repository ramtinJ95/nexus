/**
 * nexus start, send, seen and abort, for pi threads and Claude workers, and queued threads, against the control plane's
 * real API with a fake harness behind it. src/test-support/cli-kit.ts says when a test runs the CLI in its own process
 * and when as a child.
 */
import { until } from "../test-support/kit.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planningPrefix } from "../control/agent-protocol.ts";
import type { QueuedThread, ThreadRow } from "../contract/threads.ts";
import type { Thread } from "../control/thread-store.ts";
import { claudeWorkerAt } from "../test-support/registry-kit.ts";
import type { ProjectId } from "../ids.ts";
import type { InterruptClaudeOutcome } from "../protocol/commands.ts";
import { transcriptStart, type ClaudeEntry } from "../control/claude-transcript.ts";
import { tempDir, testCapacity, testObservation } from "../test-support/kit.ts";
import { CliError } from "./transport.ts";
import type { Api } from "./kit.ts";
import { threadsCommands } from "./commands/threads.ts";
import { node, project, withHealth, listening, setup, claudeWatched, timeless } from "../test-support/cli-kit.ts";
import { localTime } from "./kit.ts";

test("a thread is named by a unique prefix of its ID, with or without th-, or by @last, and a full ID costs no lookup", async (t) => {
  const s = await setup(t);
  const first: Thread = await s.json(["start", "--project", "acme", "--title", "first"]);
  await until("the clock moves past the first start, so the second is newer", () => Date.now() > first.createdAt);
  const second: Thread = await s.json(["start", "--project", "acme", "--title", "second"]);
  let n = 4;
  while (second.id.startsWith(first.id.slice(0, n))) n++;
  const prefix = first.id.slice(0, n);

  let before = s.requests();
  assert.equal((await s.json(["show", first.id])).thread.id, first.id);
  assert.equal(s.requests() - before, 1, "a full ID goes to the API as typed, with no lookup");
  before = s.requests();
  assert.equal((await s.json(["show", prefix])).thread.id, first.id, "a unique prefix names its thread");
  assert.equal(s.requests() - before, 3, "a prefix reads the threads and the queue first");
  assert.equal((await s.json(["show", prefix.slice(3)])).thread.id, first.id, "without th- too");
  assert.equal((await s.nexus(["archive", prefix])).stdout, `Archived ${first.id}.\n`, "a command's text names the full ID");

  const both = await s.nexus(["show", "th-"]);
  assert.equal(both.code, 64);
  assert.equal(both.stderr, `nexus: th- is the start of 2 threads, ${first.id} (archived: first), ${second.id} (active: second). Give more of the ID\n`);
  const none = ["th-0", "th-1", "th-2"].find((p) => !first.id.startsWith(p) && !second.id.startsWith(p))!;
  assert.equal((await s.nexus(["show", none])).stderr, `nexus: no thread ${none}\n`, "a prefix of no thread goes to the API as typed");

  assert.equal((await s.json(["show", "@last"])).thread.id, second.id, "@last is the newest thread");
  await s.json(["delete", "@last"]);
  assert.equal((await s.json(["show", "@last"])).thread.id, first.id, "a deleted thread is never @last");
  assert.equal((await s.json(["show", "th-"])).thread.id, first.id, "a deleted thread makes no prefix ambiguous");
  await s.json(["delete", first.id]);
  assert.deepEqual([(await s.nexus(["show", "@last"])).code, (await s.nexus(["show", "@last"])).stderr], [4, "nexus: @last names the newest thread that is not deleted, and there is none\n"]);
});

test("without --project, start takes the one project whose repository is the checkout's origin", async (t) => {
  const s = await setup(t);
  const checkout = async (origin: string | null) => {
    const dir = await tempDir("nexus-checkout-", t);
    await promisify(execFile)("git", ["init", "-q", dir]);
    if (origin !== null) await promisify(execFile)("git", ["-C", dir, "remote", "add", "origin", origin]);
    return dir;
  };
  for (const origin of ["git@github.com:octocat/Spoon-Knife", "ssh://git@GitHub.com:22/octocat/Spoon-Knife.git", "https://github.com/octocat/Spoon-Knife/"]) {
    const res = await s.spawned(["start", "--title", "inferred", "--json"], undefined, await checkout(origin));
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stderr, "nexus: project acme, from this checkout's origin\n", origin);
    assert.equal(JSON.parse(res.stdout).project, "acme", origin);
  }
  assert.equal((await s.spawned(["start", "--title", "given", "--project", "acme"], undefined, await checkout("https://github.com/other/repo.git"))).code, 0, "--project still wins");

  const other = await s.spawned(["start", "--title", "x"], undefined, await checkout("https://github.com/other/repo.git"));
  assert.deepEqual([other.code, other.stderr], [64, "nexus: start needs --project, since no project has this checkout's origin, https://github.com/other/repo.git. Run nexus start --help for usage\n"]);
  const bare = await s.spawned(["start", "--title", "x"], undefined, await checkout(null));
  assert.deepEqual([bare.code, bare.stderr], [64, "nexus: start needs --project. Run nexus start --help for usage\n"]);
  s.registry.projects.createProject({ ...project, id: "escaped" as ProjectId, repoUrl: "https://git.example/team/100%.git" });
  s.registry.projects.createProject({ ...project, id: "ported" as ProjectId, repoUrl: "https://git.example:8443/team/repo.git" });
  const ported = await s.spawned(["start", "--title", "ported"], undefined, await checkout("https://git.example:8443/team/repo"));
  assert.deepEqual([ported.code, ported.stderr], [0, "nexus: project ported, from this checkout's origin\n"], "a port other than the scheme's default is kept");
  const elsewhere = await s.spawned(["start", "--title", "x"], undefined, await checkout("https://git.example:9443/team/repo.git"));
  assert.deepEqual([elsewhere.code, elsewhere.stderr], [64, "nexus: start needs --project, since no project has this checkout's origin, https://git.example:9443/team/repo.git. Run nexus start --help for usage\n"], "another port is another server");
  s.registry.projects.createProject({ ...project, id: "spoon" as ProjectId, repoUrl: "git@github.com:octocat/Spoon-Knife.git" });
  const two = await s.spawned(["item", "add", "--message", "x"], undefined, await checkout("https://github.com/octocat/Spoon-Knife.git"));
  assert.deepEqual([two.code, two.stderr], [64, "nexus: item add needs --project, since projects acme, spoon all have this checkout's origin, https://github.com/octocat/Spoon-Knife.git. Run nexus item add --help for usage\n"]);
});

test("seen and --unread share the API marker without waking an archived thread", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "read me"]);
  await s.json(["archive", thread.id]);
  s.registry.threads.recordReply(thread.id, 1000);
  const before = s.registry.threads.thread(thread.id)!;
  assert.equal(await s.json(["seen", thread.id]), null);
  assert.ok(s.registry.threads.thread(thread.id)!.seenAt! >= 1000);
  assert.equal(await s.json(["seen", thread.id, "--unread"]), null);
  assert.deepEqual(s.registry.threads.thread(thread.id), { ...before, seenAt: 999 });
});

test("seen --last-reply-at marks only up to the reply the client showed, and never lowers the mark", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "read me"]);
  s.registry.threads.recordReply(thread.id, 1000);
  s.registry.threads.recordReply(thread.id, 2000);
  const seen = async (...flags: string[]) => {
    assert.equal(await s.json(["seen", thread.id, ...flags]), null);
    return s.registry.threads.thread(thread.id)!.seenAt;
  };
  assert.equal(await seen("--last-reply-at", "1000"), 1000, "a reply that landed after the one shown stays unread");
  assert.equal((await s.json(["show", thread.id])).attention, "reply");
  assert.equal(await seen("--last-reply-at", "500"), 1000, "an older mark does not lower it");
  assert.equal(await seen("--last-reply-at", "2000"), 2000);
  assert.equal((await s.json(["show", thread.id])).attention, null);
  for (const flags of [["--last-reply-at", "soon"], ["--last-reply-at", "-1"], ["--last-reply-at", "1000", "--unread"]]) {
    const refused = await s.nexus(["seen", thread.id, ...flags]);
    assert.equal(refused.code, 64, flags.join(" "));
  }
  assert.equal(s.registry.threads.thread(thread.id)!.seenAt, 2000);
});

test("seen encodes a thread ID so it cannot become an unarchive request", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Stay archived"]);
  await s.json(["archive", thread.id]);
  const before = s.registry.threads.thread(thread.id);
  for (const flags of [[], ["--unread"]]) {
    const result = await s.nexus(["seen", `${thread.id}/unarchive?`, ...flags, "--json"]);
    assert.equal(result.code, 4, result.stderr);
    assert.deepEqual(s.registry.threads.thread(thread.id), before);
  }
});

test("start --claude queues a poteto worker without sending a harness message", async (t) => {
  const s = await setup(t);
  const thread = await s.json(["start", "--project", "acme", "--claude", "/poteto-mode fix it"]);
  assert.equal(thread.conversationId, null);
  assert.deepEqual(s.registry.threads.claudeWorker(thread.id), { model: "claude-opus-5-5", prompt: "/poteto-mode fix it", state: "pending", session: null });
  assert.equal((await s.nexus(["start", "--project", "acme", "--claude", "fix", "--message", "also fix"])).code, 64);
});

test("show exposes the registry's failed worker and its selected model", async (t) => {
  const s = await setup(t);
  const thread = await s.json(["start", "--project", "acme", "--claude", "fix it", "--model", "claude-sonnet-5-5"]);
  const message = "Claude launch did not complete: agent executable missing";
  claudeWorkerAt(s.registry, thread.id, "failed", { message });
  const detail = await s.json(["show", thread.id]);
  assert.deepEqual(detail.claudeWorker, { state: "failed", model: "claude-sonnet-5-5", message });
  assert.equal(detail.attention, "failed");
  assert.deepEqual(detail.sessions, []);
  const text = (await s.nexus(["show", thread.id])).stdout;
  assert.match(text, /Claude worker: failed, model claude-sonnet-5-5/);
  assert.ok(text.includes(message));
  assert.equal(s.registry.threads.events().filter((e) => e.kind === "thread.failed").at(-1)?.payload.message, detail.claudeWorker.message);
  assert.equal((await s.nexus(["start", "--project", "acme", "--title", "no worker", "--model", "x"])).code, 64);
});

/** Four threads: one quiet, one with a reply unseen, one whose Claude worker failed, and one idle. */
async function fourThreads(s: Awaited<ReturnType<typeof setup>>) {
  const start = (title: string, ...flags: string[]): Promise<Thread> => s.json(["start", "--project", "acme", "--title", title, ...flags]);
  const quiet = await start("quiet");
  const replied = await start("replied");
  const broken = await start("broken", "--claude", "fix it");
  const dozing = await start("dozing");
  const repliedAt = Date.UTC(2026, 9, 28, 9);
  s.registry.threads.recordReply(replied.id, repliedAt);
  claudeWorkerAt(s.registry, broken.id, "failed", { message: "Claude launch did not complete" });
  s.registry.threads.setThreadStatus(dozing.id, "idle");
  return { quiet, replied, broken, dozing, repliedAt };
}

test("threads heads its columns, says each thread's attention and last reply, and --needs-me, --active and --limit narrow it", async (t) => {
  const s = await setup(t);
  const { quiet, replied, broken, dozing, repliedAt } = await fourThreads(s);
  const all = await s.nexus(["threads"]);
  assert.equal(all.code, 0, all.stderr);
  const lines = timeless(all.stdout).split("\n");
  assert.equal(lines[0], "Thread  Status  Attention  Run  Pylon  Project  Last reply  Title");
  assert.ok(lines.includes(`${replied.id}  active  reply  -  unknown  acme  ${localTime(repliedAt)}  replied`), all.stdout);
  assert.ok(lines.includes(`${quiet.id}  active  -  -  unknown  acme  no reply yet  quiet`), all.stdout);
  assert.ok(lines.includes(`${broken.id}  active  failed  -  unknown  acme  no reply yet  broken`), all.stdout);
  assert.ok(lines.includes(`${dozing.id}  idle  -  -  unknown  acme  no reply yet  dozing`), all.stdout);

  const listed: ThreadRow[] = await s.json(["threads"]);
  const rowsOf = (...ids: string[]) => listed.filter((r) => ids.includes(r.id));
  assert.deepEqual(await s.json(["threads", "--needs-me"]), rowsOf(replied.id, broken.id), "--json prints the same rows, only fewer");
  const needed = (await s.nexus(["threads", "--needs-me"])).stdout;
  assert.deepEqual([quiet.id, replied.id, broken.id, dozing.id].map((id) => needed.includes(id)), [false, true, true, false], needed);
  assert.deepEqual(await s.json(["threads", "--active"]), rowsOf(quiet.id, replied.id, broken.id));
  assert.deepEqual(await s.json(["threads", "--active", "--needs-me"]), rowsOf(replied.id, broken.id));
  assert.deepEqual(await s.json(["threads", "--limit", "2"]), listed.slice(0, 2));
  assert.equal((await s.nexus(["threads", "--limit", "2"])).stdout.trimEnd().split("\n").length, 3, "the header and two rows");
  for (const flags of [["--limit", "0"], ["--limit", "two"], ["--queued", "--needs-me"], ["--queued", "--active"]]) {
    assert.equal((await s.nexus(["threads", ...flags])).code, 64, flags.join(" "));
  }
});

test("threads colours failed and attention rows only on a terminal, and not under NO_COLOR", async (t) => {
  const s = await setup(t);
  const { quiet, replied, broken } = await fourThreads(s);
  const rowOf = (text: string, id: string) => text.split("\n").find((line) => line.includes(id))!;
  const coloured = (await s.ttyOut(["threads"])).stdout;
  assert.ok(rowOf(coloured, broken.id).startsWith("\x1b[31m"), coloured);
  assert.ok(rowOf(coloured, replied.id).startsWith("\x1b[33m"), coloured);
  assert.ok(rowOf(coloured, quiet.id).startsWith(quiet.id), "a row that needs no one stays plain");
  assert.ok(coloured.startsWith("Thread "), "the header stays plain");
  assert.ok(!(await s.nexus(["threads"])).stdout.includes("\x1b"), "no colour when stdout is not a terminal");
  assert.ok(!(await s.ttyOut(["threads"], { NO_COLOR: "1" })).stdout.includes("\x1b"), "no colour under NO_COLOR");
  assert.equal(timeless((await s.ttyOut(["threads"], { NO_COLOR: "" })).stdout), timeless(coloured), "an empty NO_COLOR is unset");
  assert.ok(!(await s.ttyOut(["threads", "--json"])).stdout.includes("\x1b"), "--json is never coloured");
});

test("wake says it recorded the person's activity and what that does to the pylon", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "sleepy"]);
  const before = s.registry.threads.thread(thread.id)!.lastHumanActivityAt;
  await until("the clock moves past the start", () => Date.now() > before);
  assert.equal((await s.nexus(["wake", thread.id])).stdout, `Recorded your activity on ${thread.id}, so Nexus wakes its pylon, which is unknown.\n`);
  assert.ok(s.registry.threads.thread(thread.id)!.lastHumanActivityAt > before);
  assert.equal(await s.json(["wake", thread.id]), null, "--json prints null, as before");
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  s.registry.threads.ingested(testObservation(node, { pylons: [{ pylonId: thread.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" }] }), []);
  assert.equal((await s.nexus(["wake", thread.id])).stdout, `Recorded your activity on ${thread.id}, but its pylon failed, and activity does not retry it. \`nexus retry-pylon ${thread.id}\` does.\n`);
  await s.json(["archive", thread.id]);
  assert.equal((await s.nexus(["wake", thread.id])).stdout, `Recorded your activity on ${thread.id}, but it is archived, so its pylon stays paused. \`nexus unarchive ${thread.id}\` wakes it.\n`);
});

test("threads and show say a Claude worker is working while its session's turn runs", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
  const report = (sequence: number, kind: "session.turn-started" | "session.turn-ended") =>
    s.registry.threads.reportSession(node, { sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1" } });
  report(1, "session.turn-started");
  assert.match((await s.nexus(["threads"])).stdout, new RegExp(`^${thread.id} +active +working +working +`, "m"));
  assert.match((await s.nexus(["show", thread.id])).stdout, /^status: active, agent working$/m);
  report(2, "session.turn-ended");
  assert.match((await s.nexus(["threads"])).stdout, new RegExp(`^${thread.id} +active +reply +- +`, "m"));
  assert.match((await s.nexus(["show", thread.id])).stdout, /^status: active$/m);
});

test("threads, show and conversation say a Claude worker stopped on its usage limit, until when, and how to resume it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
  const resetsAt = Date.now() + 3_600_000;
  const until = `${new Date(resetsAt).toISOString().slice(11, 16)} UTC`;
  const entries: ClaudeEntry[] = [{ kind: "notice", at: 1, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt } }];
  s.registry.threads.appendClaudeRead(thread.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 9 }, reset: false, readAt: Date.now() });
  assert.match((await s.nexus(["threads"])).stdout, new RegExp(`^${thread.id} +active +limited +stopped on its usage limit until ${until}`, "m"));
  const shown = (await s.nexus(["show", thread.id])).stdout;
  assert.ok(shown.includes("attention: limited"), shown);
  assert.ok(shown.includes(`usage limit: stopped on its usage limit until ${until}. \`nexus send ${thread.id} continue\` resumes it once the limit resets`), shown);
  assert.ok((await s.nexus(["conversation", thread.id])).stdout.endsWith(`(Claude stopped on its usage limit until ${until}. Send it "continue" after the reset to resume)\n`));
});

test("show says a Claude worker's turn died, when Nexus resumes it, and why Nexus stopped resuming it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
  const report = (sequence: number, kind: "session.turn-started" | "session.ended", at: number) =>
    s.registry.threads.reportSession(node, { sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1", at } });
  report(1, "session.turn-started", 1_000);
  report(2, "session.ended", 4_000);
  assert.ok(timeless((await s.nexus(["show", thread.id])).stdout).includes(`\nturn died: its Claude session ended during the turn, ${localTime(4_000)}\n`));
  s.registry.threads.saveClaudeResume(thread.id, { state: "waiting", turn: 4_000, count: 1, due: 64_000 });
  assert.ok(timeless((await s.nexus(["show", thread.id])).stdout).includes(`\nturn died: its Claude session ended during the turn, ${localTime(4_000)}; Nexus resumes it ${localTime(64_000)}, 1 in a row\n`));
  const why = "Its turn died 4 times in a row (last: its Claude session ended during the turn), so Nexus stopped resuming it.";
  s.registry.threads.saveClaudeResume(thread.id, { state: "person", turn: 4_000, count: 3, why });
  const shown = (await s.nexus(["show", thread.id])).stdout;
  assert.ok(shown.includes("attention: decision"), shown);
  assert.ok(shown.includes(`resume: stopped. ${why} Write to it to resume it`), shown);
});

test("conversation prints a Claude worker's transcript, and send types into its session, waiting for a paused pylon under one request ID", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
  const entries: ClaudeEntry[] = [
    { kind: "prompt", at: 1, text: "Count the lines\nof hello.py", from: "person", images: [{ offset: 0, bytes: 900, sha256: "a".repeat(64), index: 0 }] },
    { kind: "tool", at: 2, id: "t1", name: "Bash", input: { command: "wc -l hello.py" } },
    { kind: "result", at: 3, toolUseId: "t1", output: "1 hello.py", isError: false },
    { kind: "tool", at: 4, id: "t2", name: "Bash", input: { command: "false" } },
    { kind: "result", at: 5, toolUseId: "t2", output: "Exit code 1", isError: true },
    { kind: "reply", at: 6, text: "It has 1 line." },
    { kind: "task", at: 7, toolUseId: "t1", status: "completed", summary: 'Agent "Count" finished', result: null },
    { kind: "notice", at: 8, tone: "error", text: "The model failed" },
    { kind: "turn", at: 9, durationMs: 72_000 },
    { kind: "record", at: null, type: "mystery", summary: '{"type":"mystery"}' },
    { kind: "pull-request", at: 10, number: 7, url: "https://github.com/octocat/Spoon-Knife/pull/7", repository: "octocat/Spoon-Knife" },
    { kind: "pull-request", at: 10, number: 7, url: "https://github.com/octocat/Spoon-Knife/pull/7", repository: "octocat/Spoon-Knife" },
    { kind: "prompt", at: 10, text: "/compact", from: "command" },
    { kind: "queue", at: 11, op: "enqueue", text: "and then deploy" },
    { kind: "tool", at: 12, id: "t3", name: "Read", input: { file_path: "hello.py" } },
  ];
  const readAt = Date.now();
  s.registry.threads.appendClaudeRead(thread.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 9 }, reset: false, readAt });

  assert.deepEqual(await s.json(["conversation", thread.id]), { kind: "claude", session: "s1", entries, dropped: 0, readAt, working: false, usageLimit: null }, "--json prints the API's reply");
  const transcript = [
    "> Count the lines\n> of hello.py\n> [image]",
    '[tool] Bash {"command":"wc -l hello.py"} (ok)',
    '[tool] Bash {"command":"false"} (failed)',
    "It has 1 line.",
    '[task] completed: Agent "Count" finished',
    "[error] The model failed",
    "[turn] 72s",
    '[record] mystery: {"type":"mystery"}',
    "[pull request] Opened pull request #7: https://github.com/octocat/Spoon-Knife/pull/7",
    "> [slash command] /compact",
  ];
  assert.equal((await s.nexus(["conversation", thread.id])).stdout, [...transcript, '[tool] Read {"file_path":"hello.py"} (no result)', "(queued) > and then deploy"].join("\n\n") + "\n");
  s.registry.threads.reportSession(node, { sequence: 1, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "s1" } });
  assert.equal((await s.nexus(["conversation", thread.id])).stdout, [...transcript, '[tool] Read {"file_path":"hello.py"} (running)', "(queued) > and then deploy", "(Claude is working)"].join("\n\n") + "\n");

  let refusals = 2;
  s.probeAnswers(async () => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return { kind: "send-claude", outcome: "queued", terminal: "t1", resumed: true };
  });
  s.commands.length = 0;
  const queued = await s.nexus(["send", thread.id, "and", "then", '"deploy"', "--request-id", "msg:fixed"]);
  assert.equal(queued.code, 0, queued.stderr);
  assert.equal(queued.stdout, `Queued for Claude in ${thread.id}, which takes it at its next step. Its session was resumed to take it.\n`);
  assert.deepEqual(s.commands, Array(3).fill({ kind: "send-claude", session: "s1", text: 'and then "deploy"', requestId: "msg:fixed", model: "claude-opus-5-5" }), "a paused pylon is woken and asked again until it runs");
  assert.deepEqual(await s.json(["send", thread.id, "and", "then", '"deploy"', "--request-id", "msg:fixed"]), { claude: { session: "s1", outcome: "queued", resumed: true } });
  assert.equal(s.commands.length, 3, "a resend under the same request ID is not typed again");
  s.probeAnswers(async () => ({ kind: "send-claude", outcome: "sent", terminal: "t1", resumed: false }));
  assert.equal((await s.nexus(["send", thread.id, "go", "--steer"])).stdout, `Sent to Claude in ${thread.id}.\n`);
  assert.deepEqual(s.fake.calls.filter(([call]) => call === "send"), [], "the harness is sent nothing");
  assert.match((await s.nexus(["send", "--help"])).stdout, /typed into the Claude worker's session/);
});

test("send to a Claude worker that waits at a prompt in its terminal fails at once with exit code 5, and is typed once", { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const { thread } = await claudeWatched(t, s);
  s.probeAnswers(async () => ({ kind: "send-claude", outcome: "blocked", terminal: "t1", resumed: false }));
  s.commands.length = 0;
  const blocked = await s.nexus(["send", thread.id, "deploy", "--json"]);
  assert.equal(blocked.code, 5, blocked.stderr);
  const reported = JSON.parse(blocked.stderr);
  assert.match(reported.error, /^Claude waits at a prompt in its terminal, so nothing was typed/);
  assert.deepEqual([reported.kind, reported.status, reported.code], ["conflict", 409, "blocked"]);
  assert.equal(s.commands.filter((c) => c.kind === "send-claude").length, 1);
});

test("abort interrupts a Claude worker's turn with Esc in its terminal, and fails with exit code 5 when Claude was not working", async (t) => {
  const s = await setup(t);
  const { thread } = await claudeWatched(t, s);
  let outcome: InterruptClaudeOutcome = "interrupted";
  s.probeAnswers(async (command) => command.kind === "interrupt-claude" ? { kind: "interrupt-claude", outcome } : assert.fail(`unexpected ${command.kind}`));
  s.commands.length = 0;
  const done = await s.nexus(["abort", thread.id]);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(s.commands, [{ kind: "interrupt-claude", session: "s1" }]);
  assert.deepEqual(s.fake.calls.filter(([call]) => call === "abort"), [], "the harness aborts nothing");
  outcome = "blocked";
  const refused = await s.nexus(["abort", thread.id]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, new RegExp(`Claude waits at a prompt in its terminal, which Esc would cancel, so nothing was pressed\\. Attach to the pylon \\(\`nexus attach ${thread.id}\`\\)`));
});

test("start --request-id starts one thread and sends its first message once, however often it is run", async (t) => {
  const s = await setup(t);
  const args = ["start", "--project", "acme", "--message", "Fix the build", "--request-id", "start:cli"];
  const before = s.requests();
  const first: Thread = await s.json(args);
  assert.equal(s.requests() - before, 1, "one request starts it with its first message");
  const again = await s.nexus(args);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `Started ${first.id} on acme: Fix the build\nSent the first message.\n\`nexus watch ${first.id}\` follows it.\n`);
  assert.deepEqual((await s.json(["threads"])).map((r: Thread) => r.id), [first.id]);
  assert.deepEqual(s.fake.transcript(first.id).messages.map((m) => m.content), ["Fix the build"]);
  const other = await s.nexus(["start", "--project", "acme", "--message", "Fix the tests", "--request-id", "start:cli", "--json"]);
  assert.equal(other.code, 5, "another start under the same request ID is a conflict");
  assert.match(other.stderr, new RegExp(`request ID start:cli started thread ${first.id} with another body`));
});

test("start --plan starts a planning thread, whose first message carries the guide, and show says it plans", async (t) => {
  const s = await setup(t);
  assert.equal((await s.nexus(["start", "--project", "acme", "--plan", "--claude", "Plan it"])).code, 64);
  const started = await s.nexus(["start", "--project", "acme", "--plan", "--message", "Plan the orchestration wave"]);
  assert.equal(started.code, 0, started.stderr);
  const id = /^Started planning thread (th-[0-9a-f]+) on acme: Plan the orchestration wave\nSent the first message\.\n`nexus watch \1` follows it\.$/.exec(started.stdout.trim())?.[1];
  assert.ok(id !== undefined, started.stdout);
  const first = s.fake.transcript(id).messages[0]!.content as string;
  assert.ok(first.startsWith(planningPrefix) && first.endsWith("Plan the orchestration wave"));
  assert.match((await s.nexus(["show", id])).stdout, /^planning: its proposed items become questions you accept or reject$/m);
  assert.equal((await s.json(["show", id])).planning, true);
});

test("start --after --request-id answers the queued thread, and the thread once it has started", async (t) => {
  const s = await setup(t, { queue: true });
  const first: Thread = await s.json(["start", "--project", "acme", "--title", "First"]);
  const args = ["start", "--project", "acme", "--message", "Then this", "--after", first.id, "--request-id", "start:queued"];
  const queued: QueuedThread = await s.json(args);
  assert.deepEqual(await s.json(args), queued);
  assert.equal((await s.nexus(["start-queued", queued.id])).code, 0);
  const again = await s.nexus(args);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `Started ${queued.id} on acme: Then this\n`);
});

test("start --after queues a thread in one request, and threads, show, start-queued and archive speak of it as queued", async (t) => {
  const s = await setup(t, { queue: true });
  const first: Thread = await s.json(["start", "--project", "acme", "--title", "First"]);
  const second: Thread = await s.json(["start", "--project", "acme", "--title", "Second"]);
  const before = s.requests();
  const queuedText = await s.nexus(["start", "--project", "acme", "--message", "Fix the next bug\nthen push", "--after", `${first.id}, ${second.id}`]);
  assert.equal(queuedText.code, 0, queuedText.stderr);
  assert.equal(s.requests() - before, 1, "one request queues it with its first message");
  const [record] = s.registry.queue.queuedThreads();
  const id = record!.id;
  assert.equal(queuedText.stdout, `Queued ${id} on acme: Fix the next bug. It starts once ${first.id} and ${second.id} have merged their pull requests.\n`);
  assert.equal(record!.message, "Fix the next bug\nthen push");
  assert.deepEqual(s.fake.calls.filter((c) => c[0] === "send"), [], "the first message waits for the start");

  const later: QueuedThread = await s.json(["start", "--project", "acme", "--title", "Later", "--claude", "Do it", "--after", id]);
  assert.deepEqual([later.worker, later.model, later.prompt], ["claude", "claude-opus-5-5", "Do it"]);
  assert.deepEqual(later.waits, [{ thread: id, state: "waiting", why: "is queued" }]);
  assert.equal((await s.nexus(["start", "--project", "acme", "--title", "x", "--after", "th-nope"])).code, 4);
  assert.equal((await s.nexus(["start", "--project", "acme", "--title", "x", "--after", ","])).code, 64);

  const pr = (number: number, state: "open" | "closed") => ({ pr: { repo: "octocat/Spoon-Knife", number, title: "PR", url: "", state, checks: "none" as const, review: "none", conflict: null }, seen: [], failed: false });
  s.registry.prWatches.savePrWatch(first.id, { links: [pr(3, "open")], commentWakes: 0, pending: null, error: null });
  s.registry.prWatches.savePrWatch(second.id, { links: [pr(4, "closed")], commentWakes: 0, pending: null, error: null });
  const rows = (await s.nexus(["threads"])).stdout;
  assert.match(rows, new RegExp(`^${id}\\s+blocked\\s+blocked by ${second.id}: PR #4 closed without merging\\s+rj-firebat\\s+acme\\s+\\S+ ago \\(.+\\)\\s+Fix the next bug$`, "m"));
  assert.match(rows, new RegExp(`^${later.id}\\s+queued\\s+waits for ${id}: is queued\\s`, "m"));
  assert.deepEqual((await s.json(["threads"])).map((r: Thread) => r.id), [first.id, second.id], "--json prints the thread rows alone, as before");
  assert.deepEqual((await s.json(["threads", "--queued"])).map((q: QueuedThread) => q.id), [id, later.id]);
  assert.doesNotMatch((await s.nexus(["threads", "--queued"])).stdout, new RegExp(first.id));

  assert.equal((await s.nexus(["show", id])).stdout, [
    `${id}  Fix the next bug`, "project: acme", "status: blocked", "node: rj-firebat", "worker: Nexus agent", "size: 2 CPUs, 4 GiB memory, 10 GiB disk",
    "first message: Fix the next bug", `waits for ${first.id}: PR #3 is open`, `blocked by ${second.id}: PR #4 closed without merging`,
    `nexus start-queued ${id} starts it now; nexus archive ${id} cancels it.`, "",
  ].join("\n"));
  assert.equal((await s.json(["show", id])).blocked, true);
  assert.equal((await s.nexus(["show", "th-nope"])).code, 4, "an unknown thread is still not found");

  assert.equal((await s.nexus(["start-queued", id])).stdout, `Started ${id} on acme: Fix the next bug\n`);
  assert.deepEqual(s.fake.calls.at(-1), ["send", id, "Fix the next bug\nthen push", `queued:${id}`, "followUp"]);
  assert.equal((await s.json(["show", id])).thread.id, id);
  assert.equal((await s.nexus(["start-queued", id])).code, 5, "a started thread is not queued");

  assert.equal((await s.nexus(["archive", later.id])).stdout, `Archived ${later.id}. Its queued start is cancelled.\n`);
  assert.doesNotMatch((await s.nexus(["threads"])).stdout, new RegExp(later.id));
  assert.match((await s.nexus(["threads", "--all"])).stdout, new RegExp(`^${later.id}\\s+cancelled\\s`, "m"));
  assert.match((await s.nexus(["show", later.id])).stdout, new RegExp(`^status: cancelled$[^]*^nexus unarchive ${later.id} queues it again\\.$`, "m"));
  assert.equal((await s.nexus(["start-queued", later.id])).code, 5);
  assert.equal((await s.nexus(["unarchive", later.id])).stdout, `Unarchived ${later.id}. It is queued again.\n`);
  assert.equal((await s.json(["delete", later.id])).status, "deleted");
});

test("start --after against a control plane without its GitHub token exits 5 and says why", async (t) => {
  const s = await setup(t);
  const refused = await s.nexus(["start", "--project", "acme", "--title", "x", "--after", "th-any"]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /queued threads need the control plane's GitHub token \(github.tokenFile\)/);
  assert.equal((await s.nexus(["threads"])).stdout, "No threads.\n");
  assert.equal((await s.nexus(["threads", "--queued"])).stdout, "No queued threads.\n");
});

test("start and item add check their worker flags alike, a Fable model included, and item add refuses an --after that names nothing without a request", async (t) => {
  const s = await setup(t, { queue: true });
  for (const command of [["start"], ["item", "add"]]) {
    const res = await s.nexus([...command, "--project", "acme", "--message", "Build A", "--model", "claude-opus-5-5"]);
    assert.deepEqual([res.code, res.stderr], [64, `nexus: --model requires --claude. Run nexus ${command.join(" ")} --help for usage\n`], command.join(" "));
    const asked = s.requests();
    const fable = await s.nexus([...command, "--project", "acme", "--claude", "Build A", "--model", "claude-fable-5-1"]);
    assert.equal(fable.code, 64, command.join(" "));
    assert.match(fable.stderr, /^nexus: --model claude-fable-5-1 is a Fable model, and Fable models are not available in pylons: .* or leave out --model for claude-opus-5-5\./, command.join(" "));
    assert.equal(s.requests(), asked, "a Fable model is refused before any request");
  }
  await s.nexus(["project", "edit", "acme", "--pipeline", "start"]);
  const asked = s.requests();
  const empty = await s.nexus(["item", "add", "--project", "acme", "--message", "Build A", "--after", " , "]);
  assert.deepEqual([empty.code, empty.stderr], [64, "nexus: --after needs a thread. Run nexus item add --help for usage\n"]);
  assert.equal(s.requests(), asked, "nothing was sent");
  assert.deepEqual(await s.json(["items"]), []);
});

test("send to a Claude worker whose message meets an unreachable control plane fails at once with exit code 2, and is not sent again", { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const sends: string[] = [];
  const dropping = createHttpServer(withHealth((req, res) => {
    if (req.method === "GET") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ thread: { status: "active" }, claudeWorker: {} }));
    sends.push(req.url!);
    req.socket.destroy();
  }));
  const port = await listening(t, dropping);
  const started = Date.now();
  const sent = await s.nexus(["send", "th-0123456789ab", "deploy", "--json"], { NEXUS_URL: `http://127.0.0.1:${port}`, NEXUS_SOCKS: "none" });
  assert.equal(sent.code, 2, sent.stderr);
  assert.equal(JSON.parse(sent.stderr).kind, "unreachable");
  assert.equal(sends.length, 1, "the message may have run, so it is not sent again");
  assert.ok(Date.now() - started < 60_000, "it fails at once rather than waiting the 120 s for the pylon, and this bound only ends a hang");
});

test("send, start and item add take a message from stdin or a file as written, and text that starts with a dash after --", async (t) => {
  const s = await setup(t, { queue: true });
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "texts"]);
  const sent = () => s.fake.calls.at(-1)?.slice(2, 3)[0];
  const dir = await tempDir("nexus-message-", t);
  const file = join(dir, "message.md");
  const awkward = "- first bullet\n--force is broken\nplease check the --json output\n";
  await writeFile(file, awkward);

  assert.equal((await s.nexus(["send", thread.id, "-"], undefined, awkward)).stdout, `Sent to ${thread.id}.\n`);
  assert.equal(sent(), awkward.slice(0, -1), "send - reads stdin, less the last line break");
  assert.equal((await s.nexus(["send", thread.id, "--file", file, "--steer"])).code, 0);
  assert.deepEqual(s.fake.calls.at(-1)?.slice(2), [awkward.slice(0, -1), s.fake.calls.at(-1)![3], "steer"], "--file reads the file, and flags still parse");
  assert.equal((await s.nexus(["send", thread.id, "--", "- first bullet"])).code, 0);
  assert.equal(sent(), "- first bullet", "after -- text that starts with a dash is sent");
  assert.equal((await s.nexus(["send", thread.id, "please", "check", "--steer", "this"])).code, 0);
  assert.deepEqual(s.fake.calls.at(-1)?.slice(2), ["please check this", s.fake.calls.at(-1)![3], "steer"], "flags among the words parse as before");
  await s.nexus(["send", thread.id, "-"], undefined, Buffer.from("\uFEFFhi\r\n"));
  assert.equal(sent(), "\uFEFFhi", "stdin is decoded as a file is, keeping a byte order mark");
  await s.nexus(["send", thread.id, "-", "x"]);
  assert.equal(sent(), "- x", "- with other words is text, as before");

  const before = s.fake.calls.length;
  const refused = async (args: string[], stderr: string, stdin?: string) => assert.deepEqual(
    [(await s.nexus(args, undefined, stdin)).stderr, s.fake.calls.length], [`nexus: ${stderr}\n`, before], args.join(" "));
  await refused(["send", thread.id, "- first bullet"], "send takes no -. To send text that starts with a dash, put -- before it, or pass it on stdin with - or from a file with --file PATH. Run nexus send --help for usage");
  await refused(["send", thread.id], "send needs the message: words, - to read stdin, or --file PATH. Run nexus send --help for usage");
  await refused(["send", thread.id, "-"], "send - read nothing from stdin. Run nexus send --help for usage");
  await refused(["send", thread.id, "hi", "--file", file], "send takes its text as words, -, or --file, not both words and --file. Run nexus send --help for usage");
  await refused(["send", thread.id, "--file", join(dir, "none")], `--file could not read ${join(dir, "none")}: ENOENT: no such file or directory, open '${join(dir, "none")}'`);
  await refused(["start", "--project", "acme", "--message", "--force is broken"], "--message takes a value that starts with a dash only as --message=VALUE, or from a file or stdin with --message-file PATH|-. Run nexus start --help for usage");
  await refused(["start", "--project", "acme", "--message", "x", "--message-file", file], "--message and --message-file cannot be used together. Run nexus start --help for usage");
  await refused(["send", thread.id, "--stee", "x"], "send takes no --stee. Did you mean --steer? To send text that starts with a dash, put -- before it, or pass it on stdin with - or from a file with --file PATH. Run nexus send --help for usage");
  await refused(["start", "--project", "acme", "--message-file", "-", "--claude-file", "-"], "--message-file is for a Nexus agent thread. A Claude worker's first prompt is its --claude-file. Run nexus start --help for usage", "never read");

  const started: Thread = await s.json(["start", "--project", "acme", "--message-file", "-"], undefined, async (args, overrides) => s.nexus(args, overrides, awkward));
  assert.equal(started.title, "- first bullet", "the title is the file's first line");
  assert.deepEqual(s.fake.calls.at(-1)?.slice(1, 3), [started.id, awkward.slice(0, -1)], "start --message-file - sends stdin as the first message");
  assert.match((await s.nexus(["start", "--project", "acme", "--message-file", file])).stdout, /\nSent the first message\.\n/, "the text says a message from a file was sent");
  const claude: Thread = await s.json(["start", "--project", "acme", "--title", "c", "--claude-file", file]);
  assert.equal(s.registry.threads.claudeWorker(claude.id)?.prompt, `/poteto-mode ${awkward.trim()}`, "start --claude-file reads the prompt from the file");

  await s.nexus(["project", "edit", "acme", "--pipeline", "approve"]);
  const item = await s.json(["item", "add", "--project", "acme", "--message-file", file]);
  const prompted = await s.json(["item", "add", "--project", "acme", "--claude-file", "-"], undefined, async (args, overrides) => s.nexus(args, overrides, "--force is broken"));
  assert.deepEqual([item.brief, prompted.brief, prompted.worker], [awkward.slice(0, -1), "--force is broken", "claude"]);
});

test("show reads only a refusal coded queued as a queued thread, and passes any other 409 on", async () => {
  const asked: string[] = [];
  const refusing = (refusal: CliError): Api => async (method, path) => {
    asked.push(`${method} ${path}`);
    if (path === "/v1/threads/th-0123456789ab") throw refusal;
    return { id: "th-0123456789ab", status: "queued" };
  };
  const blocked = new CliError("conflict", "the Claude worker waits at a prompt", 409, "blocked");
  await assert.rejects(threadsCommands.show!.run(refusing(blocked), ["th-0123456789ab"], {}, null!, null!) as Promise<unknown>, blocked);
  assert.deepEqual(asked, ["GET /v1/threads/th-0123456789ab"], "a 409 that is not queued asks for no queued thread");
});
