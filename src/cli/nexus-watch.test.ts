/**
 * nexus watch and nexus conversation, against the control plane's real API with a fake harness behind it. src/test-
 * support/cli-kit.ts says when a test runs the CLI in its own process and when as a child.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Thread } from "../control/thread-store.ts";
import { claudeWorkerAt } from "../test-support/registry-kit.ts";
import type { TailnetNodeId } from "../ids.ts";
import { transcriptStart, type ClaudeEntry } from "../control/claude-transcript.ts";
import { tempDir, until } from "../test-support/kit.ts";
import { cli, node, setup, at, claudeWatched } from "../test-support/cli-kit.ts";

/** The JSON lines a watch prints, one at a time. */
function watchLines(t: TestContext, s: Awaited<ReturnType<typeof setup>>, args: readonly string[], interval = 50) {
  return jsonLines(t, s, ["watch", ...args, "--json", "--interval", String(interval)]);
}

/** The JSON lines a run of the CLI prints, one at a time. */
function jsonLines(t: TestContext, s: Awaited<ReturnType<typeof setup>>, args: readonly string[]) {
  const child = spawn(process.execPath, [cli, ...args], { env: s.env() });
  t.after(() => { child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    async next(): Promise<any> {
      // The deadline only ends a hang: a loaded suite can take seconds over what takes milliseconds alone.
      const timeout = AbortSignal.timeout(60_000);
      const line = await Promise.race([lines.next(), once(timeout, "abort").then(() => assert.fail(`no line from ${args[0]}. stderr: ${stderr}`))]);
      assert.ok(!line.done, `${args[0]} ended early. stderr: ${stderr}`);
      return JSON.parse(line.value);
    },
    /** Every line left until the output ends. */
    async rest(): Promise<any[]> {
      const left = [];
      for (let line = await lines.next(); !line.done; line = await lines.next()) left.push(JSON.parse(line.value));
      return left;
    },
  };
}

/** An entry as pi-durable serves it, holding one user message. */
const userEntry = (id: number, text: string) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] }) as never;

/** The run in flight with this partial answer, as pi-durable's live document holds it. */
const streaming = (partial: string) => ({ run: { taskId: 1, inputs: [] }, tools: [], generation: { message: { role: "assistant", content: [{ type: "text", text: partial }] } } });
const claudeRecords = {
  prompt: { type: "user", timestamp: at(1), origin: { kind: "human" }, message: { role: "user", content: "Count the lines of hello.py" } },
  call: { type: "assistant", timestamp: at(2), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "wc -l hello.py" } }] } },
  failed: { type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "wc: hello.py: No such file", is_error: true }] } },
  reply: { type: "assistant", timestamp: at(4), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "There is no hello.py." }] } },
  pr: { type: "pr-link", sessionId: "s1", prNumber: 7, prUrl: "https://github.com/octocat/Spoon-Knife/pull/7", prRepository: "octocat/Spoon-Knife", timestamp: at(5) },
};
const jsonl = (...records: object[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

/** Runs `args` with its output in a file under a shell, kills the shell once the output has `ready`, and answers how long the orphan outlived it. */
async function orphanLife(t: TestContext, s: Awaited<ReturnType<typeof setup>>, args: readonly string[], ready: string): Promise<number> {
  const out = join(await tempDir("nexus-orphan-", t), "out");
  const sh = spawn("sh", ["-c", `"$0" "$@" > "${out}" 2>&1 & echo $!; wait`, process.execPath, cli, ...args], { env: s.env() });
  t.after(() => { sh.kill("SIGKILL"); });
  const [pidLine] = await once(sh.stdout, "data") as [Buffer];
  const pid = Number(pidLine.toString().trim());
  t.after(() => { try { process.kill(pid); } catch {} });
  await until(`${args[0]} printed ${ready}`, async () => (await readFile(out, "utf8").catch(() => "")).includes(ready));
  sh.kill("SIGKILL");
  await once(sh, "exit");
  const killed = Date.now();
  await until(`the orphaned ${args[0]} exited`, async () => {
    try {
      process.kill(pid, 0);
      // A container's PID 1 may leave an exited orphan as a zombie.
      return /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""));
    } catch { return true; }
  });
  return Date.now() - killed;
}

