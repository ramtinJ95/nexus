// A local Nexus control plane for the verify-pylon captures: the real registry, API, dashboard, PR watch, inbox, review
// loop, thread starter and placement, and the real check runner for both .nexus/check and the live check, wired as
// src/control/main.ts wires them, on 127.0.0.1:7470 for a deployer. Stand-ins replace only what cannot run here:
//  - GitHub is a fetch handler behind the real githubClient, over two local git repositories. ramtinJ95/nexus has a
//    .nexus/verify, ramtinJ95/greeter has none. A builder's push opens a PR at a real commit of its repository.
//  - Two nodes report themselves online. verify-node is every project's default and does not nest KVM. rj-firebat
//    reports nestedVirtualization, so it is the only node a verify pylon can go to. Every pylon reports running.
//  - The probe's stream is the fake verify pylon: it clones the pylon's repository at the pylon's commit into a
//    directory of its own, and runs the gate's script there as a local process, so the script and its exit status are
//    real. The image environment is a file. No VM boots, and no KVM module loads.
//  - Builders are Claude workers with no Claude Code. Each message typed into one is logged in typed.log, and one that
//    gives it a LIVE finding is answered a second later, rejecting it.
//  - Reviewers are harness threads in the test's fake harness, which approve every head they are sent.
//  - Both nodes report each desired release healthy at once. The planner is not running, so the stand-in reports an
//    archived thread's pylon stopped and every other running.
// The PR watch polls every 2 s and the review loop every second, instead of every 2 minutes and 15 s.
//
//   OUT=... node docs/verification/verify-pylon/stack.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { checkRuns, imageEnv, verifyGate } from "../../../src/control/gate.ts";
import { githubClient } from "../../../src/control/github.ts";
import { agentInbox } from "../../../src/control/inbox.ts";
import { prWatcher } from "../../../src/control/pr-watch.ts";
import { openRegistry, type Thread, type ThreadId } from "../../../src/control/registry.ts";
import { canDeploy } from "../../../src/control/releases.ts";
import { agentReplies, reviewLoop } from "../../../src/control/review.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { processStream } from "../../../src/process-stream.ts";
import { checkoutDir } from "../../../src/sessions.ts";
import type { ImageId } from "../../../src/images.ts";
import type { CommandResult, NodeName, PylonCommand, PylonId, TailnetNodeId } from "../../../src/protocol.ts";
import { transcriptStart, type TranscriptCursor } from "../../../src/claude-transcript.ts";

