// A local Nexus control plane for the review loop: the real registry, API, PR watch and review loop on 127.0.0.1:7470,
// with a real Claude Code builder in a Herdr pane under the real sessions.ts code, as in claude-thread-streaming/stack.ts.
// Stand-ins replace only what a pylon cannot host:
//  - GitHub is a fetch handler over a local bare repository, origin.git. A pushed `feature` branch opens PR #1 there, as
//    `gh pr create` would, with a fixed description. Its merge squashes the branch into main. Every request is logged.
//  - The reviewer is a harness thread whose model is scripted: it reads greet.sh at the head it was asked to review from
//    origin.git, runs it, and requests a change until `sh greet.sh Ada` prints `hello Ada`.
//  - The probe's git facts are the branch output this stack records once origin.git has `feature`.
//  - The node's release worker reports each new desired release healthy after 3 s, or rolled back with FAIL_DEPLOY=1.
//  - A check thread's pylon is a fresh clone here at the commit its boot names, made when its pipe opens, so the real
//    check script and .nexus/check run, and the verdict is the local process's exit status. Each pipe is logged.
//
//   node docs/verification/review-flow/stack.ts
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { openRegistry, type ThreadId } from "../../../src/control/registry.ts";
import { runCommand, type ProbeDeps, type Guest } from "../../../src/backend.ts";
import { processStream } from "../../../src/process-stream.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { agentReplies, reviewLoop } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { checkCaller, checkRuns } from "../../../src/control/gate.ts";
import type { CommandResult, NodeName, PylonCommand, PylonId, TailnetNodeId } from "../../../src/protocol.ts";

const root = "/tmp/nexus-review-verify";
const evidence = process.env.EVIDENCE ?? join(root, "evidence");
const home = join(root, "home");
const origin = join(root, "origin.git");
const builderRepo = join(root, "builder");
const herdrServer = "verify-review";
const bridgePort = 7489;
const node = "verify-node" as NodeName;
const nodeId = "nVERIFYNODE" as TailnetNodeId;
const laptop = "nVERIFY" as TailnetNodeId;
const repo = "ramtinJ95/nexus";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=verify", "-c", "user.email=verify@example.com", ...args], { encoding: "utf8" }).trim();
const log = (file: string, line: string) => appendFileSync(join(evidence, file), `${new Date().toISOString()} ${line}\n`);

rmSync(root, { recursive: true, force: true });
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(evidence, { recursive: true });
execFileSync("ln", ["-sfn", "/home/user/.claude/plugins", join(home, ".claude", "plugins")]);
execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
const seed = join(root, "seed");
execFileSync("git", ["init", "-q", "-b", "main", seed]);
mkdirSync(join(seed, ".nexus"));
writeFileSync(join(seed, "README.md"), "# greet\n\nA tiny repository for the review loop's verification.\n");
writeFileSync(join(seed, ".nexus", "check"), "#!/bin/sh\nset -e\n[ \"$(sh greet.sh)\" = hello ]\n[ \"$(sh greet.sh Ada)\" = \"hello Ada\" ]\necho check passed\n", { mode: 0o755 });
git(seed, "add", "-A");
git(seed, "commit", "-qm", "init");
git(seed, "push", "-q", origin, "main");
execFileSync("git", ["clone", "-q", origin, builderRepo]);
/** A check pylon's checkout: a fresh clone at the commit its boot names, as the pylon's first boot would clone it. */
function checkRepo(pylon: PylonId): string {
  const dir = join(root, pylon);
  const boot = registry.pylon(pylon)!.boot.repo;
  rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin, dir]);
  if (boot.kind === "clone") git(dir, "checkout", "-q", "--detach", boot.checkout.commit);
  return dir;
}