test("watch prints the backlog, then each new entry and state change, and ends when the thread is deleted", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id]);
  const exited = once(watch.child, "exit");

  const first = await watch.next();
  assert.deepEqual([first.type, first.entries.map((e: any) => [e.entry.id, e.entry.kind, e.text])], ["reset", [[1, "pi.user", "> hi"]]], "the first poll prints the context whole");
  const state = { type: "state", thread: thread.id, status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "unknown", failed: null, ports: [] };
  assert.deepEqual(await watch.next(), state);
  const quiet = { type: "live", thread: thread.id, queued: [], tools: [], partial: null, retry: null };
  assert.deepEqual(await watch.next(), quiet, "the run in flight follows the first state");

  s.fake.transcript(thread.id).messages.push({
    role: "assistant", content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
    stopReason: "toolUse", timestamp: Date.now(),
  } as never);
  s.fake.commit(thread.id);
  const answer = await watch.next();
  assert.deepEqual([answer.type, answer.entry.id, answer.text], ["entry", 2, 'On it.\n[tool] bash {"command":"npm test"}']);

  s.fake.transcript(thread.id).docs["pi.live"] = {
    run: { taskId: 1, inputs: [] },
    tools: [{ callId: "c1", status: "running", output: "PASS 3/9" }, { callId: "c0", status: "done", output: "old" }],
    generation: { message: { role: "assistant", content: [{ type: "text", text: "Tests are " }, { type: "text", text: "running." }] }, retry: { error: "overloaded" } },
  };
  s.fake.transcript(thread.id).docs["pi.inbox"] = { items: [{ id: 9, mode: "followUp", content: "and then?" }, { id: 10, mode: "write", content: "x" }] };
  s.fake.commit(thread.id);
  assert.deepEqual(await watch.next(), { ...state, run: "working", queued: 1 });
  assert.deepEqual(await watch.next(), {
    ...quiet, queued: ["and then?"], tools: [{ callId: "c1", output: "PASS 3/9" }], partial: "Tests are running.", retry: "overloaded",
  }, "live carries the queued texts, the running tools' output, the streaming answer and a pending retry");

  await s.json(["delete", thread.id]);
  assert.deepEqual(await watch.next(), { ...state, run: "idle", status: "deleted", queued: 0 }, "a deleted thread has no conversation to be busy");
  assert.deepEqual(await exited, [0, null]);
});

test("a watch whose consumer is killed outright exits, though an idle thread never writes to the dead pipe", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "idle"]);
  const out = join(await tempDir("nexus-orphan-", t), "watch.jsonl");
  // The shell starts the watch with its output in a file, so killing the shell leaves no pipe for the watch to find closed.
  const sh = spawn("sh", ["-c", `"$0" "$1" watch "$2" --json --interval 50 > "$3" 2>&1 & echo $!; wait`, process.execPath, cli, thread.id, out], { env: s.env() });
  t.after(() => { sh.kill("SIGKILL"); });
  const [pidLine] = await once(sh.stdout, "data") as [Buffer];
  const pid = Number(pidLine.toString().trim());
  t.after(() => { try { process.kill(pid); } catch {} });
  const alive = async () => {
    try {
      process.kill(pid, 0);
      // A container's PID 1 may leave an exited orphan as a zombie.
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      return !/\) Z /.test(stat);
    } catch { return false; }
  };
  // The deadlines only end a hang: a loaded suite can take seconds over what takes milliseconds alone.
  for (const deadline = Date.now() + 60_000; !(await readFile(out, "utf8").catch(() => "")).includes('"type":"state"');) {
    assert.ok(Date.now() < deadline, "the watch printed the thread's state");
    await new Promise((r) => setTimeout(r, 50));
  }
  sh.kill("SIGKILL");
  await once(sh, "exit");
  for (const deadline = Date.now() + 60_000; await alive();) {
    assert.ok(Date.now() < deadline, "the orphaned watch exited");
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("watch prints the whole context again when it changes other than by an append", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "one"]);
  await s.json(["send", thread.id, "two"]);
  const transcript = s.fake.transcript(thread.id);
  const watch = watchLines(t, s, [thread.id]);
  const ids = (event: any) => [event.type, event.entries?.map((e: any) => e.entry.id) ?? event.entry.id];
  assert.deepEqual(ids(await watch.next()), ["reset", [1, 2]]);
  assert.equal((await watch.next()).type, "state");
  assert.equal((await watch.next()).type, "live");

  // A new head marker leads the active context, ahead of entries older than itself.
  transcript.entries = [userEntry(12, "summary"), userEntry(10, "one")];
  s.fake.commit(thread.id);
  const reordered = await watch.next();
  assert.deepEqual(ids(reordered), ["reset", [12, 10]]);
  assert.deepEqual(reordered.entries.map((e: any) => e.text), ["> summary", "> one"]);
  transcript.entries = [...transcript.entries, userEntry(14, "three")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["entry", 14], "an append to the new context is one entry");

  // A compaction drops what it summarized.
  transcript.entries = [userEntry(15, "compacted"), userEntry(14, "three")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["reset", [15, 14]]);
  transcript.entries = [userEntry(15, "compacted")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["reset", [15]], "a context that lost its last entry is printed whole");
});

