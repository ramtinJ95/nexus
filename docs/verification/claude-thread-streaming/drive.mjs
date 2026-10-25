// Drives the stack in stack.ts through the person's surfaces: the dashboard in headless Chromium and the Mac CLI. It
// starts a Claude Code thread from the start dialog, follows the thread's stream while the turn runs, steers Claude
// from the composer mid-turn and with `nexus send` after the turn, pauses and wakes the pylon, and saves what it saw
// here. Chromium and puppeteer-core come from the npm packages @sparticuz/chromium and puppeteer-core, installed
// outside the repo: MODULES names their node_modules, and LD_LIBRARY_PATH and FONTCONFIG_PATH their libraries.
//
//   MODULES=... node docs/verification/claude-thread-streaming/drive.mjs
import { execFile } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const out = new URL(".", import.meta.url).pathname;
const base = "http://127.0.0.1:7470";
const run = promisify(execFile);
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${new Date().toISOString()} ${line}\n`); };
const nexus = (...args) => run("node", ["src/cli/nexus.ts", ...args], { env: { ...process.env, NEXUS_URL: base, NEXUS_SOCKS: "none" }, maxBuffer: 1 << 24 });
const api = async (path) => (await fetch(`${base}${path}`)).json();
const until = async (what, check, ms = 600_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 1000))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const shot = async (name) => { await page.screenshot({ path: join(out, name) }); log(`screenshot ${name}`); };

await page.goto(`${base}/threads/new`);
await page.waitForSelector("#start-dialog[open]");
await shot("01-start-dialog.png");
const prompt = [
  "Quick verification task, keep it small: no subagents, no pull request, no reviews.",
  "In this repository, one tool call per step:",
  "1. Write wc.js, a Node script that prints the number of words it reads on stdin.",
  "2. Write wc.test.js with node:test that checks it on two inputs.",
  "3. Run node --test.",
  "4. Run `node -e \"setTimeout(() => {}, 40000)\"` in the foreground with Bash (timeout 120000), which waits 40 seconds.",
  "5. Commit with git -c user.name=verify -c user.email=verify@example.com commit.",
  "6. Reply with a short markdown summary: a heading and a list.",
].join("\n");
await page.type("#start-claude", prompt);
await Promise.all([page.waitForNavigation(), page.$eval("#start button[type=submit]", (b) => b.click())]);
const thread = new URL(page.url()).pathname.split("/").at(-1);
log(`started ${thread} from the start dialog`);
writeFileSync(join(out, "thread.json"), JSON.stringify(await api(`/v1/threads/${thread}`), null, 2));

// The dashboard's own stream, as the page follows it: each frame logged with when it arrived.
const frames = join(out, "stream-frames.log");
writeFileSync(frames, "");
void (async () => {
  const res = await fetch(`${base}/threads/${thread}/stream`);
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    for (const event of decoder.decode(chunk).split("\n\n")) {
      if (!event.startsWith("data: ")) continue;
      const frame = JSON.parse(event.slice(6));
      const tools = frame.convo === undefined ? null : (frame.convo.match(/class="tool[ "]/g) ?? []).length;
      appendFileSync(frames, `${new Date().toISOString()} ${frame.convo === undefined ? "grow" : "convo"} tools=${tools} bytes=${event.length}\n`);
    }
  }
})();

const conversation = () => api(`/v1/threads/${thread}/conversation`);
await until("Claude's first tool call", async () => (await conversation()).entries?.some((e) => e.kind === "tool"));
await until("a second tool call while working", async () => {
  const c = await conversation();
  return c.working && c.entries.filter((e) => e.kind === "tool").length >= 2;
});
await page.waitForSelector(".run-bar.working", { timeout: 30_000 });
await shot("02-live-turn.png");

const steer = 'Also add this line to README.md, exactly:\nShe said "it\'s `wc` -- it costs $5 and $(echo nothing) runs"\nand mention it in your summary.';
// page.type presses Enter for each newline, so the text goes into the box whole, as a paste would put it.
await page.$eval("#prompt-text", (el, text) => { el.value = text; }, steer);
await page.$eval("#send", (b) => b.click());
log("sent the mid-turn message from the composer");
await until("the mid-turn message in the transcript", async () => (await conversation()).entries.some((e) => e.kind === "prompt" && e.text === steer) || (await conversation()).entries.some((e) => e.kind === "queue" && e.text === steer));
await page.reload();
await shot("03-steered-mid-turn.png");

await until("the turn to end", async () => {
  const c = await conversation();
  return !c.working && c.entries.some((e) => e.kind === "turn") && c.entries.at(-1).kind !== "queue";
}, 900_000);
await page.reload();
await page.evaluate(() => document.getElementById("scroll").scrollTo(0, 1e9));
await shot("04-turn-ended.png");

const after = "Reply with only the text between the markers, unchanged:\n<<\nquote \" single ' backtick ` dollar $HOME $(whoami) backslash \\ tab-free\n>>";
const sent = await nexus("send", thread, after, "--json");
writeFileSync(join(out, "cli-send-after-turn.json"), sent.stdout);
log(`nexus send after the turn: ${sent.stdout.trim()}`);
await until("the reply to the second message", async () => {
  const c = await conversation();
  const asked = c.entries.findIndex((e) => e.kind === "prompt" && e.text === after);
  return asked !== -1 && !c.working && c.entries.slice(asked).some((e) => e.kind === "reply");
});
await page.reload();
await page.evaluate(() => document.getElementById("scroll").scrollTo(0, 1e9));
await shot("05-sent-after-turn.png");
await page.evaluate(() => { for (const d of document.querySelectorAll("details.steps")) d.open = true; document.getElementById("scroll").scrollTo(0, 0); });
await shot("06-tools-expanded.png");

writeFileSync(join(out, "cli-conversation.txt"), (await nexus("conversation", thread)).stdout);
writeFileSync(join(out, "cli-conversation.json"), (await nexus("conversation", thread, "--json")).stdout);

// Exactness: the person's prompts as Claude Code itself recorded them, from the raw transcript.
const { session } = await conversation();
const dir = "/tmp/nexus-claude-verify/home/.claude/projects";
const file = readdirSync(dir).map((d) => join(dir, d, `${session}.jsonl`)).find((f) => { try { readFileSync(f); return true; } catch { return false; } });
const recorded = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).flatMap((r) =>
  r.type === "user" && typeof r.message?.content === "string" && r.origin?.kind === "human" ? [r.message.content]
  : r.type === "attachment" && r.attachment?.type === "queued_command" ? [r.attachment.prompt] : []);
const exact = { midTurn: recorded.includes(steer), afterTurn: recorded.includes(after) };
writeFileSync(join(out, "exactness.json"), JSON.stringify({ steer, after, recordedPersonPrompts: recorded, exact }, null, 2));
log(`exact as written in Claude's own transcript: ${JSON.stringify(exact)}`);
await browser.close();
log(`done; next: THREAD=${thread} node drive-pause.mjs`);
process.exit(0);
