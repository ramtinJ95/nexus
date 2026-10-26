// The stack of docs/verification/claude-turn-snapshots/stack.ts, moved to 127.0.0.1:7473, the bridge on 7491, the Herdr
// server verify-limit and /tmp/nexus-limit-verify, with two changes. The Claude worker's Claude Code reaches the fake API
// on 127.0.0.1:18767 (fake-api.mjs, which the stack starts) with a fake login, so its usage limit is the fake API's to
// hand out. And the control plane's opt-in resumer runs every 2 s, typing through the real inbox and runCommand, with
// a 5-second grace past the reset rather than three minutes, so a run takes minutes rather than an hour.
//
//   node docs/verification/usage-limit-stops/stack.ts
//   HOOKS=old node docs/verification/usage-limit-stops/stack.ts
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { usageLimitResumer } from "../../../src/control/usage-limit.ts";
import { openRegistry, type ThreadId } from "../../../src/control/registry.ts";
import { runCommand, type ProbeDeps } from "../../../src/backend.ts";
import { processStream } from "../../../src/process-stream.ts";
import type { Guest } from "../../../src/backend.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const root = "/tmp/nexus-limit-verify";
const home = join(root, "home");
const repo = join(root, "repo");
const herdrServer = "verify-limit";
const bridgePort = 7491;
const fakeApiPort = 18767;
const node = "verify-node" as NodeName;
const laptop = "nVERIFY" as TailnetNodeId;

mkdirSync(join(home, ".claude"), { recursive: true });
// /poteto-mode, which every Claude worker's prompt starts with, comes from the image's pstack plugin.
execFileSync("ln", ["-sfn", "/home/user/.claude/plugins", join(home, ".claude", "plugins")]);
mkdirSync(repo, { recursive: true });
execFileSync("sh", ["-c", `cd ${repo} && [ -d .git ] || { git init -q -b main && printf '# words\\n' > README.md && git add -A && git -c user.name=verify -c user.email=verify@example.com commit -qm init; }`]);
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const image = new URL("../../../images/pylon/", import.meta.url);
const helper = new URL("../../../src/checkout-files.py", import.meta.url).pathname;
// The hook reports only under the pylon user's HOME, which the stack moves, so the staged copy compares with the moved one.
for (const file of ["nexus-claude-hook", "nexus-heartbeat.ts", "nexus-turn.ts", "nexus-outbox.ts"]) {
  const staged = readFileSync(new URL(file, image), "utf8").replaceAll("/home/user/workspace/repo", repo).replaceAll("/usr/local/lib/nexus/checkout-files.py", helper).replaceAll("userInfo().homedir", "process.env.HOME");
  writeFileSync(join(bin, file), staged, { mode: 0o755 });
}
const hookPath = join(bin, "nexus-claude-hook");
const hook = (kind: string) => [{ matcher: "", hooks: [{ type: "command", command: `${hookPath} ${kind}`, timeout: 2 }] }];
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
  enabledPlugins: { "pstack@cursor-plugins": true },
  extraKnownMarketplaces: { "cursor-plugins": { source: { source: "directory", path: "/opt/nexus/agent-setup/marketplaces/cursor-plugins" } } },
  hooks: {
    SessionStart: [{ matcher: "^(startup|resume|clear|compact|fork)$", hooks: [{ type: "command", command: "bash '/home/user/.claude/hooks/herdr-agent-state.sh' session", timeout: 10 }] }],
    UserPromptSubmit: hook("session.turn-started"), PostToolUse: hook("session.heartbeat"), Stop: hook("session.turn-ended"), SessionEnd: hook("session.ended"),
    // As the image installs them. HOOKS=old leaves out StopFailure, as the image before this branch does.
    ...(process.env.HOOKS === "old" ? {} : { StopFailure: hook("session.turn-ended") }),
  },
}, null, 2));
execFileSync("sh", ["-c", `herdr --session ${herdrServer} workspace list >/dev/null 2>&1 || { setsid -f herdr --session ${herdrServer} server </dev/null >/dev/null 2>&1; sleep 1; }`]);