test("watch prints each commit of the run as it streams, between polls, and an answer's entry before the live event that drops it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  // One poll in the whole test, so everything after the first prints comes from the stream.
  const watch = watchLines(t, s, [thread.id], 600_000);
  assert.equal((await watch.next()).type, "reset");
  assert.equal((await watch.next()).type, "state");
  assert.equal((await watch.next()).partial, null);

  const transcript = s.fake.transcript(thread.id);
  transcript.docs["pi.live"] = streaming("The");
  s.fake.commit(thread.id);
  assert.deepEqual(await watch.next(), { type: "state", thread: thread.id, status: "active", run: "working", parkedTasks: 0, queued: 0, pylon: "unknown", failed: null, ports: [] });
  assert.equal((await watch.next()).partial, "The");
  for (const partial of ["The build", "The build passes", "The build passes."]) {
    transcript.docs["pi.live"] = streaming(partial);
    s.fake.commit(thread.id);
    assert.deepEqual(await watch.next(), { type: "live", thread: thread.id, queued: [], tools: [], partial, retry: null }, "each commit of the partial is one live event");
  }

  // pi-durable commits the answer and clears the live document together.
  transcript.messages.push({ role: "assistant", content: [{ type: "text", text: "The build passes." }], stopReason: "stop", timestamp: Date.now() } as never);
  transcript.docs["pi.live"] = {};
  s.fake.commit(thread.id);
  const answer = await watch.next();
  assert.deepEqual([answer.type, answer.text], ["entry", "The build passes."]);
  assert.equal((await watch.next()).run, "idle");
  assert.equal((await watch.next()).partial, null, "the partial goes once its entry is printed");
});

test("watch opens a dropped stream again, reports the outage once, and prints the state again when the control plane is back", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id]);
  assert.equal((await watch.next()).type, "reset");
  const state = await watch.next();
  assert.equal((await watch.next()).type, "live");
  assert.equal(s.fake.watching(thread.id), 1);

  const restart = await s.stop();
  const errors = [await watch.next()];
  // The poll and the stream both retry while it is down, every 50 ms.
  const tried = s.proxy.connects.length;
  await until("the watch retried a few times", () => s.proxy.connects.length >= tried + 6);
  await restart();
  let back = await watch.next();
  for (; back.type === "error"; back = await watch.next()) errors.push(back);
  assert.ok(errors.every((e) => e.type === "error" && e.kind === "unreachable"), JSON.stringify(errors));
  assert.equal(new Set(errors.map((e) => e.message)).size, errors.length, "each message is reported once, whichever source failed with it");
  assert.deepEqual(back, state, "the state again says the control plane is back");

  s.fake.transcript(thread.id).docs["pi.live"] = streaming("Back");
  s.fake.commit(thread.id);
  assert.equal((await watch.next()).run, "working");
  assert.equal((await watch.next()).partial, "Back", "the stream follows the control plane that came back");
  assert.equal(s.fake.watching(thread.id), 1, "the old stream's watch stopped when its connection dropped");
});

