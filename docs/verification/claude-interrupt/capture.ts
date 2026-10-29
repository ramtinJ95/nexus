// Captures what a checkout of Nexus lets the person do to a Claude worker's turn from the dashboard and the CLI: the
// state bar while Claude works, Interrupt or its absence, `nexus abort` while a permission dialog waits, and /clear
// typed into the composer. run.sh runs it once against main and once against the branch, each with a fresh Claude.
//
// The control plane is the checkout's own registry, API, dashboard and CLI on 127.0.0.1:7472, with the test fake for
// the model harness. The Claude worker is a real Claude Code (haiku) in the scratch Herdr session HERDR_SESSION under
// HOME, which run.sh starts. The probe is the replaced boundary: its commands run the checkout's own runCommand, and
// its pipes the transcript reader, against that Herdr and HOME, as live.ts does. Session events come from Herdr's
// state of the pane rather than from the image's hooks, which this HOME does not install.
//
//   HOME=... HERDR_SESSION=verify SESSION=<uuid> BROWSER_DEPS=... CHROMIUM=... node capture.ts <checkout> <out dir> <label>
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const [root, out, label] = process.argv.slice(2) as [string, string, string];
const session = process.env.SESSION!;
const scratch = process.env.HERDR_SESSION!;
const home = process.env.HOME!;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "capture.log"), "");
const log = (line: string) => { console.log(line); appendFileSync(join(out, "capture.log"), `${line}\n`); };

const { startApi } = await import(join(root, "src/control/api.ts"));
const { fakeHarness } = await import(join(root, "src/control/fake-harness.ts"));
const { threadStarter } = await import(join(root, "src/control/threads.ts"));
const { openRegistry } = await import(join(root, "src/control/registry.ts"));
const { runCommand } = await import(join(root, "src/backend.ts"));
const { herdrSession, sessionFacts } = await import(join(root, "src/sessions.ts"));
const { claudeProjects } = await import(join(root, "src/claude-transcript.ts"));
const { processStream } = await import(join(root, "src/process-stream.ts"));

type Thread = { id: string; pylonId: string };
const node = "verify-node";
const laptop = "nVERIFY";
const port = 7472;
const base = `http://127.0.0.1:${port}`;

const own = (arg: string) => arg.replaceAll(`--session ${herdrSession} `, `--session ${scratch} `).replaceAll(claudeProjects, `${home}/.claude/projects`);
const guest = {
  exec: (argv: readonly string[], opts: { timeoutMs: number }) => new Promise((resolve) => {
    const args = argv.map((arg, i) => argv[i - 1] === "--session" && arg === herdrSession ? scratch : own(arg));
    execFile(args[0]!, args.slice(1), { cwd: home, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const killed = err !== null && "killed" in err && err.killed;
      resolve({ exitCode: err === null ? 0 : killed ? null : typeof err.code === "number" ? err.code : 127, output: stdout + stderr, truncated: false });
    });
  }),
};
const commands: string[] = [];
const probe = {
  node,
  async command(pylonId: string, command: { kind: string }) {
    commands.push(command.kind);
    log(`probe command: ${JSON.stringify(command)}`);
    return await runCommand(pylonId, command, { backend: { guest: () => guest } });
  },
  // The pylon's asks are the hook's, which this HOME has none of. Every other pipe is the transcript reader.
  async stream(_pylonId: string, argv: readonly string[]) {
    return argv[0]!.endsWith("nexus-claude-hook") ? processStream("sh", ["-c", 'echo "[]"'], () => {}) : processStream(argv[0]!, argv.slice(1).map(own), () => {});
  },
};

