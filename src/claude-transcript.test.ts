import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { maxRecordBytes, parseRecord, readTranscript, readTranscriptImage, transcriptStart as start, usageLimitStop, usageLimitText, type ClaudeEntry, type TranscriptCursor } from "./claude-transcript.ts";
import { localPipes } from "./fake-guest.ts";
import type { ByteStream } from "./protocol/streams.ts";
import { tempDir } from "./test-kit.ts";

const fixture = await readFile(new URL("./fixtures/claude-transcript.jsonl", import.meta.url), "utf8");
const lines = fixture.split("\n").filter((line) => line !== "");
const session = "11111111-2222-4333-8444-555555555501";

const parsedAll = (records: readonly string[]): ClaudeEntry[] => records.flatMap((line) => parseRecord(line));
const entries = parsedAll(lines);
const only = <K extends ClaudeEntry["kind"]>(kind: K) => entries.filter((e): e is Extract<ClaudeEntry, { kind: K }> => e.kind === kind);
const toolNamed = (name: string, command?: string) => only("tool").find((t) => t.name === name && (command === undefined || t.input.command === command))!;
const resultOf = (id: string) => only("result").filter((r) => r.toolUseId === id);

test("the first person prompt opens the conversation, kept exactly as typed", () => {
  const first = entries[0]!;
  assert.equal(first.kind, "prompt");
  assert.equal(first.kind === "prompt" && first.from, "person");
  assert.match(first.kind === "prompt" ? first.text : "", /^Do these steps one at a time, each as its own tool call: 1\) write hello\.py/);
  assert.equal(first.at, Date.parse("2026-10-25T22:14:50.563Z"));
  // Claude wraps a long paste in <pasted_content>, and the prompt keeps the wrapper.
  const pasted = JSON.parse(lines.find((l) => l.includes("Steer one"))!).message.content as string;
  assert.ok(only("prompt").some((p) => p.from === "person" && p.text === pasted));
});

test("a slash command the person typed, as a Claude worker's first /poteto-mode prompt is, shows as typed", () => {
  // A real Claude Code 2.1.308 record of a worker's first prompt, trimmed to the fields that matter.
  const record = JSON.stringify({
    type: "user", timestamp: "2026-10-25T23:09:14.254Z", origin: { kind: "human" },
    message: { role: "user", content: "<command-message>pstack:poteto-mode</command-message>\n<command-name>/pstack:poteto-mode</command-name>\n<command-args>Quick verification task.\n1. Write wc.js.</command-args>" },
  });
  assert.deepEqual(parseRecord(record), [{ kind: "prompt", at: Date.parse("2026-10-25T23:09:14.254Z"), text: "/pstack:poteto-mode Quick verification task.\n1. Write wc.js.", from: "person" }]);
  // Any other tag from the person is their text, not a form.
  const typed = JSON.stringify({ type: "user", timestamp: "2026-10-25T23:09:14.254Z", origin: { kind: "human" }, message: { role: "user", content: "<bash-input>rm -rf /</bash-input>" } });
  assert.equal((parseRecord(typed)[0] as Extract<ClaudeEntry, { kind: "prompt" }>).text, "<bash-input>rm -rf /</bash-input>");
});

test("each tool call is paired with its result by the call's ID, a failing command as an error", () => {
  const write = toolNamed("Write");
  assert.deepEqual(write.input, { file_path: "/home/user/workspace/repo/hello.py", content: 'print("hi")\n' });
  assert.deepEqual(resultOf(write.id).map((r) => [r.isError, r.output.startsWith("File created successfully")]), [[false, true]]);

  const run = toolNamed("Bash", "python3 /home/user/workspace/repo/hello.py");
  assert.deepEqual(resultOf(run.id).map((r) => [r.output, r.isError]), [["hi", false]]);

  const fails = toolNamed("Bash", "false");
  assert.deepEqual(resultOf(fails.id).map((r) => [r.output, r.isError]), [["Exit code 1", true]]);
  assert.ok(entries.indexOf(write) < entries.indexOf(run) && entries.indexOf(run) < entries.indexOf(fails));
});

