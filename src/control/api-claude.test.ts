/** Claude worker threads: their sends, aborts, transcripts and page streams. */
import { snapshotTurn } from "../../images/pylon/nexus-turn.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { claudeProjects, maxRecordBytes, type ClaudeConversation } from "../claude-transcript.ts";
import { claudeTurn } from "../../images/pylon/nexus-contract.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadRow } from "./wire.ts";
import type { Thread } from "./thread-store.ts";
import { processStream } from "../process-stream.ts";
import { stoppedPylon, testObservation, until } from "../test-kit.ts";
import type { CommandResult, InterruptClaudeOutcome, PylonCommand } from "../protocol/commands.ts";
import { node, claudeSession, fixture, withThread, localCheckout, pngBytes, withClaude, sent } from "./api-test-kit.ts";

const usageLimitRecord = (await readFile(new URL("../fixtures/claude-api-errors.jsonl", import.meta.url), "utf8")).split("\n")[0]! + "\n";

test("a Claude worker start stores its first prompt without starting a harness conversation", async (t) => {
  const s = await withThread(t);
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix the bug" });
  assert.equal(started.status, 201);
  assert.equal(started.body.conversationId, null);
  assert.deepEqual(s.registry.claudeWorker(started.body.id), { model: "claude-opus-5-5", prompt: "/poteto-mode fix the bug", state: "pending", session: null });
  assert.equal((await s.call("GET", `/v1/threads/${started.body.id}`)).body.claudeWorker.state, "pending");
  const brief = "fix the bug:\n\t- keep \"quotes\", `ticks` and $HOME\n\nthen test";
  const multiLine = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: brief });
  assert.equal(s.registry.claudeWorker(multiLine.body.id)!.prompt, `/poteto-mode ${brief}`);
  assert.equal((await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "a\0b" })).status, 400);
});

test("a Claude worker's pasted image is served from its transcript while the pylon runs, by the place its entry names", async (t) => {
  const s = await withClaude(t);
  const record = JSON.stringify({
    type: "user", timestamp: "2026-10-28T10:00:00.000Z", origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "What is wrong here?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: pngBytes.toString("base64") } }] },
  });
  await writeFile(s.transcript, `${fixture[0]}${record}\n`);
  const view = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  const prompt = view.entries.find((e) => e.kind === "prompt" && e.text === "What is wrong here?") as Extract<ClaudeConversation["entries"][number], { kind: "prompt" }>;
  const [place] = prompt.images!;
  const query = (p: typeof place) => `/v1/threads/${s.thread.id}/image?source=transcript&offset=${p!.offset}&bytes=${p!.bytes}&sha256=${p!.sha256}&index=${p!.index}`;
  const active = s.registry.thread(s.thread.id)!.lastHumanActivityAt;
  s.woken.length = 0;
  const shot = await s.raw(query(place));
  assert.equal(shot.status, 200);
  assert.deepEqual(shot.body, pngBytes);
  assert.equal(shot.headers["content-type"], "image/png");
  assert.equal(shot.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.equal(shot.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal((await s.raw(query({ ...place!, index: 1 }))).status, 404);
  assert.equal((await s.raw(query({ ...place!, bytes: 5 << 20 }))).status, 400, "no record is longer than one read");
  s.registry.markOffline(node);
  const paused = await s.call("GET", query(place));
  assert.equal(paused.status, 409);
  assert.deepEqual(s.woken, []);
  assert.equal(s.registry.thread(s.thread.id)!.lastHumanActivityAt, active);
});

test("a Claude worker thread's latest turn is the one its newest turn-started names, and a turn without a snapshot is refused", async (t) => {
  const s = await withClaude(t);
  const { repo } = await localCheckout(t, s);
  const route = `/v1/threads/${s.thread.id}/changes?base=turn`;
  const helper = fileURLToPath(new URL("../checkout-files.py", import.meta.url));
  let sequence = 0;
  const started = (session: string, at: number) => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session, at } });
  const turn = async (session: string, at: number) => {
    assert.ok(await snapshotTurn(repo, claudeTurn(session, at), 30_000, helper));
    started(session, at);
  };
  const changed = async () => (await s.call("GET", route)).body.files.map((f: { path: string }) => f.path);
  assert.equal((await s.call("GET", route)).status, 422, "no turn has started");
  const at = Date.now();
  await turn(claudeSession, at);
  await writeFile(join(repo, "first.txt"), "first\n");
  assert.deepEqual(await changed(), ["first.txt"]);
  await turn(claudeSession, at + 1);
  await writeFile(join(repo, "second.txt"), "second\n");
  assert.deepEqual(await changed(), ["second.txt"]);
  started("another-session", at);
  assert.deepEqual(await changed(), ["second.txt"], "an older turn reported late does not replace the newest");
  started(claudeSession, at + 2);
  const stale = await s.call("GET", route);
  assert.equal(stale.status, 422, "a turn whose hook took no snapshot, as on an older image, never shows the previous one");
  assert.match(stale.body.error, /no latest-turn snapshot/);
});