const out = process.env.OUT ?? mkdtempSync(join(tmpdir(), "nexus-verify-pylon-out-"));
const work = mkdtempSync(join(tmpdir(), "nexus-verify-pylon-"));
const log = (file: string, line: string) => appendFileSync(join(out, file), `${new Date().toISOString()} ${line}\n`);
const flat = "verify-node" as NodeName;
const nests = "rj-firebat" as NodeName;
const nodeId = "nNODE" as TailnetNodeId;
const laptop = "nLAPTOP" as TailnetNodeId;
const registry = openRegistry(join(work, "registry.db"));
registry.upsertNode({ name: flat, tailnetHost: "verify-node.tail.ts.net", tailnetNodeId: nodeId });
registry.upsertNode({ name: nests, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
const deployment = { self: nodeId, deployers: new Set([laptop]), keys: {} };

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=verify", "-c", "user.email=verify@example.com", ...args], { encoding: "utf8" }).trim();
const executable = (path: string, body: string) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
/** A repository whose main has .nexus/check, and .nexus/verify when `verify` is given. */
function repository(name: string, verify: string | null) {
  const dir = join(work, name);
  mkdirSync(join(dir, ".nexus"), { recursive: true });
  mkdirSync(join(dir, "src"));
  git(work, "init", "-q", "-b", "main", dir);
  executable(join(dir, ".nexus", "check"), "echo typecheck ok; echo 3 tests pass");
  if (verify !== null) executable(join(dir, ".nexus", "verify"), verify);
  writeFileSync(join(dir, "src", "greeting.txt"), "Hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "main");
  return { dir, main: git(dir, "rev-parse", "HEAD") };
}
const verifyScript = [
  'echo "booting $(git rev-parse --short HEAD) as a fleet: a control plane, a probe and one pylon"',
  'greeting=$(cat src/greeting.txt)',
  'case "$greeting" in Hello*) echo "the pylon answered: $greeting" ;; *) echo "the pylon answered: $greeting, which is not a greeting"; exit 1 ;; esac',
].join("\n");
const repos: Record<string, ReturnType<typeof repository>> = { "ramtinJ95/nexus": repository("nexus", verifyScript), "ramtinJ95/greeter": repository("greeter", null) };
const image = join(work, "environ");
writeFileSync(image, `PATH=${process.env.PATH}\0HOME=/root\0`);

let main = repos["ramtinJ95/nexus"]!.main;
registry.setDesiredRelease({ commit: main, requestedBy: "verify seed", requestedAt: Date.now() });
const reportHealthy = (release: string) => {
  registry.reportRelease({ node: flat, role: "control", commit: release, target: release, state: "healthy", reason: null, observedAt: Date.now() });
  for (const node of [flat, nests]) registry.reportRelease({ node, role: "probe", commit: release, target: release, state: "healthy", reason: null, observedAt: Date.now() });
};
reportHealthy(main);

interface Pr { repo: string; number: number; title: string; branch: string; head: string; body: string; merged: string | null }
const prs: Pr[] = [];
const pull = (p: Pr) => ({
  number: p.number, title: p.title, html_url: `https://github.com/${p.repo}/pull/${p.number}`, state: p.merged === null ? "open" : "closed", merged: p.merged !== null, body: p.body, merge_commit_sha: p.merged,
  head: { sha: p.head, ref: p.branch, repo: { full_name: p.repo } }, base: { ref: "main" }, mergeable_state: "clean",
});
const fakeGitHub: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const [, , owner, name, ...rest] = url.pathname.split("/");
  const repo = `${owner}/${name}`;
  const tail = `/${rest.join("/")}`;
  const number = Number(/^\/(?:pulls|issues)\/(\d+)/.exec(tail)?.[1]);
  const p = prs.find((pr) => pr.repo === repo && pr.number === number);
  if (method !== "GET") log("github.log", `${method} ${url.pathname}${init?.body ? ` ${String(init.body)}` : ""}`);
  if (tail === "/pulls") {
    const branch = url.searchParams.get("head")!.split(":")[1];
    return Response.json(prs.filter((pr) => pr.repo === repo && pr.branch === branch && pr.merged === null).map(pull));
  }
  if (tail.startsWith("/contents/")) {
    const path = tail.slice("/contents/".length);
    const ref = url.searchParams.get("ref")!;
    let found = true;
    try { git(repos[repo]!.dir, "cat-file", "-e", `${ref}:${path}`); } catch { found = false; }
    log("github.log", `GET contents ${repo} ${path} at ${ref.slice(0, 12)}: ${found ? 200 : 404}`);
    return found ? Response.json({ type: "file", path }) : Response.json({ message: "Not Found" }, { status: 404 });
  }
  if (p !== undefined && tail === `/pulls/${p.number}`) return Response.json(pull(p));
  if (p !== undefined && tail === `/pulls/${p.number}/files`) return Response.json([{ filename: "src/greeting.txt", patch: "@@ -1 +1 @@\n-Hello\n+" + git(repos[repo]!.dir, "show", `${p.head}:src/greeting.txt`) }]);
  if (p !== undefined && tail === `/pulls/${p.number}/merge` && method === "PUT") {
    const { sha } = JSON.parse(String(init!.body));
    if (sha !== p.head) return Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
    const dir = repos[repo]!.dir;
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", p.branch);
    git(dir, "commit", "-qm", p.title);
    p.merged = git(dir, "rev-parse", "HEAD");
    if (repo === "ramtinJ95/nexus") main = p.merged;
    log("github.log", `merged ${repo}#${p.number} at ${sha} as ${p.merged}`);
    return Response.json({ sha: p.merged, merged: true, message: "Pull Request successfully merged" });
  }
  if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] });
  return Response.json([]);
};
const github = githubClient("verify-token", fakeGitHub);