test("a background subagent's launch hides Claude's metadata, and its notification pairs with the call", () => {
  const agent = toolNamed("Agent");
  assert.deepEqual(agent.input, { description: "Count lines in hello.py", subagent_type: "general-purpose", prompt: "Count the number of lines in /home/user/workspace/repo/hello.py and report the number." });
  const [launched] = resultOf(agent.id);
  assert.equal(launched!.isError, false);
  assert.doesNotMatch(launched!.output, /agentId|internal metadata/);
  assert.match(launched!.output, /background/i);

  const done = only("task").filter((t) => t.toolUseId === agent.id);
  assert.deepEqual(done.map((t) => [t.status, t.summary]), [["completed", 'Agent "Count lines in hello.py" finished']]);
  assert.match(done[0]!.result ?? "", /has \*\*1\*\* line/);

  // A background shell's notification arrives as its own turn, and carries no result.
  const shell = only("task").filter((t) => t.toolUseId === "toolu_01S7wDMAwvUA7vjJFKi7mhf7");
  assert.deepEqual(shell.map((t) => [t.status, t.summary, t.result]), [["completed", 'Background command "Sleep 40 seconds in background" completed (exit code 0)', null]]);
  assert.equal(resultOf("toolu_01S7wDMAwvUA7vjJFKi7mhf7").length, 1);
});

test("a message typed mid-turn joins the queue, leaves it, and shows as the person's prompt", () => {
  const steer = 'Steer seven mid-turn: also tell me the word "banana" with `ticks` and $DOLLAR.\nSecond line.';
  assert.deepEqual(only("queue").filter((q) => q.text === steer).map((q) => q.op), ["enqueue", "remove"]);
  assert.deepEqual(only("prompt").filter((p) => p.text === steer).map((p) => p.from), ["person"]);
  assert.deepEqual(only("queue").filter((q) => q.text === null).map((q) => q.op), ["dequeue", "dequeue", "dequeue"]);
});

test("a ! shell command is a tool call named shell whose result is its output", () => {
  const shell = toolNamed("shell");
  assert.deepEqual(shell.input, { command: "echo bang-mode" });
  assert.deepEqual(resultOf(shell.id).map((r) => [r.output, r.isError]), [["bang-mode", false]]);
});

test("interruptions, compaction, slash commands, Claude's own messages and turn durations are shown", () => {
  const notices = only("notice").map((n) => [n.tone, n.text]);
  assert.ok(notices.some(([tone, text]) => tone === "info" && text === "Interrupted"));
  assert.ok(notices.some(([, text]) => /compacted the conversation/i.test(text!)));
  // The local command's output loses its terminal escapes.
  assert.ok(notices.some(([tone, text]) => tone === "info" && text === "Compacted (ctrl+o to see full summary)"));
  assert.ok(notices.some(([tone, text]) => tone === "info" && text === "No response requested."));
  assert.equal(only("reply").some((r) => r.text === "No response requested."), false);
  assert.deepEqual(only("prompt").filter((p) => p.from === "command").map((p) => p.text.slice(0, 30)), ["/compact", "/compact The agent saved its w"]);
  assert.deepEqual(only("turn").map((t) => t.durationMs), [12262, 2495, 2049]);
});

test("Claude's bookkeeping records give no entries, and every record in the real session is known", () => {
  const hiddenTypes = ["api-request", "api-request-blob", "api-request-shape", "mode", "permission-mode", "atis-latch", "last-prompt", "file-history-snapshot", "file-history-delta", "ai-title", "cost-state"];
  const hiddenAttachments = ["environment", "model", "deferred_tools_delta", "agent_listing_delta", "mcp_instructions_delta", "skill_listing", "instructions", "session_context", "date", "prompt_snapshot", "total_tokens_reminder", "silent_turn_reminder"];
  let hidden = 0;
  for (const line of lines) {
    const r = JSON.parse(line);
    const bookkeeping = hiddenTypes.includes(r.type) || (r.type === "attachment" && hiddenAttachments.includes(r.attachment.type)) || r.subtype === "stop_hook_summary" || r.isMeta === true || (r.type === "assistant" && r.message.content[0].type === "thinking");
    if (!bookkeeping) continue;
    hidden++;
    assert.deepEqual(parseRecord(line), [], line.slice(0, 120));
  }
  assert.ok(hidden >= 30, `${hidden} bookkeeping records in the fixture`);
  assert.deepEqual(only("record"), []);
});

