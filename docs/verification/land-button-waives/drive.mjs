// Drives the stack in stack.ts in headless Chromium and through the CLI, and saves what it saw in OUT. Chromium opens
// the dashboard at its HTTPS address, trusting the stack's certificate by its key. The same driver runs on main and on
// the branch, and records whatever each one shows and answers. A browser's confirmation dialog is not part of a
// screenshot, so the driver adds a dashed yellow box, marked as added by this script, that says what it asked.
//
//   OUT=... ROOT=<checkout> STACK='{...}' MODULES=... node docs/verification/land-button-waives/drive.mjs
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
const base = `https://${stack.hostname}:7443`;
const plain = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const as = (node) => fetch("http://127.0.0.1:7489/verify/caller", { method: "POST", body: JSON.stringify({ node }) });
const review = async (thread) => (await (await fetch(`${plain}/v1/threads/${thread}`)).json()).review;
const save = (name, text) => { writeFileSync(join(out, name), text); log(text); };

writeFileSync(join(out, "drive.log"), "");
const browser = await puppeteer.launch({
  args: [...chromium.args, `--host-resolver-rules=MAP ${stack.hostname} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${stack.spki}`],
  executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
let asked = null;
page.on("dialog", async (dialog) => {
  asked = dialog.message();
  log(`the page asked: ${JSON.stringify(asked)}, and the driver accepted`);
  await dialog.accept();
});
let landBody = null;
page.on("request", (req) => {
  if (req.method() === "POST" && /\/v1\/threads\/[^/]+\/land$/.test(new URL(req.url()).pathname)) landBody = req.postData();
});

const seen = () => page.evaluate(() => ({
  landing: document.getElementById("landing")?.innerText.trim() ?? null,
  landButton: (() => { const b = document.getElementById("land"); return b === null ? "(no Land button)" : `${b.textContent}${b.disabled ? " (disabled)" : ""}`; })(),
  error: document.getElementById("action-error")?.hidden === false ? document.getElementById("action-error").textContent : null,
}));
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
  return res.status();
};
const cli = (name, args) => {
  const run = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: plain, NEXUS_SOCKS: "none" }, encoding: "utf8" });
  save(`${name}.txt`, `$ nexus ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`);
};
/** A land request from the open page, as the dashboard's client sends one, so it comes from the browser's caller. */
const landFromPage = async (thread, body) => {
  const reply = await page.evaluate(async (path, body) => {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : JSON.parse(text) };
  }, `/v1/threads/${thread}/land`, body);
  const shown = reply.status === 200 ? { phase: reply.body.phase, waiver: reply.body.waiver } : reply.body;
  return `POST /v1/threads/${thread}/land ${JSON.stringify(body)}\n=> ${reply.status} ${JSON.stringify(shown)}`;
};
const held = async (thread) => {
  const r = await review(thread);
  return { head: r.rounds.at(-1).head, reasons: r.phase.reasons ?? [] };
};
const press = async () => {
  const button = await page.$("#land[data-action]:not([disabled])");
  if (button === null) return false;
  await button.click();
  await sleep(1200);
  return true;
};

/** Screenshots the page each time the review's phase changes, once the page shows it, until it ends or a minute passes. */
async function follow(thread, prefix) {
  let last = null;
  let shown = JSON.stringify(await seen());
  let n = 0;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    const r = await review(thread);
    if (r.phase.kind !== last) {
      last = r.phase.kind;
      for (const by = Date.now() + 6_000; Date.now() < by && JSON.stringify(await seen()) === shown;) await sleep(200);
      shown = JSON.stringify(await seen());
      log(`${prefix}: the review is ${last} ${JSON.stringify(await seen(), null, 2)}`);
      await shot(`${prefix}-${++n}-${last}.png`);
      if (["landed", "needs-person", "approved", "rebasing"].includes(last)) return r;
    }
    await sleep(250);
  }
  log(`${prefix}: the review did not end within a minute`);
}

