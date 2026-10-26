// Drives the stack in ../claude-thread-streaming/stack.ts through the Mac CLI and the dashboard: starts a Claude Code
// worker thread, follows it with `nexus watch` in text and JSON, reads `show` while a turn runs, adds the pr-link
// record Claude Code wrote for this change's own pull request to the worker's transcript, steers a second turn,
// marks the first reply seen with `seen --last-reply-at`, and saves what it saw here. PR_LINK is the transcript of the
// session that opened the pull request. shot.mjs then captures the thread's page.
//
//   PR_LINK=~/.claude/projects/.../<session>.jsonl node docs/verification/cli-contract-fixes/drive.mjs
import { execFile, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const out = new URL(".", import.meta.url).pathname;
const base = "http://127.0.0.1:7470";
const env = { ...process.env, NEXUS_URL: base, NEXUS_SOCKS: "none" };
const run = promisify(execFile);
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${new Date().toISOString()} ${line}\n`); };
const nexus = async (...args) => (await run("node", ["src/cli/nexus.ts", ...args], { env, maxBuffer: 1 << 24 })).stdout;
const json = async (...args) => JSON.parse(await nexus(...args, "--json"));
const save = (name, value) => writeFileSync(join(out, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
const until = async (what, check, ms = 900_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 1000))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};

writeFileSync(join(out, "drive.log"), "");
const prompt = [
  "Quick verification task, keep it small: no subagents, no pull request, no reviews, no skills beyond this one.",
  "One tool call per step:",
  "1. Run `false` with Bash.",
  "2. Run `sleep 20` with Bash.",
  "3. Reply with one short sentence.",
].join("\n");
const thread = (await json("start", "--project", "words", "--claude", prompt)).id;
log(`started ${thread} with nexus start --claude`);

const watches = ["watch.txt", "watch.jsonl"].map((name) => {
  const child = spawn("node", ["src/cli/nexus.ts", "watch", thread, ...name.endsWith(".jsonl") ? ["--json"] : []], { env });
  child.stdout.pipe(createWriteStream(join(out, name)));
  return child;
});
const watched = () => readFileSync(join(out, "watch.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const idleAfterWork = (from) => {
  const states = watched().slice(from).filter((e) => e.type === "state");
  return states.some((s) => s.run === "working") && states.at(-1)?.run === "idle";
};

const working = await until("a turn of the worker", async () => {
  const detail = await json("show", thread);
  return detail.thread.sessionTurnRunning === true ? detail : null;
});
save("show-working.json", working);
save("threads-row-working.json", (await json("threads")).find((t) => t.id === thread));
log(`show --json while the turn runs: sessionTurnRunning ${working.thread.sessionTurnRunning}, sessionActiveUntil ${working.thread.sessionActiveUntil}`);

await until("the first turn's end in watch", () => idleAfterWork(0));
const first = await json("show", thread);
log(`first turn ended, lastReplyAt ${first.lastReplyAt}, attention ${first.attention}`);

const session = (await json("conversation", thread)).session;
const transcript = `/tmp/nexus-claude-verify/home/.claude/projects/-tmp-nexus-claude-verify-repo/${session}.jsonl`;
const prLinks = readFileSync(process.env.PR_LINK, "utf8").split("\n").filter((l) => l.includes('"type":"pr-link"'));
appendFileSync(transcript, `${prLinks[0]}\n${prLinks.at(-1)}\n`);
log(`appended ${prLinks[0] === prLinks.at(-1) ? "the one pr-link record, twice" : "the first and last pr-link records"} to ${transcript}`);

const mark = watched().length;
save("send.json", await json("send", thread, "Reply with the single word: ok"));
await until("the second turn's end in watch", () => idleAfterWork(mark));
const second = await json("show", thread);
log(`second turn ended, lastReplyAt ${second.lastReplyAt}`);

const seen = [];
for (const at of [first.lastReplyAt, second.lastReplyAt - 5_000, second.lastReplyAt]) {
  await nexus("seen", thread, "--last-reply-at", String(at));
  const d = await json("show", thread);
  seen.push({ lastReplyAtGiven: at, seenAt: d.seenAt, lastReplyAt: d.lastReplyAt, attention: d.attention });
}
save("seen.json", seen);
log(`seen --last-reply-at: ${JSON.stringify(seen)}`);

save("conversation.txt", await nexus("conversation", thread));
await new Promise((r) => setTimeout(r, 3000));
for (const w of watches) w.kill();

log(`dashboard capture: node docs/verification/cli-contract-fixes/shot.mjs ${thread}`);
