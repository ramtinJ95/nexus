// Drives sessions.ts's interruptClaude and sendToClaude against a real Claude Code in a real Herdr, which the unit tests
// only fake. with-claude.sh starts that Claude. Each step's result and the pane's screen go to OUT/live.txt.
//
//   bash -l docs/verification/claude-interrupt/with-claude.sh env OUT=docs/verification/claude-interrupt/live node docs/verification/claude-interrupt/live.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Guest } from "../../../src/backend.ts";
import { herdrSession, interruptClaude, sendToClaude, sessionFacts } from "../../../src/sessions.ts";

const session = process.env.SESSION!;
const scratch = process.env.HERDR_SESSION!;
mkdirSync(process.env.OUT!, { recursive: true });
const out = join(process.env.OUT!, "live.txt");
writeFileSync(out, `Claude session ${session}\n`);
const own = (arg: string) => arg.replaceAll(`--session ${herdrSession} `, `--session ${scratch} `);
const guest: Guest = {
  exec: (argv, opts) => new Promise((resolve) => {
    const args = argv.map((arg, i) => argv[i - 1] === "--session" && arg === herdrSession ? scratch : own(arg));
    execFile(args[0]!, args.slice(1), { cwd: process.env.HOME, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const killed = err !== null && "killed" in err && err.killed;
      resolve({ exitCode: err === null ? 0 : killed ? null : typeof err.code === "number" ? err.code : 127, output: stdout + stderr, truncated: false });
    });
  }),
  writeFiles: () => Promise.reject(new Error("unused")),
  stream: () => Promise.reject(new Error("unused")),
  services: () => Promise.reject(new Error("unused")),
  startService: () => Promise.reject(new Error("unused")),
  linkPort: () => Promise.reject(new Error("unused")),
  unlinkPort: () => Promise.reject(new Error("unused")),
  previewOrigin: () => { throw new Error("unused"); },
};
const herdr = async (...args: string[]) => (await guest.exec(["herdr", "--session", herdrSession, ...args], { cwd: "/", timeoutMs: 20_000 })).output;
const screen = async (pane = "w1:p1") => (await herdr("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "40")).split("\n").filter((l) => l.trim() !== "").slice(-14).join("\n");
const log = (line: string) => { console.log(line); appendFileSync(out, `${line}\n`); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, ok: (facts: Awaited<ReturnType<typeof sessionFacts>>) => boolean) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(250)) if (ok(await sessionFacts(guest))) return;
  assert.fail(`${what} within 60 s; the pane showed:\n${await screen()}`);
}
const status = (facts: Awaited<ReturnType<typeof sessionFacts>>) => facts.find((f) => f.herdrPane === "w1:p1")?.status;

log(`# interrupt a working Claude\nsend: ${JSON.stringify(await sendToClaude(guest, { session, text: "Write a 1500-word essay about lighthouses, in plain prose, with no tools." }))}`);
await until("Claude works", (f) => status(f) === "working");
for (const deadline = Date.now() + 60_000; !/^● /m.test(await screen()) && Date.now() < deadline;) await sleep(250);
log(`interrupt while Claude writes its reply: ${await interruptClaude(guest, session)}`);
await until("Claude stops", (f) => status(f) !== "working");
const stopped = await screen();
log(`status after: ${status(await sessionFacts(guest))}\n${stopped}`);
assert.match(stopped, /Interrupted/);

log(`\n# interrupt before Claude starts its reply\nsend: ${JSON.stringify(await sendToClaude(guest, { session, text: "Write another 1500-word essay, about harbours." }))}`);
await until("Claude works", (f) => status(f) === "working");
log(`interrupt at once: ${await interruptClaude(guest, session)}`);
await until("Claude stops", (f) => status(f) !== "working");
await sleep(1_000);
const early = await screen();
log(`status after: ${status(await sessionFacts(guest))}\n${early}`);
assert.match(early.split("\n").filter((l) => l.startsWith("❯")).at(-1) ?? "", /about harbours/, "Claude put the message back in its prompt");
await herdr("pane", "send-keys", "w1:p1", "ctrl+u");
await sleep(500);
log(`after Ctrl+U, the prompt line: ${(await screen()).split("\n").filter((l) => l.startsWith("❯")).at(-1)}`);

log(`\n# interrupt an idle Claude, twice in a row\nfirst: ${await interruptClaude(guest, session)}\nsecond: ${await interruptClaude(guest, session)}`);
await sleep(1_000);
assert.doesNotMatch(await screen(), /Rewind/, "no Esc reached the idle prompt, so no rewind picker opened");
log("no rewind picker opened");

log(`\n# interrupt while a permission dialog waits\nsend: ${JSON.stringify(await sendToClaude(guest, { session, text: "Use the Bash tool to run exactly: touch interrupt-marker" }))}`);
await until("the permission dialog waits", (f) => status(f) === "blocked");
log(`interrupt at the dialog: ${await interruptClaude(guest, session)}`);
await sleep(1_000);
const dialog = await screen();
log(`status after: ${status(await sessionFacts(guest))}\n${dialog}`);
assert.match(dialog, /Do you want to proceed\?/, "the dialog still waits");
log(`message at the dialog: ${JSON.stringify(await sendToClaude(guest, { session, text: "yes" }))}`);
await herdr("pane", "send-keys", "w1:p1", "esc");
await until("the dialog closes", (f) => status(f) !== "blocked");

log(`\n# /clear typed as a send would type it\nbefore: ${JSON.stringify((await sessionFacts(guest)).map((f) => [f.herdrPane, f.harnessSessionId]))}`);
log(`send /clear: ${JSON.stringify(await sendToClaude(guest, { session, text: "/clear" }))}`);
await until("Herdr learns the new session", (f) => f.some((p) => p.herdrPane === "w1:p1" && p.harnessSessionId !== session));
log(`after: ${JSON.stringify((await sessionFacts(guest)).map((f) => [f.herdrPane, f.harnessSessionId]))}`);
log(`interrupt the old session: ${await interruptClaude(guest, session)}`);
const after = await sendToClaude(guest, { session, text: "Say hello." });
log(`next message to the old session: ${JSON.stringify(after)}`);
assert.equal(after.resumed, true, "the old session no longer runs in w1:p1, so the send resumes it elsewhere");
await sleep(3_000);
log(`panes now: ${JSON.stringify((await sessionFacts(guest)).map((f) => [f.herdrPane, f.harness, f.harnessSessionId]))}`);
