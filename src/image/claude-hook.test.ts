import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { heartbeatDue, heartbeatIntervalMs } from "../../images/pylon/nexus-heartbeat.ts";
import { tempDir } from "../test-support/kit.ts";

const hook = new URL("../../images/pylon/nexus-claude-hook", import.meta.url).pathname;
const session = "3305dc74-0d65-4bd9-8df5-3094ddc4782f";
/** The clock's second, which a `date` on the hook's PATH prints. */
const second = 1_800_000_000;

/** A PostToolUse input in the key order Claude Code 2.1.310 hands its hooks. */
const postToolUse = (tool: string, input: object = {}) => JSON.stringify({ session_id: session, transcript_path: "/t.jsonl", cwd: "/w", hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: {} });

/**
 * Runs the hook with `node` and `date` on its PATH replaced: the clock reads `second`, and Node, if the hook starts
 * it, records its arguments and input. Answers what Node got, or null when the hook did not start it.
 */
async function run(t: { after(fn: () => Promise<void>): void }, args: string[], input: string, stamp?: number): Promise<{ args: string; input: string } | null> {
  const home = await tempDir("nexus-claude-hook-", t);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$*" > "$HOME/node.args"\ncat > "$HOME/node.input"\n`);
  await writeFile(join(bin, "date"), `#!/bin/sh\necho ${second}\n`);
  await Promise.all(["node", "date"].map((name) => chmod(join(bin, name), 0o755)));
  if (stamp !== undefined) {
    const path = join(home, ".nexus", "heartbeats", createHash("sha256").update(session).digest("hex"));
    await mkdir(join(path, ".."), { recursive: true });
    assert.equal(await heartbeatDue(path, stamp), true, "the Node hook's own write makes the stamp");
  }
  const child = promisify(execFile)(hook, args, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
  child.child.stdin!.end(input);
  await child;
  const ran = await readFile(join(home, "node.args"), "utf8").catch(() => null);
  return ran === null ? null : { args: ran.trimEnd(), input: (await readFile(join(home, "node.input"), "utf8")).trimEnd() };
}

const nodeHook = (...args: string[]) => [new URL("../../images/pylon/nexus-claude-hook.mjs", import.meta.url).pathname, ...args].join(" ");

test("a heartbeat within the throttle, at any instant of the clock's second, ends without starting Node", async (t) => {
  const stamp = second * 1000 + 999 - heartbeatIntervalMs + 1;
  assert.equal(await run(t, ["session.heartbeat"], postToolUse("Bash", { command: "ls" }), stamp), null);
  assert.equal(await run(t, ["session.heartbeat"], postToolUse("Bash", { command: "ls" }), second * 1000), null);
});

test("a heartbeat that may be due, or whose session has no stamp, reaches the Node hook with its input", async (t) => {
  const input = postToolUse("Bash", { command: "ls" });
  assert.deepEqual(await run(t, ["session.heartbeat"], input, second * 1000 + 999 - heartbeatIntervalMs), { args: nodeHook("session.heartbeat"), input });
  assert.deepEqual(await run(t, ["session.heartbeat"], input), { args: nodeHook("session.heartbeat"), input });
});

test("an answered AskUserQuestion's heartbeat skips the throttle, and an input the fast path cannot read goes to Node", async (t) => {
  const answered = postToolUse("AskUserQuestion", { questions: [{ question: "Which drink?" }] });
  assert.deepEqual(await run(t, ["session.heartbeat"], answered, second * 1000), { args: nodeHook("session.heartbeat"), input: answered });
  const reordered = JSON.stringify({ hook_event_name: "PostToolUse", session_id: session, tool_name: "Bash" });
  assert.deepEqual(await run(t, ["session.heartbeat"], reordered, second * 1000), { args: nodeHook("session.heartbeat"), input: reordered });
});

test("every other kind reaches the Node hook untouched, a Stop with running shells included", async (t) => {
  const stop = JSON.stringify({ session_id: session, hook_event_name: "Stop", background_tasks: [{ id: "b1", type: "shell", status: "running" }] });
  assert.deepEqual(await run(t, ["session.turn-ended"], stop, second * 1000), { args: nodeHook("session.turn-ended"), input: stop });
  assert.deepEqual(await run(t, ["answer", "{\"a\": 1}"], "", second * 1000), { args: nodeHook("answer", "{\"a\": 1}"), input: "" });
});
