// Drives the stack in stack.ts through the person's surfaces, the CLI and the dashboard, and saves what they show here.
// This pylon has no libraries for a headless Chromium, so the dashboard's pages are saved as the HTML the control plane
// renders, with the text of each thread's state.
//
//   node docs/verification/usage-limit-stops/drive.mjs
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = new URL(".", import.meta.url).pathname;
const repo = new URL("../../../", import.meta.url).pathname;
const fakeApi = "http://127.0.0.1:18767";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${new Date().toISOString()} ${line}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nexus(...args) {
  return execFileSync("node", ["src/cli/nexus.ts", ...args], { cwd: repo, env: { ...process.env, NEXUS_URL: "http://127.0.0.1:7473", NEXUS_SOCKS: "none" }, encoding: "utf8" });
}
const json = (...args) => JSON.parse(nexus(...args, "--json"));
/** `events --json` prints one event per line. */
const events = (...args) => nexus("events", ...args, "--json").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
function save(file, text) {
  writeFileSync(join(out, file), text);
  log(`saved ${file}`);
}
async function until(what, check, ms = 240_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}
const row = (id) => json("threads").find((t) => t.id === id);
const continued = (id) => events("--thread", id, "--kind", "usage-limit.continued");
const mode = (name, reset) => fetch(`${fakeApi}/mode/${name}${reset === undefined ? "" : `?reset=${reset}`}`, { method: "POST" });

async function page(path, file) {
  const html = await (await fetch(`http://127.0.0.1:7473${path}`)).text();
  save(file, html);
  const states = [...new Set([...html.matchAll(/class="dot dot-(\w+)" role="img" aria-label="([^"]*)"/g)].map((m) => `${m[2]} (${m[1]})`))];
  log(`${path} states: ${JSON.stringify(states)}`);
}

writeFileSync(join(out, "drive.log"), "");

// A thread that stops on its session limit, and that the resumer continues once the limit resets.
const reset = Math.floor(Date.now() / 1000) + 150;
await mode("limit", reset);
const a = json("start", "--project", "words", "--title", "Stops on its limit", "--claude", "Write hello.txt containing hi, then say done.").id;
log(`started ${a}, the fake API's limit resets at ${new Date(reset * 1000).toISOString()}`);
await until(`${a} to stop on its usage limit`, () => row(a)?.attention === "limited");
log(`${a} attention is limited: ${JSON.stringify(row(a).usageLimit)}`);
save("01-threads.txt", nexus("threads"));
save("01-thread-row.json", JSON.stringify(row(a), null, 2));
save("01-show.txt", nexus("show", a));
save("01-conversation.txt", nexus("conversation", a));
save("01-conversation.json", nexus("conversation", a, "--json"));
await page("/", "01-home.html");
await page(`/threads/${a}`, "02-thread.html");
nexus("seen", a);
log(`after seen, ${a} attention is ${row(a).attention}`);
await mode("ok");
await until(`the resumer to continue ${a}`, () => continued(a).length > 0, (reset * 1000 - Date.now()) + 60_000);
log(`continued ${a}: ${JSON.stringify(continued(a))}`);
await until(`${a}'s continued turn to end`, () => row(a)?.attention === "reply");
await sleep(10_000);
save("03-events.jsonl", events("--thread", a).map((e) => JSON.stringify(e)).join("\n") + "\n");
save("03-conversation.txt", nexus("conversation", a));
const sent = continued(a).length;
log(`${a} has ${sent} usage-limit.continued event(s) after 10 s more; attention ${row(a).attention}, usageLimit ${JSON.stringify(row(a).usageLimit ?? null)}`);
if (sent !== 1) throw new Error(`expected one continue, got ${sent}`);
await page(`/threads/${a}`, "03-continued.html");

// A thread the person continues by hand, as without the resumer. Its reset is an hour away, so the resumer leaves it.
await mode("limit", Math.floor(Date.now() / 1000) + 3600);
const b = json("start", "--project", "words", "--title", "Continued by hand", "--claude", "Write two.txt containing 2, then say done.").id;
await until(`${b} to stop on its usage limit`, () => row(b)?.attention === "limited");
await mode("ok");
save("04-send.txt", nexus("send", b, "continue"));
await until(`${b}'s continued turn to end`, () => row(b)?.attention === "reply");
save("04-conversation.txt", nexus("conversation", b));
log(`${b} after nexus send: attention ${row(b).attention}, continued events ${continued(b).length}`);

// An archived thread is never continued, so its pylon never wakes for it.
const soon = Math.floor(Date.now() / 1000) + 40;
await mode("limit", soon);
const c = json("start", "--project", "words", "--title", "Archived while stopped", "--claude", "Write three.txt containing 3, then say done.").id;
await until(`${c} to stop on its usage limit`, () => row(c)?.attention === "limited");
nexus("archive", c);
await mode("ok");
await sleep(Math.max(0, soon * 1000 - Date.now()) + 20_000);
save("05-archived.txt", [nexus("show", c), `usage-limit.continued events: ${continued(c).length}`].join("\n"));
log(`${c} archived, 20 s past its reset: continued events ${continued(c).length}`);
if (continued(c).length !== 0) throw new Error("the archived thread was continued");

log("done");
