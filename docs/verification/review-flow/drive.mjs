// Drives the review flow through the Mac CLI against stack.ts, and saves each step's command, output and exit code.
//
//   EVIDENCE=docs/verification/review-flow/run node docs/verification/review-flow/drive.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const evidence = process.env.EVIDENCE ?? "/tmp/nexus-review-verify/evidence";
mkdirSync(evidence, { recursive: true });
let step = 0;
function nexus(name, args) {
  const result = spawnSync("node", ["src/cli/nexus.ts", ...args], { env: { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" }, encoding: "utf8" });
  const file = `${String(++step).padStart(2, "0")}-${name}.txt`;
  writeFileSync(join(evidence, file), `$ nexus ${args.join(" ")}\n${result.stdout}${result.stderr ? `--- stderr\n${result.stderr}` : ""}--- exit ${result.status}\n`);
  return result;
}
const json = (name, args) => JSON.parse(nexus(name, [...args, "--json"]).stdout);
const quiet = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { env: { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" }, encoding: "utf8" }).stdout);
async function until(what, minutes, check) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(3_000);
  }
}
const note = (line) => { console.log(line); writeFileSync(join(evidence, "timeline.txt"), `${new Date().toISOString()} ${line}\n`, { flag: "a" }); };

const task = process.env.TASK ?? "Add a shell script greet.sh at the repository root that prints hello. Commit it on a new branch named feature and push it with `git push -u origin feature`. Do not open a pull request yourself: Nexus opens it for this verification. Keep it minimal, with no subagents, tests or docs.";
// BUILDER resumes a run whose builder already started.
const builder = process.env.BUILDER ? { id: process.env.BUILDER } : json("start", ["start", "--project", "nexus", "--title", "Greet script", "--claude", task]);
note(`${process.env.BUILDER ? "resumed" : "started"} builder ${builder.id}`);
const linked = await until("the builder's PR to be linked", 20, () => quiet(["show", builder.id]).pullRequests?.find((p) => p.state === "open"));
note(`PR watch linked PR #${linked.number}`);
nexus("show-linked", ["show", builder.id]);

await until("the builder's first turn to end", 20, () => quiet(["show", builder.id]).attention !== "working");
if (!process.env.BUILDER) await fetch("http://127.0.0.1:7489/verify/comment", { method: "POST", body: "Thanks for the script.\r\nNo change is needed for this comment: it only checks that PR feedback reaches you." });
note("the owner commented on the PR");
await until("the PR watch to type the comment into Claude", 5, () => existsSync(join(evidence, "typed.log")) && readFileSync(join(evidence, "typed.log"), "utf8").includes("[Nexus PR watch"));
note("the PR watch typed the comment into the Claude builder");
await until("Claude to take the comment", 10, () => JSON.stringify(quiet(["conversation", builder.id]).entries).includes("No change is needed for this comment"));
await until("the comment's turn to end", 20, () => quiet(["show", builder.id]).attention !== "working");
nexus("conversation-after-comment", ["conversation", builder.id]);

const review = json("review", ["review", builder.id, "--land"]);
note(`review ${review.id} started with reviewer ${review.reviewer} on ${review.models.reviewer}`);
let seen = "";
const ended = await until("the review to end", 45, () => {
  const r = quiet(["show", builder.id]).review;
  const now = `${r.phase.kind} round ${r.rounds.length}`;
  if (now !== seen) { note(`review ${r.id}: ${now}`); seen = now; }
  return ["landed", "needs-person", "approved"].includes(r.phase.kind) ? r : null;
});
note(`review ended ${ended.phase.kind}`);
nexus("show-ended", ["show", builder.id]);
json("show-ended-json", ["show", builder.id]);
nexus("events-review", ["events", "--thread", builder.id, "--kind", "review.changed", "--kind", "attention.changed", "--kind", "pull-request.feedback"]);
nexus("events-release", ["events", "--kind", "release.changed"]);
nexus("conversation-builder", ["conversation", builder.id]);
nexus("conversation-reviewer", ["conversation", ended.reviewer]);
nexus("show-reviewer", ["show", ended.reviewer]);
nexus("threads", ["threads"]);
nexus("release", ["release"]);
nexus("land-again", ["land", builder.id]);