/** The pylon's paths and Herdr server, moved under `root`. Herdr's own CLI keeps the real HOME, where its socket is. */
const moved = (arg: string) => arg.replaceAll("/home/user/workspace/repo", repo).replaceAll("/home/user", home).replaceAll("--session nexus", `--session ${herdrServer}`);
const run = (argv: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv) => new Promise<{ exitCode: number | null; output: string; truncated: boolean }>((resolve) => {
  execFile(argv[0]!, argv.slice(1), { env, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
    resolve({ exitCode: code, output: stdout + stderr, truncated: false });
  });
});
const guest = {
  async exec(argv: readonly string[], options: { timeoutMs: number }) {
    const herdr = argv[0] === "herdr";
    const local = herdr ? ["herdr", "--session", herdrServer, ...argv.slice(3).map(moved)] : argv.map(moved);
    // A script that runs Herdr, such as the one that types a message, needs the real HOME, where Herdr's socket is.
    const result = await run(local, options.timeoutMs, herdr || argv.some((a) => a.includes("herdr --session")) ? process.env : { ...process.env, HOME: home });
    if (herdr && argv[3] === "workspace" && argv[4] === "create" && result.exitCode === 0) {
      const pane = JSON.parse(result.output.trim().split("\n").at(-1)!).result.root_pane.pane_id as string;
      await run(["herdr", "--session", herdrServer, "pane", "run", pane, `export HOME=${home} NEXUS_API=http://127.0.0.1:${bridgePort} ANTHROPIC_BASE_URL=http://127.0.0.1:${fakeApiPort} CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake CLAUDE_CODE_MAX_RETRIES=0; cd ${repo}; clear`], 10_000, process.env);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return result;
  },
} as unknown as Guest;
const deps = { node, backend: { guest: () => guest }, serve: { withdraw: async () => {} } } as unknown as ProbeDeps;

const registry = openRegistry(join(root, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: "nVERIFYNODE" as TailnetNodeId });
const record = { id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-25T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never;
registry.saveImage(record);
registry.setCurrentImage("img-0000000000aa" as never);
if (registry.project("words" as never) === undefined) {
  registry.createProject({ id: "words", repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: ["claude"], preSetup: null } as never);
}

/** Which pylons the node reports running. `POST /verify/pause` and `/verify/run` flip one, as a pause and a wake would. */
const paused = new Set<PylonId>();
function observe() {
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => paused.has(p.pylonId) ? { pylonId: p.pylonId, phase: "stopped" as const, checkpoint: null, sessions: null } : {
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2026-10-25T00:00:00Z",
    bootedFrom: { image: "img-0000000000aa" as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  });
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, previewRoutes: [] }, []);
}

const api = await startApi({
  registry, host: "127.0.0.1", port: 7473,
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1", "localhost"]),
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  harness: fakeHarness().harness,
  wake: () => {},
  probes: new Map([[node, {
    async command(pylonId: PylonId, command: never) {
      if (paused.has(pylonId)) throw Object.assign(new Error(`${pylonId} is paused, not running`), { code: "not-running" });
      return runCommand(pylonId, command, deps);
    },
    async stream(pylonId: PylonId, argv: readonly string[]) {
      if (paused.has(pylonId)) throw Object.assign(new Error(`${pylonId} is paused, not running`), { code: "not-running" });
      const local = argv.map(moved);
      return processStream(local[0]!, local.slice(1), (text) => process.stderr.write(text));
    },
  }]]) as never,
  previewPorts: { first: 10200, last: 10299 },
});

// The reconcile loop's launch of a pending worker, as src/control/loop.ts runs it once the pylon runs.
// Past the receipt of an earlier run of this stack, which the registry would take for replays.
let sequence = Date.now();
async function launch() {
  for (const t of registry.threads()) {
    const worker = registry.claudeWorker(t.id);
    if (worker?.state !== "pending") continue;
    const session = crypto.randomUUID();
    registry.setClaudeWorker(t.id, worker.prompt, "starting", undefined, session);
    try {
      await runCommand(t.pylonId, { kind: "open-session", harness: "claude-code", title: t.title.slice(0, 80), resume: session, prompt: worker.prompt, model: worker.model ?? "claude-opus-5-5" }, deps);
      registry.setClaudeWorker(t.id, worker.prompt, "started");
      console.log(`launched ${t.id} as Claude session ${session}`);
    } catch (err) {
      registry.setClaudeWorker(t.id, worker.prompt, "failed", (err as Error).message);
      console.error(`launch of ${t.id} failed: ${(err as Error).message}`);
    }
  }
}
let launching = false;
setInterval(() => {
  observe();
  if (launching) return;
  launching = true;
  void launch().finally(() => { launching = false; });
}, 1000);

// The host bridge and probe, for the hooks: each event goes to the registry as the probe's observation carries it.
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try {
      if (req.url === "/v1/request") {
        const request = JSON.parse(body);
        const thread = registry.threads().find((t) => registry.claudeWorker(t.id)?.session === request.session && t.status === "active");
        if (request.op === "event" && thread !== undefined) {
          registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind: request.kind, session: request.session, ...(request.at === undefined ? {} : { at: request.at }) } });
          console.log(`event ${request.kind} for ${thread.id}`);
        }
        return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      const flip = /^\/verify\/(pause|run)\/(th-[0-9a-f]+)$/.exec(req.url ?? "");
      if (flip !== null) {
        const pylon = `pylon-${flip[2]}` as PylonId;
        if (flip[1] === "pause") paused.add(pylon); else paused.delete(pylon);
        observe();
        console.log(`${pylon} is ${flip[1] === "pause" ? "paused" : "running"}`);
        return void res.writeHead(204).end();
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500).end((err as Error).message);
    }
  });
}).listen(bridgePort, "127.0.0.1");

const fakeApi = spawn(process.execPath, [new URL("fake-api.mjs", import.meta.url).pathname, String(fakeApiPort), "limit", String(Math.floor(Date.now() / 1000) + 120)], { stdio: ["ignore", "inherit", "inherit"] });
process.on("exit", () => fakeApi.kill());

const commandProbe = { command: (pylonId: PylonId, command: never) => runCommand(pylonId, command, deps) };
const inbox = agentInbox({ registry, harness: fakeHarness().harness, probes: new Map([[node, commandProbe]]) as never, wake: () => {} });
const resumer = usageLimitResumer({ registry, inbox, graceMs: 5_000 });
setInterval(() => void resumer.poll(), 2_000);

console.log(`verify stack: API at http://127.0.0.1:${api.port}, fake API on ${fakeApiPort}, bridge on ${bridgePort}, Herdr server ${herdrServer}, HOME ${home}`);
export type { ThreadId };