const registry = openRegistry(join(mkdtempSync(join(tmpdir(), "nexus-interrupt-")), "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nNODE" });
const harness = fakeHarness().harness;
const dotfiles = { repo: "git@example.com:dotfiles.git", ref: "main" };
const api = await startApi({
  registry, host: "127.0.0.1", port, deployment: { self: "nCONTROL", deployers: new Set(), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1"]),
  dotfiles, harness, wake: () => {}, probes: new Map([[node, probe]]), previewPorts: { first: 10200, last: 10299 },
  startThread: threadStarter({ registry, harness, dotfiles, wake: () => {}, mirror: { setupInputs: () => Promise.reject(new Error("the capture reads no remote")) } }),
});
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
};
const image = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "24.22.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
await call("POST", "/v1/projects", {
  id: "nexus", repoUrl: "git@example.com:nexus.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
});
await call("POST", "/v1/images", image);
registry.setCurrentImage(image.id);
const claude: Thread = await call("POST", "/v1/threads", { project: "nexus", title: "Write the lighthouse essay", claude: "Wait for my messages." });
registry.setClaudeWorker(claude.id, "Wait for my messages.", "started", undefined, session);
const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
const observe = () => {
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylon = {
    pylonId: claude.pylonId, phase: "running", liveHash: registry.pylon(claude.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
    bootedFrom: { image: image.id, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  };
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: [pylon], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
};
observe();
const observing = setInterval(observe, 1000);

let sequence = 0;
let status = "idle";
const report = (event: Record<string, unknown>) => registry.reportSession(node, { sequence: ++sequence, pylon: claude.pylonId, time: Date.now(), event: { session, at: Date.now(), ...event } });
const pane = async () => (await sessionFacts(guest)).find((f: { herdrPane: string }) => f.herdrPane === "w1:p1");
const following = setInterval(async () => {
  const now = (await pane())?.status ?? "unknown";
  if (now === status || now === "unknown") return;
  if (now === "working") report({ kind: "session.turn-started" });
  else if (now === "blocked") report({ kind: "session.waiting", message: "Claude needs your permission to use Bash" });
  else report({ kind: "session.turn-ended" });
  log(`herdr: Claude went from ${status} to ${now}`);
  status = now;
}, 300);
const herdr = async (...args: string[]) => (await guest.exec(["herdr", "--session", herdrSession, ...args], { timeoutMs: 20_000 }) as { output: string }).output;
const screen = async () => (await herdr("pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "40")).split("\n").filter((l) => l.trim() !== "").slice(-12).join("\n");
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 90_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) if (await ok()) return log(`waited: ${what}`);
  throw new Error(`gave up waiting: ${what}`);
}
const cli = async (args: string[]) => {
  const r = await promisify(execFile)("node", [join(root, "src/cli/nexus.ts"), ...args], { env: { PATH: process.env.PATH!, HOME: home, NEXUS_URL: base, NEXUS_SOCKS: "none" } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (err: { code: number; stdout: string; stderr: string }) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }));
  const text = `$ nexus ${args.join(" ")}\n${r.stdout}${r.stderr}[exit ${r.code}]`;
  log(text);
  return text;
};
log(`${label}: Claude worker thread ${claude.id}, session ${session}`);
await cli(["--version"]);

const require = createRequire(join(process.env.BROWSER_DEPS!, "node_modules", "x.js"));
const { chromium: playwright } = require("playwright-core");
const browser = await playwright.launch({ executablePath: process.env.CHROMIUM, args: ["--no-sandbox", "--headless=new", "--font-render-hinting=none"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await context.newPage();
await page.goto(`${base}/threads/${claude.id}`);
const bar = async () => (await page.locator("#agent-state").innerText()).replace(/\s+/g, " ").trim();
const shot = async (file: string) => { await page.screenshot({ path: join(out, file) }); log(`screenshot ${file}`); };
async function compose(text: string) {
  await page.fill("#prompt-text", text);
  await page.locator("#prompt button[type=submit]").first().click();
}

await compose("Write a 1500-word essay about lighthouses, in plain prose, with no tools.");
await until("the state bar says Claude works", async () => (await bar()).startsWith("Claude is working"));
await sleep(3_000);
const interrupt = page.locator('#agent-state button[data-action="abort"]');
log(`state bar while Claude works: ${await bar()}`);
await shot("01-working.png");
if (await interrupt.count() > 0) {
  log(`the state bar offers "${await interrupt.innerText()}"; clicking it`);
  await interrupt.click();
} else {
  log("the state bar offers no way to stop the turn; it runs to its end");
}
await until("Claude stops working", () => status !== "working", 120_000);
await until("the state bar says Idle", async () => (await bar()).startsWith("Idle"), 15_000);
await sleep(3_000);
log(`Claude's terminal after:\n${await screen()}`);
await shot("02-after-turn.png");

await compose("Use the Bash tool to run exactly: touch interrupt-marker");
await until("the permission dialog waits", () => status === "blocked");
await until("the state bar says it waits", async () => (await bar()).startsWith("Waiting for you"), 15_000);
log(`state bar at the dialog: ${await bar()}`);
writeFileSync(join(out, "abort-at-dialog.txt"), `${await cli(["abort", claude.id])}\n`);
await sleep(1_000);
log(`Claude's terminal after the abort:\n${await screen()}`);
await shot("03-dialog.png");
await herdr("pane", "send-keys", "w1:p1", "esc");
log("the person cancels the dialog in the terminal");
await until("the dialog closes", () => status !== "blocked");

const before = (await pane())?.harnessSessionId;
await page.reload();
await compose("/clear");
await sleep(4_000);
const after = (await pane())?.harnessSessionId;
const error = await page.locator("#action-error").evaluate((p: HTMLElement) => p.hidden ? null : p.textContent);
log(`composer after /clear: error ${JSON.stringify(error)}, draft ${JSON.stringify(await page.inputValue("#prompt-text"))}`);
log(`Herdr's session for the pane: ${before} before, ${after} after; the worker follows ${session}`);
await shot("04-clear.png");
writeFileSync(join(out, "clear.txt"), `${JSON.stringify({ error, before, after, worker: session, commands }, null, 2)}\n`);

await browser.close();
clearInterval(following);
clearInterval(observing);
await api.close();
registry.close();