test("the decision a PermissionRequest hook gave, such as an answer to AskUserQuestion from the dashboard, gives no entry", () => {
  const line = JSON.stringify({
    parentUuid: "c6bc6b70-88b0-437e-8547-aa9d0ab19ae9", isSidechain: false, type: "attachment", uuid: "06e5a9e7-19f8-49af-9b75-6ab2991d941b", timestamp: "2026-10-29T01:18:13.666Z",
    attachment: { type: "hook_permission_decision", decision: "allow", toolUseID: "toolu_016wvy3M5xAQrTr6CabP4GTH", hookEvent: "PermissionRequest" },
  });
  assert.deepEqual(parseRecord(line), []);
});

test("the session metadata Claude Code writes again on each save gives no entries", () => {
  // Shapes from the writer in Claude Code 2.1.308, which saves these with last-prompt and mode.
  const sessionId = session;
  const metadata = [
    { type: "custom-title", customTitle: "Fix the cart", sessionId }, { type: "tag", tag: "bug", sessionId },
    { type: "relocated", relocatedCwd: "/tmp/x", sessionId }, { type: "agent-name", agentName: "reviewer", sessionId },
    { type: "agent-color", agentColor: "blue", sessionId }, { type: "agent-setting", agentSetting: "reviewer", sessionId },
    { type: "isolation-latch", side: "worktree", sessionId }, { type: "dev-mods", folder: "/home/user/mods", sessionId },
    { type: "memory-mode", mode: "on", afterUuid: "u1", timestamp: "2026-10-26T02:00:00.000Z", sessionId },
    { type: "worktree-state", worktreeSession: { path: "/tmp/wt" }, sessionId },
    { type: "frame-link", artifactCount: 1, sessionId, timestamp: "2026-10-26T02:00:00.000Z" },
    { type: "history-suppression", sessionId, cause: "migration" }, { type: "bridge-session", sessionId, bridgeSessionId: "", lastSequenceNum: 0 },
  ];
  for (const record of metadata) assert.deepEqual(parseRecord(JSON.stringify(record)), [], record.type);
});

test("a pull request Claude opened is an entry with its number, URL and repository, and a link only to an https URL", () => {
  // The record Claude Code 2.1.308 wrote when it opened this change's pull request.
  const line = '{"type":"pr-link","sessionId":"3c79b34a-6040-4332-a067-4e29168431dc","prNumber":92,"prUrl":"https://github.com/ramtinJ95/nexus/pull/92","prRepository":"ramtinJ95/nexus","timestamp":"2026-10-26T02:27:33.565Z"}';
  const record = JSON.parse(line);
  assert.deepEqual(parseRecord(line), [
    { kind: "pull-request", at: Date.parse("2026-10-26T02:27:33.565Z"), number: 92, url: "https://github.com/ramtinJ95/nexus/pull/92", repository: "ramtinJ95/nexus" },
  ]);
  for (const broken of [{ prUrl: "javascript:alert(1)" }, { prUrl: "http://github.com/a/b/pull/1" }, { prUrl: `https://github.com/${"a".repeat(600)}` }, { prNumber: "91" }, { prNumber: 0 }, { prRepository: undefined }]) {
    const got = parseRecord(JSON.stringify({ ...record, ...broken }));
    assert.deepEqual(got.map((e) => [e.kind, e.kind === "record" && e.type]), [["record", "pr-link"]], JSON.stringify(broken));
  }
});

