/**
 * Drives the Sessions list of a Claude worker's thread page on a local stack whose pylon is this machine: opens a
 * shell from the page, runs a command in it through the page's terminal, shows Claude's pane and the shell's in turn,
 * shows the shell while a new attach is under way, and closes the shell. It captures the page, the pylon's Herdr panes and which one was focused:
 *
 *   MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/sessions-from-page/stack.ts drive <src> <out>
 *
 * The stack is the thread-page-interaction one: the real startControlPlane and probe server of the checkout under
 * test, each in a child process, and a VM backend that boots nothing, whose one pylon is this machine as the Linux
 * user `verify`. Herdr, the Claude Code launch, the session routes, the attach route's terminal and the relay under it
 * are the checkout's own code, run by a real Claude Code. tailscaled's whois is the stand-in.
 */
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { VmBackend, Guest } from "../../../src/backend.ts";
import type { ImageId, ImageManifest } from "../../../src/images.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const [mode, srcArg, ...rest] = process.argv.slice(2) as [string, string, ...string[]];
const src = resolve(srcArg);
const image = "img-0000000000aa" as ImageId;
const controlId = "nVERIFYCONTROL" as TailnetNodeId;
/** Every caller of the API but the probe is the person's laptop, as the CLI on a Mac is. */
const laptop = "nVERIFYLAPTOP" as TailnetNodeId;
const node = { name: "node-a" as NodeName, host: "127.0.0.1", id: "nVERIFYA" as TailnetNodeId };
const api = "http://127.0.0.1:7470";
const bridgePort = 7489;
const user = "verify";
const home = `/home/${user}`;
const bin = `${home}/.verify-bin`;
const prompt = "This thread only checks Nexus's dashboard. Do nothing else: read no files, write none, start no subagents, ask no reviewer, open no pull request. Reply with the single word READY and end your turn.";


const sudo = (argv: readonly string[]) => ["sudo", "-n", "-u", user, "-H", "--", ...argv];
/** A guest path or argument as it is on this machine. */
const moved = (arg: string) => arg
  .replaceAll("/usr/local/bin/nexus-", `${bin}/nexus-`).replace(/^\/usr\/local\/bin\/nexus$/, `${bin}/nexus`)
  .replaceAll("/home/user", home);

/** The pylon user's HOME as the image leaves it, from the checkout's images/pylon: its nexus scripts, Claude's hooks and settings, and the checkout. */
async function setUp() {
  const pylon = join(src, "../images/pylon");
  execFileSync("sh", ["-c", `id ${user} >/dev/null 2>&1 || sudo -n useradd -m -s /bin/bash ${user}`]);
  stopUser();
  execFileSync("sudo", ["-n", "rm", "-rf", `${home}/.claude`, `${home}/.claude.json`, `${home}/.nexus`, `${home}/workspace`, bin, `${home}/.config/herdr`]);
  const script = [
    "set -e",
    `mkdir -p ${bin} ${home}/.claude ${home}/.nexus ${home}/workspace/repo`,
    `ln -sfn /home/user/.claude/plugins ${home}/.claude/plugins`,
    `echo '{}' > ${home}/.nexus/pylon.json`,
    // The pane's shells must post the hooks' events to this stack, never to the pylon's own control plane.
    `printf '%s\\n' '. /etc/profile.d/nexus-secrets.sh 2>/dev/null' 'unset GH_TOKEN' 'export NEXUS_API=http://127.0.0.1:${bridgePort}' > ${home}/.bashrc`,
    `printf '%s\\n' '. ~/.bashrc' > ${home}/.bash_profile`,
    `cd ${home}/workspace/repo && git init -q -b main && printf '# drinks\\n' > README.md && git add -A && git -c user.name=verify -c user.email=verify@example.com commit -qm init`,
    // As the pylon image's Dockerfile writes it, so no first-run dialog takes an attached terminal's keys.
    `mkdir -p ${home}/.config/herdr && printf 'onboarding = false\\n\\n[session]\\nresume_agents_on_restore = false\\n' > ${home}/.config/herdr/config.toml`,
    "herdr integration install claude >/dev/null",
  ].join("\n");
  execFileSync("sudo", sudo(["sh", "-c", script]).slice(1));
  execFileSync("sh", ["-c", `sudo -n cp ${pylon}/nexus ${pylon}/nexus-claude-hook ${pylon}/*.ts ${bin}/ && sudo -n chown -R ${user}: ${bin}`]);
  const { claudeHooks } = await import(`${pylon}/agent-setup/install.ts`) as { claudeHooks: readonly (readonly unknown[])[] };
  const path = `${home}/.claude/settings.json`;
  const settings = JSON.parse(execFileSync("sudo", ["-n", "cat", path], { encoding: "utf8" }));
  settings.enabledPlugins = { "pstack@cursor-plugins": true };
  settings.hooks ??= {};
  for (const row of claudeHooks) {
    const [hook, kind, matcher, timeout] = row as [string, string, string, number | undefined];
    settings.hooks[hook] = [...settings.hooks[hook] ?? [], { matcher, hooks: [{ type: "command", command: `${bin}/nexus-claude-hook ${kind}`, timeout: timeout ?? 2 }] }];
  }
  execFileSync("sudo", sudo(["sh", "-c", `cat > ${path}`]).slice(1), { input: JSON.stringify(settings, null, 2) });
  return settings.hooks as Record<string, unknown>;
}