test("watch follows a Claude worker's transcript: the entries whole, then each new one as Claude writes it, and whether Claude works", async (t) => {
  const s = await setup(t);
  const c = await claudeWatched(t, s);
  await writeFile(c.transcript, jsonl(claudeRecords.prompt));
  // The conversation route reads the transcript, so the stream's first frame holds what that read found.
  assert.equal((await s.json(["conversation", c.thread.id])).entries.length, 1);
  const watch = watchLines(t, s, [c.thread.id]);
  const exited = once(watch.child, "exit");

  assert.deepEqual(await watch.next(), {
    type: "claude-reset", thread: c.thread.id, session: "s1", dropped: 0,
    entries: [{ entry: { kind: "prompt", at: Date.parse(at(1)), text: "Count the lines of hello.py", from: "person" }, text: "> Count the lines of hello.py" }],
  });
  const state = { type: "state", thread: c.thread.id, status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "running", failed: null, ports: [] };
  assert.deepEqual(await watch.next(), state);
  const quiet = { type: "live", thread: c.thread.id, queued: [], tools: [], partial: null, retry: null };
  assert.deepEqual(await watch.next(), quiet);

  c.report("session.turn-started");
  assert.deepEqual(await watch.next(), { ...state, run: "working" });
  await appendFile(c.transcript, jsonl(claudeRecords.call));
  c.report("session.turn-started");
  const call = await watch.next();
  assert.deepEqual([call.type, call.entry.kind, call.text], ["claude-entry", "tool", '[tool] Bash {"command":"wc -l hello.py"}']);
  assert.deepEqual(await watch.next(), { ...quiet, tools: [{ callId: "t1", output: "" }] }, "the turn's call runs until its result");

  await appendFile(c.transcript, jsonl(claudeRecords.failed, claudeRecords.reply, claudeRecords.pr, { ...claudeRecords.pr, timestamp: at(6) }));
  c.report("session.turn-ended");
  const texts: string[] = [];
  let idle = false;
  while (texts.length < 4 || !idle) {
    const line = await watch.next();
    if (line.type === "claude-entry") texts.push(line.text);
    idle ||= line.type === "state" && line.run === "idle";
  }
  assert.deepEqual(texts, ["[tool error] wc: hello.py: No such file", "There is no hello.py.", "[pull request] Opened pull request #7: https://github.com/octocat/Spoon-Knife/pull/7", ""],
    "a pull request Claude Code names again prints nothing the second time");

  const restart = await s.stop();
  await restart();
  await appendFile(c.transcript, jsonl({ ...claudeRecords.reply, timestamp: at(7), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } }));
  c.report("session.turn-ended");
  let line = await watch.next();
  for (; line.type !== "claude-entry"; line = await watch.next()) assert.notEqual(line.type, "claude-reset", "a reconnect prints no entry again");
  assert.equal(line.text, "Done.", "only the entry Claude wrote since");

  await s.json(["delete", c.thread.id]);
  for (let line = await watch.next(); ; line = await watch.next()) {
    if (line.type === "state" && line.status === "deleted") break;
  }
  assert.deepEqual(await exited, [0, null]);
});