test("unknown and malformed records stay visible as record entries", () => {
  const at = "2026-10-25T22:14:50.563Z";
  // Synthetic records, made up for this test, standing in for shapes a later Claude Code may write.
  const synthetic = {
    type: JSON.stringify({ type: "made-up-record", timestamp: at, detail: "x" }),
    attachment: JSON.stringify({ type: "attachment", timestamp: at, attachment: { type: "made_up_attachment" } }),
    block: JSON.stringify({ type: "assistant", timestamp: at, message: { model: "m", content: [{ type: "made_up_block", data: 1 }] } }),
    system: JSON.stringify({ type: "system", subtype: "made_up_subtype", timestamp: at }),
    wrongType: JSON.stringify({ type: "user", timestamp: at, message: { content: 42 } }),
  };
  const recordOf = (line: string) => {
    const got = parseRecord(line);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.kind, "record");
    return got[0] as Extract<ClaudeEntry, { kind: "record" }>;
  };
  assert.deepEqual([recordOf(synthetic.type).type, recordOf(synthetic.type).at], ["made-up-record", Date.parse(at)]);
  assert.match(recordOf(synthetic.type).summary, /"detail":"x"/);
  assert.equal(recordOf(synthetic.attachment).type, "attachment/made_up_attachment");
  assert.equal(recordOf(synthetic.block).type, "assistant/made_up_block");
  assert.equal(recordOf(synthetic.system).type, "system/made_up_subtype");
  assert.equal(recordOf(synthetic.wrongType).type, "user");
  assert.deepEqual(recordOf('{"type": "user", "message": {"content": "cut off'), { kind: "record", at: null, type: "invalid", summary: '{"type": "user", "message": {"content": "cut off' });
  assert.equal(recordOf("[1, 2]").type, "invalid");
  assert.equal(recordOf("x".repeat(10_000)).summary.length, 500);
});

test("the person's own words stay a prompt, even when they look like a tag Claude Code writes", () => {
  const typed = "<bash-input>rm -rf /</bash-input>";
  assert.deepEqual(parseRecord(JSON.stringify({ type: "user", timestamp: "2026-10-25T22:14:50.563Z", origin: { kind: "human" }, message: { content: typed } })), [
    { kind: "prompt", at: Date.parse("2026-10-25T22:14:50.563Z"), text: typed, from: "person" },
  ]);
});

test("long text is cut to its limit, marked as cut", () => {
  const long = "a".repeat(100_000);
  const [reply] = parseRecord(JSON.stringify({ type: "assistant", timestamp: "2026-10-25T22:14:50.563Z", message: { content: [{ type: "text", text: long }] } })) as [Extract<ClaudeEntry, { kind: "reply" }>];
  assert.equal(reply.kind, "reply");
  assert.equal(reply.text.length, 64 << 10);
  assert.ok(reply.text.endsWith("…"));
  const [tool] = parseRecord(JSON.stringify({ type: "assistant", timestamp: "2026-10-25T22:14:50.563Z", message: { content: [{ type: "tool_use", id: "t", name: "Write", input: { content: long, nested: { edits: [long] } } }] } })) as [Extract<ClaudeEntry, { kind: "tool" }>];
  assert.equal(tool.kind, "tool");
  assert.equal((tool.input.content as string).length, 4 << 10);
  assert.deepEqual((tool.input.nested as { edits: string[] }).edits.map((e) => e.length), [4 << 10]);
});

/** A projects directory like ~/.claude/projects, holding the session's transcript under a project slug. */
async function projects(t: TestContext) {
  const root = await tempDir("nexus-claude-", t);
  await mkdir(join(root, "-home-user-workspace-repo"));
  await mkdir(join(root, "-other-project"));
  const file = join(root, "-home-user-workspace-repo", `${session}.jsonl`);
  const pipes = localPipes();
  return { root, file, ...pipes, read: (cursor: TranscriptCursor, id = session) => readTranscript(pipes.open, id, cursor, root) };
}