const fake = fakeHarness();
const harness = {
  ...fake.harness,
  async send(threadId: string, text: string, requestId: string, mode: "followUp" | "steer", sender?: "pr-watch" | "review") {
    const submission = await fake.harness.send(threadId, text, requestId, mode, sender);
    log("reviewer.log", `${threadId} received ${requestId}`);
    setTimeout(() => approve(threadId as ThreadId, text), 1_000);
    return submission;
  },
};
const tokenOf = (text: string) => /"token": "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(text)?.[1] ?? /token "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(text)?.[1];
function approve(thread: ThreadId, request: string) {
  const token = tokenOf(request);
  const head = registry.reviews().find((r) => r.reviewer === thread)?.rounds.at(-1)?.head;
  const pr = prs.find((p) => p.head === head);
  if (token === undefined || head === undefined || pr === undefined) return;
  const quote = /Not checked live: (.*)/.exec(pr.body)?.[1] ?? null;
  const verdict = { token, verdict: "approve", findings: [], reserved: [], notCheckedLive: quote };
  const text = `I read the change at ${head}. It does what it says.\n\n\`\`\`nexus-review\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
  fake.transcript(thread).messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never);
  fake.commit(thread);
  registry.recordReply(thread, Date.now());
  log("reviewer.log", `${thread} approved ${head}`);
}

// A builder's transcript, as the probe's reads would store it.
const cursors = new Map<ThreadId, TranscriptCursor>();
function transcribe(thread: ThreadId, entries: Parameters<typeof registry.appendClaudeRead>[1]["entries"]) {
  const from = cursors.get(thread) ?? transcriptStart;
  const cursor = { offset: from.offset + 1, skipping: false, before: from.before };
  registry.appendClaudeRead(thread, { session: registry.claudeWorker(thread)!.session!, from, entries, cursor, reset: false, readAt: Date.now() });
  cursors.set(thread, cursor);
}
function builderTyped(thread: Thread, text: string) {
  log("typed.log", `typed into ${thread.id}:\n${text}\n`);
  transcribe(thread.id, [{ kind: "prompt", at: Date.now(), text, from: "person" }]);
  const token = /"token": "(rv-[0-9a-f]+:[0-9a-f]+)"/.exec(text)?.[1];
  if (token === undefined || !text.includes("LIVE (P0)")) return;
  setTimeout(() => {
    const answers = { token, answers: [{ id: "LIVE", action: "rejected", reason: "The greeting is meant to say goodbye; the live check's script is wrong." }] };
    transcribe(thread.id, [{ kind: "reply", at: Date.now(), text: `I will not change the greeting.\n\n\`\`\`nexus-review-answers\n${JSON.stringify(answers)}\n\`\`\`` }]);
    registry.recordReply(thread.id, Date.now());
    log("typed.log", `${thread.id} rejected LIVE`);
  }, 1_000);
}

/** The fake verify pylon, and the fake check pylon: the pylon's repository at its commit, with the gate's script run here. */
async function stream(pylonId: PylonId, argv: readonly string[]) {
  if (argv[3] !== "nexus-check" && argv[3] !== "nexus-verify") throw Object.assign(new Error("the verify stack's pylons run only the gates' scripts"), { code: "unsupported" });
  const pylon = registry.pylon(pylonId)!;
  const repo = pylon.boot.repo.kind === "clone" ? pylon.boot.repo : null;
  const origin = Object.values(repos).find((r) => repo !== null && repo.url.endsWith(`${r.dir.split("/").at(-1)}.git`))!;
  const checkout = join(work, "pylons", pylonId);
  rmSync(checkout, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin.dir, checkout]);
  git(checkout, "checkout", "-q", "--detach", repo!.checkout.commit);
  log("pylons.log", `${pylonId} on ${pylon.node}, ${JSON.stringify(pylon.boot.resources)}, runs ${argv[3]} at ${repo!.checkout.commit.slice(0, 12)}`);
  return processStream("sh", ["-c", argv[2]!.replaceAll(checkoutDir, checkout).replace(imageEnv, `cat ${image}`), ...argv.slice(3)], () => {});
}

