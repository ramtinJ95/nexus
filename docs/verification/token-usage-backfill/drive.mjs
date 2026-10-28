// Drives the backfill captures in one checkout, ROOT, and saves what it saw in OUT. It runs probe.ts and control.ts as
// their own processes, so it can restart the control plane alone, as a deploy does. The same driver runs on main and on
// the branch, and records whatever each one shows and answers.
//
//   ROOT=<checkout> OUT=<dir> WORK=<empty dir> SOCKETS=<short dir> MODULES=<node_modules with @sparticuz/chromium and
//   puppeteer-core> node drive.mjs
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { ROOT: root, OUT: out, WORK: work, SOCKETS: sockets } = process.env;
const require = createRequire(join(process.env.MODULES, "x.js"));
const chromiumModule = require("@sparticuz/chromium");
const chromium = chromiumModule.default ?? chromiumModule;
const puppeteer = require("puppeteer-core");
const base = "http://127.0.0.1:7470";
const fixtures = join(here, "../../../src/fixtures");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "drive.log"), "");
const log = (line) => { console.log(line); appendFileSync(join(out, "drive.log"), `${line}\n`); };
const save = (name, text) => { writeFileSync(join(out, name), text); log(`--- ${name}\n${text}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, WORK: work, EVIDENCE: out, SOCKETS: sockets, NEXUS_URL: base, NEXUS_SOCKS: "none" };

function server(name, file, n) {
  const output = join(out, `${name}-${n}.out`);
  writeFileSync(output, "");
  const child = spawn("node", [join("docs/verification/token-usage-backfill", file)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => appendFileSync(output, d));
  child.stderr.on("data", (d) => appendFileSync(output, d));
  return child;
}
async function until(what, check, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
const stop = (child) => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
const get = async (path) => { const res = await fetch(`${base}${path}`); return res.ok ? res.json() : `GET ${path} answered ${res.status}`; };
let controls = 0;
async function startControl() {
  const child = server("control", "control.ts", ++controls);
  await until("the control plane", async () => (await fetch(`${base}/v1/nodes`)).ok);
  await until("verify-node online", async () => (await get("/v1/nodes")).some?.((n) => n.state === "online"));
  return child;
}
const cli = (name, args) => {
  const run = spawnSync("node", ["src/cli/nexus.ts", ...args], { cwd: root, env, encoding: "utf8" });
  save(`${name}.txt`, `$ nexus ${args.join(" ")}\n${run.stdout}${run.stderr}exit ${run.status}\n`);
  return run;
};
const json = (args) => JSON.parse(spawnSync("node", ["src/cli/nexus.ts", ...args, "--json"], { cwd: root, env, encoding: "utf8" }).stdout);

const iso = (day, i) => new Date(Date.UTC(2026, 8, day, 9, 0, i)).toISOString();
const claudeLines = (thread, n, [input, output, cacheWrite, cacheRead], day) => Array.from({ length: n }, (_, i) => {
  const record = { type: "assistant", timestamp: iso(day + (i % 5), i % 60), message: { id: `msg_${thread}_${i}`, model: "claude-opus-4-5", usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead } } };
  return `${JSON.stringify(record)}\n${JSON.stringify({ ...record, uuid: `block-2-${i}` })}\n`;
}).join("");
const piLines = (thread, n, [input, output, cacheWrite, cacheRead], day) => Array.from({ length: n }, (_, i) => `${JSON.stringify({
  type: "message", id: `e${i}`, timestamp: iso(day, i % 60),
  message: { role: "assistant", model: "gpt-6-astra", responseId: `resp_${thread}_${i}`, timestamp: Date.parse(iso(day, i % 60)), usage: { input, output, cacheWrite, cacheRead } },
})}\n`).join("");
const claudeFile = (home, name = "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30.jsonl") => join(home, ".claude/projects/-home-user-workspace-repo", name);
const piFile = (home) => join(home, ".pi/agent/sessions/--home-user-workspace-repo--/2026-09-03T10-00-00-000Z_01a17f87-262c-71b1-937e-ee435ee114b8.jsonl");
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const sum = (...parts) => parts.reduce((a, p) => ({ calls: a.calls + p.calls, input: a.input + p.input, output: a.output + p.output, cacheWrite: a.cacheWrite + p.cacheWrite, cacheRead: a.cacheRead + p.cacheRead }), { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const calls = (n, [input, output, cacheWrite, cacheRead]) => ({ calls: n, input: n * input, output: n * output, cacheWrite: n * cacheWrite, cacheRead: n * cacheRead });
const withTotal = (t) => ({ ...t, total: t.input + t.output + t.cacheWrite + t.cacheRead });

// Each thread's history, stated here rather than read from the code under test. claude-transcript.jsonl and
// pi-session.jsonl are the real fixtures that docs/verification/token-usage/README.md sums by hand.
const realClaude = { calls: 9, input: 20, output: 1523, cacheWrite: 37665, cacheRead: 293246 };
const realPi = { calls: 2, input: 1927, output: 10, cacheWrite: 0, cacheRead: 1536 };
const history = {
  live: { title: "Counted live before archive", spent: realClaude },
  big: { title: "Long Claude history", spent: sum(calls(6000, [3, 50, 200, 1000]), calls(10, [5, 20, 0, 400])) },
  pi: { title: "Harness review in pi", spent: realPi },
  both: { title: "Claude and pi, held at boot", spent: sum(calls(25, [10, 100, 500, 2000]), calls(7, [300, 40, 0, 1200])) },
  noboot: { title: "Pylon fails to boot", spent: calls(4, [1, 1, 1, 1]) },
  noread: { title: "Transcripts fail to read", spent: calls(3, [2, 2, 2, 2]) },
  deleted: { title: "Deleted before the backfill", spent: calls(5, [7, 7, 7, 7]) },
};
const before = withTotal(history.live.spent);
const recoverable = withTotal(sum(history.live.spent, history.big.spent, history.pi.spent, history.both.spent));
save("01-hand-sum.txt", [
  ...Object.entries(history).map(([k, h]) => `${k.padEnd(8)} ${h.title.padEnd(30)} ${JSON.stringify(h.spent)}`),
  "", `counted live before the backfill (live): ${JSON.stringify(before)}`,
  `after a backfill (live, big, pi, both; noboot and noread are skipped, deleted has no pylon): ${JSON.stringify(recoverable)}`, "",
].join("\n"));

const ordered = (t) => typeof t === "string" ? t : { calls: t.calls, input: t.input, output: t.output, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, total: t.total };
const apiTotal = async () => { const r = await get("/v1/usage?since=all&by=kind"); return typeof r === "string" ? r : ordered(r.total); };
const compare = (what, seen, expected) => `${what}: ${JSON.stringify(seen)}\nexpected:  ${JSON.stringify(expected)}\n${JSON.stringify(seen) === JSON.stringify(expected) ? "MATCH" : "DIFFERENT"}\n`;
const threadFacts = async () => Object.fromEntries((await get("/v1/threads")).filter((t) => ids[t.title] !== undefined && t.status !== "deleted").map((t) => [ids[t.title], {
  status: t.status, attention: t.attention, desired: t.desired, actual: t.pylon.actualState, failed: t.pylon.failed, lastHumanActivityAt: t.lastHumanActivityAt, seenAt: t.seenAt, lastReplyAt: t.lastReplyAt,
}]));
const sessionsOf = async (key) => { const d = await get(`/v1/threads/${threads[key]}`); return d.sessions?.map((s) => `${s.harness} ${s.state}`).join(", ") ?? JSON.stringify(d).slice(0, 200); };
const backfillState = async () => { const r = await get("/v1/usage/backfill"); return typeof r === "string" ? r : r.backfill; };

const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 1100 } });
const page = await browser.newPage();
async function shot(name, path = "/usage?period=all") {
  const res = await page.goto(`${base}${path}`);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  const note = await page.$eval("#usage-backfill", (e) => `${e.getAttribute("data-backfill-state")}: ${e.innerText}`).catch(() => "no #usage-backfill on the page");
  log(`--- ${name}.png: HTTP ${res.status()}, ${note.replace(/\s+/g, " ")}`);
}

const probe = server("probe", "probe.ts", 1);
await until("the probe", async () => readFileSync(join(out, "probe-1.out"), "utf8").includes('"probe"'));
let control = await startControl();
const node = (await get("/v1/nodes"))[0];
cli("00-project", ["project", "add", "nexus", "--scratch", "--node", "verify-node", "--cpus", "1", "--memory", "1", "--disk", "1"]);
const threads = {};
const ids = {};
for (const [key, h] of Object.entries(history)) {
  threads[key] = json(["start", "--project", "nexus", "--title", h.title]).id;
  ids[h.title] = key;
}
const homeOf = (key) => join(work, "pylons", `pylon-${threads[key]}`, "home");
const pylonDir = (key) => join(work, "pylons", `pylon-${threads[key]}`);
await until("every pylon running", async () => (await get("/v1/threads")).every((t) => t.pylon.actualState === "running"));
copyFileSync(join(fixtures, "claude-transcript.jsonl"), (mkdirSync(dirname(claudeFile(homeOf("live"))), { recursive: true }), claudeFile(homeOf("live"))));
log("wrote the live thread's transcript into its running pylon, and restarted the control plane, whose start reads every running pylon");
await stop(control);
control = await startControl();
await until("the live thread counted", async () => (await apiTotal()).calls === before.calls, 30_000).catch(() => log("the live thread's calls were not counted"));
for (const key of Object.keys(history)) cli(`00-archive-${key}`, ["archive", threads[key]]);
cli("00-delete", ["delete", threads.deleted]);
await until("every archived pylon paused", async () => (await get("/v1/threads")).filter((t) => t.status !== "deleted").every((t) => t.pylon.actualState === "paused"));

// What the archived pylons' disks held from before counting started.
put(claudeFile(homeOf("big")), claudeLines("big", 6000, [3, 50, 200, 1000], 1));
put(claudeFile(homeOf("big"), "6f1c2a9e-3b7d-4e05-8c21-9d4b7a1e5f30/subagents/agent-a1.jsonl"), claudeLines("big-sub", 10, [5, 20, 0, 400], 2));
copyFileSync(join(fixtures, "pi-session.jsonl"), (mkdirSync(dirname(piFile(homeOf("pi"))), { recursive: true }), piFile(homeOf("pi"))));
put(claudeFile(homeOf("both")), claudeLines("both", 25, [10, 100, 500, 2000], 3));
put(piFile(homeOf("both")), piLines("both", 7, [300, 40, 0, 1200], 4));
put(claudeFile(homeOf("noboot")), claudeLines("noboot", 4, [1, 1, 1, 1], 5));
writeFileSync(join(pylonDir("noboot"), "fail-boot"), "pylon-vm: the VM did not boot: gondolin exited 1 before the guest answered\n");
put(claudeFile(homeOf("noread")), claudeLines("noread", 3, [2, 2, 2, 2], 6));
writeFileSync(join(pylonDir("noread"), "fail-read"), "");
writeFileSync(join(pylonDir("both"), "hold-boot"), "");
log(`wrote the archived pylons' histories; ${Object.entries(threads).map(([k, id]) => `${k}=${id}`).join(" ")}`);

const factsBefore = await threadFacts();
save("02-threads-before.json", `${JSON.stringify(factsBefore, null, 2)}\n`);
save("02-sessions-before.txt", `${(await Promise.all(Object.keys(history).filter((k) => k !== "deleted").map(async (k) => `${k}: ${await sessionsOf(k)}`))).join("\n")}\n`);
save("03-api-total-before.txt", compare("GET /v1/usage total before the backfill", await apiTotal(), ordered(before)));
cli("03-usage-before", ["usage", "--since", "all", "--by", "kind"]);
await shot("03-usage-before");

cli("04-dry-run", ["usage", "backfill", "--dry-run"]);
const roomy = Math.floor(node.capacity.memoryGiB);
cli("05-project-big", ["project", "add", "big", "--scratch", "--node", "verify-node", "--cpus", "1", "--memory", String(roomy), "--disk", "1"]);
const startedAt = readFileSync(join(out, "pylons.log"), "utf8").length;
const hasBackfill = cli("05-start", ["usage", "backfill"]).status === 0;
await sleep(5_000);
save("05-waiting.txt", `after 5 s with project big asking ${roomy} GiB of the node's ${node.capacity.memoryGiB.toFixed(1)} GiB:\n${JSON.stringify(await backfillState(), null, 2)}\n${readFileSync(join(out, "pylons.log"), "utf8").includes("without relaunching") ? "a pylon was woken" : "no pylon was woken"}\n`);
cli("05-project-big-smaller", ["project", "edit", "big", "--memory", "1"]);

if (hasBackfill) await until("the held pylon booting", async () => (await backfillState())?.current?.thread === threads.both, 120_000).catch((e) => log(String(e)));
await sleep(1_000);
cli("06-usage-running", ["usage", "--since", "all", "--by", "kind"]);
await shot("06-usage-running");
const mid = await backfillState();
save("07-restart.txt", [
  `before the restart: ${JSON.stringify(mid)}`,
  `total: ${JSON.stringify(await apiTotal())}`,
].join("\n") + "\n");
await stop(control);
log("stopped the control plane while the probe holds the boot of the thread both");
control = await startControl();
appendFileSync(join(out, "07-restart.txt"), `after the restart: ${JSON.stringify(await backfillState())}\ntotal: ${JSON.stringify(await apiTotal())}\n`);
rmSync(join(pylonDir("both"), "hold-boot"));
log("released the held boot");
if (hasBackfill) await until("the backfill done", async () => (await backfillState())?.state === "done", 180_000).catch((e) => log(String(e)));
await until("every pylon paused again", async () => (await get("/v1/threads")).filter((t) => t.status !== "deleted").every((t) => t.pylon.actualState === "paused"), 60_000).catch((e) => log(String(e)));

save("08-api-total-after.txt", compare("GET /v1/usage total after the backfill", await apiTotal(), ordered(recoverable)));
cli("08-usage-after", ["usage", "--since", "all", "--by", "kind"]);
cli("08-backfill-json", ["usage", "backfill", "--dry-run", "--json"]);
await shot("09-usage-done");
await page.setViewport({ width: 390, height: 900 });
await shot("09-usage-done-phone");
await page.setViewport({ width: 1280, height: 1100 });

const factsAfter = await threadFacts();
save("10-threads-after.json", `${JSON.stringify(factsAfter, null, 2)}\n`);
save("10-threads-compare.txt", `${Object.keys(factsBefore).map((k) => {
  const [a, b] = [factsBefore[k], factsAfter[k]];
  const same = ["status", "attention", "desired", "actual", "failed", "lastHumanActivityAt", "seenAt", "lastReplyAt"].filter((f) => JSON.stringify(a?.[f]) !== JSON.stringify(b?.[f]));
  return `${k.padEnd(8)} ${b?.status} attention=${b?.attention} pylon=${b?.actual}: ${same.length === 0 ? "UNCHANGED" : `CHANGED ${same.join(", ")}`}`;
}).join("\n")}\n`);
save("10-sessions-after.txt", `${(await Promise.all(Object.keys(history).filter((k) => k !== "deleted").map(async (k) => `${k}: ${await sessionsOf(k)}`))).join("\n")}\n`);
const pylonsLog = readFileSync(join(out, "pylons.log"), "utf8");
save("11-pylon-lifecycle.txt", `${pylonsLog.slice(startedAt)}\nboots that relaunched the sessions, which starts an agent: ${(pylonsLog.match(/so its agent started/g) ?? []).length}\n`);

const firstRun = pylonsLog.length;
const totalBefore2 = await apiTotal();
cli("12-second-run", ["usage", "backfill"]);
if (hasBackfill) await until("the second run done", async () => { const s = await backfillState(); return s?.state === "done" && s.current === null; }, 120_000).catch((e) => log(String(e)));
await until("every pylon paused again", async () => (await get("/v1/threads")).filter((t) => t.status !== "deleted").every((t) => t.pylon.actualState === "paused"), 60_000).catch((e) => log(String(e)));
save("12-second-run-pylons.txt", readFileSync(join(out, "pylons.log"), "utf8").slice(firstRun));
save("12-second-run-total.txt", compare("GET /v1/usage total after a second run", await apiTotal(), totalBefore2));
cli("12-usage-after-second-run", ["usage", "--since", "all", "--by", "kind"]);

await stop(control);
await stop(probe);
await browser.close();