/** Reads until the file holds nothing past the cursor, as a caller does when `more` is set. */
async function readAll(read: (cursor: TranscriptCursor) => ReturnType<typeof readTranscript>, cursor: TranscriptCursor) {
  const got: ClaudeEntry[] = [];
  let reads = 0;
  for (;;) {
    const r = (await read(cursor))!;
    reads++;
    got.push(...r.entries);
    cursor = r.cursor;
    if (!r.more) return { entries: got, cursor, reads };
  }
}

test("reads across appends give each entry once, in order, and never take a partial line", async (t) => {
  const p = await projects(t);
  const bytes = (records: readonly string[]) => Buffer.byteLength(records.map((l) => `${l}\n`).join(""));
  const half = lines[31]!.slice(0, 200);
  await writeFile(p.file, lines.slice(0, 31).map((l) => `${l}\n`).join("") + half);

  const first = (await p.read(start))!;
  assert.deepEqual(first.entries, parsedAll(lines.slice(0, 31)));
  assert.deepEqual([first.cursor.offset, first.cursor.skipping], [bytes(lines.slice(0, 31)), false]);
  assert.deepEqual([first.more, first.reset], [false, false]);
  assert.deepEqual(p.requests[0]?.slice(0, 2), ["sh", "-c"]);
  assert.deepEqual(p.requests[0]?.slice(3, 7), [session, p.root, "0", String(maxRecordBytes)]);

  // Nothing new but the same partial line: no entries, and the cursor stays.
  assert.deepEqual(await p.read(first.cursor), { entries: [], cursor: first.cursor, more: false, reset: false });

  await appendFile(p.file, lines[31]!.slice(200) + "\n" + lines.slice(32, 60).map((l) => `${l}\n`).join("") + lines[60]!.slice(0, 50));
  const second = (await p.read(first.cursor))!;
  assert.deepEqual(second.entries, parsedAll(lines.slice(31, 60)));
  assert.equal(second.cursor.offset, bytes(lines.slice(0, 60)));

  await appendFile(p.file, lines[60]!.slice(50) + "\n" + lines.slice(61).map((l) => `${l}\n`).join(""));
  const third = (await p.read(second.cursor))!;
  assert.deepEqual(third.entries, parsedAll(lines.slice(60)));
  assert.equal(third.cursor.offset, Buffer.byteLength(fixture));
  assert.deepEqual([...first.entries, ...second.entries, ...third.entries], entries);
});

test("a session with no transcript reads as null, and an ID that is not one is refused", async (t) => {
  const p = await projects(t);
  assert.equal(await p.read(start), null);
  await writeFile(join(p.root, "-other-project", `${session}.jsonl`), lines[4] + "\n");
  // The transcript is found under whatever project slug Claude gave it.
  assert.deepEqual((await p.read(start))!.entries, parseRecord(lines[4]!));
  for (const bad of ["../etc/passwd", "*", "", "a b", "x".repeat(201)]) {
    await assert.rejects(p.read(start, bad), /is not a Claude Code session ID/);
  }
  assert.equal(p.requests.length, 2);
});

test("a record longer than one read is skipped with one record entry, and reading goes on after it", async (t) => {
  const p = await projects(t);
  const huge = JSON.stringify({ type: "assistant", timestamp: "2026-10-25T22:14:50.563Z", message: { content: [{ type: "text", text: "z".repeat(maxRecordBytes * 2 + 1000) }] } });
  await writeFile(p.file, `${lines[4]}\n${huge}\n${lines[22]}\n`);
  const all = await readAll(p.read, start);
  assert.deepEqual(all.entries, [
    ...parseRecord(lines[4]!),
    { kind: "record", at: null, type: "oversized", summary: `a record of more than ${maxRecordBytes} bytes was skipped` },
    ...parseRecord(lines[22]!),
  ]);
  assert.deepEqual([all.cursor.offset, all.cursor.skipping], [(await readFile(p.file)).length, false]);
  assert.ok(all.reads >= 4, `${all.reads} reads`);
});

