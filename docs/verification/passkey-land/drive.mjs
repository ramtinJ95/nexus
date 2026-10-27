// Drives the stack in stack.ts in headless Chromium, through the CLI and through the host command, and saves what it
// saw in OUT. Chromium opens the dashboard at its HTTPS address, trusting the stack's certificate by its key, and holds
// a WebAuthn virtual authenticator over CDP that verifies the person whenever it is asked, as a passkey would after a
// fingerprint. The same driver runs on main and on the branch: where main has no passkey surface, it records what main
// answers instead. A browser's confirmation dialog and the authenticator are not part of a screenshot, so the driver
// adds a dashed yellow box, marked as added by this script, that says what they did.
//
//   OUT=... ROOT=<checkout> STACK='{...}' MODULES=... node docs/verification/passkey-land/drive.mjs
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
const cdp = await page.createCDPSession();
await cdp.send("WebAuthn.enable");
const authenticator = async () => (await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
  protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
} })).authenticatorId;
let device = await authenticator();
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
const host = (name, args, sudo = true) => {
  const argv = [...sudo ? ["-n", process.execPath] : [], "src/control/passkeys-host.ts", stack.config, ...args];
  const run = spawnSync(sudo ? "sudo" : process.execPath, argv, { cwd: process.env.ROOT, encoding: "utf8" });
  save(`${name}.txt`, `$ ${sudo ? "sudo " : ""}node src/control/passkeys-host.ts /etc/nexus/control.json ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`);
  return run.stdout;
};
/**
 * Requests from the open page, as the dashboard's client sends them. A sign step has the person's passkey sign the
 * options the step before got, and "$assertion" in a later body is that assertion, or the one passed in.
 */
const fromPage = (steps, given = null) => page.evaluate(async (steps, given) => {
  const fromB64 = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const toB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const call = async (method, path, body) => {
    const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : JSON.parse(text) };
  };
  const results = [];
  let assertion = given;
  for (const step of steps) {
    if (step.kind === "sign") {
      const options = results.at(-1).reply.body;
      if (results.at(-1).reply.status !== 200) { results.push({ signed: null }); continue; }
      const c = await navigator.credentials.get({ publicKey: { ...options, challenge: fromB64(options.challenge), allowCredentials: options.allowCredentials.map((a) => ({ ...a, id: fromB64(a.id) })) } });
      assertion = { id: c.id, clientDataJSON: toB64(c.response.clientDataJSON), authenticatorData: toB64(c.response.authenticatorData), signature: toB64(c.response.signature) };
      results.push({ signed: JSON.parse(atob(assertion.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/"))), assertion });
    } else {
      const body = step.body === undefined ? undefined : JSON.parse(JSON.stringify(step.body).replace('"$assertion"', JSON.stringify(assertion)));
      results.push({ request: `${step.method} ${step.path}`, body: body ?? null, reply: await call(step.method, step.path, body) });
    }
  }
  return results;
}, steps, given);
const transcript = (results) => results.map((r) => r.signed === null ? "(there is no challenge to sign)" : r.signed !== undefined
  ? `(the virtual authenticator verified the person and signed the challenge ${r.signed.challenge} for ${r.signed.origin})`
  : `${r.request} ${JSON.stringify(r.body, (k, v) => k === "assertion" && v !== null ? `<assertion from credential ${v.id.slice(0, 8)}>` : v)}\n=> ${r.reply.status} ${JSON.stringify(r.reply.body)}`).join("\n");

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
      if (["landed", "needs-person", "approved"].includes(last)) return r;
    }
    await sleep(250);
  }
  log(`${prefix}: the review did not end within a minute`);
}

await as(stack.laptop);
const status = await open("/passkeys");
log(`GET /passkeys answered ${status}`);
await shot("01-passkeys-page.png");