async function probe() {
  const { startProbe } = await import(`${src}/probe/server.ts`) as typeof import("../../../src/probe/server.ts");
  const { nodeSecrets } = await import(`${src}/probe/config.ts`) as typeof import("../../../src/probe/config.ts");
  const { listenHostBridge } = await import(`${src}/probe/pylon-api.ts`) as typeof import("../../../src/probe/pylon-api.ts");
  const { processStream } = await import(`${src}/process-stream.ts`) as typeof import("../../../src/process-stream.ts");
  const run = (argv: readonly string[], timeoutMs: number, input?: string) => new Promise<{ exitCode: number | null; output: string; truncated: boolean }>((done) => {
    const child = execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      done({ exitCode: err === null ? 0 : typeof err.code === "number" ? err.code : null, output: stdout + stderr, truncated: false });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
  const booted = new Set<PylonId>();
  const guest = (): Guest => ({
    async exec(argv, { cwd, timeoutMs }) {
      const moved_ = argv.map(moved);
      console.log(`guest: exec ${moved_.map((a) => a.length > 120 ? `${a.slice(0, 117)}...` : a).join(" ").replaceAll("\n", " ")}`);
      return run(sudo(["sh", "-c", 'cd "$0" && exec "$@"', moved(cwd), ...moved_]), timeoutMs);
    },
    async stream(argv, log) {
      const [command, ...args] = sudo(argv.map(moved));
      console.log(`guest: stream ${argv.map(moved).join(" ").replaceAll("\n", " ").slice(0, 160)}${argv.at(-2) === "attach" ? ` ... attach ${JSON.stringify(argv.at(-1))}` : ""}`);
      return processStream(command!, args, log);
    },
    async writeFiles(files) {
      for (const file of files) {
        await run(sudo(["sh", "-c", 'mkdir -p "$(dirname "$0")" && cat > "$0" && chmod "$1" "$0"', moved(file.path), file.mode.toString(8)]), 10_000, typeof file.content === "string" ? file.content : Buffer.from(file.content).toString());
      }
    },
    services: async () => ({ services: [] }),
    startService: () => Promise.reject(new Error("no services in the stand-in guest")),
    linkPort: () => Promise.reject(new Error("no ports in the stand-in guest")),
    unlinkPort: async () => null,
    previewOrigin: () => { throw new Error("no previews in the stand-in guest"); },
  } as Guest);
  const backend = {
    async ensureRunning(boot: Parameters<VmBackend["ensureRunning"]>[0]) {
      if (!booted.has(boot.pylonId)) console.log(`backend: booted ${boot.pylonId}`);
      booted.add(boot.pylonId);
    },
    async ensurePaused() {}, async ensureDeleted(pylonId: PylonId) { booted.delete(pylonId); },
    list: async () => [...booted].map((pylonId) => ({ pylonId, vm: "running" as const, checkpoint: null, image, bootedAt: "2026-10-28T00:00:00.000Z" })),
    async buildTemplate() {}, async buildImage() {},
    guest,
    // Every pylon API request comes from the one pylon this machine stands in for.
    hostBridge: listenHostBridge({ host: "127.0.0.1", port: bridgePort }, async (req) => req.url === "/v1/request" ? [...booted][0] ?? null : null),
    artifacts: { list: async () => [image], manifest: async () => null, export: () => Promise.reject(new Error("unused")), async import() {}, async drop() {} },
    async updateSecret() { return []; },
  } as unknown as VmBackend;
  const secrets = nodeSecrets({ value: () => undefined, names: () => [] });
  const p = await startProbe({ node: node.name, host: node.host, port: 7480, auth: { controlPlane: controlId, peers: [] }, whois: async () => controlId, backend, secrets, log: () => {} });
  console.log(`probe listening on ${node.host}:${p.port}`);
  process.once("SIGTERM", () => { void p.close().then(() => process.exit(0)); });
}

async function control(runDir: string) {
  const { startControlPlane } = await import(`${src}/control/main.ts`) as typeof import("../../../src/control/main.ts");
  const { scriptedModel, scriptedModels } = await import(`${src}/harness/test-fixture.ts`) as typeof import("../../../src/harness/test-fixture.ts");
  const socket = join(runDir, "tailscaled.sock");
  rmSync(socket, { force: true });
  await new Promise<void>((done) => createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: addr === `${node.host}:7480` ? node.id : laptop } }));
  }).listen(socket, done));
  const cp = await startControlPlane({
    db: join(runDir, "registry.db"),
    listen: { host: "127.0.0.1", port: 7470, hostnames: ["127.0.0.1"] },
    self: { tailnetNodeId: controlId },
    nodes: [{ name: node.name, tailnetHost: node.host, tailnetNodeId: node.id }],
    callers: [laptop],
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    harness: { storage: join(runDir, "harness.sqlite"), credentials: join(runDir, "unused-credentials.json"), model: scriptedModel },
    tailscaledSocket: socket,
    previewPorts: { first: 10200, last: 10299 },
    resumeAfterUsageLimit: false,
  } as never, scriptedModels() as never);
  console.log("control plane listening");
  process.once("SIGTERM", () => { void cp.close().then(() => process.exit(0)); });
}