test("a Claude worker thread's message is typed into its session exactly, in either mode, and never reaches the harness", async (t) => {
  const s = await withClaude(t);
  s.probeAnswers(async (command) => command.kind === "send-claude" ? sent("sent") : assert.fail(`unexpected ${command.kind}`));
  s.calls.length = 0;
  s.woken.length = 0;
  const before = Date.now();
  const send = (body: unknown) => s.call("POST", `/v1/threads/${s.thread.id}/messages`, body);
  const text = `Fix the "cart" total:\n  run \`npm test\` with $HOME and $(whoami) as typed\n\nthen say 'done' !`;

  assert.deepEqual(await send({ text, requestId: "msg:1" }), { status: 202, body: { claude: { session: claudeSession, outcome: "sent", resumed: false } } });
  assert.equal((await send({ text: "now", requestId: "msg:2", mode: "steer" })).status, 202);
  assert.equal((await send({ text: "later", requestId: "msg:3", mode: "followUp" })).status, 202);
  assert.equal((await send({ text: " one\r\ntwo\rthree\r\n", requestId: "msg:4" })).status, 202);
  const typed = (text: string, requestId: string) => [s.thread.pylonId, { kind: "send-claude", session: claudeSession, text, requestId, model: "claude-opus-5-5" }];
  assert.deepEqual(s.commands, [typed(text, "msg:1"), typed("now", "msg:2"), typed("later", "msg:3"), typed("one\ntwo\nthree", "msg:4")], "the text exactly, line ends made newlines, in both modes");
  assert.deepEqual(s.calls.filter(([call]) => call === "send"), [], "the harness is sent none of them");
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt >= before, "a message is human activity");
  assert.ok(s.woken.includes(node));

  s.commands.length = 0;
  const tab = await send({ text: "a\tb", requestId: "msg:5" });
  assert.equal(tab.status, 400);
  assert.match(tab.body.error, /tab/);
  assert.equal((await send({ text: " \n ", requestId: "msg:6" })).status, 400);
  assert.equal((await send({ text: "x" })).status, 400);
  assert.deepEqual(s.commands, [], "a message Claude cannot take as typed never reaches the probe");
});