test("watch prints one new entry past the kept 3,000 of a Claude transcript, across a reconnect too", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
  const prompt = (n: number): ClaudeEntry => ({ kind: "prompt", at: n, text: `prompt ${n}`, from: "person" });
  let offset = 0;
  const read = (entries: ClaudeEntry[]) => {
    const from = { ...transcriptStart, offset };
    offset += entries.length;
    assert.ok(s.registry.threads.appendClaudeRead(thread.id, { session: "s1", from, entries, cursor: { ...transcriptStart, offset }, reset: false, readAt: Date.now() }));
  };
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.threads.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1" } });
  read(Array.from({ length: 3000 }, (_, i) => prompt(i)));
  const watch = watchLines(t, s, [thread.id]);
  const first = await watch.next();
  assert.deepEqual([first.type, first.entries.length, first.dropped], ["claude-reset", 3000, 0]);
  const next = async (what: string) => {
    for (;;) {
      const line = await watch.next();
      assert.notEqual(line.type, "claude-reset", what);
      if (line.type === "claude-entry") return line.entry;
    }
  };

  read([prompt(3000)]);
  report("session.turn-started");
  assert.deepEqual(await next("an entry past the kept 3,000 is no reset"), prompt(3000));
  const restart = await s.stop();
  await restart();
  read([prompt(3001)]);
  report("session.turn-ended");
  assert.deepEqual(await next("a reconnect at the limit prints no entry again"), prompt(3001));
  const reread = await s.json(["conversation", thread.id]);
  assert.deepEqual([reread.entries.length, reread.dropped], [3000, 2]);
});

test("watch's text says a Claude transcript was replaced only when it printed some of it, not when the worker's first session starts", async (t) => {
  const s = await setup(t);
  const c = await claudeWatched(t, s, false);
  const child = spawn(process.execPath, [cli, "watch", c.thread.id, "--interval", "50"], { env: s.env() });
  t.after(() => { child.kill(); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, "-- active, pylon running");
  await writeFile(c.transcript, jsonl(claudeRecords.prompt));
  claudeWorkerAt(s.registry, c.thread.id, "started", { session: "s1" });
  c.report("session.turn-started");
  const printed: string[] = [];
  while (!printed.includes("> Count the lines of hello.py")) printed.push((await lines.next()).value as string);
  assert.ok(!printed.some((line) => line.includes("replaced")), printed.join("\n"));
});

test("watch ends with the API's exit code when it refuses the stream", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "x"]);
  s.callAs("nSTRANGER" as TailnetNodeId);
  const res = await s.nexus(["watch", thread.id, "--json", "--interval", "50"]);
  assert.equal(res.code, 3, res.stderr);
  assert.equal(JSON.parse(res.stderr).kind, "refused");
});

test("a bare thread has no conversation to print, send to or watch", async (t) => {
  const s = await setup(t);
  const bare = await s.startThread({ request: { project: "acme", title: "Check" }, caller: "nLAPTOP", role: "check" });
  const refused = { code: 5, stdout: "", stderr: `nexus: thread ${bare.id} has no conversation\n` };
  const run = async (args: string[]) => {
    const { code, stdout, stderr } = await s.nexus(args);
    return { code, stdout, stderr };
  };
  assert.deepEqual(await run(["conversation", bare.id]), refused);
  assert.deepEqual(await run(["send", bare.id, "hi"]), refused);
  assert.deepEqual(await run(["abort", bare.id]), refused);
  const watch = watchLines(t, s, [bare.id]);
  const printed = [await watch.next()];
  const exited = once(watch.child, "exit");
  await s.json(["delete", bare.id]);
  for (let line = await watch.next(); ; line = await watch.next()) {
    printed.push(line);
    if (line.type === "state" && line.status === "deleted") break;
  }
  assert.deepEqual((await exited)[0], 0);
  assert.deepEqual(printed.map((l) => `${l.type} ${l.status ?? ""}`), ["reset ", "state active", "live ", "state deleted"], "a bare thread's watch prints its state and an empty conversation, and ends once it is deleted");
});

test("a watch or events --follow whose parent is killed exits within about a second, however long the watch's interval", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "idle"]);
  // The bounds are well under the minute's interval, and loose for a loaded suite.
  assert.ok(await orphanLife(t, s, ["watch", thread.id, "--json", "--interval", "60000"], '"type":"state"') < 10_000, "the watch did not wait out its interval");
  s.registry.threads.appendEvent("release.changed", null, { state: "pending" });
  assert.ok(await orphanLife(t, s, ["events", "--follow"], "release.changed") < 10_000, "events --follow exited");
});