if (await page.$("#enrol") === null) {
  save("02-enrol-without-code.txt", transcript(await fromPage([{ method: "POST", path: "/v1/passkeys/enrolment", body: { code: "ABCD-EFGH-JKLM-NPQR-STUV" } }])));
} else {
  await page.type("#enrol input[name=code]", "ABCD-EFGH-JKLM-NPQR-STUV");
  await page.type("#enrol input[name=name]", "Agent's software key");
  await page.click("#enrol-submit");
  await sleep(1500);
  log(`enrolment with a made-up code: ${JSON.stringify(await seen())}`);
  await shot("02-enrol-without-code.png", "The driver typed a code the host never made and pressed Enrol.");
  save("02-enrol-without-code.txt", transcript(await fromPage([{ method: "POST", path: "/v1/passkeys/enrolment", body: { code: "ABCD-EFGH-JKLM-NPQR-STUV" } }])));
}
host("03-host-code-not-root", ["code"], false);
const printed = host("04-host-code", ["code"]);
const url = /^https:\/\/\S+/m.exec(printed)?.[0];
if (url === undefined) log("the host command printed no address, so nothing enrols");
else {
  await page.goto(url.replace(`https://${stack.hostname}:7443`, base));
  await sleep(600);
  await page.type("#enrol input[name=name]", "MacBook Touch ID");
  await shot("05-enrol-0-with-code.png", "The driver opened the address the host command printed, which filled in its code, and typed a name.");
  await page.click("#enrol-submit");
  await sleep(2000);
  log(`enrolled: ${JSON.stringify(await seen())}`);
  await shot("05-enrol-1-enrolled.png", "The driver pressed Enrol, and the virtual authenticator verified the person and made the passkey.");
  const code = new URL(url).searchParams.get("code");
  await page.type("#enrol input[name=code]", code);
  await page.type("#enrol input[name=name]", "Second try");
  await page.click("#enrol-submit");
  await sleep(1500);
  await shot("06-code-used-twice.png", `The driver typed the same code, ${code}, again and pressed Enrol.`);
  save("06-code-used-twice.txt", transcript(await fromPage([{ method: "POST", path: "/v1/passkeys/enrolment", body: { code } }])));
  host("07-host-list", ["list"]);
}

await open(`/threads/${stack.reserved}`);
log(`reserved, held: ${JSON.stringify(await seen(), null, 2)}`);
await shot("08-held-reserved.png");
cli("09-land-0-nexus-land", ["land", stack.reserved]);
await follow(stack.reserved, "09-land");
cli("09-land-show", ["show", stack.reserved]);

await open(`/threads/${stack.reserved}`);
const waive = await page.$('#land[data-action="waive"]:not([disabled])');
if (waive === null) {
  log("the page has no passkey Land button");
  await shot("10-passkey-0-no-button.png", "This page has no button that lands the review past its hold. The policy holds every landing of this commit again.");
} else {
  await waive.click();
  await sleep(1200);
  await shot("10-passkey-0-pressed.png", `The browser's confirmation dialog said: "${asked}" The driver accepted, and the virtual authenticator verified the person and signed.`);
  await follow(stack.reserved, "10-passkey");
  log(`the page sent: ${landBody}`);
}
cli("11-show-landed", ["show", stack.reserved]);
cli("12-events-waived", ["events", "--thread", stack.reserved, "--kind", "review.waived"]);
cli("12-events-review", ["events", "--thread", stack.reserved, "--kind", "review.changed"]);

const reserved = await review(stack.reserved);
if (landBody !== null) {
  save("13-replay.txt", `The driver sends the page's own land request again, assertion and all.\n${transcript(await fromPage([{ method: "POST", path: `/v1/threads/${stack.reserved}/land`, body: JSON.parse(landBody) }]))}\nThe review is still ${(await review(stack.reserved)).phase.kind}.`);
} else {
  const head = reserved.rounds.at(-1).head;
  save("13-replay.txt", `There is no passkey landing to replay. A land request carrying a waiver:\n${transcript(await fromPage([{ method: "POST", path: `/v1/threads/${stack.reserved}/land`, body: { head, waiver: { holds: reserved.phase.reasons ?? [], assertion: { id: "x", clientDataJSON: "x", authenticatorData: "x", signature: "x" } } } }]))}`);
}

await open(`/threads/${stack.claude}`);
log(`claude, held: ${JSON.stringify(await seen(), null, 2)}`);
await shot("14-not-waivable.png");
const claude = await review(stack.claude);
save("14-not-waivable.txt", `The driver asks to waive the Claude reviewer's hold anyway.\n${transcript(await fromPage([{ method: "POST", path: `/v1/threads/${stack.claude}/land/challenge`, body: { head: claude.rounds.at(-1).head, holds: claude.phase.reasons } }]))}`);

