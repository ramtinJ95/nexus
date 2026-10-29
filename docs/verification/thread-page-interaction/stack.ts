/**
 * Drives a thread page's sending, steering and attaching on a local stack whose pylon is this machine, for a Nexus
 * agent thread and a Claude worker, and captures what the CLI, the dashboard at a desktop and a phone width, and the
 * pylon's Herdr panes saw:
 *
 *   MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/thread-page-interaction/stack.ts drive <src> <out>
 *
 * The stack is the ask-user-question-card one: the real startControlPlane and probe server of the checkout under test,
 * each in a child process, and a VM backend that boots nothing, whose one pylon is this machine as the Linux user
 * `verify`. Herdr, the Claude Code launch, its hooks, the attach route's terminal and the relay under it are the
 * checkout's own code, run by a real Claude Code. The Nexus agent thread's model is the harness's scripted one, which
 * answers `bash: <command>` with one bash call in the pylon and then an answer, and anything else with an answer.
 * tailscaled's whois is the other stand-in.
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
      console.log(`guest: stream ${argv.map(moved).join(" ").replaceAll("\n", " ").slice(0, 160)}`);
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
  const runDir = mkdtempSync(join(tmpdir(), "nexus-thread-page-"));
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
  const desktop = await browser.newPage();
  await desktop.setViewport({ width: 1360, height: 1000 });
  const phone = await browser.newPage();
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  for (const [width, page] of [["desktop", desktop], ["phone", phone]] as const) {
    page.on("request", (req: { method(): string; url(): string; postData(): string | undefined }) => {
      if (req.method() === "POST" && req.url().endsWith("/messages")) log(`${width} page sent ${req.postData()}`);
    });
  }
  const widths = [["desktop", desktop], ["phone", phone]] as const;
  /** Both widths of the page at the conversation's end, as <name>-desktop.png and <name>-phone.png, and its dock's text. */
  async function shots(name: string, path: string) {
    for (const [width, page] of widths) {
      if (!page.url().endsWith(path)) await page.goto(`${api}${path}`, { waitUntil: "load" });
      await sleep(1500);
      await page.evaluate('document.getElementById("scroll")?.scrollTo(0, 1e9)');
      await sleep(200);
      await page.screenshot({ path: join(out, `${name}-${width}.png`) });
      if (await page.evaluate("document.documentElement.scrollWidth > window.innerWidth")) log(`${name}-${width}: the page scrolls sideways`);
    }
    log(`dashboard ${path} -> ${name}-desktop.png, ${name}-phone.png; dock: ${await dock(desktop)}`);
  }
  const dock = (page: typeof desktop) => page.evaluate('document.querySelector(".dock")?.innerText.replace(/\\s+/g, " ").trim() ?? ""') as Promise<string>;
  /** Types `text` into the composer and presses `keys`, as the person does. */
  async function compose(page: typeof desktop, path: string, text: string, keys: "Control" | "Alt") {
    if (!page.url().endsWith(path)) await page.goto(`${api}${path}`, { waitUntil: "load" });
    await page.waitForSelector("#prompt-text");
    await page.click("#prompt-text");
    await page.type("#prompt-text", text);
    await page.keyboard.down(keys);
    await page.keyboard.press("Enter");
    await page.keyboard.up(keys);
    log(`typed ${JSON.stringify(text)} into the composer and pressed ${keys === "Control" ? "Ctrl" : "Alt"}+Enter`);
  }
  const replied = async (id: string, since: number) => { const d = await detail(id); return !d.thread.working && (d.lastReplyAt ?? 0) > since; };

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
    const agent = (JSON.parse((await nexus("start-agent", "start", "--project", "drinks", "--title", "Agent thread", "--json")).stdout) as { id: string }).id;
    await until("Claude has answered its prompt", () => replied(claude, 0), 300_000);
    await until("the agent thread's pylon runs", async () => (await detail(agent)).pylon.actualState === "running", 120_000);
    const agentPath = `/threads/${agent}`, claudePath = `/threads/${claude}`;

    log("== a Nexus agent thread: send, then steer and queue while it works");
    await shots("01-agent-idle", agentPath);
    let since = Date.now();
    await compose(desktop, agentPath, "hello", "Control");
    await until("the agent replies", () => replied(agent, since), 60_000);
    await shots("02-agent-sent", agentPath);
    await compose(desktop, agentPath, "bash: sleep 12", "Control");
    await until("the agent works", async () => (await detail(agent)).thread.working, 30_000);
    await shots("03-agent-working", agentPath);
    await compose(desktop, agentPath, "steer: take this after the sleep", "Control");
    await sleep(1500);
    await desktop.screenshot({ path: join(out, "04-agent-steered-desktop.png") });
    log(`-> 04-agent-steered-desktop.png; dock: ${await dock(desktop)}`);
    await compose(desktop, agentPath, "queued: after the run", "Alt");
    await sleep(1500);
    await desktop.screenshot({ path: join(out, "05-agent-queued-desktop.png") });
    log(`-> 05-agent-queued-desktop.png; composer holds ${JSON.stringify(await desktop.evaluate('document.getElementById("prompt-text")?.value'))}`);
    since = Date.now();
    await until("the agent's run and what it took end", async () => { const d = await detail(agent); return !d.thread.working && d.lastReplyAt > since - 60_000 ? d : null; }, 120_000);
    await sleep(3000);
    await nexus("conversation-agent", "conversation", agent);
    await shots("06-agent-after", agentPath);

    log("== a Claude worker: send, then steer while it works");
    await shots("07-claude-idle", claudePath);
    since = Date.now();
    await compose(desktop, claudePath, "Run `sleep 30` in bash, then reply with the word DONE.", "Control");
    await until("Claude works", async () => (await detail(claude)).thread.working, 60_000);
    await sleep(4000);
    await shots("08-claude-working", claudePath);
    await compose(desktop, claudePath, "Also put the word BANANA in that reply.", "Control");
    await sleep(2000);
    await desktop.screenshot({ path: join(out, "09-claude-steered-desktop.png") });
    log(`-> 09-claude-steered-desktop.png; dock: ${await dock(desktop)}`);
    await until("Claude's turn ends", () => replied(claude, since), 300_000);
    await sleep(3000);
    await nexus("conversation-claude", "conversation", claude);
    await shots("10-claude-after", claudePath);

    log("== attaching: the person last left Herdr on a shell session, then attaches again");
    await nexus("show-agent", "show", agent);
    await nexus("show-claude", "show", claude);
    await nexus("session-open", "session", "open", claude, "--harness", "shell", "--title", "Shell");
    const shellWorkspace = () => {
      const listed = JSON.parse(herdr("workspace", "list")).result.workspaces as { workspace_id: string; label: string }[];
      const shell = listed.find((w) => w.label === "Shell")!.workspace_id;
      herdr("workspace", "focus", shell);
      log(`focused Herdr workspace ${shell}, "Shell", as the person's last attach left it`);
    };
    shellWorkspace();
    panes("panes-before-attach");
    since = Date.now();
    const attach = spawn("script", ["-qfc", `stty cols 120 rows 36; exec ${process.execPath} ${join(src, "cli/nexus.ts")} attach ${claude}`, "/dev/null"], { env: cliEnv, stdio: ["pipe", "pipe", "pipe"] });
    let screen = "";
    attach.stdout!.on("data", (b: Buffer) => { screen += b.toString(); });
    await sleep(6000);
    attach.stdin!.write("Reply with the word PINEAPPLE.");
    await sleep(800);
    attach.stdin!.write("\r");
    log("typed \"Reply with the word PINEAPPLE.\" and Enter into `nexus attach`");
    await sleep(3000);
    panes("panes-after-cli-attach");
    attach.kill("SIGTERM");
    writeFileSync(join(out, "attach-cli-screen.txt"), screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, ""));
    await until("Claude answers what was typed into the attached terminal", () => replied(claude, since), 120_000);
    await nexus("conversation-after-cli-attach", "conversation", claude);

    shellWorkspace();
    for (const [width, page] of widths) {
      await page.goto(`${api}${claudePath}`, { waitUntil: "load" });
      await sleep(1500);
      if (await page.$('[data-tab="term"]') === null) {
        log(`${width}: the thread page has no terminal tab`);
        if (width === "desktop") await page.click('label.seg-tab:has(input[value="pylon"])');
        else { await page.click('button.mini[data-pane="pylon"]'); }
        await sleep(500);
        await page.evaluate('document.querySelector(".attach")?.scrollIntoView({ block: "center" })');
      } else {
        await page.click('[data-tab="term"]');
        await until(`the ${width} terminal attaches`, () => page.evaluate('document.getElementById("term-status")?.textContent === "" && (document.querySelector(".xterm-rows")?.textContent ?? "").trim() !== ""'), 30_000);
        await sleep(2500);
      }
      await page.screenshot({ path: join(out, `11-terminal-${width}.png`) });
      log(`-> 11-terminal-${width}.png`);
    }
    if (await desktop.$('[data-tab="term"]') !== null) {
      since = Date.now();
      await desktop.keyboard.type("Reply with the word MANGO.");
      await sleep(800);
      await desktop.keyboard.press("Enter");
      log("typed \"Reply with the word MANGO.\" and Enter into the page's terminal");
      await until("Claude answers what was typed into the page's terminal", () => replied(claude, since), 120_000);
      await sleep(2000);
      await desktop.screenshot({ path: join(out, "12-terminal-typed-desktop.png") });
      panes("panes-after-page-terminal");
      await nexus("conversation-after-page-terminal", "conversation", claude);
      await desktop.click("#term-detach");
      await sleep(1000);
      log(`detached; the terminal says ${JSON.stringify(await desktop.evaluate('document.getElementById("term-status")?.textContent'))}`);
      const sheets = () => desktop.evaluate("document.adoptedStyleSheets.length") as Promise<number>;
      const before = await sheets();
      for (const n of [1, 2]) {
        await desktop.click("#term-again");
        await until(`the terminal attaches again (${n})`, () => desktop.evaluate('document.getElementById("term-status")?.textContent === "" && document.getElementById("term-detach")?.hidden === false'), 30_000);
        await desktop.click("#term-detach");
        await sleep(500);
      }
      log(`after two more attaches: ${await desktop.evaluate('document.querySelectorAll("#term-host .xterm").length')} terminal in the tab, adopted stylesheets ${before} -> ${await sheets()}`);
      await nexus("archive-claude", "archive", claude);
      await until("the Terminal tab hides", () => desktop.evaluate('document.querySelector(\'[data-tab="term"]\')?.hidden === true'), 30_000);
      await nexus("unarchive-claude", "unarchive", claude);
      await until("the Terminal tab is back without a reload", () => desktop.evaluate('document.querySelector(\'[data-tab="term"]\')?.hidden === false'), 30_000);
      await desktop.screenshot({ path: join(out, "13-unarchived-desktop.png") });
      log("-> 13-unarchived-desktop.png");
    }
    await nexus("delete-agent", "delete", agent);
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