test("a watch whose reader closed the pipe exits 0 when the thread's deletion ends it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "closing"]);
  const watch = watchLines(t, s, [thread.id]);
  const exited = once(watch.child, "exit");
  assert.equal((await watch.next()).type, "reset");
  watch.child.stdout.destroy();
  await s.json(["delete", thread.id]);
  assert.deepEqual(await exited, [0, null]);
});

/** The agent's answer, as pi-durable commits it once its run ends. */
const answered = (s: Awaited<ReturnType<typeof setup>>, id: string, text: string) => {
  s.fake.transcript(id).messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 } as never);
  delete s.fake.transcript(id).docs["pi.live"];
  s.fake.commit(id);
};

test("send --watch --json prints the send's reply as one line, then the watch stream, and exits 0 once the run that took the message replied", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const sending = jsonLines(t, s, ["send", thread.id, "Count the lines", "--watch", "--json", "--interval", "50"]);
  const exited = once(sending.child, "exit");
  const next = () => sending.next();

  assert.equal((await next()).type, undefined, "the send's reply comes first, as one line");
  const reset = await next();
  assert.deepEqual([reset.type, reset.entries.map((e: any) => e.text)], ["reset", ["> hi", "> Count the lines"]], "the stream is the watch's, backlog and all");
  assert.equal((await next()).run, "idle");
  await next();

  s.fake.transcript(thread.id).docs["pi.live"] = streaming("Counting");
  s.fake.commit(thread.id);
  for (let line = await next(); line.type !== "state" || line.run !== "working"; line = await next());
  answered(s, thread.id, "hello.py has 3 lines.");
  for (let line = await next(); line.type !== "entry"; line = await next());
  s.registry.threads.recordReply(thread.id, Date.UTC(2026, 10, 9));
  assert.deepEqual(await exited, [0, null]);
});

test("send --watch prints the run from the sent message on, though the reply came before the watch opened", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const release = s.fake.holdWatches();
  const sent = s.nexus(["send", thread.id, "Count the lines", "--watch", "--interval", "50"]);
  await until("the message reached the agent", async () => s.fake.transcript(thread.id).messages.length === 2);
  answered(s, thread.id, "hello.py has 3 lines.");
  s.registry.threads.recordReply(thread.id, Date.UTC(2026, 10, 9));
  release();
  const res = await sent;
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `Sent to ${thread.id}.\n> Count the lines\nhello.py has 3 lines.\n-- active, pylon unknown\n-- It replied.\n`);
});

