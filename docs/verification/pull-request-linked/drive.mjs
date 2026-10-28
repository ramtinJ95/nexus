// Drives the stack in stack.ts through the Mac CLI, the same steps on main and on the branch, and saves each step's
// command, output and exit code in OUT. Two followers run for the whole drive: one asks for pull-request.linked only,
// the other for every kind. Two builders push, then the person closes and reopens the first PR, and the drive waits
// several more PR watch passes, so a follower should hear of each PR once.
//
//   OUT=... ROOT=<checkout> node docs/verification/pull-request-linked/drive.mjs
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
function follow(name, args) {
  const child = spawn("node", ["src/cli/nexus.ts", "events", "--follow", "--since", "latest", ...args, "--json"], { cwd: process.env.ROOT, env });
  const lines = [];
  let stderr = "";
  let buffered = "";
  child.stdout.on("data", (d) => {
    buffered += d;
    for (let i; (i = buffered.indexOf("\n")) >= 0; buffered = buffered.slice(i + 1)) lines.push({ at: Date.now(), event: JSON.parse(buffered.slice(0, i)) });
  });
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return { lines, async stop() {
    child.kill("SIGINT");
    const code = await exited;
    writeFileSync(join(out, `${name}.jsonl`), lines.map((l) => JSON.stringify(l.event)).join("\n") + (lines.length ? "\n" : ""));
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

nexus("version", ["--version"]);
const linked = follow("follow-linked", ["--kind", "pull-request.linked"]);
const all = follow("follow-all", []);
await sleep(1_500);
const started = {};
for (const [key, title, prompt] of [["byName", "Greet by name", "push greet-name"], ["loudly", "Greet loudly", "push greet-loud"]]) {
  started[key] = JSON.parse(nexus(`start-${key}`, ["start", "--project", "nexus", "--title", title, "--claude", prompt, "--json"]).stdout).id;
}
const linkedAt = {};
await until("the PR watch linked both PRs", () => Object.entries(started).every(([key, id]) => {
  if ((json(["show", id]).pullRequests ?? []).length !== 1) return false;
  linkedAt[key] ??= Date.now();
  return true;
}), 30_000);
for (const action of ["close", "reopen"]) {
  const r = await fetch(`http://127.0.0.1:7472/${action}/1`, { method: "POST" });
  log(`${action} PR #1 on GitHub: HTTP ${r.status}`);
  await until(`show reports PR #1 ${action === "close" ? "closed" : "open"}`, () => json(["show", started.byName]).pullRequests?.[0]?.state === (action === "close" ? "closed" : "open"), 15_000);
}
await sleep(8_000);
await linked.stop();
await all.stop();
for (const [key, id] of Object.entries(started)) {
  const heard = linked.lines.find((l) => l.event.thread === id);
  log(`${key} (${id}): show listed its PR by ${new Date(linkedAt[key]).toISOString()}; the pull-request.linked follower ${heard ? `got the event written at ${new Date(heard.event.time).toISOString()} ${heard.at - heard.event.time} ms later` : "never heard of it"}`);
}
for (const [key, id] of Object.entries(started)) nexus(`show-${key}`, ["show", id]);
nexus("events-linked", ["events", "--kind", "pull-request.linked"]);
nexus("events-all", ["events"]);
const kinds = {};
for (const l of all.lines) kinds[l.event.kind] = (kinds[l.event.kind] ?? 0) + 1;
log(`every-kind follower, events by kind: ${JSON.stringify(kinds)}`);
log(`pull-request.linked follower, per thread: ${JSON.stringify(Object.fromEntries(Object.entries(started).map(([key, id]) => [key, linked.lines.filter((l) => l.event.thread === id).length])))}`);
writeFileSync(join(out, "threads.json"), JSON.stringify(started, null, 2));
