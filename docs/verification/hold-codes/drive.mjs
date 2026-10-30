// Drives hold-codes/stack.ts over its API and dashboard without a browser, and saves what a hold, a waiver
// and the Land card show now that holds carry codes.
//
//   OUT=<dir> STACK='{...}' node docs/verification/hold-codes/drive.mjs
import { writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";

const stack = JSON.parse(process.env.STACK);
const out = process.env.OUT;
const plain = "http://127.0.0.1:7470";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (name, text) => writeFileSync(join(out, name), `${text}\n`);
const review = async (thread) => (await (await fetch(`${plain}/v1/threads/${thread}`)).json()).review;
const held = async (thread) => {
  for (let i = 0; i < 60; i++) {
    const r = await review(thread);
    if (r.phase.kind === "needs-person") return r;
    await sleep(500);
  }
  throw new Error(`${thread} was never held`);
};
const land = async (thread, body) => {
  const res = await fetch(`${plain}/v1/threads/${thread}/land`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const reply = text === "" ? null : JSON.parse(text);
  return `POST /v1/threads/${thread}/land ${JSON.stringify(body)}\n=> ${res.status} ${JSON.stringify(res.status === 200 ? { phase: reply.phase, waiver: reply.waiver } : reply)}`;
};
/** The thread page as the dashboard serves it, over HTTPS at its address, with the stack's self-signed certificate. */
const page = (thread) => new Promise((resolve, reject) => {
  request({ host: "127.0.0.1", port: 7443, servername: stack.hostname, path: `/threads/${thread}`, headers: { host: `${stack.hostname}:7443` }, rejectUnauthorized: false }, (res) => {
    let body = "";
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve(body));
  }).on("error", reject).end();
});
const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const reserved = await held(stack.reserved);
save("01-held-reserved.json", JSON.stringify({ reasons: reserved.phase.reasons, holds: reserved.phase.holds }, null, 2));
const card = /<ul class="land-reasons">[\s\S]*?<\/ul>/.exec(await page(stack.reserved))?.[0] ?? "no Land card";
save("02-land-card.txt", `${textOf(card)}\ndata-holds: ${/data-holds="([^"]*)"/.exec(await page(stack.reserved))?.[1] ?? "none"}`);

const claude = await held(stack.claude);
save("03-claude-refused.txt", `${JSON.stringify(claude.phase.holds, null, 2)}\n${await land(stack.claude, { head: claude.rounds.at(-1).head, waive: claude.phase.reasons })}`);

// The Land button sends the holds its card marks waivable, as data-holds.
const waivable = JSON.parse(/data-holds="([^"]*)"/.exec(await page(stack.reserved))[1].replace(/&quot;/g, '"'));
save("04-waived.txt", await land(stack.reserved, { head: reserved.rounds.at(-1).head, waive: waivable }));
let landed = await review(stack.reserved);
for (let i = 0; i < 60 && landed.phase.kind !== "landed"; i++) { await sleep(500); landed = await review(stack.reserved); }
const events = await (await fetch(`${plain}/v1/events?thread=${stack.reserved}&kind=review.waived`)).text();
save("05-landed.txt", `phase: ${JSON.stringify(landed.phase)}\nwaiver: ${JSON.stringify(landed.waiver)}\nreview.waived events: ${events.trim()}`);