test("watch --until-idle exits 10 when the run parks, 12 when the thread asks the person, and 11 when the worker fails", async (t) => {
  const s = await setup(t);
  const firstState = async (watch: ReturnType<typeof watchLines>) => {
    for (let line = await watch.next(); line.type !== "state"; line = await watch.next());
  };

  const parks: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const parking = watchLines(t, s, [parks.id, "--until-idle"]);
  const parked = once(parking.child, "exit");
  await firstState(parking);
  s.fake.park(parks.id, 2);
  assert.deepEqual(await parked, [10, null]);

  const asks: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-before", thread: asks.id, text: "Asked before the watch", options: ["Yes"], reserved: null, answerer: "person", askedAt: 1, failure: 0 });
  const asking = watchLines(t, s, [asks.id, "--until-idle"]);
  const asked = once(asking.child, "exit");
  await firstState(asking);
  s.registry.questions.askQuestion({ kind: "judgment", id: "qn-new", thread: asks.id, text: "Start the next brief?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: 2, failure: 0 });
  assert.deepEqual(await asked, [12, null], "a question asked since the watch began ends it at once, while an older one ends it only at the run's end");

  const c = await claudeWatched(t, s, false);
  const failing = watchLines(t, s, [c.thread.id, "--until-idle"]);
  const failed = once(failing.child, "exit");
  await firstState(failing);
  claudeWorkerAt(s.registry, c.thread.id, "failed", { message: "claude exited" });
  assert.deepEqual(await failed, [11, null]);
});

test("conversation --last prints only the newest reply, and --last N the newest N entries", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  answered(s, thread.id, "First answer.");
  s.fake.transcript(thread.id).messages.push(
    { role: "user", content: "And the tests?", timestamp: 0 } as never,
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse", timestamp: 0 } as never,
  );
  s.fake.commit(thread.id);
  answered(s, thread.id, "They pass.");

  const reply = await s.nexus(["conversation", thread.id, "--last"]);
  assert.deepEqual([reply.code, reply.stdout], [0, "They pass.\n"]);
  const three = await s.nexus(["conversation", thread.id, "--last", "3"]);
  assert.deepEqual([three.code, three.stdout], [0, '> And the tests?\n\n[tool] bash {"command":"npm test"}\n\nThey pass.\n']);
  assert.deepEqual((await s.json(["conversation", thread.id, "--last"])).entries.map((e: any) => e.id), [5], "--json keeps the view's shape, with only the entries picked");
  assert.equal((await s.nexus(["conversation", thread.id, "3"])).code, 64, "a count needs --last");
});

test("start --watch follows the first message's run until it replies, and needs a first message to wait for", async (t) => {
  const s = await setup(t);
  assert.equal((await s.nexus(["start", "--project", "acme", "--title", "quiet", "--watch"])).code, 64);
  assert.equal((await s.nexus(["start", "--project", "acme", "--message", "hi", "--interval", "50"])).code, 64);
  assert.deepEqual(await s.json(["threads"]), [], "a bad flag starts nothing");
  const release = s.fake.holdWatches();
  const started = s.nexus(["start", "--project", "acme", "--message", "Count the lines", "--watch", "--interval", "50"]);
  let id = "";
  await until("the thread started", async () => {
    id = (await s.json(["threads"]))[0]?.id ?? "";
    return id !== "" && s.fake.transcript(id).messages.length === 1;
  });
  answered(s, id, "hello.py has 3 lines.");
  s.registry.threads.recordReply(id as never, Date.UTC(2026, 10, 9));
  release();
  const res = await started;
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^Started th-[0-9a-f]+ on acme: Count the lines\nSent the first message\.\n> Count the lines\nhello\.py has 3 lines\.\n-- active, pylon unknown\n-- It replied\.\n$/);
});

const apiErrors = (await readFile(new URL("../fixtures/claude-api-errors.jsonl", import.meta.url), "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
/** The first fixture record stops a turn on its usage limit, and the fourth on an overloaded model, at `at(3)` here. */
const usageStop = { ...apiErrors[0], timestamp: at(3) };
const modelError = { ...apiErrors[3], timestamp: at(3) };

/**
 * A Claude worker's turn from `at(2)` to `at(4)`, which writes `records`, watched with --until-idle from before it
 * starts. The pylon's reads are held from the turn's records until the stream says the turn ended. `before` runs
 * before the watch starts, and `then` once the reads go on. Answers the text of each entry printed and the exit code.
 */
async function claudeTurn(t: TestContext, s: Awaited<ReturnType<typeof setup>>, records: object[], before = (_: string) => {}, then = async (_: Awaited<ReturnType<typeof claudeWatched>>) => {}) {
  const c = await claudeWatched(t, s);
  await writeFile(c.transcript, jsonl(claudeRecords.prompt));
  assert.equal((await s.json(["conversation", c.thread.id])).entries.length, 1);
  before(c.thread.id);
  const watch = watchLines(t, s, [c.thread.id, "--until-idle"]);
  const exited = once(watch.child, "exit");
  for (let line = await watch.next(); line.type !== "live"; line = await watch.next());
  c.report("session.turn-started", Date.parse(at(2)));
  for (let line = await watch.next(); line.type !== "state" || line.run !== "working"; line = await watch.next());

  const release = c.holdReads();
  await appendFile(c.transcript, jsonl(...records));
  c.report("session.turn-ended", Date.parse(at(4)));
  const lines = [];
  for (let line = await watch.next(); line.type !== "state" || line.run !== "idle"; line = await watch.next()) lines.push(line);
  release();
  await then(c);
  lines.push(...await watch.rest());
  return { texts: lines.flatMap((l) => l.type === "claude-entry" && l.text !== "" ? [l.text] : []), code: (await exited)[0] };
}

test("watch --until-idle prints the reply a Claude turn wrote before it exits, though the stream says the turn ended before the transcript is read", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await claudeTurn(t, s, [claudeRecords.reply]), { texts: ["There is no hello.py."], code: 0 });
});

