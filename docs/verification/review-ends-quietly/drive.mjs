// Drives four reviews of one PR through the Mac CLI against ../review-flow/stack.ts, run with ALWAYS_CHANGES=1 and a
// slow reviewer: one whose rounds run out, one whose reviewer the person archives, one whose PR the person closes, and
// one whose PR the person merges. Saves each step's command, output and exit code.
//
//   SCRIPTED_BUILDER=1 ALWAYS_CHANGES=1 REVIEWER_DELAY_MS=40000 EVIDENCE=<dir> node docs/verification/review-flow/stack.ts
//   EVIDENCE=<dir> node docs/verification/review-ends-quietly/drive.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const evidence = process.env.EVIDENCE ?? "/tmp/nexus-review-verify/evidence";
mkdirSync(evidence, { recursive: true });
const env = { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" };
let step = 0;
function nexus(name, args) {
  const result = spawnSync("node", ["src/cli/nexus.ts", ...args], { env, encoding: "utf8" });
  const file = `${String(++step).padStart(2, "0")}-${name}.txt`;
  writeFileSync(join(evidence, file), `$ nexus ${args.join(" ")}\n${result.stdout}${result.stderr ? `--- stderr\n${result.stderr}` : ""}--- exit ${result.status}\n`);
  return result;
}
const json = (name, args) => JSON.parse(nexus(name, [...args, "--json"]).stdout);
const quiet = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { env, encoding: "utf8" }).stdout);
async function until(what, minutes, check) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2_000);
  }
}
const note = (line) => { console.log(line); writeFileSync(join(evidence, "timeline.txt"), `${new Date().toISOString()} ${line}\n`, { flag: "a" }); };
const person = (action) => fetch(`http://127.0.0.1:7489/verify/${action}`, { method: "POST" });

const task = "Add a shell script greet.sh at the repository root that prints hello. Commit it on a new branch named feature and push it with `git push -u origin feature`. Do not open a pull request yourself: Nexus opens it for this verification. Keep it minimal, with no subagents, tests or docs. After the push, end your turn. If an automated Nexus review message arrives later, answer it as it asks, but do not push again.";
const builder = process.env.BUILDER ? { id: process.env.BUILDER } : json("start", ["start", "--project", "nexus", "--title", "Greet script", "--claude", task]);
note(`started builder ${builder.id}`);
await until("the builder's PR to be linked", 20, () => quiet(["show", builder.id]).pullRequests?.find((p) => p.state === "open"));
await until("the builder's first turn to end", 20, () => quiet(["show", builder.id]).attention !== "working");
note("PR watch linked PR #1 and the builder's turn ended");

async function review(name, ...args) {
  const r = json(name, ["review", builder.id, ...args]);
  note(`review ${r.id} started with reviewer ${r.reviewer}`);
  return r;
}
async function endsAs(r, kinds, minutes) {
  let seen = "";
  const ended = await until(`review ${r.id} to end`, minutes, () => {
    const now = quiet(["show", builder.id]).review;
    const line = `${now.phase.kind} round ${now.rounds.length}`;
    if (line !== seen) { note(`review ${now.id}: ${line}`); seen = line; }
    return kinds.includes(now.phase.kind) ? now : null;
  });
  return ended;
}

const ranOut = await review("review-ran-out", "--rounds", "1");
await endsAs(ranOut, ["needs-person"], 10);
await until("the label", 1, () => quiet(["show", builder.id]).review.phase.label?.state === "added");
nexus("show-ran-out", ["show", builder.id]);

const archived = await review("review-archived");
await sleep(5_000);
nexus("archive-reviewer", ["archive", archived.reviewer]);
note(`the person archived reviewer ${archived.reviewer}`);
await endsAs(archived, ["cancelled", "needs-person"], 2);
nexus("show-cancelled", ["show", builder.id]);

const closed = await review("review-closed");
await sleep(5_000);
await person("close");
note("the person closed PR #1");
await endsAs(closed, ["closed", "needs-person"], 2);
nexus("show-closed", ["show", builder.id]);

await person("reopen");
note("the person reopened PR #1");
await until("the PR watch to relink the open PR", 2, () => quiet(["show", builder.id]).pullRequests?.find((p) => p.state === "open"));
const merged = await review("review-merged");
await sleep(5_000);
await person("merge");
note("the person merged PR #1 and deleted feature");
await endsAs(merged, ["merged", "needs-person"], 2);
await sleep(45_000);
note("waited past the reviewer's late answer");
nexus("show-merged", ["show", builder.id]);
json("show-merged-json", ["show", builder.id]);
nexus("events", ["events", "--thread", builder.id, "--kind", "review.changed", "--kind", "attention.changed"]);
nexus("threads", ["threads", "--all"]);