const probe = {
  stream,
  async command(pylonId: PylonId, command: PylonCommand): Promise<CommandResult> {
    const thread = registry.threads().find((t) => t.pylonId === pylonId)!;
    if (command.kind === "send-claude") {
      builderTyped(thread, command.text);
      return { kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false };
    }
    if (command.kind === "send-claude-outcome") return { kind: "send-claude-outcome", send: "unknown" };
    throw Object.assign(new Error(`the verify stack's pylons run no ${command.kind}`), { code: "unsupported" });
  },
};
const probes = new Map([[flat, probe], [nests, probe]]);
const wake = () => {};
const wakeThread = (t: Thread) => log("wake.log", `woke the planner for ${t.id} (${t.title}), now ${registry.thread(t.id)?.status}`);
const inbox = agentInbox({ registry, harness, probes: probes as never, wake });
const mirror = { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote, so every thread boots fresh")) };
const dotfiles = { repo: "https://example.com/dotfiles.git", ref: "main" };
const startThread = threadStarter({ registry, harness, mirror, dotfiles, wake });

const reviews = reviewLoop({
  registry, github, inbox, harnessModel: "gpt-6-astra", startThread,
  replies: agentReplies(registry, harness),
  checks: checkRuns({ registry, probes: probes as never, startThread, wake: wakeThread }),
  live: checkRuns({ registry, probes: probes as never, startThread, wake: wakeThread, gate: verifyGate }),
  release: { self: nodeId, repo: "ramtinJ95/nexus" },
  mayLand: (caller) => canDeploy(registry, deployment, caller as TailnetNodeId),
  wake: wakeThread,
  log: (message) => log("stack.log", message),
});
const watch = prWatcher({ registry, github, inbox, linked: reviews.auto });

const api = await startApi({
  registry, host: "127.0.0.1", port: 7470, prWatchEnabled: true, reviews, deployment, whois: async () => laptop, allowed: new Set([laptop]),
  hostnames: new Set(["127.0.0.1", "localhost"]),
  harness, startThread, wake, probes: probes as never, previewPorts: { first: 10200, last: 10299 },
});

const call = async (method: string, path: string, payload: unknown) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
};
const manifest = {
  id: "img-0123456789ab", gondolinBuildId: "b1", builtOn: nests, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: `sha256:${"d".repeat(64)}`, node: "26.12.1", nodeSha256: "e".repeat(64), claudeCode: "c", pi: "p", herdr: "h", piEnv: "e",
    piEnvSha256: "f".repeat(64), gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f", gh: "2.103.2", ghSha256: "a".repeat(64),
    neovim: "0.12.6", neovimSha256: "b".repeat(64),
  },
};
await call("POST", "/v1/images", manifest);
registry.setCurrentImage(manifest.id as ImageId);
for (const id of ["nexus", "greeter"]) {
  await call("POST", "/v1/projects", {
    id, repoUrl: `https://github.com/ramtinJ95/${id}.git`, defaultBranch: "main", defaultNode: flat,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  });
}

function observe() {
  for (const node of [flat, nests]) {
    const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
    registry.apply({ record: "node", node, state: "online", capacity });
    const pylons = registry.pylonsOn(node).map((p) => registry.thread(p.thread as ThreadId)!.status === "active" ? {
      pylonId: p.pylonId, phase: "running" as const, liveHash: p.liveHash, bootedAt: "2027-01-01T00:00:00Z",
      bootedFrom: { image: manifest.id as `img-${string}`, checkpoint: null },
      services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    } : { pylonId: p.pylonId, phase: "stopped" as const, checkpoint: null, sessions: null });
    registry.ingested({
      node, observedAt: new Date().toISOString(), probeBootId: "verify", events: [], capacity, artifacts: [manifest.id] as never, jobs: [], pylons: pylons as never,
      grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [], ...node === nests ? { nestedVirtualization: true as const } : {},
    }, []);
  }
}

// What the reconcile loop's launch and a builder's first push would leave: a started worker, a PR at a real commit, a branch output.
let numbers = 0;
function launch() {
  for (const t of registry.threads()) {
    const worker = registry.claudeWorker(t.id);
    if (worker?.state !== "pending") continue;
    registry.setClaudeWorker(t.id, worker.prompt, "started", undefined, crypto.randomUUID());
    const [, branch, greeting, statement] = /push ([\w-]+) "([^"]+)"(?: not checked live: (.*))?/.exec(worker.prompt) ?? [];
    if (branch === undefined) continue;
    const repo = `ramtinJ95/${t.project}`;
    const dir = repos[repo]!.dir;
    git(dir, "checkout", "-q", "-b", branch, "main");
    writeFileSync(join(dir, "src", "greeting.txt"), `${greeting}\n`);
    git(dir, "commit", "-qam", t.title);
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    const body = `Changes the greeting to "${greeting}".${statement === undefined ? "" : `\n\nNot checked live: ${statement}`}`;
    const pr: Pr = { repo, number: ++numbers, title: t.title, branch, head, body, merged: null };
    prs.push(pr);
    registry.apply({ record: "output", pylonId: t.pylonId, kind: "branch", ref: `origin/${branch}` });
    transcribe(t.id, [{ kind: "prompt", at: Date.now(), text: worker.prompt, from: "person" }, { kind: "reply", at: Date.now(), text: `Pushed ${branch} at ${head} and opened PR #${pr.number}.` }]);
    registry.recordReply(t.id, Date.now());
    log("github.log", `${t.id} pushed ${branch} at ${head}, opening ${repo}#${pr.number}`);
  }
}

let deployed = main;
setInterval(() => {
  observe();
  launch();
  const desired = registry.desiredRelease()!.commit;
  if (desired !== deployed) {
    deployed = desired;
    reportHealthy(desired);
    log("release.log", `desired release ${desired} by ${registry.desiredRelease()!.requestedBy}, reported healthy`);
  }
}, 200);
setInterval(() => { void watch.poll(); }, 2_000);
setInterval(() => { void reviews.poll(); }, 1_000);
observe();
console.log(JSON.stringify({ out }));