test("watch --until-idle prints a Claude reply before it exits 12 on a decision the person owes from before the wait", async (t) => {
  const s = await setup(t);
  const asked = (thread: string) => s.registry.questions.askQuestion({ kind: "judgment", id: "qn-old", thread: thread as never, text: "Start the next brief?", options: ["Yes"], reserved: null, answerer: "person", askedAt: 1, failure: 0 });
  assert.deepEqual(await claudeTurn(t, s, [claudeRecords.reply], asked), { texts: ["There is no hello.py."], code: 12 });
});

test("watch --until-idle exits 12 when a Claude turn stops on its usage limit, since the person resumes it after the reset", async (t) => {
  const s = await setup(t);
  assert.equal((await claudeTurn(t, s, [usageStop])).code, 12);
});

test("watch --until-idle exits 11 when a Claude turn dies on a model error that Nexus does not resume", async (t) => {
  const s = await setup(t);
  assert.equal((await claudeTurn(t, s, [modelError])).code, 11);
});

test("watch --until-idle exits 12 when a Claude turn died and Nexus gave its resume to the person", async (t) => {
  const s = await setup(t);
  const handed = (thread: string) => s.registry.threads.saveClaudeResume(thread as never, { state: "person", turn: Date.parse(at(3)), count: 3, why: "it died three times in a row" });
  assert.equal((await claudeTurn(t, s, [modelError], handed)).code, 12);
});

test("watch --until-idle waits through a Claude turn that died while Nexus resumes it, and exits 0 on the resumed turn's reply", async (t) => {
  const s = await setup(t);
  const resuming = (thread: string) => s.registry.threads.saveClaudeResume(thread as never, { state: "waiting", turn: Date.parse(at(3)), count: 1, due: 0 });
  const resumed = async (c: Awaited<ReturnType<typeof claudeWatched>>) => {
    c.report("session.turn-started", Date.parse(at(5)));
    await appendFile(c.transcript, jsonl({ ...claudeRecords.reply, timestamp: at(6), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } }));
    c.report("session.turn-ended", Date.parse(at(7)));
  };
  const { texts, code } = await claudeTurn(t, s, [modelError], resuming, resumed);
  assert.equal(code, 0);
  assert.equal(texts.at(-1), "Done.");
});

test("watch --until-idle prints a pi reply whose commits its stream missed before it exits", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id, "--until-idle"]);
  const exited = once(watch.child, "exit");
  for (let line = await watch.next(); line.type !== "live"; line = await watch.next());
  s.fake.holdCommits();
  s.fake.transcript(thread.id).docs["pi.live"] = streaming("Counting");
  s.fake.commit(thread.id);
  answered(s, thread.id, "hello.py has 3 lines.");
  s.registry.threads.recordReply(thread.id, Date.UTC(2026, 10, 9));
  const entries = (await watch.rest()).filter((l) => l.type === "entry").map((l) => l.text);
  assert.deepEqual(entries, ["hello.py has 3 lines."]);
  assert.deepEqual(await exited, [0, null]);
});

test("watch --until-idle ends on what the thread's detail says, though the conversation's stream never opens", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  s.fake.holdWatches();
  const watch = s.nexus(["watch", thread.id, "--until-idle", "--interval", "50"]);
  await until("the watch asked for the stream", async () => s.fake.calls.some(([call, id]) => call === "watch" && id === thread.id));
  s.fake.park(thread.id, 1);
  const res = await watch;
  assert.deepEqual([res.code, res.stdout], [10, `-- 1 parked tasks hold the run, which \`nexus retry ${thread.id}\` retries\n`]);
});