await as(stack.laptop);
log(`GET /passkeys answered ${await open("/passkeys")}`);
await shot("01-passkeys-page.png");

await open(`/threads/${stack.reserved}`);
log(`reserved, held: ${JSON.stringify(await seen(), null, 2)}`);
await shot("02-held-reserved.png");
cli("03-cli-land-0", ["land", stack.reserved]);
await follow(stack.reserved, "03-cli-land");
cli("03-cli-land-show", ["show", stack.reserved]);

await open(`/threads/${stack.reserved}`);
if (await press()) {
  await shot("04-press-0-pressed.png", `The driver pressed Land. The browser's confirmation dialog said: "${asked}" The driver accepted.`);
  await follow(stack.reserved, "04-press");
  log(`the page sent: ${landBody}`);
} else {
  log(`the card has no Land button the driver can press: ${JSON.stringify(await seen())}`);
  await shot("04-press-0-needs-passkey.png", "The Land button is disabled. Pressing it does nothing.");
  const { head, reasons } = await held(stack.reserved);
  save("04-press-waive-without-passkey.txt", `The driver sends the branch's waiving land request from this page.\n${await landFromPage(stack.reserved, { head, waive: reasons })}\nThe review is still ${(await review(stack.reserved)).phase.kind}.`);
}
cli("05-show", ["show", stack.reserved]);
cli("06-events-waived", ["events", "--thread", stack.reserved, "--kind", "review.waived"]);
cli("06-events-review", ["events", "--thread", stack.reserved, "--kind", "review.changed"]);

await open(`/threads/${stack.failing}`);
log(`failing GitHub checks, held: ${JSON.stringify(await seen(), null, 2)}`);
await shot("07-failing-checks-held.png");
if (await press()) {
  await shot("07-failing-checks-0-pressed.png", `The driver pressed Land. The browser's confirmation dialog said: "${asked}" The driver accepted.`);
  await follow(stack.failing, "07-failing-checks");
}
cli("07-failing-checks-show", ["show", stack.failing]);

await open(`/threads/${stack.unchecked}`);
log(`failed .nexus/check, held: ${JSON.stringify(await seen(), null, 2)}`);
await shot("08-failed-check.png");
const unchecked = await held(stack.unchecked);
save("08-failed-check.txt", `The driver asks to waive every hold on the review whose .nexus/check failed.\n${await landFromPage(stack.unchecked, { head: unchecked.head, waive: unchecked.reasons })}\nThe review is still ${(await review(stack.unchecked)).phase.kind}.`);

await open(`/threads/${stack.claude}`);
log(`claude, held: ${JSON.stringify(await seen(), null, 2)}`);
await shot("09-claude-approved.png");
const claude = await held(stack.claude);
save("09-claude-approved.txt", `The driver asks to waive the Claude reviewer's hold anyway.\n${await landFromPage(stack.claude, { head: claude.head, waive: claude.reasons })}`);

const moved = await held(stack.moved);
await fetch("http://127.0.0.1:7489/verify/advance", { method: "POST" });
const headB = (await review(stack.moved)).rounds.at(-1).head;
save("10-moved-head.txt", `PR #46 moved from ${moved.head} to ${headB}, and the reviewer approved it there. The driver sends a waiver confirmed for ${moved.head}:\n${await landFromPage(stack.moved, { head: moved.head, waive: moved.reasons })}\nThe review is still ${(await review(stack.moved)).phase.kind} at ${(await review(stack.moved)).rounds.at(-1).head}.`);

await as(stack.phone);
await open(`/threads/${stack.moved}`);
await shot("11-not-deployer.png", "whois now answers the phone, which the API allows but which is not a deployer.");
save("11-not-deployer.txt", `As the phone:\n${await landFromPage(stack.moved, { head: headB, waive: moved.reasons })}\nThe review is still ${(await review(stack.moved)).phase.kind}.`);
await as(stack.laptop);
await browser.close();