const hook = (kind: string) => [{ matcher: "", hooks: [{ type: "command", command: `/usr/local/bin/nexus-claude-hook ${kind}`, timeout: 2 }] }];
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
  enabledPlugins: { "pstack@cursor-plugins": true },
  extraKnownMarketplaces: { "cursor-plugins": { source: { source: "directory", path: "/opt/nexus/agent-setup/marketplaces/cursor-plugins" } } },
  hooks: {
    SessionStart: [{ matcher: "^(startup|resume|clear|compact|fork)$", hooks: [{ type: "command", command: "bash '/home/user/.claude/hooks/herdr-agent-state.sh' session", timeout: 10 }] }],
    UserPromptSubmit: hook("session.turn-started"), PostToolUse: hook("session.heartbeat"), Stop: hook("session.turn-ended"), SessionEnd: hook("session.ended"),
  },
}, null, 2));
execFileSync("sh", ["-c", `herdr --session ${herdrServer} workspace list >/dev/null 2>&1 || { setsid -f herdr --session ${herdrServer} server </dev/null >/dev/null 2>&1; sleep 1; }`]);

/** The builder pylon's paths and Herdr server, moved under `root`. Herdr's own CLI keeps the real HOME, where its socket is. */
const moved = (arg: string) => arg.replaceAll("/home/user/workspace/repo", builderRepo).replaceAll("/home/user", home).replaceAll("--session nexus", `--session ${herdrServer}`);
const run = (argv: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv, cwd?: string) => new Promise<{ exitCode: number | null; output: string; truncated: boolean }>((resolve) => {
  execFile(argv[0]!, argv.slice(1), { env, timeout: timeoutMs, maxBuffer: 1 << 20, ...(cwd === undefined ? {} : { cwd }) }, (err, stdout, stderr) => {
    const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
    resolve({ exitCode: code, output: stdout + stderr, truncated: false });
  });
});
const guest = {
  async exec(argv: readonly string[], options: { timeoutMs: number }) {
    const herdr = argv[0] === "herdr";
    const local = herdr ? ["herdr", "--session", herdrServer, ...argv.slice(3).map(moved)] : argv.map(moved);
    const result = await run(local, options.timeoutMs, herdr || argv.some((a) => a.includes("herdr --session")) ? process.env : { ...process.env, HOME: home });
    if (herdr && argv[3] === "workspace" && argv[4] === "create" && result.exitCode === 0) {
      const pane = JSON.parse(result.output.trim().split("\n").at(-1)!).result.root_pane.pane_id as string;
      await run(["herdr", "--session", herdrServer, "pane", "run", pane, `. /etc/profile.d/nexus-secrets.sh; export HOME=${home} NEXUS_API=http://127.0.0.1:${bridgePort}; cd ${builderRepo}; clear`], 10_000, process.env);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return result;
  },
} as unknown as Guest;
const deps = { node, backend: { guest: () => guest }, serve: { withdraw: async () => {} } } as unknown as ProbeDeps;

const registry = openRegistry(join(root, "registry.db"));
registry.upsertNode({ name: node, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
registry.saveImage({ id: "img-0000000000aa", gondolinBuildId: "b1", builtOn: node, builtAt: "2026-10-26T00:00:00Z", sha256: "a".repeat(64), pins: {} } as never);
registry.setCurrentImage("img-0000000000aa" as never);
registry.createProject({ id: "nexus", repoUrl: `https://github.com/${repo}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: ["claude"], preSetup: null } as never);
registry.setDesiredRelease({ commit: git(origin, "rev-parse", "main"), requestedBy: "verify seed", requestedAt: Date.now() });
for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: git(origin, "rev-parse", "main"), target: git(origin, "rev-parse", "main"), state: "healthy", reason: null, observedAt: Date.now() });

function observe() {
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 };
  registry.apply({ record: "node", node, state: "online", capacity });
  const pylons = registry.pylonsOn(node).map((p) => ({
    pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2026-10-26T00:00:00Z",
    bootedFrom: { image: "img-0000000000aa" as `img-${string}`, checkpoint: null },
    services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
  }));
  registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "verify", capacity, artifacts: [], jobs: [], pylons: pylons as never, previewRoutes: [] }, []);
}

// GitHub, over origin.git.
const pr = { opened: false, merged: null as string | null, comments: [] as { id: number; body: string }[] };
const branchHead = () => { try { return git(origin, "rev-parse", "--verify", "-q", "refs/heads/feature"); } catch { return null; } };
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  log("github.log", `${method} ${url.pathname}${url.search}`);
  const base = `/repos/${repo}`;
  const head = branchHead();
  if (head !== null && !pr.opened) pr.opened = true;
  const p = () => ({
    number: 1, title: "Add greet.sh", html_url: `https://github.com/${repo}/pull/1`, state: pr.merged ? "closed" : "open", merged: pr.merged !== null,
    body: "Adds greet.sh, which greets.\n\nNot checked live: greet.sh is a local script, with no service to start.", merge_commit_sha: pr.merged ?? "t".repeat(40),
    head: { sha: head, ref: "feature", repo: { full_name: repo } }, base: { ref: "main" }, mergeable_state: "clean",
  });
  if (url.pathname === `${base}/pulls`) return Response.json(pr.opened && pr.merged === null ? [p()] : []);
  if (url.pathname === `${base}/pulls/1` && pr.opened) return Response.json(p());
  if (url.pathname === `${base}/pulls/1/files`) {
    const names = git(origin, "diff", "--name-only", `main...${head}`).split("\n").filter(Boolean);
    return Response.json(names.map((filename) => ({ filename, patch: git(origin, "diff", `main...${head}`, "--", filename) })));
  }
  if (url.pathname === `${base}/issues/1/comments`) return Response.json(pr.comments.map((c) => ({ id: c.id, body: c.body, html_url: `https://github.com/${repo}/pull/1#issuecomment-${c.id}`, user: { login: "ramtinJ95" }, author_association: "OWNER" })));
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
  if (url.pathname === `${base}/pulls/1/merge` && method === "PUT") {
    const { sha } = JSON.parse(String(init!.body));
    if (sha !== head) return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
    const work = join(root, "merge");
    rmSync(work, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", origin, work]);
    git(work, "merge", "--squash", "-q", `origin/feature`);
    git(work, "commit", "-qm", "Add greet.sh (#1)");
    git(work, "push", "-q", "origin", "main");
    pr.merged = git(work, "rev-parse", "HEAD");
    log("github.log", `merged ${sha} as ${pr.merged}`);
    return Response.json({ sha: pr.merged, merged: true, message: "Pull Request successfully merged" });
  }
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

// The scripted reviewer: a harness conversation whose answers this stack writes.
const fake = fakeHarness();
const harness = {
  ...fake.harness,
  async send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: "pr-watch" | "review") {
    const submission = await fake.harness.send(threadId, text, requestId, mode, sender);
    log("reviewer.log", `received ${requestId}`);
    setTimeout(() => answer(threadId as ThreadId, text), 2_000);
    return submission;
  },
};
function answer(thread: ThreadId, request: string) {
  const token = /"token": "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(request)?.[1] ?? /token "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(request)?.[1];
  const review = registry.reviews().find((r) => r.reviewer === thread);
  const head = review?.rounds.at(-1)?.head;
  if (token === undefined || head === undefined) return;
  let greeted = "";
  try {
    const script = git(origin, "show", `${head}:greet.sh`);
    greeted = execFileSync("sh", ["-c", script, "greet.sh", "Ada"], { encoding: "utf8" }).trim();
  } catch (err) {
    greeted = `(failed: ${(err as Error).message.split("\n")[0]})`;
  }
  const approve = greeted === "hello Ada";
  const verdict = {
    token, verdict: approve ? "approve" : "changes",
    findings: approve ? [] : [{ id: "F1", severity: "serious", where: "greet.sh:1", summary: `\`sh greet.sh Ada\` prints "${greeted}", not "hello Ada"`, detail: "Greet the name given as the first argument, and keep printing plain `hello` without one." }],
    reserved: [], notCheckedLive: "greet.sh is a local script, with no service to start.",
  };
  const text = `I ran greet.sh at ${head}: \`sh greet.sh Ada\` printed "${greeted}".\n\n\`\`\`nexus-review\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
  fake.transcript(thread).messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never);
  fake.commit(thread);
  registry.recordReply(thread, Date.now());
  log("reviewer.log", `answered ${token}: ${verdict.verdict}`);
}

const probe = {
  async command(pylonId: PylonId, command: PylonCommand): Promise<CommandResult> {
    if (command.kind === "send-claude") log("typed.log", `send-claude to ${pylonId}:\n${command.text}\n`);
    return runCommand(pylonId, command, deps);
  },
  async stream(pylonId: PylonId, argv: readonly string[]) {
    const thread = registry.threads().find((t) => t.pylonId === pylonId);
    if (thread?.startedBy === checkCaller) {
      const dir = checkRepo(pylonId);
      log("check.log", `pipe into ${pylonId}, a fresh clone at ${argv.at(-1)}`);
      const stream = processStream(argv[0]!, argv.slice(1).map((a) => a.replaceAll("/home/user/workspace/repo", dir)), (text) => process.stderr.write(text));
      void stream.done.then((end) => log("check.log", `pipe into ${pylonId} ended: ${JSON.stringify(end)}`));
      return stream;
    }
    const local = argv.map(moved);
    return processStream(local[0]!, local.slice(1), (text) => process.stderr.write(text));
  },
};
const probes = new Map([[node, probe]]);
const wake = () => {};
const inbox = agentInbox({ registry, harness, probes, wake });
const watch = prWatcher({ registry, github, inbox });
const startThread = threadStarter({ registry, harness, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, wake });
const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread,
  replies: agentReplies(registry, harness),
  checks: checkRuns({ registry, probes, startThread, wake }),
  release: { self: nodeId, repo },
  log: (message) => console.error(message),
});

const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: true, reviews,
  deployment: { self: nodeId, deployers: new Set([laptop]), keys: {} },
  whois: async () => laptop, allowed: new Set([laptop]), hostnames: new Set(["127.0.0.1", "localhost"]),
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  harness, wake: () => {}, probes: probes as never,
  previewPorts: { first: 10200, last: 10299 },
});

// The reconcile loop's launch of a pending worker, as src/control/loop.ts runs it once the pylon runs.
let sequence = 0;
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
let deployed = registry.desiredRelease()!.commit;
setInterval(() => {
  observe();
  // The probe's git facts: the builder's pushed branch, as a same-named remote-tracking ref.
  const builder = registry.threads().find((t) => registry.claudeWorker(t.id) !== undefined);
  if (builder !== undefined && branchHead() !== null && !registry.outputs(builder.id).some((o) => o.ref === "origin/feature")) {
    registry.apply({ record: "output", pylonId: builder.pylonId, kind: "branch", ref: "origin/feature" });
    log("stack.log", `recorded branch output origin/feature for ${builder.id}`);
  }
  // The node's release worker.
  const desired = registry.desiredRelease()!.commit;
  if (desired !== deployed) {
    deployed = desired;
    log("release.log", `desired release ${desired} by ${registry.desiredRelease()!.requestedBy}`);
    setTimeout(() => {
      const failed = process.env.FAIL_DEPLOY === "1" && desired === pr.merged;
      for (const role of ["control", "probe"] as const) registry.reportRelease({ node, role, commit: failed ? null : desired, target: desired, state: failed ? "rolled-back" : "healthy", reason: failed ? "health check failed" : null, observedAt: Date.now() });
      log("release.log", `reported ${desired} ${failed ? "rolled-back" : "healthy"}`);
    }, 3_000);
  }
  if (launching) return;
  launching = true;
  void launch().finally(() => { launching = false; });
}, 1000);
setInterval(() => { void watch.poll(); }, 5_000);
setInterval(() => { void reviews.poll(); }, 2_000);

// The host bridge and probe, for the hooks, and the stack's own controls: a PR comment, as the person would post.
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
      if (req.url === "/verify/comment" && req.method === "POST") {
        pr.comments.push({ id: pr.comments.length + 1, body });
        log("github.log", `owner commented: ${body}`);
        return void res.writeHead(204).end();
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500).end((err as Error).message);
    }
  });
}).listen(bridgePort, "127.0.0.1");

console.log(`verify stack: API at http://127.0.0.1:${api.port}, hooks bridge on ${bridgePort}, Herdr server ${herdrServer}, evidence ${evidence}`);