async function drive(out: string) {
  const runDir = mkdtempSync(join(tmpdir(), "nexus-sessions-page-"));
  mkdirSync(out, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  for (const f of ["timeline.txt", "guest.log", "control.log"]) writeFileSync(join(out, f), "");
  const log = (line: string) => { const l = `${stamp()} ${line}`; console.log(l); appendFileSync(join(out, "timeline.txt"), `${l}\n`); };
  const scrub = (text: string) => text.replaceAll(runDir, "<run>");

  await setUp();
  log(`set up ${home} from ${src.replace(process.cwd(), "<repo>")}/../images/pylon`);

  const children = new Set<ChildProcess>();
  const child = (label: string, args: string[]) => {
    const c = spawn(process.execPath, [here, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(c);
    c.once("exit", () => children.delete(c));
    c.stdout!.on("data", (b: Buffer) => { for (const l of b.toString().trimEnd().split("\n")) { if (l.startsWith("guest:") || l.startsWith("backend:")) appendFileSync(join(out, "guest.log"), `${stamp()} ${l}\n`); } });
    c.stderr!.on("data", (b: Buffer) => appendFileSync(join(out, "control.log"), `${stamp()} ${label}: ${scrub(b.toString())}`));
    return new Promise<ChildProcess>((ready) => c.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("listening")) ready(c); }));
  };
  const stop = (c: ChildProcess) => new Promise<void>((done) => { c.once("exit", () => done()); c.kill("SIGTERM"); });

  let step = 0;
  const run = promisify(execFile);
  const cliEnv = { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" };
  const cli = (args: string[]) => run(process.execPath, [join(src, "cli/nexus.ts"), ...args], { env: cliEnv, maxBuffer: 1 << 24 });
  /** One CLI call, saved as NN-<name>.txt with the command, stdout, stderr and exit code. */
  async function nexus(name: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    let code = 0, stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await cli(args));
    } catch (err) {
      ({ code, stdout, stderr } = err as { code: number; stdout: string; stderr: string });
    }
    const file = `cli-${String(++step).padStart(2, "0")}-${name}.txt`;
    writeFileSync(join(out, file), `$ nexus ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(" ")}\n${stdout}${stderr === "" ? "" : `[stderr] ${stderr}`}[exit ${code}]\n`);
    log(`nexus ${args.map((a) => a.length > 60 ? `${a.slice(0, 57)}...` : a).join(" ")} -> exit ${code} (${file})`);
    return { code, stdout };
  }
  const detail = async (id: string) => JSON.parse((await cli(["show", id, "--json"])).stdout);
  async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 300_000): Promise<T | null> {
    const from = Date.now();
    for (;;) {
      try {
        const value = await check();
        if (value) { log(`${what} after ${((Date.now() - from) / 1000).toFixed(1)} s`); return value; }
      } catch {}
      if (Date.now() - from > ms) { log(`gave up after ${ms / 1000} s waiting until ${what}`); return null; }
      await sleep(500);
    }
  }
  const herdr = (...args: string[]) => execFileSync("sudo", sudo(["herdr", "--session", "nexus", ...args]).slice(1), { encoding: "utf8" });
  /** Each of the pylon's Herdr panes as the person attached to it would see it, saved as <name>.txt. */
  function panes(name: string) {
    const listed = JSON.parse(herdr("pane", "list")).result.panes as { pane_id: string; workspace_id: string }[];
    const focused = JSON.parse(herdr("api", "snapshot")).result.snapshot.focused_pane_id as string;
    const text = listed.map((p) => `== pane ${p.pane_id}${p.pane_id === focused ? ", focused" : ""}\n${herdr("pane", "read", p.pane_id, "--source", "visible", "--lines", "40").replace(/\n{3,}/g, "\n\n")}`).join("\n");
    writeFileSync(join(out, `${name}.txt`), text);
    log(`herdr panes -> ${name}.txt`);
  }

  const require = createRequire(join(process.env.MODULES!, "x.js"));
  const chromiumModule = require("@sparticuz/chromium");
  const chromium = chromiumModule.default ?? chromiumModule;
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 1000 });
  page.on("dialog", (dialog: { message(): string; accept(): Promise<void> }) => {
    log(`the page asked: ${JSON.stringify(dialog.message())}, and the person pressed OK`);
    void dialog.accept();
  });
  page.on("request", (req: { method(): string; url(): string; postData(): string | undefined }) => {
    if (req.method() !== "GET") log(`the page sent ${req.method()} ${req.url().replace(api, "")} ${req.postData() ?? ""}`);
  });
  const phone = await browser.newPage();
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const focused = () => JSON.parse(herdr("api", "snapshot")).result.snapshot.focused_pane_id as string;
  const listedPanes = () => (JSON.parse(herdr("pane", "list")).result.panes as { pane_id: string; workspace_id: string; agent?: string }[]);
  const screen = () => page.evaluate('document.querySelector("#term-host .xterm-rows")?.innerText ?? ""') as Promise<string>;
  const sessionsText = () => page.evaluate('document.querySelector("#pane-pylon section[aria-labelledby=sessions-h]")?.innerText.replace(/\\s+/g, " ").trim() ?? ""') as Promise<string>;
  async function pylonTab(p: typeof page) {
    if (p === page) await p.click('label.seg-tab:has(input[value="pylon"])');
    else await p.click('button.mini[data-pane="pylon"]');
    await sleep(500);
    await p.evaluate('document.querySelector("#sessions-h")?.scrollIntoView({ block: "start" })');
    await sleep(300);
  }
  async function shot(name: string) {
    await page.screenshot({ path: join(out, `${name}.png`) });
    log(`-> ${name}.png; focused pane ${focused()}`);
  }

  try {
    const { openRegistry } = await import(`${src}/control/registry.ts`) as typeof import("../../../src/control/registry.ts");
    const seed = openRegistry(join(runDir, "registry.db"));
    seed.saveImage({ id: image, gondolinBuildId: "stand-in", builtOn: node.name, builtAt: new Date().toISOString(), sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest, null);
    seed.setCurrentImage(image);
    seed.close();
    await child("probe", ["probe", src, runDir]);
    await child("control", ["control", src, runDir]);
    await until("the control plane answers", async () => (await fetch(`${api}/v1/nodes`)).ok, 30_000);
    await nexus("version", "--version");
    await nexus("project-add", "project", "add", "drinks", "--scratch", "--node", node.name, "--cpus", "1", "--memory", "3", "--disk", "5");
    const claude = (JSON.parse((await nexus("start-claude", "start", "--project", "drinks", "--title", "Claude thread", "--claude", prompt, "--model", "claude-sonnet-5-5", "--json")).stdout) as { id: string }).id;
    await until("Claude has answered its prompt", async () => { const d = await detail(claude); return !d.thread.working && (d.lastReplyAt ?? 0) > 0; }, 300_000);
    const claudePane = (await detail(claude)).sessions.find((s: { harness: string }) => s.harness === "claude-code").herdrPane as string;
    log(`the Claude worker runs in pane ${claudePane}`);
    const path = `/threads/${claude}`;

    await page.goto(`${api}${path}`, { waitUntil: "load" });
    await sleep(1500);
    await pylonTab(page);
    await shot("01-sessions-desktop");
    log(`Sessions reads: ${await sessionsText()}`);
    await phone.goto(`${api}${path}`, { waitUntil: "load" });
    await sleep(1500);
    await pylonTab(phone);
    await phone.screenshot({ path: join(out, "01-sessions-phone.png") });
    log("-> 01-sessions-phone.png");
    if (await phone.evaluate("document.documentElement.scrollWidth > window.innerWidth")) log("the phone's page scrolls sideways");

    if (await page.$('[data-action="open-session"][data-harness="shell"]') === null) {
      log("the Sessions list offers no New shell, Show in terminal or Close, so opening, jumping and closing take the CLI and Herdr's keys");
    } else {
      await page.click('[data-action="open-session"][data-harness="shell"]');
      log("pressed New shell");
      const shellPane = await until("the shell's pane is open", async () => listedPanes().find((p) => p.agent === undefined && p.pane_id !== claudePane)?.pane_id, 60_000);
      await until("the page's terminal attaches", () => page.evaluate('document.getElementById("term-status")?.textContent === "" && document.getElementById("term-detach")?.hidden === false'), 30_000);
      await until(`Herdr focuses the shell's pane ${shellPane}`, async () => focused() === shellPane, 30_000);
      await sleep(1500);
      await shot("02-new-shell-desktop");
      await page.keyboard.type("echo from the page $((6 * 7))");
      await page.keyboard.press("Enter");
      log('typed "echo from the page $((6 * 7))" and Enter into the page\'s terminal');
      await until("the shell printed from the page 42", async () => herdr("pane", "read", shellPane!, "--source", "visible", "--lines", "40").includes("from the page 42"), 30_000);
      await until("the page's terminal shows it", async () => (await screen()).includes("from the page 42"), 30_000);
      await shot("03-shell-ran-desktop");
      panes("panes-after-shell-ran");

      await pylonTab(page);
      await page.click(`[data-action="show-session"][data-pane="${claudePane}"]`);
      log("pressed Show in terminal on Claude Code's session");
      await until(`Herdr focuses Claude's pane ${claudePane}`, async () => focused() === claudePane, 30_000);
      await until("the page's terminal shows Claude Code", async () => !(await screen()).includes("from the page 42"), 30_000);
      await sleep(1500);
      await shot("04-claude-shown-desktop");

      await pylonTab(page);
      await page.click(`[data-action="show-session"][data-pane="${shellPane}"]`);
      log("pressed Show in terminal on the shell's session");
      await until(`Herdr focuses the shell's pane ${shellPane}`, async () => focused() === shellPane, 30_000);
      await until("the page's terminal shows the shell again", async () => (await screen()).includes("from the page 42"), 30_000);
      await sleep(1000);
      await shot("05-shell-shown-desktop");

      await page.click("#term-detach");
      await until("the page's terminal detaches", () => page.evaluate('document.getElementById("term-again")?.hidden === false'), 10_000);
      herdr("agent", "focus", claudePane);
      await pylonTab(page);
      await page.evaluate(`document.getElementById("term-again").click(); document.querySelector('[data-action="show-session"][data-pane="${shellPane}"]').click();`);
      log("pressed Attach again and, before it attached, Show in terminal on the shell's session");
      await until(`Herdr focuses the shell's pane ${shellPane}`, async () => focused() === shellPane, 30_000);
      await sleep(3000);
      log(`3 s later Herdr's focused pane is ${focused()}`);
      await shot("06-show-while-attaching-desktop");

      await pylonTab(page);
      log(`Sessions reads: ${await sessionsText()}`);
      await page.click(`[data-action="close-session"][data-session="${shellPane}"]`);
      log("pressed Close on the shell's session");
      await until("Herdr closed the shell's pane", async () => !listedPanes().some((p) => p.pane_id === shellPane), 30_000);
      await until("the Sessions list drops the shell", async () => !(await sessionsText()).includes(shellPane!), 30_000);
      await pylonTab(page);
      await shot("07-shell-closed-desktop");
      log(`Sessions reads: ${await sessionsText()}`);
      panes("panes-after-close");
    }
    await nexus("show-claude", "show", claude);
    await nexus("delete-claude", "delete", claude);
  } finally {
    await browser.close();
    await Promise.all([...children].map(stop));
    stopUser();
    rmSync(runDir, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((w) => setTimeout(w, ms));
/** Ends every process of the `verify` user: its Herdr server, Claude and its hooks. */
function stopUser() {
  try { execFileSync("sudo", ["-n", "pkill", "-u", user], { stdio: "ignore" }); } catch {}
}
await (mode === "probe" ? probe() : mode === "control" ? control(rest[0]!) : drive(resolve(rest[0]!)));
