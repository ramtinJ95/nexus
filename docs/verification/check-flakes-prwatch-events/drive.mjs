// Drives the stack in stack.ts through the Mac CLI, the same steps on main and on the branch, and saves each step's
// command, output and exit code in OUT. A follower of the two PR-watch error kinds runs for the whole drive. A builder
// pushes, GitHub fails for several watch passes and recovers, then a thread is queued after the builder, the builder
// is archived, and only the queued thread's read of its PR fails for several passes before it recovers.
//
//   OUT=... ROOT=<checkout> node docs/verification/check-flakes-prwatch-events/drive.mjs
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env.OUT;
const env = { ...process.env, NEXUS_URL: "http://127.0.0.1:7470", NEXUS_SOCKS: "none" };
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(join(out, "drive.log"), "");

let step = 0;
function nexus(name, args) {
  const r = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: process.env.ROOT, env, encoding: "utf8" });
  const text = `$ nexus ${args.join(" ")}\n${r.stdout}${r.stderr ? `[stderr] ${r.stderr}` : ""}[exit ${r.status}]\n`;
  writeFileSync(join(out, `${String(++step).padStart(2, "0")}-${name}.txt`), text);
  log(text);
  return r;
}
const json = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { cwd: process.env.ROOT, env, encoding: "utf8" }).stdout);
const kinds = ["--kind", "pull-request.error", "--kind", "pull-request.error-cleared"];
function follow(name, args) {
  const child = spawn("node", ["src/cli/nexus.ts", "events", "--follow", "--since", "latest", ...args, "--json"], { cwd: process.env.ROOT, env });
  const lines = [];
  let stderr = "";
  let buffered = "";
  child.stdout.on("data", (d) => {
    buffered += d;
    for (let i; (i = buffered.indexOf("\n")) >= 0; buffered = buffered.slice(i + 1)) lines.push(JSON.parse(buffered.slice(0, i)));
  });
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return { lines, async stop() {
    child.kill("SIGINT");
    const code = await exited;
    writeFileSync(join(out, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
    const text = `$ nexus events --follow --since latest ${args.join(" ")} --json\n${lines.length} events\n${stderr ? `[stderr] ${stderr}` : ""}[exit ${code}]\n`;
    writeFileSync(join(out, `${name}.txt`), text);
    log(text);
  } };
}
async function until(what, ok, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (ok()) { log(`waited: ${what}`); return true; } await sleep(250); }
  log(`gave up waiting after ${ms / 1000} s: ${what}`);
  return false;
}
const github = async (action) => log(`GitHub ${action}: HTTP ${(await fetch(`http://127.0.0.1:7472/${action}`, { method: "POST" })).status}`);
const watchError = (id) => json(["show", id]).prWatch?.error ?? null;

nexus("version", ["--version"]);
const errors = follow("follow-errors", kinds);
await sleep(1_500);
const builder = JSON.parse(nexus("start-builder", ["start", "--project", "nexus", "--title", "Greet by name", "--claude", "push greet-name", "--json"]).stdout).id;
await until("the PR watch linked the PR", () => (json(["show", builder]).pullRequests ?? []).length === 1, 30_000);

await github("fail");
await until("show reports the watch's error", () => watchError(builder) !== null, 15_000);
await sleep(6_000);
nexus("show-failing", ["show", builder]);
await github("heal");
await until("show reports no error", () => watchError(builder) === null, 15_000);

const queued = JSON.parse(nexus("start-after", ["start", "--project", "nexus", "--title", "After greeting", "--claude", "greet", "--after", builder, "--json"]).stdout).id;
nexus("archive-builder", ["archive", builder]);
await github("fail-all");
await until("show reports the archived builder's error", () => watchError(builder) !== null, 15_000);
await sleep(6_000);
nexus("show-settle-failing", ["show", builder]);
await github("heal");
await until("show reports no error for the archived builder", () => watchError(builder) === null, 15_000);
await sleep(4_000);

await errors.stop();
nexus("events-errors", ["events", ...kinds]);
log(`follower, events by kind: ${JSON.stringify(errors.lines.reduce((n, e) => ({ ...n, [e.kind]: (n[e.kind] ?? 0) + 1 }), {}))}`);
log(`the token or transport text in any event: ${errors.lines.some((e) => /verify-token|ETIMEDOUT/.test(JSON.stringify(e)))}`);
writeFileSync(join(out, "threads.json"), JSON.stringify({ builder, queued }, null, 2));
