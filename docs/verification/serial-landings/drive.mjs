// Drives the stack in stack.ts through the API and the CLI, and saves what it saw in OUT: each review's phase as it
// changes, `nexus show` of each builder whenever its review's line changes, and the review.changed events once all
// three reviews have ended or 40 s have passed. The same driver runs on main and on the branch.
//
//   OUT=... ROOT=<checkout> STACK='{...}' node docs/verification/serial-landings/drive.mjs
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env.OUT;
const stack = JSON.parse(process.env.STACK);
const plain = "http://127.0.0.1:7470";
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${new Date().toISOString()} ${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const review = async (builder) => (await (await fetch(`${plain}/v1/threads/${builder}`)).json()).review;
const nexus = (args) => {
  const run = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env: { ...process.env, NEXUS_URL: plain, NEXUS_SOCKS: "none" }, encoding: "utf8" });
  return `$ nexus ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`;
};

writeFileSync(join(out, "drive.log"), "");
const seen = new Map();
const ended = ["landed", "needs-person"];
for (const deadline = Date.now() + 40_000; Date.now() < deadline; await sleep(300)) {
  let done = true;
  for (const [pr, builder] of Object.entries(stack.builders)) {
    const r = await review(builder);
    const line = `#${pr} ${r.phase.kind}${r.phase.waiting ? `, waiting: ${r.phase.waiting}` : ""}${r.phase.previous !== undefined ? `, previous ${r.phase.previous?.slice(0, 12) ?? "none"}` : ""}${r.phase.reasons ? `: ${r.phase.reasons.join(" ")}` : ""}`;
    if (seen.get(pr) !== line) {
      seen.set(pr, line);
      log(line);
      appendFileSync(join(out, `show-${pr}.txt`), nexus(["show", builder]).split("\n").filter((l) => /^\$|review rv-|^  |exit/.test(l)).join("\n") + "\n\n");
    }
    done &&= ended.includes(r.phase.kind);
  }
  if (done) break;
}
writeFileSync(join(out, "events-review.txt"), Object.values(stack.builders).map((b) => nexus(["events", "--thread", b, "--kind", "review.changed"])).join("\n"));