const moved = await review(stack.moved);
const headA = moved.rounds.at(-1).head;
await open(`/threads/${stack.moved}`);
await shot("15-other-commit-0-held.png");
const atA = await fromPage([{ method: "POST", path: `/v1/threads/${stack.moved}/land/challenge`, body: { head: headA, holds: moved.phase.reasons } }, { kind: "sign" }]);
await fetch("http://127.0.0.1:7489/verify/advance", { method: "POST" });
const headB = (await review(stack.moved)).rounds.at(-1).head;
await open(`/threads/${stack.moved}`);
await shot("15-other-commit-1-moved.png", `The builder pushed again and the reviewer approved ${headB.slice(0, 12)}. The driver holds a passkey assertion signed for ${headA.slice(0, 12)}.`);
const toB = await fromPage([{ method: "POST", path: `/v1/threads/${stack.moved}/land`, body: { head: headB, waiver: { holds: moved.phase.reasons, assertion: "$assertion" } } }], atA[1].assertion ?? null);
save("15-other-commit.txt", `${transcript(atA)}\nPR #46 moved to ${headB}, and the reviewer approved it there. The driver sends the assertion for ${headA} to land ${headB}:\n${transcript(toB)}\nThe review is still ${(await review(stack.moved)).phase.kind} at ${(await review(stack.moved)).rounds.at(-1).head}.`);

const signedB = await fromPage([{ method: "POST", path: `/v1/threads/${stack.moved}/land/challenge`, body: { head: headB, holds: moved.phase.reasons } }, { kind: "sign" }]);
await as(stack.phone);
await open(`/threads/${stack.moved}`);
await shot("16-not-deployer.png", "whois now answers the phone, which the API allows but which is not a deployer.");
const asPhone = await fromPage([
  { method: "POST", path: `/v1/threads/${stack.moved}/land/challenge`, body: { head: headB, holds: moved.phase.reasons } },
  { method: "POST", path: `/v1/threads/${stack.moved}/land`, body: { head: headB, waiver: { holds: moved.phase.reasons, assertion: "$assertion" } } },
], signedB[1].assertion ?? null);
save("16-not-deployer.txt", `As the laptop, a deployer, the driver had the passkey sign a waiver for ${headB}:\n${transcript(signedB)}\nThen, as the phone:\n${transcript(asPhone)}\nThe review is still ${(await review(stack.moved)).phase.kind}.`);
await as(stack.laptop);

if (url !== undefined) {
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: device });
  device = await authenticator();
  const second = /^https:\/\/\S+/m.exec(host("17-host-code-again", ["code"]))[0];
  await page.goto(second);
  await sleep(600);
  await page.type("#enrol input[name=name]", "Spare YubiKey");
  await page.click("#enrol-submit");
  await sleep(2000);
  await shot("17-two-passkeys.png", "The driver swapped the virtual authenticator for another one, as a second security key, and enrolled it with a new code.");
  const revoke = await page.evaluateHandle(() => [...document.querySelectorAll('[data-action="revoke-passkey"]')].find((b) => b.closest("tr").textContent.includes("MacBook Touch ID")));
  await revoke.click();
  await sleep(2000);
  await shot("18-revoked-from-dashboard.png", `The driver pressed Revoke on MacBook Touch ID. The dialog said: "${asked}" The spare key's passkey confirmed it.`);
  save("18-revoke-without-passkey.txt", transcript(await fromPage([{ method: "POST", path: `/v1/passkeys/${(await (await fetch(`${plain}/v1/passkeys`)).json())[0].id}/revoke`, body: {} }])));
  const spare = /^(pk-[0-9a-f]{8})/m.exec(host("19-host-list", ["list"]))?.[1];
  host("20-host-revoke", ["revoke", spare]);
  host("21-host-list-empty", ["list"]);
  cli("22-events-passkeys", ["events", "--kind", "passkey.enrolled", "--kind", "passkey.revoked"]);
}
await browser.close();