test("a Claude worker's message is typed once per request ID, a send that typed nothing can be sent again, and one that may have typed some cannot", async (t) => {
  const s = await withClaude(t);
  let answer = async (): Promise<CommandResult> => sent("queued", true);
  s.probeAnswers(() => answer());
  const send = (requestId: string) => s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "run it", requestId });
  const queued = { status: 202, body: { claude: { session: claudeSession, outcome: "queued", resumed: true } } };
  assert.deepEqual(await send("msg:1"), queued);
  assert.deepEqual(await send("msg:1"), queued, "a resend answers what the send did");
  assert.equal(s.commands.length, 1, "and types nothing");

  answer = async () => { throw { code: "not-running", message: "the pylon is paused" }; };
  const before = Date.now();
  const paused = await send("msg:2");
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /is not running yet. This request wakes it/);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt >= before, "the send is human activity, which wakes the pylon");
  answer = async () => sent("blocked" as never);
  const blocked = await send("msg:2");
  assert.equal(blocked.status, 409, "the paused send typed nothing, so its request ID is tried again");
  assert.match(blocked.body.error, /Claude waits at a prompt in its terminal, so nothing was typed. Attach/);
  answer = async () => sent("starting" as never);
  assert.equal((await send("msg:2")).status, 409);
  answer = async () => sent("moved" as never);
  const moved = await send("msg:2");
  assert.equal(moved.status, 409);
  assert.match(moved.body.error, new RegExp(`stopped running Claude session ${claudeSession} before the message was typed, so nothing was typed. Send again`));
  answer = async () => sent("sent");
  assert.equal((await send("msg:2")).status, 202);
  assert.equal(s.commands.length, 6);

  answer = async () => { throw new Error("typing into Claude's pane w1:p1 failed, so part of the message may sit unsent in its prompt"); };
  assert.equal((await send("msg:3")).status, 500);
  answer = async () => ({ kind: "send-claude-outcome", send: "failed" });
  const again = await send("msg:3");
  assert.equal(again.status, 422);
  assert.match(again.body.error, /Check the conversation before sending it again under a new request ID/);
  assert.deepEqual(s.commands.slice(6).map(([, command]) => command.kind), ["send-claude", "send-claude-outcome"], "a send that may have typed part of the message is asked after, not typed again");
});

test("a Claude worker's message whose probe wait ran out is typed once, and a resend under its request ID answers what became of it", async (t) => {
  const s = await withClaude(t);
  const send = (requestId: string) => s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "run it", requestId });
  let answer = async (_command: PylonCommand): Promise<CommandResult> => { throw Object.assign(new Error(`${node}: no answer within 90000 ms`), { code: "unreachable" }); };
  s.probeAnswers((command) => answer(command));
  const slow = await send("msg:1");
  assert.equal(slow.status, 503);
  assert.match(slow.body.error, /no answer within 90000 ms. The message may still reach Claude, as one queued in the pylon behind an earlier send does, and reaches it at most once. Send it again under request ID msg:1 to learn what became of it/);

  answer = async (command) => command.kind === "send-claude-outcome" ? { kind: "send-claude-outcome", send: { outcome: "queued", herdrPane: "w1:p1", resumed: false } } : assert.fail(`${command.kind} would type it again`);
  const queued = { status: 202, body: { claude: { session: claudeSession, outcome: "queued", resumed: false } } };
  assert.deepEqual(await send("msg:1"), queued, "the resend answers how Claude took the first");
  assert.deepEqual(await send("msg:1"), queued);
  assert.deepEqual(s.commands.map(([, command]) => command), [
    { kind: "send-claude", session: claudeSession, text: "run it", requestId: "msg:1", model: "claude-opus-5-5" },
    { kind: "send-claude-outcome", requestId: "msg:1" },
  ], "the probe was asked about it once, and the message typed once");

  answer = async (command) => { if (command.kind === "send-claude") throw Object.assign(new Error(`${node}: no answer within 90000 ms`), { code: "unreachable" }); return { kind: "send-claude-outcome", send: { outcome: "blocked", herdrPane: "w1:p1", resumed: false } }; };
  assert.equal((await send("msg:2")).status, 503);
  assert.equal((await send("msg:2")).status, 409, "the first send typed nothing after all");
  answer = async () => sent("sent");
  assert.equal((await send("msg:2")).status, 202, "so its request ID is typed when sent again");

  for (const [requestId, earlier] of [["msg:3", async () => ({ kind: "send-claude-outcome", send: "unknown" }) as CommandResult], ["msg:4", async () => { throw new Error(`${node}: POST /v1/pylons/x/commands: HTTP 400: unknown command kind "send-claude-outcome"`); }]] as const) {
    answer = async () => { throw Object.assign(new Error(`${node}: no answer within 90000 ms`), { code: "unreachable" }); };
    assert.equal((await send(requestId)).status, 503);
    answer = earlier;
    assert.equal((await send(requestId)).status, 422, `${requestId}: a probe that cannot say what became of it, restarted or older, leaves it uncertain`);
  }
});