test("a transcript that shrinks was replaced, so reading starts over from its beginning", async (t) => {
  const p = await projects(t);
  await writeFile(p.file, fixture);
  const all = await readAll(p.read, start);
  assert.deepEqual(all.entries, entries);
  await writeFile(p.file, lines.slice(0, 30).map((l) => `${l}\n`).join(""));
  const again = (await p.read(all.cursor))!;
  assert.equal(again.reset, true);
  assert.deepEqual(again.entries, parsedAll(lines.slice(0, 30)));
  assert.equal(again.cursor.offset, Buffer.byteLength(lines.slice(0, 30).map((l) => `${l}\n`).join("")));
});

test("a pylon that does not answer fails the read at its deadline and drops the pipe", async () => {
  let aborted = false;
  const silent: ByteStream = {
    async *[Symbol.asyncIterator]() { await new Promise(() => undefined); },
    write: async () => undefined,
    close: async () => undefined,
    abort: () => { aborted = true; },
    done: new Promise(() => undefined),
  };
  await assert.rejects(readTranscript(async () => silent, session, start, "/nowhere", 50), /did not read the transcript within 0.05 s/);
  assert.equal(aborted, true);
});

test("a transcript replaced by one at least as long starts over from its beginning", async (t) => {
  const p = await projects(t);
  await writeFile(p.file, fixture);
  const all = await readAll(p.read, start);
  const replaced = [...lines.slice(30), ...lines.slice(0, 30), lines[4]!].map((l) => `${l}\n`).join("");
  await writeFile(p.file, replaced);
  const first = (await p.read(all.cursor))!;
  assert.equal(first.reset, true);
  const rest = await readAll(p.read, first.cursor);
  assert.deepEqual([...first.entries, ...rest.entries], parsedAll([...lines.slice(30), ...lines.slice(0, 30), lines[4]!]));
  assert.equal(rest.cursor.offset, Buffer.byteLength(replaced));
});

const apiErrors = (await readFile(new URL("./fixtures/claude-api-errors.jsonl", import.meta.url), "utf8")).split("\n").filter((line) => line !== "");

test("a usage limit's error notice says when the limit resets, and other API errors stay plain error notices", () => {
  const [session, weekly, limited, overloaded] = apiErrors.map(parseRecord);
  assert.deepEqual(session, [{ kind: "notice", at: Date.parse("2026-10-26T05:34:18.605Z"), tone: "error", text: "You've hit your session limit · resets 6:30am (UTC)", usageLimit: { resetsAt: 1792996200000 } }]);
  assert.deepEqual(weekly!.map((e) => e.kind === "notice" && e.usageLimit), [{ resetsAt: 1793251800000 }]);
  for (const plain of [limited!, overloaded!]) {
    assert.equal(plain.length, 1);
    assert.equal(plain[0]!.kind === "notice" && plain[0]!.tone, "error");
    assert.equal("usageLimit" in plain[0]!, false);
  }
});

test("a usage limit whose reset is missing or malformed still gives its notice, with no reset", () => {
  const record = JSON.parse(apiErrors[0]!);
  for (const apiErrorParams of [undefined, "soon", { rate_limit_info: { resetsAt: "1792996200" } }, { rate_limit_info: { resetsAt: -1 } }, { rate_limit_info: null }]) {
    const [entry] = parseRecord(JSON.stringify({ ...record, apiErrorParams }));
    assert.equal(entry!.kind === "notice" && entry!.text, "You've hit your session limit · resets 6:30am (UTC)");
    assert.deepEqual(entry!.kind === "notice" && entry!.usageLimit, { resetsAt: null });
  }
});

test("a session stopped on its usage limit while the newest entry, bookkeeping aside, is the limit's notice", () => {
  const stop: ClaudeEntry = { kind: "notice", at: 5, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt: 9000 } };
  const turn: ClaudeEntry = { kind: "turn", at: 6, durationMs: 100 };
  const prompt: ClaudeEntry = { kind: "prompt", at: 7, text: "continue", from: "person" };
  const queue: ClaudeEntry = { kind: "queue", at: 7, op: "enqueue", text: "continue" };
  assert.deepEqual(usageLimitStop([prompt, stop]), { stoppedAt: 5, resetsAt: 9000 });
  assert.deepEqual(usageLimitStop([stop, turn, queue]), { stoppedAt: 5, resetsAt: 9000 });
  assert.equal(usageLimitStop([stop, turn, prompt]), null);
  assert.equal(usageLimitStop([stop, { kind: "notice", at: 8, tone: "error", text: "API Error: 529 Overloaded" }]), null);
  assert.equal(usageLimitStop([turn]), null);
  assert.equal(usageLimitStop([]), null);
});

