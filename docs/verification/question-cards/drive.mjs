// Drives the stack in stack.ts in headless Chromium and through the CLI, and saves what it saw in OUT. The same driver
// runs on main and on the branch, and records whatever each one shows and answers. A browser's confirmation dialog is
// not part of a screenshot, so the driver adds a dashed yellow box, marked as added by this script, that quotes it.
//
//   OUT=... ROOT=<checkout> STACK='{...}' MODULES=... node docs/verification/question-cards/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const out = process.env.OUT;
const stack = JSON.parse(process.env.STACK);
const base = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, text) => { writeFileSync(join(out, name), text); log(text); };
const as = async (who) => {
  await fetch("http://127.0.0.1:7489/verify/caller", { method: "POST", body: JSON.stringify({ as: who }) });
  log(`whois now answers the ${who}, ${stack.callers[who]}`);
};

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 900 } });
const page = await browser.newPage();
let asked = null;
page.on("dialog", async (dialog) => {
  asked = dialog.message();
  log(`the page asked: ${JSON.stringify(asked)}, and the driver accepted`);
  await dialog.accept();
});

const card = (question) => page.evaluate((question) => {
  const el = document.querySelector(`[data-question="${question}"]:not(button)`);
  if (el === null) return "(no card)";
  const buttons = [...el.querySelectorAll("button")].map((b) => `[${b.textContent.trim()}${b.disabled ? ", disabled" : ""}]`);
  return `${el.innerText.trim()}\n${buttons.join(" ")}`.trim();
}, question);
const box = (text) => page.evaluate((text) => {
  const div = document.createElement("div");
  div.id = "drive-box";
  div.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:200;max-width:min(620px,calc(100vw - 24px));padding:12px 16px;background:#fff8c5;color:#111;border:2px dashed #b08800;border-radius:6px;font:14px/1.5 system-ui,sans-serif";
  div.textContent = text;
  document.body.append(div);
}, text);
const shot = async (name, note) => {
  if (note !== undefined) await box(`Added by drive.mjs. ${note}`);
  await page.screenshot({ path: join(out, name), fullPage: false });
  if (note !== undefined) await page.evaluate(() => document.getElementById("drive-box").remove());
  log(`screenshot ${name}`);
};
const open = async (path) => {
  const res = await page.goto(`${base}${path}`);
  await sleep(600);
  log(`GET ${path} answered ${res.status()}`);
};
const cli = (name, args) => {
  const run = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: base, NEXUS_SOCKS: "none" }, encoding: "utf8" });
  save(`${name}.txt`, `$ nexus ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`);
};
const answer = async (question, option) => {
  const res = await fetch(`${base}/v1/questions/${question}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ option }) });
  const text = await res.text();
  return `POST /v1/questions/${question}/answer ${JSON.stringify({ option })}\n=> ${res.status} ${text}`;
};
const attention = async (thread) => {
  const d = await (await fetch(`${base}/v1/threads/${thread}`)).json();
  return `attention ${JSON.stringify(d.attention)}, questions ${JSON.stringify(d.questions ?? "(none in ThreadDetail)")}`;
};
/** Presses the option's button, then screenshots the card once the page shows it answered, or after 8 seconds. */
async function press(question, option, prefix) {
  const button = await page.$(`button[data-action="answer"][data-question="${question}"][data-option="${option}"]:not([disabled])`);
  if (button === null) {
    log(`${prefix}: no enabled "${option}" button for ${question} to press`);
    return false;
  }
  await button.click();
  await sleep(300);
  await shot(`${prefix}-0-pressed.png`, `The driver pressed "${option}". The browser's confirmation dialog said: "${asked}" The driver accepted.`);
  for (const deadline = Date.now() + 8_000; Date.now() < deadline && !(await card(question)).includes("Answered");) await sleep(250);
  log(`${prefix}: the card now reads\n${await card(question)}`);
  await shot(`${prefix}-1-answered.png`);
  return true;
}

await as("laptop");
await open("/");
await shot("01-home.png");
cli("02-threads", ["threads"]);
cli("03-show-image-before", ["show", stack.image]);

await open(`/threads/${stack.image}`);
log(`the image question's card as the laptop:\n${await card("qn-image-rebuild")}`);
await shot("04-image-card.png");
await press("qn-image-rebuild", "Rebuild and roll out", "05-image-press");
cli("06-show-image-after", ["show", stack.image]);
save("06-image-detail.txt", await attention(stack.image));

await as("phone");
await open(`/threads/${stack.secret}`);
log(`the merge token question's card as the phone:\n${await card("qn-merge-token")}`);
await shot("07-secret-as-phone.png", "whois now answers the phone, a person the API allows who is not a deployer.");
save("07-secret-as-phone.txt", `As the phone:\n${await answer("qn-merge-token", "Rotate now")}\n${await attention(stack.secret)}`);

await as("node");
save("08-brief-as-node.txt", `As verify-node, the control plane's own node:\n${await answer("qn-brief", "Start it")}\n${await attention(stack.brief)}`);

await as("phone");
await open(`/threads/${stack.brief}`);
log(`the brief question's card as the phone:\n${await card("qn-brief")}`);
await shot("09-brief-as-phone.png", "whois now answers the phone, a person the API allows who is not a deployer.");
await press("qn-brief", "Start it", "10-brief-press");
cli("11-show-brief-after", ["show", stack.brief]);

await as("laptop");
save("12-answers-again.txt", [
  "As the laptop, the same answer again, another answer, an unknown question, and an option the question does not offer:",
  await answer("qn-image-rebuild", "Rebuild and roll out"),
  await answer("qn-image-rebuild", "Leave the image as it is"),
  await answer("qn-unknown", "Start it"),
  await answer("qn-merge-token", "Rotate later"),
].join("\n"));
cli("13-threads-after", ["threads"]);
await open("/");
await shot("14-home-after.png");
await browser.close();