test("a resend while its first send is still asked waits for it, so a late answer that typed nothing cannot clear a newer send's fence", async (t) => {
  const s = await withClaude(t);
  const answers: PromiseWithResolvers<CommandResult>[] = [];
  s.probeAnswers(() => { answers.push(Promise.withResolvers()); return answers.at(-1)!.promise; });
  const send = () => s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "run it", requestId: "msg:1" });
  const asked = async (n: number) => { while (s.commands.length < n) await sleep(5); };
  const first = send();
  await asked(1);
  const resend = send();
  await sleep(100);
  assert.equal(s.commands.length, 1, "the resend does not ask the probe while the first send waits on it");
  answers[0]!.resolve(sent("blocked" as never));
  assert.equal((await first).status, 409, "the first send typed nothing");
  await asked(2);
  const again = send();
  await sleep(100);
  answers[1]!.resolve(sent("queued"));
  const queued = { status: 202, body: { claude: { session: claudeSession, outcome: "queued", resumed: false } } };
  assert.deepEqual(await resend, queued, "the resend typed the message itself, as the first typed nothing");
  assert.deepEqual(await again, queued, "and a resend while it was typing answers what it did");
  assert.deepEqual(await send(), queued);
  assert.deepEqual(s.commands.map(([, command]) => command.kind), ["send-claude", "send-claude"], "the message was typed by one send only");
});