test("Claude Code's own continue after the reset is a prompt from Claude Code, which ends the stop", async () => {
  const session = (await readFile(new URL("./fixtures/claude-usage-limit-session.jsonl", import.meta.url), "utf8")).split("\n").filter((line) => line !== "");
  const entries = session.flatMap(parseRecord);
  assert.deepEqual(entries.at(-1), { kind: "prompt", at: Date.parse("2026-10-26T05:55:36.839Z"), from: "other", text: "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete." });
  assert.equal(usageLimitStop(entries), null);
  const stopped = session.slice(0, 3).flatMap(parseRecord);
  assert.deepEqual(stopped.map((e) => e.kind), ["notice", "notice", "turn"]);
  assert.deepEqual(stopped[1], { kind: "notice", at: Date.parse("2026-10-26T05:51:36.706Z"), tone: "info", text: "Usage limit reached · continuing automatically at 5:54am · esc to cancel" });
  assert.deepEqual(usageLimitStop(stopped), { stoppedAt: Date.parse("2026-10-26T05:51:36.702Z"), resetsAt: 1792994043000 });
});

test("a usage limit's text names its reset in UTC, with its date when more than a day away, and says once it passed", () => {
  const reset = Date.parse("2026-10-26T06:30:00Z");
  assert.equal(usageLimitText({ resetsAt: reset }, Date.parse("2026-10-26T05:34:00Z")), "stopped on its usage limit until 06:30 UTC");
  assert.equal(usageLimitText({ resetsAt: Date.parse("2026-10-29T05:30:00Z") }, Date.parse("2026-10-26T05:34:00Z")), "stopped on its usage limit until Oct 29, 05:30 UTC");
  assert.equal(usageLimitText({ resetsAt: reset }, Date.parse("2026-10-26T07:00:00Z")), "stopped on its usage limit, which reset at 06:30 UTC");
  assert.equal(usageLimitText({ resetsAt: null }, reset), "stopped on its usage limit");
});

/** A user record as Claude Code writes it: a pasted image beside the prompt's text, or a Read of an image, whose base64 the record holds twice. */
const pastedRecord = (png: Buffer, text: string) => JSON.stringify({
  type: "user", timestamp: "2026-10-28T10:00:00.000Z", origin: { kind: "human" },
  message: { role: "user", content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] },
});
const readRecord = (png: Buffer, id: string) => JSON.stringify({
  type: "user", timestamp: "2026-10-28T10:00:01.000Z",
  message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text: "the screenshot" }, { type: "image", source: { type: "base64", data: png.toString("base64"), media_type: "image/png" } }] }] },
  toolUseResult: { type: "image", file: { base64: png.toString("base64"), type: "image/png" } },
});
const png = (bytes: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(bytes - 8)]);

