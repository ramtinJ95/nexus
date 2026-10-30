/**
 * Starts a Claude worker thread on a local stack whose pylon is this machine, watches it through a long Bash command
 * and an AskUserQuestion, answers the ask through the API as the dashboard does, and records each run of
 * `nexus-claude-hook asks` the control plane made meanwhile:
 *
 *   node docs/verification/ask-pull-gate/stack.ts drive <src> <out>
 *
 * The stack is ask-user-question-card's, without the browser: the real startControlPlane and probe server of the
 * checkout under test, each in a child process, and a probe whose one pylon is this machine as the Linux user
 * `verify`, under whose HOME the real Claude Code runs the checkout's hooks. The hooks post to the probe's pylon API on
 * 127.0.0.1:7489, so nothing reaches the live control plane.
 */
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const prompt = [
  "This thread only checks how Nexus follows a Claude worker. Do nothing else: read no files, write none, start no subagents, ask no reviewer, open no pull request.",
  'First run the shell command "sleep 45" with the Bash tool, in the foreground.',
  'Then call AskUserQuestion once, with one question: header "Size", question "Which size?", not multi-select, options "Small" (description "200 ml") and "Large" (description "400 ml").',
  "Then reply with the tool's result word for word in a code block, and end your turn.",
].join("\n");

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
  const runDir = mkdtempSync(join(tmpdir(), "nexus-ask-"));
  mkdirSync(out, { recursive: true });
  const here = fileURLToPath(import.meta.url);
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  for (const f of ["timeline.txt", "guest.log", "control.log"]) writeFileSync(join(out, f), "");
  const log = (line: string) => { const l = `${stamp()} ${line}`; console.log(l); appendFileSync(join(out, "timeline.txt"), `${l}\n`); };
  const scrub = (text: string) => text.replaceAll(runDir, "<run>");

  const hooks = await setUp();
  writeFileSync(join(out, "claude-hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);
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
  const cli = (args: string[]) => run(process.execPath, [join(src, "cli/nexus.ts"), ...args], { env: { ...process.env, NEXUS_URL: api, NEXUS_SOCKS: "none" }, maxBuffer: 1 << 24 });
  /** One CLI call, saved as NN-<name>.txt with the command, stdout, stderr and exit code. */
  async function nexus(name: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
    let code = 0, stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await cli(args));
    } catch (err) {
      ({ code, stdout, stderr } = err as { code: number; stdout: string; stderr: string });
    }
    const file = `${String(++step).padStart(2, "0")}-${name}.txt`;
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
      await sleep(1000);
    }
  }
  /** The runs of `nexus-claude-hook asks` the probe has started so far. */
  const pulls = () => readFileSync(join(out, "guest.log"), "utf8").split("\n").filter((l) => l.includes("nexus-claude-hook asks")).length;

  try {
    const { openRegistry } = await import(`${src}/control/registry.ts`) as typeof import("../../../src/control/registry.ts");
    const seed = openRegistry(join(runDir, "registry.db"));
    seed.saveImage({ id: image, gondolinBuildId: "stand-in", builtOn: node.name, builtAt: new Date().toISOString(), sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest, null);
    seed.setCurrentImage(image);
    seed.close();
    await child("probe", ["probe", src, runDir]);
    await child("control", ["control", src, runDir]);
    await until("the control plane answers", async () => (await fetch(`${api}/v1/nodes`)).ok, 30_000);
    await nexus("project-add", "project", "add", "sizes", "--scratch", "--node", node.name, "--cpus", "1", "--memory", "3", "--disk", "5");
    const started = await nexus("start", "start", "--project", "sizes", "--title", "Ask about a size", "--claude", prompt, "--model", "claude-sonnet-5-5", "--json");
    const id = (JSON.parse(started.stdout) as { id: string }).id;
    // The dashboard's thread page holds this stream open, which makes the control plane read a running turn every 2 s.
    const watching = new AbortController();
    const frames = fetch(`${api}/v1/threads/${id}/claude/events`, { signal: watching.signal }).then(async (res) => { for await (const _ of res.body!) {} }).catch(() => {});
    log("watching the thread's transcript stream, as its page does");

    await until("the node reports the Claude session working", async () => (await detail(id)).thread.working, 180_000);
    await until("the conversation shows the Bash call", async () => (await cli(["conversation", id])).stdout.includes("sleep 45"), 120_000);
    const from = { at: Date.now(), pulls: pulls() };
    type Asked = { id: string; ask?: unknown; answer: unknown };
    const openAsk = async () => ((await detail(id)).questions as Asked[] | undefined)?.find((q) => q.ask !== undefined && q.answer === null);
    const waiting = await until("the thread waits on AskUserQuestion or its card shows", async () => (await detail(id)).attention === "waiting" || await openAsk(), 300_000);
    const turn = { seconds: (Date.now() - from.at) / 1000, pulls: pulls() - from.pulls };
    log(`while the watched turn ran its Bash command, ${turn.seconds.toFixed(1)} s, the control plane ran nexus-claude-hook asks ${turn.pulls} times`);
    const question = waiting === null ? null : await until("its card shows", () => openAsk(), 60_000);
    log(`card shown at ${Date.now()} ms since the epoch, to compare with the waiting record's at`);
    asks("asks-asked");
    await nexus("show-asked", "show", id);
    if (question !== null) {
      // A person takes a while to answer, which gives the dialog's Notification time to arrive.
      await sleep(20_000);
      const res = await fetch(`${api}/v1/questions/${question.id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choices: [{ picked: ["Large"] }] }) });
      log(`answered ${question.id} with Large through the dashboard's route: HTTP ${res.status}`);
      writeFileSync(join(out, "answer.txt"), `POST /v1/questions/${question.id}/answer {"choices":[{"picked":["Large"]}]}\nHTTP ${res.status}\n${await res.text()}\n`);
    }
    await until("Claude's turn ends with its reply", async () => { const d = await detail(id); return !d.thread.working && d.attention !== "waiting" && d.attention !== "decision"; }, 300_000);
    const idle = pulls();
    await sleep(20_000);
    log(`in the 20 s after the turn ended, the control plane ran nexus-claude-hook asks ${pulls() - idle} times`);
    await nexus("conversation-answered", "conversation", id);
    await nexus("show-answered", "show", id);
    const events = await (await fetch(`${api}/v1/events?thread=${id}&kind=session.turn-started&kind=session.heartbeat&kind=session.waiting&kind=session.turn-ended`)).json() as { kind: string; payload: unknown }[];
    writeFileSync(join(out, "session-events.txt"), events.map((e) => `${e.kind} ${JSON.stringify(e.payload)}`).join("\n") + "\n");
    log(`${events.length} session events -> session-events.txt`);
    writeFileSync(join(out, "summary.txt"), `asks pulls while the watched turn ran its Bash command: ${turn.pulls} in ${turn.seconds.toFixed(1)} s\ncard: ${question === null ? "none" : question.id}\n`);
    watching.abort();
    await frames;
    await nexus("delete", "delete", id);
  } finally {
    await Promise.all([...children].map(stop));
    stopUser();
    rmSync(runDir, { recursive: true, force: true });
  }

  /** What the pylon's hooks keep for the asks that wait, under ~/.nexus/asks, saved as <name>.txt. */
  function asks(name: string) {
    const listing = execFileSync("sudo", sudo(["sh", "-c", `cd ${home}/.nexus/asks 2>/dev/null || { echo "no ${home}/.nexus/asks"; exit 0; }; for f in *; do [ -e "$f" ] || continue; echo "== $f"; head -c 300 "$f"; echo; done`]).slice(1), { encoding: "utf8" });
    writeFileSync(join(out, `${name}.txt`), listing);
    log(`${home}/.nexus/asks -> ${name}.txt`);
  }
}

const sleep = (ms: number) => new Promise((w) => setTimeout(w, ms));
/** Ends every process of the `verify` user: its Herdr server, Claude and the hooks Claude left waiting. */
function stopUser() {
  try { execFileSync("sudo", ["-n", "pkill", "-u", user], { stdio: "ignore" }); } catch {}
}
await (mode === "probe" ? probe() : mode === "control" ? control(rest[0]!) : drive(resolve(rest[0]!)));