test("a Claude worker thread takes no messages while archived, deleted or before its session starts, and asks no probe", async (t) => {
  const s = await withClaude(t);
  s.probeAnswers(async () => assert.fail("no command reaches the probe"));
  const fresh = (await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "later" })).body as Thread;
  const early = await s.call("POST", `/v1/threads/${fresh.id}/messages`, { text: "hi", requestId: "msg:1" });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /has not started a session yet/);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`, {})).status, 200);
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hi", requestId: "msg:2" }), { status: 409, body: { error: `thread ${s.thread.id} is archived` } });
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`, {})).status, 200);
  assert.deepEqual(await s.call("POST", `/v1/threads/${s.thread.id}/messages`, { text: "hi", requestId: "msg:3" }), { status: 409, body: { error: `thread ${s.thread.id} is deleted` } });
  assert.equal((await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).status, 409);
  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/abort`)).status, 409);
  assert.deepEqual(s.calls.filter(([call]) => call === "send" || call === "abort"), []);
});

test("a Claude worker thread's abort presses Esc in its session's pane through the probe, and says why when nothing was pressed", async (t) => {
  const s = await withClaude(t);
  let outcome: InterruptClaudeOutcome = "interrupted";
  s.probeAnswers(async (command) => command.kind === "interrupt-claude" ? { kind: "interrupt-claude", outcome } : assert.fail(`unexpected ${command.kind}`));
  const abort = () => s.call("POST", `/v1/threads/${s.thread.id}/abort`);
  assert.equal((await abort()).status, 204);
  assert.deepEqual(s.commands, [[s.thread.pylonId, { kind: "interrupt-claude", session: claudeSession }]]);
  assert.deepEqual(s.calls.filter(([call]) => call === "abort"), [], "the harness aborts nothing");

  const refusals: [InterruptClaudeOutcome, RegExp][] = [
    ["blocked", new RegExp(`waits at a prompt in its terminal, which Esc would cancel, so nothing was pressed.*nexus attach ${s.thread.id}`)],
    ["idle", /not working, so there is no turn to interrupt/],
    ["unknown", /cannot tell yet/],
    ["not-running", new RegExp(`no pane runs Claude session ${claudeSession}`)],
  ];
  for ([outcome] of refusals) {
    const refused = await abort();
    assert.equal(refused.status, 409, outcome);
    assert.match(refused.body.error, refusals.find(([o]) => o === outcome)![1]);
  }

  s.commands.length = 0;
  s.woken.length = 0;
  observePaused(s);
  const paused = await abort();
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /does not wake it/);
  assert.deepEqual([s.commands, s.woken], [[], []], "a paused pylon runs no turn, so it is not woken to be interrupted");

  const fresh = (await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "later" })).body as Thread;
  const early = await s.call("POST", `/v1/threads/${fresh.id}/abort`);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /has not started a session yet, so it has no turn to interrupt/);
});

/** Records the thread's pylon stopped, as the loop would from its node's observation. */
function observePaused(s: Awaited<ReturnType<typeof withClaude>>) {
  s.registry.ingested(testObservation(node, { pylons: [stoppedPylon(s.thread.pylonId)] }), []);
}

test("a Claude worker stopped on its usage limit lists as limited, with the stop in its row and its conversation", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, `${fixture[0]}${usageLimitRecord}`);
  const stop = { stoppedAt: Date.parse("2026-10-26T05:34:18.605Z"), resetsAt: 1792996200000 };
  assert.deepEqual(((await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation).usageLimit, stop);
  const row = ((await s.call("GET", "/v1/threads")).body as ThreadRow[]).find((r) => r.id === s.thread.id)!;
  assert.equal(row.attention, "limited");
  assert.deepEqual(row.usageLimit, stop);
});

test("a Claude worker thread's conversation is its transcript, read from the running pylon after each session event and kept for when it is paused", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const reply = await s.call("GET", `/v1/threads/${s.thread.id}/conversation`);
  assert.equal(reply.status, 200);
  const first = reply.body as ClaudeConversation;
  assert.deepEqual({ ...first, entries: [], readAt: null }, { kind: "claude", session: claudeSession, entries: [], dropped: 0, readAt: null, working: false, usageLimit: null });
  assert.ok(first.readAt !== null && first.readAt >= Date.now() - 10_000);
  const prompt = first.entries[0]!;
  assert.ok(prompt.kind === "prompt" && prompt.from === "person" && prompt.text.startsWith("Do these steps one at a time"), JSON.stringify(prompt));
  assert.deepEqual(first.entries.flatMap((e) => e.kind === "tool" ? [e.name] : []), ["Write", "Bash", "Bash", "Agent"]);
  assert.deepEqual(first.entries.flatMap((e) => e.kind === "result" ? [e.isError] : []), [false, false, true, false], "each call's result, the failed `false` among them");

  const reads = s.streams.length;
  await appendFile(s.transcript, fixture.slice(30, 43).join(""));
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  await until("a session event is followed by a read, with no one watching", () => s.registry.claudeTranscript(s.thread.id)!.readAt > first.readAt!);
  assert.equal(s.streams.length, reads + 1);

  observePaused(s);
  const paused = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  assert.equal(s.streams.length, reads + 1, "a paused pylon is not read");
  assert.ok(paused.entries.length > first.entries.length);
  assert.deepEqual(paused.entries.slice(0, first.entries.length), first.entries, "a read only appends");
  assert.ok(paused.entries.some((e) => e.kind === "task" && e.status === "completed" && e.summary.includes("Count lines in hello.py")), "the subagent's finish");
  assert.ok(paused.entries.some((e) => e.kind === "turn"));
  assert.deepEqual(s.commands, [], "reading is never a command");
});

test("a Claude worker thread's page stream shows new entries during a turn, read when its session events say so rather than on a timer", async (t) => {
  // The reads follow intervals, which the test steps through, so a slow suite cannot outrun them or fit an extra one in.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  const frame = async (pattern: RegExp, what: string) => {
    for (;;) {
      const next = await stream.next();
      assert.ok(next.convo !== undefined || next.grow !== undefined || next.shows !== undefined, what);
      if (next.convo !== undefined && pattern.test(next.convo)) return next.convo as string;
    }
  };
  assert.match(await frame(/Do these steps one at a time/, "the read a watch starts with"), /Claude Code · claude-opus-5-5/);
  const idle = s.streams.length;
  t.mock.timers.tick(10_000);
  assert.equal(s.streams.length, idle, "an idle thread is not read on a timer");

  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind, session: claudeSession } });
  await appendFile(s.transcript, fixture.slice(22, 24).join(""));
  report("session.turn-started");
  t.mock.timers.tick(1_000);
  await frame(/<span class="t-name">Write<\/span>/, "the turn's start is followed by a read");
  await appendFile(s.transcript, fixture[24]!);
  t.mock.timers.tick(2_000);
  assert.match(await frame(/<span class="t-mark run"/, "a turn that runs is read again"), /python3 \/home\/user\/workspace\/repo\/hello.py/);
  await appendFile(s.transcript, fixture.slice(25, 28).join(""));
  report("session.turn-ended");
  t.mock.timers.tick(1_000);
  assert.doesNotMatch(await frame(/Exit code 1/, "the turn's end is followed by a read"), /t-mark run/);
  const ended = s.streams.length;
  t.mock.timers.tick(10_000);
  assert.equal(s.streams.length, ended, "the reads stop with the turn");
});

/** The page's conversation region: its opening tag's watermark and named view, and whether it holds a rendering. */
async function convoRegion(s: Awaited<ReturnType<typeof withClaude>>, query = "") {
  const html = (await s.raw(`/threads/${s.thread.id}${query}`)).body.toString();
  const tag = /<div class="convo" id="convo" data-rendered-reply-at="(\d*)"(?: data-shows="([^"]+)")? data-live[^>]*>/.exec(html)!;
  return { replyAt: tag[1], named: tag[2], inside: html.slice(tag.index + tag[0].length).split('<section class="file-view"')[0]!.replace(/<\/div><\/div>\s*$/, "") };
}

test("a poll of a Claude worker's streaming page names the view its stream shows rather than render it, and names a reply's view only once a frame showed the reply", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  let shows: string | undefined;
  const frame = async (pattern: RegExp) => {
    for (;;) {
      const next = await stream.next();
      shows = next.shows ?? shows;
      if (next.convo !== undefined && pattern.test(next.convo)) return;
    }
  };
  await frame(/Do these steps one at a time/);
  assert.deepEqual(await convoRegion(s, "?streaming=1"), { replyAt: "", named: shows, inside: "" }, "the poll names the view the stream's last frame shows and renders none");
  const unstreamed = await convoRegion(s);
  assert.equal(unstreamed.named, undefined);
  assert.match(unstreamed.inside, /Do these steps one at a time/, "a poll from a page that does not stream renders the conversation");

  await appendFile(s.transcript, fixture.slice(30, 43).join(""));
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  const replyAt = String(s.registry.thread(s.thread.id)!.lastReplyAt);
  t.mock.timers.tick(1_000);
  await until("the read after the turn's end stores the reply", () => s.registry.claudeEntries(s.thread.id).some((e) => e.kind === "reply" && e.text.startsWith("The subagent reported 1 line")));
  const read = await convoRegion(s, "?streaming=1");
  assert.equal(read.replyAt, replyAt);
  assert.notEqual(read.named, shows, "the page has not shown the reply yet, so the poll names another view than it shows");
  await frame(/The subagent reported 1 line/);
  assert.equal(shows, read.named, "the frame that shows the reply is of the view the poll named");
});

test("a Claude worker's page names no reply watermark until the transcript holds a read that started after the reply", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const projects = dirname(dirname(s.transcript));
  let held: Promise<void> = Promise.resolve();
  s.probePipes(async (argv) => {
    await held;
    return processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {});
  });
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  let shows: string | undefined;
  const frame = async (until: (next: any) => boolean) => {
    for (;;) {
      const next = await stream.next();
      shows = next.shows ?? shows;
      if (until(next)) return;
    }
  };
  await frame((next) => /Do these steps one at a time/.test(next.convo ?? ""));
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind, session: claudeSession } });
  report("session.turn-started");
  t.mock.timers.tick(1_000);
  const idle = shows;
  await frame(() => shows !== idle);
  // A refresh waits for the turn's read, so none runs when the next is held.
  await s.call("GET", `/v1/threads/${s.thread.id}/conversation`);

  const read = Promise.withResolvers<void>();
  held = read.promise;
  await appendFile(s.transcript, fixture.slice(30, 43).join(""));
  report("session.turn-ended");
  const working = shows;
  t.mock.timers.tick(1_000);
  await frame(() => shows !== working);
  const ended = await convoRegion(s, "?streaming=1");
  assert.equal(ended.named, shows, "the stream shows the turn's end, and the poll names that view");
  assert.equal(ended.replyAt, "", "but the read that brings the reply has not been stored, so no watermark");
  read.resolve();
  await frame((next) => /The subagent reported 1 line/.test(next.convo ?? ""));
  assert.deepEqual(await convoRegion(s, "?streaming=1"), { replyAt: String(s.registry.thread(s.thread.id)!.lastReplyAt), named: shows, inside: "" });
});

test("a Claude worker's page names no reply watermark while the reads after the reply have not reached the transcript's end", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 30).join(""));
  const projects = dirname(dirname(s.transcript));
  const second = Promise.withResolvers<void>();
  let reads = 0;
  let held = Infinity;
  s.probePipes(async (argv) => {
    if (++reads === held) await second.promise;
    return processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {});
  });
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  const frame = async (pattern: RegExp) => {
    for (let next = await stream.next(); !pattern.test(next.convo ?? ""); next = await stream.next());
  };
  await frame(/Do these steps one at a time/);
  await s.call("GET", `/v1/threads/${s.thread.id}/conversation`);

  const reply = JSON.parse(fixture[40]!);
  // Two records of more than half of what one read takes, so the reply lies past the first read.
  const long = (i: number) => `${JSON.stringify({ ...reply, uuid: `long-${i}`, message: { ...reply.message, id: `msg-long-${i}`, content: [{ type: "text", text: `Long ${i} ${"x".repeat(maxRecordBytes * 0.6)}` }] } })}\n`;
  await appendFile(s.transcript, long(0) + long(1) + fixture.slice(30, 43).join(""));
  held = reads + 2;
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  t.mock.timers.tick(1_000);
  await frame(/Long 0 x/);
  assert.equal((await convoRegion(s, "?streaming=1")).replyAt, "", "the first read stopped short of the reply, so no watermark");
  second.resolve();
  await frame(/The subagent reported 1 line/);
  assert.equal((await convoRegion(s, "?streaming=1")).replyAt, String(s.registry.thread(s.thread.id)!.lastReplyAt));
});

test("a Claude worker's page stream sends nothing while its conversation is unchanged, its pings included, though an age in it changed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-27T12:00:00Z") });
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const stream = s.events(`/threads/${s.thread.id}/stream`);
  t.after(() => stream.close());
  for (let next = await stream.next(); !/Do these steps one at a time/.test(next.convo ?? ""); next = await stream.next());
  for (let pings = 0; pings < 4; pings++) t.mock.timers.tick(15_000);
  assert.match((await convoRegion(s)).inside, /started <time [^>]*data-ago>1 min ago<\/time>/, "a minute on, a render says so");

  await appendFile(s.transcript, fixture.slice(22, 24).join(""));
  // No turn runs, so the event's read is the only change the stream can show.
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  t.mock.timers.tick(1_000);
  assert.match((await stream.next()).convo, /<span class="t-name">Write<\/span>/, "the first frame after the pings is the read's, not one for the age");
});

test("two page streams of one Claude worker render each new view once between them", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const streams = [s.events(`/threads/${s.thread.id}/stream`), s.events(`/threads/${s.thread.id}/stream`)];
  t.after(() => { for (const stream of streams) stream.close(); });
  const frame = async (stream: (typeof streams)[number], pattern: RegExp) => {
    for (;;) {
      const next = await stream.next();
      if (next.convo !== undefined && pattern.test(next.convo)) return next;
    }
  };
  for (const stream of streams) await frame(stream, /Do these steps one at a time/);
  // Each render reads who sent the prompts it shows, and nothing else here does.
  const senders = s.registry.claudeMessageSenders;
  let renders = 0;
  s.registry.claudeMessageSenders = (...args) => { renders++; return senders(...args); };
  t.after(() => { s.registry.claudeMessageSenders = senders; });
  await appendFile(s.transcript, fixture.slice(22, 24).join(""));
  s.registry.reportSession(node, { sequence: 1, pylon: s.thread.pylonId, time: Date.now(), event: { kind: "session.turn-ended", session: claudeSession } });
  const [a, b] = await Promise.all(streams.map((stream) => frame(stream, /<span class="t-name">Write<\/span>/)));
  assert.deepEqual(a, b);
  assert.equal(renders, 1, "the second stream's frame reuses the first's render");
});

test("a Claude worker's transcript streams to the CLI as its entries whole, then each read's new entries and the turn's start and end", async (t) => {
  const s = await withClaude(t);
  await writeFile(s.transcript, fixture.slice(0, 22).join(""));
  const whole = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  const stream = s.events(`/v1/threads/${s.thread.id}/claude/events`);
  t.after(() => stream.close());
  assert.deepEqual(await stream.next(), { reset: true, session: claudeSession, entries: whole.entries, dropped: 0, working: false });

  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: s.thread.pylonId, time: Date.now(), event: { kind, session: claudeSession } });
  report("session.turn-started");
  assert.deepEqual(await stream.next(), { reset: false, session: claudeSession, entries: [], dropped: 0, working: true }, "the turn's start");
  await appendFile(s.transcript, fixture.slice(22, 25).join(""));
  const appended: unknown[] = [];
  for (let frame = await stream.next(); ; frame = await stream.next()) {
    assert.deepEqual([frame.reset, frame.working], [false, true]);
    appended.push(...frame.entries);
    if (appended.length > 0) break;
  }
  report("session.turn-ended");
  for (let frame = await stream.next(); frame.working; frame = await stream.next()) appended.push(...frame.entries);
  const after = (await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation;
  assert.deepEqual([...whole.entries, ...appended], after.entries, "the frames add up to the transcript, each entry once");

  await writeFile(s.transcript, fixture.slice(0, 3).join(""));
  report("session.turn-ended");
  const replaced = await stream.next();
  assert.equal(replaced.reset, true, "a replaced transcript starts over");
  assert.deepEqual(replaced.entries, ((await s.call("GET", `/v1/threads/${s.thread.id}/conversation`)).body as ClaudeConversation).entries);

  const harness = await s.call("GET", `/v1/threads/${s.thread.id}/events`);
  assert.equal(harness.status, 409, "a Claude worker has no harness conversation to stream");
  const other = await s.call("GET", `/v1/threads/${(await s.call("POST", "/v1/threads", { project: "acme", title: "Agent" })).body.id}/claude/events`);
  assert.deepEqual(other.status, 409);
  assert.match(other.body.error, /has no Claude worker/);
});
