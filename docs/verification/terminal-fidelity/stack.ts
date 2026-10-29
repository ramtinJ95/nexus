/**
 * Drives a Claude worker's Terminal tab on a local stack whose pylon is this machine, at a desktop width, and captures
 * copying out, Shift+Enter, a link, a question that arrives while the terminal shows, a reattach after the attach
 * socket is reset, and a page hidden for ten minutes:
 *
 *   MODULES=<node_modules with @sparticuz/chromium and puppeteer-core> node docs/verification/terminal-fidelity/stack.ts drive <src> <out>
 *
 * The stack is the thread-page-interaction one: the real startControlPlane and probe server of the checkout under
 * test, each in a child process, and a VM backend that boots nothing, whose one pylon is this machine as the Linux
 * user `verify`. Herdr, the Claude Code launch, its hooks, the attach route and the relay under it are the checkout's
 * own code, run by a real Claude Code. The page reaches the API through a TCP proxy on port 7471, so the driver can
 * reset the attach socket's connection as a dropped link would. tailscaled's whois is the other stand-in. The page
 * reports a Mac's navigator.platform, which is what xterm.js reads to treat Option as a Mac's.
 */
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect, type Socket } from "node:net";
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
/** The page's address: a TCP proxy to the API, whose attach connections the driver can reset. */
const proxyPort = 7471;
const site = `http://127.0.0.1:${proxyPort}`;
const link = "https://example.com/nx";
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
  const runDir = mkdtempSync(join(tmpdir(), "nexus-terminal-"));
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

  const attachLinks = new Set<Socket>();
  const proxy = createTcpServer((client) => {
    const upstream = connect(7470, "127.0.0.1");
    client.once("data", (first: Buffer) => {
      if (!first.toString("latin1").includes("/attach?")) return;
      attachLinks.add(client);
      client.once("close", () => attachLinks.delete(client));
    });
    const end = () => { client.destroy(); upstream.destroy(); };
    for (const s of [client, upstream]) { s.on("error", end); s.on("close", end); }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((done) => proxy.listen(proxyPort, "127.0.0.1", done));
  /** Resets the TCP connection under each attach socket the page holds, as a dropped Wi-Fi link or a NAT timeout would. */
  const resetAttach = () => { const n = attachLinks.size; for (const s of attachLinks) s.resetAndDestroy(); return n; };

  let step = 0;
  const run = promisify(execFile);
  const cliEnv = { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" };
  const cli = (args: string[]) => run(process.execPath, [join(src, "cli/nexus.ts"), ...args], { env: cliEnv, maxBuffer: 1 << 24 });
  /** One CLI call, saved as cli-NN-<name>.txt with the command, stdout, stderr and exit code. */
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
      await sleep(250);
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
  log(`browser ${await browser.version()}`);
  await browser.defaultBrowserContext().overridePermissions(site, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const desktop = await browser.newPage();
  await desktop.setViewport({ width: 1440, height: 900 });
  await desktop.evaluateOnNewDocument(`
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    window.opened = [];
    window.open = (...args) => { window.opened.push(args); return null; };
  `);
  desktop.on("dialog", (dialog: { type(): string; message(): string; dismiss(): Promise<void> }) => { log(`the page asked ${dialog.type()}: ${JSON.stringify(dialog.message())}, dismissed`); void dialog.dismiss(); });
  const cdp = await desktop.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const sockets = new Map<string, string>();
  let osc52 = 0, osc8 = 0;
  cdp.on("Network.webSocketCreated", ({ requestId, url }: { requestId: string; url: string }) => {
    if (!url.includes("/attach?")) return;
    sockets.set(requestId, url);
    log(`the page opened attach socket ${sockets.size}`);
  });
  cdp.on("Network.webSocketClosed", ({ requestId }: { requestId: string }) => { if (sockets.has(requestId)) log(`attach socket ${[...sockets.keys()].indexOf(requestId) + 1} closed`); });
  cdp.on("Network.webSocketFrameReceived", ({ requestId, response }: { requestId: string; response: { opcode: number; payloadData: string } }) => {
    if (!sockets.has(requestId) || response.opcode !== 2) return;
    const bytes = Buffer.from(response.payloadData, "base64").toString();
    for (const [, sel, data] of bytes.matchAll(/\x1b\]52;([^;]*);([^\x07\x1b]*)/g)) log(`the pylon sent OSC 52, selection ${JSON.stringify(sel)}, text ${JSON.stringify(Buffer.from(data!, "base64").toString())} (${++osc52})`);
    if (bytes.includes("\x1b]8;") && osc8++ === 0) log("the pylon sent an OSC 8 hyperlink");
  });

  const shot = async (name: string) => { await desktop.screenshot({ path: join(out, `${name}.png`) }); log(`-> ${name}.png`); };
  const status = () => desktop.evaluate(`({ text: document.getElementById("term-status")?.textContent ?? "", again: !document.getElementById("term-again")?.hidden, detach: !document.getElementById("term-detach")?.hidden })`) as Promise<{ text: string; again: boolean; detach: boolean }>;
  const attached = async () => { const s = await status(); return s.text === "" && s.detach && (await rows()).trim() !== ""; };
  const rows = () => desktop.evaluate('document.querySelector("#term-host .xterm-rows")?.innerText ?? ""') as Promise<string>;
  const clipboard = () => desktop.evaluate("navigator.clipboard.readText()") as Promise<string>;
  const setClipboard = (text: string) => desktop.evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)})`);
  /** Where `needle` sits in the terminal's last row that holds it, in page pixels. */
  const findText = (needle: string) => desktop.evaluate(`((needle) => {
    let found = null;
    for (const row of document.querySelectorAll("#term-host .xterm-rows > div")) {
      const at = (row.textContent ?? "").indexOf(needle);
      if (at < 0) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let seen = 0, started = false;
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const len = n.textContent.length;
        if (!started && at < seen + len) { range.setStart(n, at - seen); started = true; }
        if (started && at + needle.length <= seen + len) { range.setEnd(n, at + needle.length - seen); break; }
        seen += len;
      }
      const r = range.getBoundingClientRect();
      found = { left: r.left + 1, right: r.right - 1, y: r.top + r.height / 2 };
    }
    return found;
  })(${JSON.stringify(needle)})`) as Promise<{ left: number; right: number; y: number } | null>;
  const drag = async (from: { left: number; right: number; y: number }) => {
    await desktop.mouse.move(from.left, from.y);
    await desktop.mouse.down();
    await desktop.mouse.move(from.right, from.y, { steps: 8 });
    await desktop.mouse.up();
  };
  const typeInTerminal = async (text: string) => {
    await desktop.focus("#term-host .xterm-helper-textarea");
    await desktop.keyboard.type(text, { delay: 15 });
  };
  const replied = async (id: string, since: number) => { const d = await detail(id); return !d.thread.working && (d.lastReplyAt ?? 0) > since; };
  /** Replied, and still idle a few seconds later, so a second turn has had its chance to start. */
  const settled = async (id: string, since: number) => await replied(id, since) && (await sleep(5000), await replied(id, since));

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
    await until("Claude has answered its prompt", () => replied(claude, 0), 300_000);

    log("== the Terminal tab attaches");
    await desktop.goto(`${site}/threads/${claude}`, { waitUntil: "load" });
    await desktop.click('[data-tab="term"]');
    await until("the terminal attaches", attached, 30_000);
    await sleep(2500);
    await shot("01-terminal");

    log("== copying out: a drag that Herdr selects, then an Option-drag that the page selects");
    await setClipboard("(nothing copied yet)");
    const words = await findText("Reply with the single");
    log(`"Reply with the single" is at ${JSON.stringify(words)}`);
    if (words !== null) {
      await drag(words);
      await sleep(1500);
      log(`after a plain drag over it, the clipboard holds ${JSON.stringify(await clipboard())}`);
      await shot("02-herdr-drag");
      await setClipboard("(nothing copied yet)");
      await desktop.keyboard.down("Alt");
      await drag(words);
      await desktop.keyboard.up("Alt");
      await sleep(500);
      log(`after an Option-drag, xterm.js has ${await desktop.evaluate('document.querySelectorAll("#term-host .xterm-selection > div").length')} selection boxes`);
      await shot("03-option-drag");
      await desktop.keyboard.down("Meta");
      await desktop.keyboard.press("KeyC", { commands: ["copy"] });
      await desktop.keyboard.up("Meta");
      await sleep(500);
      log(`after ⌘C, the clipboard holds ${JSON.stringify(await clipboard())}`);
    }

    log("== Shift+Enter between two lines, then Enter");
    let since = Date.now();
    await typeInTerminal("This message has two lines.");
    await desktop.keyboard.down("Shift");
    await desktop.keyboard.press("Enter");
    await desktop.keyboard.up("Shift");
    await typeInTerminal(`Reply with only this link and nothing else: ${link}`);
    log("typed a line, Shift+Enter and a second line into the page's terminal");
    await sleep(2500);
    panes("panes-shift-enter");
    await shot("04-shift-enter");
    await desktop.keyboard.press("Enter");
    log("pressed Enter");
    await until("Claude's turns end", () => settled(claude, since), 180_000);
    await sleep(2000);
    await nexus("conversation-shift-enter", "conversation", claude);
    await shot("05-replied");

    log("== a link in the output");
    const url = await findText(link);
    log(`the link is at ${JSON.stringify(url)}`);
    if (url !== null) {
      await desktop.mouse.move((url.left + url.right) / 2, url.y);
      await sleep(800);
      log(`hovered it: the pointer is ${await desktop.evaluate('getComputedStyle(document.querySelector("#term-host .xterm-screen")).cursor')}`);
      await shot("06-link-hover");
      await desktop.mouse.click((url.left + url.right) / 2, url.y);
      await sleep(800);
      log(`clicked it: window.open was called with ${JSON.stringify(await desktop.evaluate("window.opened"))}`);
    }

    log("== a question arrives while the terminal shows");
    since = Date.now();
    await typeInTerminal("Use the AskUserQuestion tool once to ask me which fruit I want, header Fruit, with the options Apple and Pear. Then reply with the fruit I picked.");
    await desktop.keyboard.press("Enter");
    await until("the thread asks a question", async () => (await detail(claude)).questions.some((q: { answer: unknown; ask?: unknown }) => q.answer === null && q.ask !== undefined), 180_000);
    const seen = await until("the question shows on the page beside the terminal", () => desktop.evaluate('(() => { const q = document.getElementById("questions"); return q !== null && q.textContent.trim() !== "" && q.checkVisibility() && document.getElementById("term-view").checkVisibility(); })()'), 20_000);
    log(`the page's view is ${await desktop.evaluate("document.querySelector('.main').dataset.view")}, the question ${seen ? "shows" : "does not show"}, and the dock reads ${JSON.stringify(await desktop.evaluate('document.querySelector(".dock")?.checkVisibility() ? document.querySelector(".dock").innerText.replace(/\\s+/g, " ").trim() : "(hidden)"'))}`);
    await shot("07-question");
    await desktop.focus("#term-host .xterm-helper-textarea");
    await desktop.keyboard.press("Enter");
    log("answered in the terminal with Enter");
    await until("the question is answered", async () => !(await detail(claude)).questions.some((q: { answer: unknown; ask?: unknown }) => q.answer === null && q.ask !== undefined), 60_000);
    await until("Claude's turn ends", () => settled(claude, since), 120_000);

    log("== the attach socket's connection is reset");
    await sleep(2000);
    const statuses: string[] = [];
    let watching = true;
    const watch = (async () => {
      let last = "";
      while (watching) {
        const s = await status().catch(() => null);
        const line = s === null ? "" : `${JSON.stringify(s.text)}${s.again ? ", Attach again" : ""}${s.detach ? ", Detach" : ""}`;
        if (line !== last) { statuses.push(`${stamp()} ${line}`); last = line; }
        await sleep(100);
      }
    })();
    log(`reset ${resetAttach()} attach connection`);
    await shot("08-dropped");
    const back = await until("the terminal is attached again", attached, 45_000);
    await sleep(1500);
    watching = false;
    await watch;
    log(`the status line went:\n${statuses.map((s) => `    ${s}`).join("\n")}`);
    await shot("09-after-drop");
    if (back !== null) {
      since = Date.now();
      await typeInTerminal("Reply with the word PLUM.");
      await desktop.keyboard.press("Enter");
      log("typed \"Reply with the word PLUM.\" and Enter after the reattach");
      await until("Claude answers what was typed after the reattach", () => replied(claude, since), 120_000);
      await sleep(2000);
      panes("panes-after-reattach");
      await shot("10-typed-after-reattach");
    }

    if (process.env.HIDDEN !== "0") {
      log("== the page is hidden for ten and a half minutes");
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      // Focus emulation, which lets a background page write the clipboard, also keeps a minimized page visible.
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      await sleep(1000);
      log(`the browser window is minimized, and the thread page is ${await desktop.evaluate("document.visibilityState")}`);
      await sleep(630_000);
      log(`after ten and a half minutes hidden, the terminal says ${JSON.stringify(await status())}`);
      panes("panes-hidden");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      log(`the thread page is ${await desktop.evaluate("document.visibilityState")} again`);
      await until("the terminal is attached once the page shows", attached, 45_000);
      await sleep(1500);
      await shot("11-shown-again");
    }
    log(`the page opened ${sockets.size} attach sockets in all`);
    await nexus("delete-claude", "delete", claude);
  } finally {
    await browser.close();
    proxy.close();
    for (const s of attachLinks) s.destroy();
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