test("a pasted image and a Read's image are kept as places in the transcript, which read back to the image's bytes", async (t) => {
  const p = await projects(t);
  const pasted = png(2_000);
  const shot = png(300_000);
  await writeFile(p.file, `${lines[4]}\n${pastedRecord(pasted, "What is wrong here?")}\n${readRecord(shot, "toolu_1")}\n`);
  const all = await readAll(p.read, start);
  const prompt = all.entries.find((e): e is Extract<ClaudeEntry, { kind: "prompt" }> => e.kind === "prompt" && e.text === "What is wrong here?")!;
  const result = all.entries.find((e): e is Extract<ClaudeEntry, { kind: "result" }> => e.kind === "result" && e.toolUseId === "toolu_1")!;
  assert.equal(result.output, "the screenshot");
  assert.equal(prompt.images?.length, 1);
  assert.equal(result.images?.length, 1);
  assert.ok(prompt.images![0]!.offset > 0);
  const line = Buffer.from(pastedRecord(pasted, "What is wrong here?"));
  assert.deepEqual(prompt.images![0], { offset: Buffer.byteLength(`${lines[4]}\n`), bytes: line.length, sha256: createHash("sha256").update(line).digest("hex"), index: 0 });
  assert.deepEqual(await readTranscriptImage(p.open, session, prompt.images![0]!, p.root), pasted);
  assert.deepEqual(await readTranscriptImage(p.open, session, result.images![0]!, p.root), shot);
  // A record parsed alone is located as the file's first line.
  assert.deepEqual((parseRecord(pastedRecord(pasted, "What is wrong here?"))[0] as { images: unknown[] }).images, [{ ...prompt.images![0], offset: 0 }]);
});

test("an image of a replaced transcript, or one named by a wrong hash or index, is gone rather than another's bytes", async (t) => {
  const p = await projects(t);
  await writeFile(p.file, `${pastedRecord(png(100), "first")}\n`);
  const image = (await p.read(start))!.entries.flatMap((e) => e.kind === "prompt" ? e.images ?? [] : [])[0]!;
  assert.ok(await readTranscriptImage(p.open, session, image, p.root));
  assert.equal(await readTranscriptImage(p.open, session, { ...image, sha256: "0".repeat(64) }, p.root), null);
  assert.equal(await readTranscriptImage(p.open, session, { ...image, index: 1 }, p.root), null);
  assert.equal(await readTranscriptImage(p.open, session, { ...image, bytes: image.bytes + 10 }, p.root), null);
  // The same record's length, with another image.
  await writeFile(p.file, `${pastedRecord(png(100), "first")}\n`);
  assert.equal(await readTranscriptImage(p.open, session, image, p.root), null);
  assert.equal(await readTranscriptImage(p.open, "11111111-2222-4333-8444-555555555599", image, p.root), null);
});

test("a Read of an image over a megabyte fits one record, where the old 512 KiB limit skipped it", async (t) => {
  const p = await projects(t);
  const shot = png(1 << 20);
  const record = readRecord(shot, "toolu_big");
  assert.ok(Buffer.byteLength(record) > 512 << 10 && Buffer.byteLength(record) < maxRecordBytes);
  await writeFile(p.file, `${record}\n${lines[4]}\n`);
  const all = await readAll(p.read, start);
  assert.equal(all.entries.some((e) => e.kind === "record"), false);
  const result = all.entries.find((e): e is Extract<ClaudeEntry, { kind: "result" }> => e.kind === "result")!;
  assert.deepEqual(await readTranscriptImage(p.open, session, result.images![0]!, p.root), shot);
});

test("a record of thousands of images shows its first 32, each read back from its own place", async (t) => {
  const p = await projects(t);
  const shots = Array.from({ length: 8_000 }, () => png(16));
  const results = shots.map((shot, i) => ({ tool_use_id: `toolu_${i}`, type: "tool_result", content: [{ type: "image", source: { type: "base64", data: shot.toString("base64"), media_type: "image/png" } }] }));
  await writeFile(p.file, `${JSON.stringify({ type: "user", timestamp: "2026-10-28T10:00:01.000Z", message: { role: "user", content: results } })}\n`);
  const entries = (await p.read(start))!.entries.filter((e): e is Extract<ClaudeEntry, { kind: "result" }> => e.kind === "result");
  assert.equal(entries.length, 8_000);
  const images = entries.flatMap((e) => e.images ?? []);
  assert.deepEqual(images.map((image) => image.index), Array.from({ length: 32 }, (_, i) => i));
  assert.equal(entries[31]!.images?.length, 1);
  assert.equal(entries[32]!.images, undefined);
  assert.deepEqual(await readTranscriptImage(p.open, session, images[31]!, p.root), shots[31]);
});
