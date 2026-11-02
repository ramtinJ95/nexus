/**
 * The demo's made-up world: three projects on two nodes, about thirty threads in every state the dashboard tells
 * apart, and the reviews, questions, pipeline items, health and usage around them. Every record goes in through the
 * API or the registry calls the tests use, so the pages read it as they read the control plane's own.
 *
 * Each thread is a row of `threads` below: when it started, where it runs, and what it has, so the world reads as one
 * table rather than thirty scripts.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import { processStream } from "../../process-stream.ts";
import { checkoutDir } from "../../session-harness.ts";
import type { ByteStream } from "../../protocol/streams.ts";
import { observeNode, image, laptop, type testApi } from "../api-test-kit.ts";
import { runningPylon, stoppedPylon, testCapacity, testObservation } from "../../test-kit.ts";
import { sampleOf } from "../node-metrics.ts";
import { personPhase, type Review, type Round } from "../review-model.ts";
import { proposalQuestion } from "../planning.ts";
import { itemRequestId } from "../pipeline.ts";
import { startKey } from "../threads.ts";
import { claudeHook } from "../../../images/pylon/nexus-contract.ts";
import { transcriptStart, type ClaudeEntry } from "../../claude-transcript.ts";
import { checkCaller, reviewPrefix, reviewerCaller, usageLimitPrefix, verifyCaller } from "../../agent-protocol.ts";
import type { AgentCall } from "../../agent-usage.ts";
import type { ImageId, NodeName, ProjectId, PylonId, ThreadId } from "../../ids.ts";
import type { ItemId, ItemRecord } from "../pipeline-store.ts";
import type { Thread } from "../thread-store.ts";
import type { NodeHealth } from "../../protocol/client.ts";
import type { PylonObservation } from "../../protocol/observations.ts";
import type { CommandResult } from "../../protocol/commands.ts";
import type { DoctorReport, Check } from "../doctor-model.ts";
import type { PullRequest } from "../github.ts";
import { claudeTalk, diffSnippet, failingTests, harnessTalk, longConversation, testOutput, typescriptSnippet } from "./demo-talk.ts";

type Demo = Awaited<ReturnType<typeof testApi>>;

const run = promisify(execFile);
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** The registry's clock is Date.now, which the demo shifts into the past while it seeds. */
export const clock = { shift: 0 };
const realNow = Date.now;
Date.now = () => realNow() - clock.shift;
const now = () => realNow();
/** Runs `seed` as if it were `ago` before now. */
async function back<T>(ago: number, seed: () => T | Promise<T>): Promise<T> {
  const before = clock.shift;
  clock.shift = ago;
  try { return await seed(); } finally { clock.shift = before; }
}

const firebat = "rj-firebat" as NodeName;
const testbench = "infra-testbench" as NodeName;
const repos: Record<string, string> = { nexus: "ramtinJ95/nexus", storefront: "ramtinJ95/storefront", "field-notes": "ramtinJ95/field-notes" };

const projects = [
  { id: "nexus", defaultNode: firebat, branch: "main", hosts: ["registry.npmjs.org", "api.github.com"], secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }], pipeline: { autoStart: true } },
  { id: "storefront", defaultNode: firebat, branch: "main", hosts: ["registry.npmjs.org", "api.stripe.com"], secrets: [{ name: "STRIPE_KEY", hosts: ["api.stripe.com"] }], pipeline: { autoStart: false } },
  { id: "field-notes", defaultNode: testbench, branch: "trunk", hosts: ["pypi.org", "files.pythonhosted.org"], secrets: [], pipeline: null },
];

/** How a thread's pylon shows: running, paused (stopped with a checkpoint), broken, or never booted. */
type PylonLook = "running" | "paused" | "broken" | "absent";

interface ThreadSpec {
  key: string;
  project: string;
  title: string;
  /** When it started. */
  ago: number;
  worker: "harness" | "claude" | "planning";
  pylon: PylonLook;
  /** Its agent is mid-turn now, which the live clock keeps so. */
  working?: boolean;
  /** Its last reply, unread unless `seen`. */
  replied?: number;
  seen?: boolean;
  archived?: boolean;
  /** The pipeline item it was started for. */
  item?: string;
  /** The review loop's caller, for a reviewer thread, or a check or verify thread, which starts bare. */
  by?: typeof reviewerCaller | typeof checkCaller | typeof verifyCaller;
  /** Fills in its conversation, reviews and the rest once it exists. */
  extra?: (d: Demo, t: Thread, w: World) => void | Promise<void>;
}

/** What the seeding passes share: each thread by key, and what the live clock keeps moving. */
interface World { threads: Map<string, Thread>; live: { working: Thread[]; talker: Thread | null } }

const pr = (project: string, number: number, title: string, over: Partial<PullRequest> = {}): PullRequest =>
  ({ repo: repos[project]!, number, title, url: `https://github.com/${repos[project]}/pull/${number}`, state: "open", checks: "passing", review: "none", conflict: false, ...over });

const head = (seed: string) => seed.repeat(40).slice(0, 40);

function review(t: Thread, p: PullRequest, over: Partial<Review>): Review {
  return {
    id: `rv-${p.number}`, builder: t.id, reviewer: `${t.id}-review` as ThreadId, pr: { repo: p.repo, number: p.number, url: p.url, title: p.title, branch: `nexus/${p.number}` },
    reviewerKind: "harness", models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, maxRounds: 5, land: null, auto: true, merged: null, waiver: null,
    expect: `rv-${p.number}:t`, sent: 3, outbox: null, asked: "", since: now() - 20 * minute, nudges: 0, startedAt: now() - 3 * hour,
    rounds: [], phase: { kind: "reviewing" }, ...over,
  };
}

const finding = (id: string, priority: "P0" | "P1" | "P2" | "P3", where: string, summary: string, detail?: string) => ({ id, priority, where, summary, detail: detail ?? null });
const round = (h: string, over: Partial<Round> = {}): Round => ({ head: head(h), base: "main", verdict: null, check: null, answers: null, ...over });
const changes = (...findings: ReturnType<typeof finding>[]) => ({ token: "t", verdict: "changes" as const, findings, reserved: [], notCheckedLive: null });
const approve = (...findings: ReturnType<typeof finding>[]) => ({ token: "t", verdict: "approve" as const, findings, reserved: [], notCheckedLive: null });

function linkPr(d: Demo, t: Thread, p: PullRequest) {
  d.registry.savePrWatch(t.id, { links: [{ pr: p, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
}

function talk(d: Demo, t: Thread, messages: readonly Message[]) {
  d.fake.transcript(t.id).messages.push(...messages);
  d.fake.commit(t.id);
}

function claudeTranscript(d: Demo, t: Thread, entries: readonly ClaudeEntry[], session = `${t.id}-s1`) {
  d.registry.setClaudeWorker(t.id, "/poteto-mode", "started", undefined, session);
  d.registry.appendClaudeRead(t.id, { session, from: transcriptStart, entries, cursor: { ...transcriptStart, offset: entries.length }, reset: false, readAt: now() });
}

const threads: ThreadSpec[] = [
  // nexus
  {
    key: "graphs", item: "it-graphs", project: "nexus", title: "Graph node health with 31 days of history", ago: 26 * hour, worker: "harness", pylon: "running", working: true,
    extra(d, t) {
      talk(d, t, longConversation(t.createdAt).messages);
      linkPr(d, t, pr("nexus", 402, "feat: graph each node's health on its page"));
      d.registry.apply({ record: "sessions", pylonId: t.pylonId, sessions: [
        { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "pi", harnessSessionId: "/home/user/.pi/sessions/graphs.jsonl", status: "working", title: "agent", message: null },
        { id: "w2:p1", state: "running", herdrPane: "w2:p1", harness: "shell", harnessSessionId: null, status: "idle", title: "dev server", message: null },
      ] });
      d.registry.allocatePreviews(t.pylonId, ["web"], { first: 10200, last: 10299 });
      d.registry.apply({ record: "preview", pylonId: t.pylonId, service: "web", httpsPort: 10200, ready: true });
      for (const [kind, ref] of [["branch", "origin/feat/node-graphs"], ["diff", "3f9c2e1"], ["preview", "web"]] as const) d.registry.apply({ record: "output", pylonId: t.pylonId, kind, ref });
    },
  },
  {
    key: "attach", project: "nexus", title: "Keep nexus attach alive across a deploy", ago: 5 * hour, worker: "claude", pylon: "running", working: true,
    extra(d, t, w) {
      const c = claudeTalk(t.createdAt)
        .prompt("/poteto-mode The dashboard's terminal and nexus attach drop when the control plane deploys. Make both reconnect on their own, and survive a slow pylon.")
        .reply("I'll reproduce the drop first. Reading the attach route and the client's reconnect logic.")
        .tool("Bash", { command: "rg -n 'reconnect' src/control/attach.ts src/attach-wire.ts", description: "Find reconnect code" }, "src/control/attach.ts:118:  // A terminal that loses its socket does not reconnect.\nsrc/attach-wire.ts:40:export const attachRoute = ...")
        .tool("Read", { file_path: "/home/user/workspace/repo/src/control/attach.ts" }, "     1\t/** A thread's terminal over a WebSocket... */\n   118\t  // A terminal that loses its socket does not reconnect.")
        .reply(`Found it. The socket closes with **1012** (service restart) during a deploy, and the client treats every close as final.\n\nPlan:\n\n1. Treat \`1012\` and \`1006\` as retryable\n2. Back off with jitter:\n\n${typescriptSnippet}\n\n3. Replay the screen from Herdr on reconnect so nothing is lost`)
        .tool("Edit", { file_path: "/home/user/workspace/repo/src/control/dashboard/terminal.js", old_string: "ws.onclose = () => done();", new_string: "ws.onclose = (e) => retryable(e.code) ? reconnect() : done();" }, "The file has been updated.")
        .tool("Bash", { command: "npm test -- src/control/attach.test.ts", description: "Run attach tests" }, "✔ a terminal reconnects after a 1012 close (1.4s)\n✔ a slow pylon's attach waits for its pane (2.1s)\nℹ pass 2")
        .tool("Bash", { command: "git push -u origin feat/attach-survives-deploy && gh pr create --fill" }, "https://github.com/ramtinJ95/nexus/pull/401")
        .pr(401, "ramtinJ95/nexus")
        .reply("Pushed and opened #401. Now checking the CLI's `nexus attach` against a simulated deploy.");
      c.open("Bash", { command: "node scripts/simulate-deploy.ts --drain 20s", description: "Simulate a deploy" });
      claudeTranscript(d, t, c.entries);
      linkPr(d, t, pr("nexus", 401, "feat: the dashboard's terminal and nexus attach survive a deploy and a slow pylon", { checks: "pending" }));
      d.registry.apply({ record: "sessions", pylonId: t.pylonId, sessions: [
        { id: "w1:p1", state: "running", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: `${t.id}-s1`, status: "working", title: "worker", message: null },
      ] });
      w.live.working.push(t);
    },
  },
  {
    key: "plan", project: "nexus", title: "Plan the maintenance wave", ago: 30 * hour, worker: "planning", pylon: "running", replied: 25 * minute,
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt)
        .person("Plan a maintenance wave for the control plane: what's rotting, what's risky, and in which order to fix it. Propose pipeline items.")
        .bash("git log --since='60 days ago' --format='%s' | cut -d: -f1 | sort | uniq -c | sort -rn", "    41 feat\n    23 fix\n     6 refactor\n     2 chore")
        .bash("rg -c 'TODO|FIXME' src | sort -t: -k2 -rn | head -5", "src/control/loop.ts:7\nsrc/control/review.ts:4\nsrc/probe/main.ts:3")
        .say(`I propose three items, in this order:

1. **Split loop.ts by node phase.** It's 2,000 lines and every bug fix touches it.
2. **Prune events older than 90 days.** The registry grows ~40 MB a month.
3. **Move cleanup onto the new model**, after the split.

Each is a question card below. Accept the ones you want in the pipeline.`).messages);
      const block = [
        { block: "b1", index: 0, key: "split", title: "Split loop.ts by node phase", brief: "loop.ts mixes placement, boots and pauses. Split it into one module per phase, behaviour unchanged, tests untouched.", after: [] },
        { block: "b1", index: 1, key: "prune", title: "Prune events older than 90 days", brief: "Add a pruning pass for events, keeping thread.failed events a judgment still needs.", after: [] },
        { block: "b1", index: 2, key: "cleanup", title: "Move cleanup onto the new model", brief: "Port cleanup.ts to cleanup-model.ts's pure rules.", after: ["split"] },
      ];
      for (const p of block) d.registry.askQuestion(proposalQuestion(t, p, block, now() - 25 * minute));
    },
  },
  {
    key: "flaky", item: "it-flaky", project: "nexus", title: "Retry flaky probe reconnects", ago: 20 * hour, worker: "harness", pylon: "running",
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt)
        .person("The probe client gives up on the first reset. Make it retry with backoff and a deadline.")
        .say(`Done in \`protocol/client.ts\`:\n\n${typescriptSnippet}\n\nOpened #398. The review ran out of rounds on one finding I rejected, so it's held for you.`).messages);
      const p = pr("nexus", 398, "fix: the probe client retries a reset with backoff", { summary: "The probe client now retries a connection reset with jittered backoff, up to a 30 s deadline." });
      linkPr(d, t, p);
      d.registry.saveReview(review(t, p, {
        rounds: [
          round("a1", { verdict: changes(finding("F1", "P1", "src/protocol/client.ts:212", "The deadline restarts on each retry, so a node that flaps never gives up."), finding("F2", "P3", "src/protocol/client.ts:190", "Name the magic 500 ms.")), answers: [{ id: "F1", action: "fixed", reason: "The deadline is set once per call now." }, { id: "F2", action: "fixed", reason: "Named it baseDelayMs." }] }),
          round("a2", { verdict: changes(finding("F3", "P2", "src/protocol/client.test.ts", "No test covers a reset after the deadline.")), answers: [{ id: "F3", action: "rejected", reason: "probe client gives up after the deadline covers it, at line 140." }] }),
          round("a3", { verdict: changes(finding("F3", "P2", "src/protocol/client.test.ts", "No test covers a reset after the deadline.", "The cited test resets before the deadline, not after.")) }),
        ],
        phase: { ...personPhase("rounds",
          { code: "open-findings", text: "Finding F3 (P2) is still open after the last round." },
          { code: "unanswered", text: "The builder has not answered F3 in round 3." },
          { code: "github-checks", text: "The pull request's GitHub checks are pending." }), label: { state: "added" } },
      }));
    },
  },
  {
    key: "drain", item: "it-drain", project: "nexus", title: "Drain the queue before a deploy", ago: 9 * hour, worker: "harness", pylon: "running", replied: 50 * minute, seen: true,
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt)
        .person("A deploy should wait for running turns to finish, up to two minutes, then drain.")
        .bash("npm test -- src/control/drain.test.ts", testOutput)
        .say("Opened #400. The reviewer approved round 2, checks passed, and it's landing now.").messages);
      const p = pr("nexus", 400, "feat: a deploy drains running turns first");
      linkPr(d, t, p);
      d.registry.saveReview(review(t, p, {
        land: { requestedBy: laptop },
        rounds: [
          round("b1", { verdict: changes(finding("F1", "P1", "src/control/drain.ts:44", "A turn that starts during the drain is not counted.")), answers: [{ id: "F1", action: "fixed", reason: "The gate closes before counting." }] }),
          round("b2", { verdict: approve(finding("N1", "P3", "src/control/drain.ts", "Consider logging the drained count.")), check: { passed: true, output: testOutput }, live: { kind: "absent" } }),
        ],
        phase: { kind: "deploying", commit: head("c7"), previous: head("fa"), requested: true, deadline: now() + 8 * minute },
      }));
    },
  },
  {
    key: "alerts", item: "it-alerts", project: "nexus", title: "Turn the daily report into health alerts", ago: 3 * day, worker: "harness", pylon: "paused", archived: true,
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt).person("Turn the daily report into health alerts on the dashboard.").say("Merged as #403 and deployed.").messages);
      const p = pr("nexus", 403, "feat: turn the control plane's daily report into health alerts", { state: "merged" });
      linkPr(d, t, p);
      d.registry.saveReview(review(t, p, { land: { requestedBy: laptop }, merged: head("f4"), rounds: [round("c1", { verdict: approve(), check: { passed: true, output: testOutput }, live: { kind: "absent" } })], phase: { kind: "landed", commit: head("f4") } }));
    },
  },
  {
    key: "cert", project: "nexus", title: "Fix doctor's certificate check", ago: 7 * hour, worker: "harness", pylon: "broken",
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt).person("nexus doctor says the certificate expires in 0 days when it has 60. Find out why.")
        .bash("openssl x509 -enddate -noout -in /var/lib/nexus/cert.pem", "notAfter=Dec 30 12:00:00 2026 GMT")
        .fail("pylon is broken: the controller exited\nqemu-system-x86_64: terminating on signal 15 from pid 1").messages);
      const reason = "pylon is broken: the controller exited";
      d.registry.savePylon({ ...d.registry.pylon(t.pylonId)!, failed: reason });
      d.registry.appendEvent("thread.failed", t.id, { message: reason });
      const failure = d.registry.failure(t.id)!.event;
      d.registry.saveJudgment({
        failure, thread: t.id, node: firebat, failed: `${reason}\nqemu: terminating on signal 15`, startedAt: now() - 40 * minute,
        request: { brief: "The pylon of thread 'Fix doctor's certificate check' failed on rj-firebat. Was it the node, the thread's work, or neither?", token: "t" }, conversation: 9,
        reply: "The node was swapping at the time: 7.8 of 8 GiB swap used. Retrying elsewhere is safest, but infra-testbench is near its memory limit too.",
        phase: { kind: "asked", verdict: { answer: "person", why: "neither node has room for a 4 GiB pylon without overcommitting", by: "judgment" } },
      }, null);
      d.registry.askQuestion({ id: `judgment:${failure}`, thread: t.id, text: "The pylon failed on rj-firebat while the node was swapping. Retry it there, move it to infra-testbench, or leave it failed?", options: ["Retry on rj-firebat", "Move to infra-testbench", "Leave it failed"], reserved: null, answerer: "person", askedAt: now() - 30 * minute });
    },
  },
  {
    key: "backfill", project: "nexus", title: "Rewrite the usage backfill", ago: 11 * hour, worker: "claude", pylon: "running",
    extra(d, t) {
      const c = claudeTalk(t.createdAt)
        .prompt("/poteto-mode The usage backfill reads every transcript again on each run. Make it resume from cursors.")
        .tool("Grep", { pattern: "usageCursor", path: "src/control" }, "src/control/usage-store.ts:104:    usageCursor(source, key) {\nsrc/control/usage-backfill.ts:88:  const cursor = registry.usageCursor(...)")
        .reply("The cursors exist but the backfill ignores them. Wiring them in.")
        .tool("Edit", { file_path: "/home/user/workspace/repo/src/control/usage-backfill.ts", old_string: "from: 0", new_string: "from: cursor?.position ?? 0" }, "The file has been updated.");
      c.notice("error", `${usageLimitPrefix} Claude usage limit reached. Your limit will reset at 6pm (Europe/Stockholm).`, now() + 2 * hour);
      claudeTranscript(d, t, c.entries);
    },
  },
  {
    key: "spin", item: "it-spin", project: "nexus", title: "Investigate idle-CPU spin on paused pylons", ago: 4 * hour, worker: "harness", pylon: "running", replied: 6 * minute,
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt).person("Pylons that should be idle burn 15% CPU. Find what spins.")
        .bash("top -b -n1 | head -12", "  PID USER      PR  NI    VIRT    RES  %CPU COMMAND\n 2211 user      20   0  812m  94m  14.7 herdr\n 2302 user      20   0  402m  51m   0.3 node")
        .bash("strace -c -p 2211 -f -e trace=all 2>&1 | head", "% time     seconds  usecs/call     calls    errors syscall\n 97.12    0.412000          3    131072           epoll_wait")
        .say(`Found it. **Herdr polls with a 0 ms timeout** when no client is attached:\n\n\`\`\`rust\nlet timeout = if clients.is_empty() { Duration::ZERO } else { TICK };\n\`\`\`\n\nThat's 131k \`epoll_wait\` calls a second. A fix upstream is one line; I can also pin a patched build in the image. Which do you prefer?`).messages);
      d.registry.recordReply(t.id, now() - 6 * minute);
    },
  },
  {
    key: "retention", project: "nexus", title: "Choose the metrics retention", ago: 2 * hour, worker: "claude", pylon: "running",
    extra(d, t) {
      const c = claudeTalk(t.createdAt)
        .prompt("/poteto-mode The metrics table will grow. Pick a retention and downsampling plan, ask me if it's a trade-off.")
        .tool("Bash", { command: "sqlite3 registry.db 'SELECT count(*), sum(length(values)) FROM node_samples'" }, "1288400|402115520")
        .reply("At this rate the table reaches 4.6 GB in a year. Two options trade disk against detail, so I'll ask.");
      const questions = [
        { question: "How long should raw samples be kept before they are downsampled?", header: "Raw", multiSelect: false, options: [
          { label: "6 hours", description: "Smallest table. Spikes older than 6 h survive only as 5-minute means.", preview: "raw ▓▓░░░░░░░░ 6h\n5m  ▓▓▓▓▓▓▓▓▓▓ 31d" },
          { label: "48 hours", description: "Two days of full detail, about 3× the disk.", preview: "raw ▓▓▓▓▓▓░░░░ 48h\n5m  ▓▓▓▓▓▓▓▓▓▓ 31d" },
        ] },
        { question: "Which series should keep a max as well as a mean?", header: "Max", multiSelect: true, options: [
          { label: "CPU load", description: "Short spikes matter for placement." },
          { label: "Temperatures", description: "Throttling shows in peaks." },
          { label: "Memory", description: "Swap pressure is gradual." },
        ] },
      ];
      const id = c.open("AskUserQuestion", { questions });
      claudeTranscript(d, t, c.entries);
      d.registry.setWaitingAsks(t.id, [{ ask: { session: `${t.id}-s1`, toolUseId: id, questions }, at: now() - 12 * minute }]);
    },
  },
  // storefront
  {
    key: "applepay", item: "it-applepay", project: "storefront", title: "Checkout: add the Apple Pay button", ago: 6 * hour, worker: "harness", pylon: "running", working: true,
    extra(d, t, w) {
      talk(d, t, harnessTalk(t.createdAt).person("Add Apple Pay to checkout using Stripe's Payment Request Button. Hide it where the browser can't pay.")
        .read("src/checkout/PaymentStep.tsx", "export function PaymentStep({ cart }: Props) {\n  return <CardForm cart={cart} />;\n}")
        .edit("src/checkout/PaymentStep.tsx", "return <CardForm cart={cart} />;", "return <>{canPay && <PaymentRequestButton request={request} />}<CardForm cart={cart} /></>;")
        .bash("npm test -- checkout", testOutput)
        .say("Round 1 asked for a fallback when `canMakePayment` rejects. Fixed and pushed; round 2 is under review.").messages);
      const p = pr("storefront", 88, "feat(checkout): Apple Pay via the Payment Request Button", { checks: "pending" });
      linkPr(d, t, p);
      d.registry.saveReview(review(t, p, {
        rounds: [
          round("d1", { verdict: changes(finding("F1", "P1", "src/checkout/PaymentStep.tsx:31", "canMakePayment() can reject in Safari private mode; the button then never hides."), finding("F2", "P2", "src/checkout/PaymentStep.tsx:12", "The amount is sent in dollars, Stripe wants cents.")), answers: [{ id: "F1", action: "fixed", reason: "Caught, treated as unavailable." }, { id: "F2", action: "fixed", reason: "Uses cart.totalCents." }] }),
          round("d2"),
        ],
        reviewer: w.threads.get("applepay-review")!.id,
        phase: { kind: "reviewing" },
      }));
      d.registry.allocatePreviews(t.pylonId, ["web"], { first: 10200, last: 10299 });
      d.registry.apply({ record: "preview", pylonId: t.pylonId, service: "web", httpsPort: 10201, ready: true });
      w.live.working.push(t);
    },
  },
  {
    key: "applepay-review", by: reviewerCaller, project: "storefront", title: "Review of #88: feat(checkout): Apple Pay via the Payment Request Button", ago: 5 * hour, worker: "harness", pylon: "running", replied: 10 * minute, seen: true,
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt)
        .person(`${reviewPrefix} Review round 2 of #88 at dddddddddddd.`)
        .bash("git diff main...HEAD --stat", " src/checkout/PaymentStep.tsx | 14 ++++++++++----\n 1 file changed, 10 insertions(+), 4 deletions(-)")
        .say("Round 2 is under review: F1's fallback is in place, and I am checking F2's test.").messages);
    },
  },
  {
    key: "rounding", project: "storefront", title: "Fix cart rounding on discounted lines", ago: 14 * hour, worker: "claude", pylon: "running", working: true,
    extra(d, t, w) {
      const c = claudeTalk(t.createdAt)
        .prompt("/poteto-mode A 10% discount on 19.99 shows 17.99 in the cart and 17.98 at Stripe. Fix it at the root.")
        .tool("Bash", { command: "npm test -- cart" }, failingTests, true)
        .reply("Reproduced. Totals round each line, then sum; Stripe sums, then rounds. Switching to integer cents end to end.")
        .pr(91, "ramtinJ95/storefront")
        .prompt("Nexus review round 1 found two problems. Answer each finding.", "nexus")
        .reply("Fixing F1 now; F2 I'll reject with a reason.");
      c.open("Edit", { file_path: "src/cart/totals.ts", old_string: "Math.round(line * 100) / 100", new_string: "line" });
      claudeTranscript(d, t, c.entries);
      const p = pr("storefront", 91, "fix(cart): keep totals in integer cents", { checks: "failed" });
      linkPr(d, t, p);
      d.registry.saveReview(review(t, p, {
        reviewerKind: "claude", models: { builder: "claude-opus-5-5", reviewer: "claude-sonnet-5-5" },
        rounds: [round("e1", { verdict: changes(finding("F1", "P0", "src/cart/totals.ts:40", "Refunds still use floats, so a partial refund can be off by a cent.", "refundLine() divides by 100 before summing."), finding("F2", "P2", "src/cart/format.ts", "Use Intl.NumberFormat for the currency.")) })],
        phase: { kind: "fixing" },
      }));
      w.live.working.push(t);
    },
  },
  {
    key: "refunds", project: "storefront", title: "End-to-end tests for the refund flow", ago: 8 * hour, worker: "harness", pylon: "running", replied: 2 * hour, seen: true,
    extra(d, t, w) {
      talk(d, t, harnessTalk(t.createdAt).person("Write Playwright tests for full and partial refunds.").say("Opened #90 with 6 tests. Review approved; the checks are running now.").messages);
      const p = pr("storefront", 90, "test: end-to-end refund flow");
      linkPr(d, t, p);
      d.registry.saveReview(review(t, p, { rounds: [round("f1", { verdict: approve(finding("N1", "P3", "e2e/refund.spec.ts", "The fixtures could share a factory.")) })], phase: { kind: "checking", startedAt: now() - 4 * minute, thread: w.threads.get("refunds-check")!.id } }));
    },
  },
  {
    key: "refunds-check", by: checkCaller, project: "storefront", title: "Check of nexus/90 at ffffffffffff", ago: 5 * minute, worker: "harness", pylon: "running",
  },
  {
    key: "lighthouse", project: "storefront", title: "Product page Lighthouse pass", ago: 7 * hour, worker: "harness", pylon: "paused", replied: 5 * hour, seen: true,
    extra(d, t) { talk(d, t, harnessTalk(t.createdAt).person("Get the product page's Lighthouse performance above 90 on mobile.").say("Up from 71 to 94: lazy-loaded the reviews widget, preloaded the hero image, and dropped 180 KB of moment.js.").messages); },
  },
  {
    key: "inventory", project: "storefront", title: "Inventory sync webhook", ago: 3 * hour, worker: "harness", pylon: "running", replied: 40 * minute, seen: true,
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt).person("Sync inventory from the warehouse webhook into Postgres.").say("The webhook signs with HMAC-SHA256, but the docs don't say which header carries it. Can you check the warehouse dashboard, or should I log the headers of the next delivery?").messages);
      d.registry.reportSession(firebat, { sequence: 1, pylon: t.pylonId, time: now() - 40 * minute, event: { kind: "session.waiting", session: "w1:p1", message: "Asked which header carries the signature" } });
    },
  },
  {
    key: "avif", project: "storefront", title: "Serve product images as AVIF", ago: 2 * day, worker: "harness", pylon: "paused", replied: 40 * hour, seen: true,
    extra(d, t) { talk(d, t, harnessTalk(t.createdAt).person("Serve AVIF with a WebP fallback.").say("Done; images are 38% smaller on average.").messages); },
  },
  {
    key: "banner", project: "storefront", title: "Seasonal banner for the winter sale", ago: 3 * day, worker: "harness", pylon: "absent",
    extra(d, t) { talk(d, t, harnessTalk(t.createdAt).person("Add a dismissible winter sale banner.").say("Added behind the `winterSale` flag.").messages); },
  },
  {
    key: "search", item: "it-search", project: "storefront", title: "Typo tolerance in product search", ago: 4 * day, worker: "harness", pylon: "paused", archived: true,
    extra(d, t) { talk(d, t, harnessTalk(t.createdAt).person("Make search forgive one typo.").say("Merged as #84.").messages); },
  },
  // field-notes
  {
    key: "tagger", project: "field-notes", title: "Train the tagger on the October export", ago: 90 * minute, worker: "claude", pylon: "running", working: true,
    extra(d, t, w) {
      const c = claudeTalk(t.createdAt)
        .prompt("/poteto-mode Retrain the note tagger on the October export and report precision per tag.")
        .tool("Bash", { command: "python -m tagger.train --data exports/2026-10.jsonl --epochs 4" }, "epoch 1/4  loss 0.912  val_f1 0.71\nepoch 2/4  loss 0.604  val_f1 0.79\nepoch 3/4  loss 0.511  val_f1 0.82")
        .reply("Epoch 3 is at 0.82 F1. One more epoch, then the per-tag report.");
      c.open("Bash", { command: "python -m tagger.train --resume --epochs 4" });
      claudeTranscript(d, t, c.entries);
      w.live.working.push(t);
    },
  },
  {
    key: "sync", project: "field-notes", title: "Offline sync conflict resolver", ago: 10 * hour, worker: "harness", pylon: "running", replied: 3 * hour, seen: true,
    extra(d, t, w) {
      talk(d, t, harnessTalk(t.createdAt).person("When two devices edit one note offline, merge by paragraph instead of last-write-wins.").say("Opened #57. Approved; the live check is running in a verify pylon.").messages);
      const p = pr("field-notes", 57, "feat(sync): merge offline edits by paragraph");
      linkPr(d, t, p);
      d.registry.saveReview(review(t, p, { rounds: [round("g1", { verdict: approve(), check: { passed: true, output: testOutput } })], phase: { kind: "verifying", startedAt: now() - 6 * minute, thread: w.threads.get("sync-verify")!.id } }));
    },
  },
  {
    key: "sync-verify", by: verifyCaller, project: "field-notes", title: "Live check of nexus/57 at gggggggggggg", ago: 7 * minute, worker: "harness", pylon: "running",
  },
  {
    key: "dark", project: "field-notes", title: "Dark mode for the reader", ago: 5 * hour, worker: "harness", pylon: "running", replied: 15 * minute,
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt).person("Add a dark mode to the reader that follows the system setting.").say(`Done. The reader follows \`prefers-color-scheme\`, and the toggle in the header overrides it. The colours come from three tokens:\n\n\`\`\`css\n:root { --ink: #1d1d1f; --paper: #fbfaf7; --accent: #2f6fde; }\n@media (prefers-color-scheme: dark) { :root { --ink: #e8e6e3; --paper: #16171a; } }\n\`\`\``).messages);
      d.registry.recordReply(t.id, now() - 15 * minute);
    },
  },
  {
    key: "export", project: "field-notes", title: "Export notes to Markdown", ago: 6 * hour, worker: "claude", pylon: "paused", replied: 4 * hour, seen: true,
    extra(d, t) { claudeTranscript(d, t, claudeTalk(t.createdAt).prompt("/poteto-mode Export a notebook as a folder of Markdown files.").reply("Done: `notes export --format md <notebook>`. Front matter keeps tags and dates.").turn(14 * minute).entries); },
  },
  {
    key: "fts", project: "field-notes", title: "Benchmark SQLite FTS against Tantivy", ago: 5 * day, worker: "harness", pylon: "paused", archived: true,
    extra(d, t) { talk(d, t, harnessTalk(t.createdAt).person("Compare SQLite FTS5 and Tantivy on 200k notes.").say("| Engine | Index | p50 | p99 |\n| --- | --- | --- | --- |\n| FTS5 | 41 s | 3.1 ms | 19 ms |\n| Tantivy | 12 s | 0.9 ms | 6 ms |\n\nFTS5 is fast enough and adds no dependency. I'd stay.").messages); },
  },
  {
    key: "crash", project: "field-notes", title: "Fix the crash on an empty notebook", ago: 2 * hour, worker: "harness", pylon: "broken",
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt).person("The app crashes opening an empty notebook.").messages);
      const reason = "pylon is broken: Setup exited 1. pip could not resolve tagger==0.9.2";
      d.registry.savePylon({ ...d.registry.pylon(t.pylonId)!, failed: reason });
      d.registry.appendEvent("thread.failed", t.id, { message: reason });
    },
  },
  {
    key: "parked", project: "field-notes", title: "Re-index attachments after the schema change", ago: 3 * hour, worker: "harness", pylon: "running",
    extra(d, t) {
      talk(d, t, harnessTalk(t.createdAt).person("Re-index every attachment under the new schema.").bash("notes reindex --all", "re-indexed 12,400 of 31,882 attachments\nKilled", true).messages);
      d.fake.park(t.id, 2);
    },
  },
];

/** The fake probe's guest commands: every one succeeds, as on a healthy pylon. */
const answer = async (command: { kind: string; port?: number }): Promise<CommandResult> => {
  switch (command.kind) {
    case "link-port": return { kind: "link-port", service: `port-${command.port}` };
    case "unlink-port": return { kind: "unlink-port", refused: null };
    case "open-session": return { kind: "open-session", herdrPane: "w9:p1" };
    case "close-session": return { kind: "close-session", outcome: "closed" };
    case "drop-failed-session": return { kind: "drop-failed-session", dropped: true };
    case "send-claude": return { kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false };
    default: return { kind: "exec", exitCode: 0, output: "", truncated: false } as CommandResult;
  }
};

/**
 * A checkout for every demo pylon's files, changes and diffs: a small repository in a temp directory whose first
 * commit is refs/nexus/base, with a commit and uncommitted edits on top, as a thread's working tree has.
 */
export async function demoCheckout(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "nexus-demo-checkout-"));
  const git = (...args: string[]) => run("git", ["-C", repo, "-c", "user.name=Nexus demo", "-c", "user.email=demo@nexus.invalid", ...args]);
  const write = async (path: string, text: string) => { await mkdir(join(repo, dirname(path)), { recursive: true }); await writeFile(join(repo, path), text); };
  for (const [path, text] of Object.entries(checkoutFiles.base)) await write(path, text);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "chore: the project as the thread found it");
  await git("update-ref", "refs/nexus/base", "HEAD");
  for (const [path, text] of Object.entries(checkoutFiles.committed)) await write(path, text);
  await git("add", "-A");
  await git("commit", "-q", "-m", "fix(probe): retry a reset with backoff");
  for (const [path, text] of Object.entries(checkoutFiles.uncommitted)) await write(path, text);
  await rm(join(repo, "src/legacy-retry.ts"));
  return repo;
}

const checkoutFiles = {
  base: {
    "README.md": "# probe-client\n\nTalks to a node's probe over the tailnet.\n",
    "package.json": JSON.stringify({ name: "probe-client", version: "1.4.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    "src/client.ts": "import { request } from \"node:http\";\n\nexport async function connect(host: string): Promise<void> {\n  await once(request({ host }), \"response\");\n}\n",
    "src/legacy-retry.ts": "export const retries = 1;\n",
    "test/client.test.ts": "import test from \"node:test\";\n\ntest(\"connects\", () => {});\n",
  },
  committed: {
    "src/backoff.ts": "/** Full jitter: a delay between half the ceiling and the ceiling. */\nexport function backoff(attempt: number, base = 500, cap = 30_000): number {\n  const ceiling = Math.min(cap, base * 2 ** attempt);\n  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));\n}\n",
    "src/client.ts": "import { request } from \"node:http\";\nimport { setTimeout as sleep } from \"node:timers/promises\";\nimport { backoff } from \"./backoff.ts\";\n\nexport async function connect(host: string, deadlineMs = 30_000): Promise<void> {\n  const until = Date.now() + deadlineMs;\n  for (let attempt = 0; ; attempt++) {\n    try {\n      return await once(request({ host }), \"response\");\n    } catch (err) {\n      if (Date.now() > until) throw err;\n      await sleep(backoff(attempt));\n    }\n  }\n}\n",
  },
  uncommitted: {
    "test/client.test.ts": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { backoff } from \"../src/backoff.ts\";\n\ntest(\"connects\", () => {});\n\ntest(\"backoff stays under its cap\", () => {\n  for (let i = 0; i < 20; i++) assert.ok(backoff(i) <= 30_000);\n});\n",
    "README.md": "# probe-client\n\nTalks to a node's probe over the tailnet, and retries a reset with jittered backoff until its deadline.\n",
  },
};

/** The pylons running on `node`, which its health lists with their processes. */
const runningOn = (registry: Demo["registry"], node: NodeName) =>
  registry.pylonsWithThreadsOn(node).filter(({ pylon }) => running.has(pylon.pylonId)).map(({ pylon }) => pylon.pylonId);
/** The pylons the seed reported running, which only they list as processes. */
const running = new Set<PylonId>();

/**
 * A probe per node that answers from memory: commands succeed and health is made up. Its pipes run checkout reads
 * in the demo checkout and refuse the rest, such as a transcript read, so a Claude worker shows its stored transcript.
 */
export function demoProbes(registryOf: () => Demo["registry"], checkout: string) {
  return new Map([firebat, testbench].map((node) => [node, {
    command: (_: PylonId, command: { kind: string; port?: number }) => answer(command),
    stream: async (_: PylonId, argv: readonly string[]): Promise<ByteStream> => {
      if (!argv.includes(checkoutDir)) throw new Error(`the demo's pylons have no ${argv[0] === claudeHook ? "hook" : "transcript"} to read`);
      return processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? checkout : arg), () => {});
    },
    health: async () => health(node, now(), runningOn(registryOf(), node)),
  }]));
}

/** A node's health at `at`, a day's rhythm of load with noise, so 31 days of samples draw as believable graphs. */
function health(node: NodeName, at: number, pylons: readonly PylonId[]): NodeHealth {
  const big = node === firebat;
  const hourOfDay = new Date(at).getUTCHours() + 1;
  const busy = hourOfDay >= 8 && hourOfDay <= 22 ? 1 : 0.25;
  const wave = Math.sin((at / day) * 2 * Math.PI) * 0.5 + 0.5;
  // Two slow waves and a faster one, so a line wanders the way a real host's does instead of zigzagging every sample.
  const noise = (seed: number) => 0.5 + (Math.sin(at / (83 * minute) + seed) * 0.5 + Math.sin(at / (19 * minute) + seed * 2.3) * 0.35 + Math.sin(at / (4 * minute) + seed * 5.1) * 0.15) / 2;
  const load = (big ? 6 : 2.5) * busy * (0.6 + wave * 0.6) + noise(1) * 1.5;
  const memTotal = big ? 64 : 32;
  const used = memTotal * (0.35 + 0.35 * busy * wave + noise(2) * 0.08);
  const diskTotal = big ? 1863 : 931;
  const growth = (at - (now() - 31 * day)) / (31 * day);
  return {
    node, readAt: new Date(at).toISOString(), cpus: big ? 16 : 8,
    load: { one: load, five: load * 0.9, fifteen: load * 0.8 },
    memory: { totalGiB: memTotal, availableGiB: memTotal - used, swapTotalGiB: 8, swapFreeGiB: big ? 8 - noise(3) * 2 : 1.4 },
    disk: { path: "/var/lib/nexus", totalGiB: diskTotal, freeGiB: big ? 640 - growth * 120 : 61 - growth * 30 },
    disks: [
      { paths: ["/var/lib/nexus"], totalGiB: diskTotal, freeGiB: big ? 640 - growth * 120 : 61 - growth * 30, pylons: true },
      { paths: ["/"], totalGiB: big ? 120 : 60, freeGiB: big ? 71 : 18 },
    ],
    temperatures: [{ sensor: "Package id 0", celsius: 42 + load * 4 + noise(4) * 3 }, { sensor: "Composite", celsius: 36 + noise(5) * 6 }],
    pylons: pylons.map((pylonId, i) => ({ pylonId, processes: 40 + i * 7, cpuPercent: busy * (20 + noise(i + 6) * 80), residentGiB: 1.2 + i * 0.4 + noise(i) * 0.3 })),
  };
}

function seedHealthHistory(d: Demo) {
  for (const node of [firebat, testbench]) {
    const pylons = runningOn(d.registry, node);
    const threadOf = (p: PylonId) => d.registry.pylon(p)?.thread ?? null;
    const end = now();
    // Five-minute samples over 31 days, then every minute for the last six hours, as the sampler takes them.
    for (let at = end - 31 * day; at < end - 6 * hour; at += 5 * minute) d.registry.recordHealthSample(node, sampleOf(health(node, at, pylons), at, threadOf));
    for (let at = end - 6 * hour; at <= end; at += minute) d.registry.recordHealthSample(node, sampleOf(health(node, at, pylons), at, threadOf));
  }
}

const doctor = (at: number): DoctorReport => {
  const checks: Check[] = [
    { node: null, name: "release", status: "ok", text: "The control plane runs fac9ff725fd1, the desired release." },
    { node: null, name: "backup", status: "warn", text: "The last backup is 31 hours old; one runs every 24 hours. Check the backup timer on rj-firebat." },
    { node: null, name: "login", status: "ok", text: "The harness is signed in to ChatGPT as openai." },
    { node: null, name: "certificate", status: "ok", text: "The dashboard's certificate is valid for 58 more days." },
    { node: firebat, name: "online", status: "ok", text: "Online, last seen 4 seconds ago." },
    { node: firebat, name: "release", status: "ok", text: "Runs fac9ff725fd1." },
    { node: firebat, name: "disk", status: "ok", text: "523 GiB free of 1863 GiB for pylons." },
    { node: firebat, name: "pylons", status: "fail", text: "1 pylon is broken: Fix doctor's certificate check. Open the thread to judge it." },
    { node: testbench, name: "online", status: "ok", text: "Online, last seen 6 seconds ago." },
    { node: testbench, name: "release", status: "warn", text: "Runs 4209370e1c2b, two releases behind. It updates on its next probe restart." },
    { node: testbench, name: "disk", status: "fail", text: "33 GiB free of 931 GiB for pylons, under the 50 GiB floor. Answer the cleanup question on its page." },
    { node: testbench, name: "pylons", status: "warn", text: "1 pylon is broken: Fix the crash on an empty notebook." },
  ];
  return { at: new Date(at).toISOString(), status: "fail", checks };
};

function seedHealthChanges(d: Demo) {
  const report = doctor(now());
  const iso = (ago: number) => new Date(now() - ago).toISOString();
  const history: [ago: number, check: Check, from: Check["status"]][] = [
    [4 * day, { node: testbench, name: "online", status: "fail", text: "Offline for 12 minutes: its probe does not answer." }, "ok"],
    [4 * day - 20 * minute, { node: testbench, name: "online", status: "ok", text: "Online again." }, "fail"],
    [2 * day, { node: firebat, name: "disk", status: "warn", text: "61 GiB free for pylons, near the 50 GiB floor." }, "ok"],
    [2 * day - 3 * hour, { node: firebat, name: "disk", status: "ok", text: "523 GiB free after the cleanup." }, "warn"],
    [31 * hour, { node: null, name: "backup", status: "warn", text: "The last backup is 25 hours old." }, "ok"],
    [9 * hour, { node: testbench, name: "release", status: "warn", text: "Runs 4209370e1c2b, two releases behind." }, "ok"],
    [5 * hour, { node: testbench, name: "disk", status: "fail", text: report.checks.find((c) => c.node === testbench && c.name === "disk")!.text }, "warn"],
    [2 * hour, { node: testbench, name: "pylons", status: "warn", text: "1 pylon is broken: Fix the crash on an empty notebook." }, "ok"],
    [40 * minute, { node: firebat, name: "pylons", status: "fail", text: "1 pylon is broken: Fix doctor's certificate check." }, "ok"],
  ];
  for (const [ago, check, from] of history) d.registry.recordHealthChanges([{ ...check, from, at: iso(ago) }], now() - 30 * day);
  d.registry.markHealthSeen(d.registry.healthChanges().find((c) => c.node === null && c.name === "backup")!.id, now() - 20 * hour);
  return report;
}

function seedUsage(d: Demo, world: World) {
  const models: [agent: AgentCall["agent"], model: string, weight: number][] = [
    ["claude", "claude-opus-5-5", 1], ["claude", "claude-sonnet-5-5", 0.6], ["pi", "gpt-6-astra", 0.9], ["pi", "gpt-6-astra-mini", 0.3], ["claude", "claude-haiku-5-5", 0.2],
  ];
  let n = 0;
  for (const t of world.threads.values()) {
    const calls: AgentCall[] = [];
    const span = Math.max(hour, now() - t.createdAt);
    const count = 12 + (n % 5) * 9;
    for (let i = 0; i < count; i++) {
      const [agent, model, weight] = models[(n + i) % models.length]!;
      if ((agent === "claude") !== (d.registry.agent(t).kind === "claude") && i % 4 !== 0) continue;
      const at = Math.round(t.createdAt + (span * i) / count);
      calls.push({ id: `${agent}:${t.id}-${i}`, agent, model, at, input: Math.round(4_000 + weight * 22_000 * ((i % 7) + 1) / 4), output: Math.round(400 + weight * 2_600 * ((i % 3) + 1)), cacheWrite: i % 5 === 0 ? 30_000 : 0, cacheRead: Math.round(weight * 90_000) });
    }
    d.registry.recordUsage(t.id, calls);
    n++;
  }
}

async function seedPipeline(d: Demo, world: World) {
  const item = (id: string, project: string, title: string, ago: number, over: Partial<ItemRecord> = {}): ItemRecord => ({
    id: id as ItemId, project: project as ProjectId, title, request: { project, title }, message: `Brief: ${title}.`, after: [], addedBy: laptop, addedAt: now() - ago,
    approved: null, cancelled: null, lastError: null, ...over,
  });
  for (const spec of threads.filter((s) => s.item !== undefined)) d.registry.saveItem(item(spec.item!, spec.project, spec.title, spec.ago + 10 * minute));
  const graphs = world.threads.get("graphs")!;
  const prune = { project: "nexus", title: "Prune events older than 90 days" };
  const pruneBrief = "Add a pruning pass for events older than 90 days.";
  d.queue!.add(prune, pruneBrief, [graphs.id], laptop, startKey(itemRequestId("it-prune" as ItemId), { request: prune, message: pruneBrief, after: [graphs.id] }));
  await d.call("POST", "/v1/threads", { project: "storefront", title: "Wishlist sharing links", after: [world.threads.get("rounding")!.id], message: "Let a shopper share a wishlist by link." });
  for (const i of [
    item("it-prune", "nexus", "Prune events older than 90 days", 20 * hour, { approved: { by: laptop, at: now() - 19 * hour } }),
    item("it-split", "nexus", "Split loop.ts by node phase", 20 * hour, { after: ["it-prune" as ItemId] }),
    item("it-cleanup", "nexus", "Move cleanup onto the new model", 20 * hour, { after: ["it-split" as ItemId] }),
    item("it-giftcards", "storefront", "Gift cards at checkout", 9 * hour),
    item("it-svelte", "storefront", "Rewrite the cart in Svelte", 2 * day, { cancelled: { by: laptop, at: now() - day } }),
  ]) d.registry.saveItem(i);
}

/** The releases each node reports, and infra-testbench's cleanup question, which waits on the person. */
function seedNodeExtras(d: Demo) {
  const current = "fac9ff725fd13db015758c7f31094f8df76077d0";
  d.registry.setDesiredRelease({ commit: current, requestedBy: laptop, requestedAt: now() - 2 * hour });
  d.registry.reportRelease({ node: firebat, role: "control", commit: current, target: current, state: "healthy", reason: null, observedAt: now() - minute });
  d.registry.reportRelease({ node: firebat, role: "probe", commit: current, target: current, state: "healthy", reason: null, observedAt: now() - minute });
  d.registry.reportRelease({ node: testbench, role: "probe", commit: "4209370e1c2b5d1a9f0e3b7c6d8a2e4f1b3c5d7e", target: current, state: "waiting-for-idle", reason: "2 pylons have running turns", observedAt: now() - 2 * minute });
  const gib = 1024 ** 3;
  d.registry.askQuestion({
    id: "cleanup:infra-testbench:1", node: testbench, reserved: null, answerer: "deployer", askedAt: now() - 3 * hour, options: ["Delete", "Keep"],
    text: "infra-testbench has 33 GiB free for pylons. These are unused: delete them to free 61.4 GiB?",
    cleanup: { outcomes: {}, items: [
      { kind: "image", id: "img-3c1d9e2f0a4b" as ImageId, bytes: Math.round(14.2 * gib) },
      { kind: "image", id: "img-8e5a7b1c2d3f" as ImageId, bytes: Math.round(13.9 * gib) },
      { kind: "template", id: "tpl-storefront-5d2a" as never, project: "storefront" as ProjectId, bytes: Math.round(21.7 * gib) },
      { kind: "template", id: "tpl-field-notes-91b0" as never, project: "field-notes" as ProjectId, bytes: Math.round(9.4 * gib) },
      { kind: "release", name: "2026-10-12-3b81960", commit: "3b81960a", bytes: Math.round(2.2 * gib) },
    ] },
  });
}

const liveReplies = [
  "Upstream took the one-line fix. I'm pinning the patched Herdr in the image until their next release.",
  "Rebuilt the image with the patched Herdr. Idle pylons now sit at **0.2% CPU**, down from 14.7%.",
  "Rolled the image to rj-firebat. `top` on three idle pylons:\n\n```\n2211 herdr  0.1\n2302 node   0.2\n2417 herdr  0.1\n```",
  "infra-testbench is next; it has two running turns, so its probe waits for them to finish.",
  "Both nodes run the patched image. Want me to open a PR that bumps the pin in `images/pylon/recipe.ts`?",
];

/**
 * Keeps the world moving: every running thread keeps working, the nodes take a health sample each minute as the
 * sampler does, and one thread gets a new reply every minute, so live updates show. Returns what stops it.
 */
function liveClock(d: Demo, world: World) {
  let n = 0;
  const tick = setInterval(() => {
    for (const t of world.live.working) d.registry.recordActivity(t.id, { agent: now(), agentTurnRunning: true });
    for (const node of [firebat, testbench]) d.registry.recordHealthSample(node, sampleOf(health(node, now(), runningOn(d.registry, node)), now(), (p) => d.registry.pylon(p)?.thread ?? null));
    const talker = world.live.talker;
    if (talker !== null && ++n % 3 === 0) {
      const text = liveReplies[(n / 3 - 1) % liveReplies.length]!;
      talk(d, talker, harnessTalk(now() - 40_000).say(text).messages);
      d.registry.recordReply(talker.id, now());
    }
  }, 20_000);
  return () => clearInterval(tick);
}

/** A review loop that only records what the person asked: a land starts merging, a cancel cancels, and nothing reaches GitHub. */
export function demoReviews(registryOf: () => Demo["registry"]) {
  const reviewOf = (builder: string) => {
    const r = registryOf().review(builder as ThreadId);
    if (r === null || r === undefined) throw new Error(`thread ${builder} has no review`);
    return r;
  };
  return {
    deploys: (r: Review) => r.pr.repo === repos.nexus,
    async start(builder: string) { return reviewOf(builder); },
    cancel(builder: string, by: string) {
      const r = reviewOf(builder);
      const next: Review = { ...r, phase: { kind: "cancelled", who: "person", by } };
      registryOf().saveReview(next, [], r);
      return next;
    },
    land(builder: string, by: string) {
      const r = reviewOf(builder);
      const next: Review = { ...r, land: { requestedBy: by }, phase: { kind: "merging", authorized: null } };
      registryOf().saveReview(next, [], r);
      return next;
    },
  } as never as import("../review.ts").ReviewLoop;
}

export async function seedDemo(d: Demo) {
  const world: World = { threads: new Map(), live: { working: [], talker: null } };

  observeNode(d, firebat, { total: 64, committed: 30 });
  observeNode(d, testbench, { total: 32, committed: 26 });
  for (const p of projects) {
    const res = await d.call("POST", "/v1/projects", {
      id: p.id, repoUrl: `https://github.com/${repos[p.id]}.git`, defaultBranch: p.branch, defaultNode: p.defaultNode,
      resources: { cpus: 2, memoryGiB: 4, diskGiB: 20 }, allowedHosts: p.hosts, secrets: p.secrets, logins: ["claude", "chatgpt"], preSetup: null,
    });
    if (res.status !== 201) throw new Error(`adding project ${p.id}: ${JSON.stringify(res.body)}`);
    if (p.pipeline !== null) d.registry.editProject(p.id as ProjectId, (stored) => ({ ...stored, pipeline: p.pipeline }));
  }
  if ((await d.call("POST", "/v1/images", image)).status !== 201) throw new Error("adding the image");
  d.registry.setCurrentImage(image.id as ImageId);

  for (const spec of threads.toSorted((a, b) => b.ago - a.ago)) {
    const t = await back(spec.ago, async () => {
      if (spec.item !== undefined) {
        const request = { project: spec.project, title: spec.title };
        return d.startThread(request, laptop, undefined, startKey(itemRequestId(spec.item as ItemId), { request, message: null, after: [] }));
      }
      if (spec.by !== undefined) return d.startThread({ project: spec.project, title: spec.title, ...(spec.by !== reviewerCaller ? { bare: true } : {}) }, spec.by);
      const res = await d.call("POST", "/v1/threads", {
        project: spec.project, title: spec.title, ...(spec.worker === "claude" ? { claude: spec.title } : {}), ...(spec.worker === "planning" ? { planning: true } : {}),
      });
      if (res.status !== 201) throw new Error(`starting ${spec.key}: ${JSON.stringify(res.body)}`);
      return res.body as Thread;
    });
    world.threads.set(spec.key, t);
  }

  for (const node of [firebat, testbench]) {
    const on = threads.filter((s) => d.registry.pylon(world.threads.get(s.key)!.pylonId)!.node === node);
    const pylons = on.flatMap((s): PylonObservation[] => {
      const t = world.threads.get(s.key)!;
      const live = d.registry.pylon(t.pylonId)!;
      if (s.pylon === "absent") return [];
      if (s.pylon === "paused" || s.archived) return [stoppedPylon(t.pylonId, { checkpoint: `ck-${t.id}` as never })];
      if (s.pylon === "broken") return [{ pylonId: t.pylonId, phase: "broken" as const, detail: "the controller exited", cause: "controller" as const, logTail: "qemu-system-x86_64: terminating on signal 15 from pid 1\n" }];
      running.add(t.pylonId);
      return [runningPylon(t.pylonId, { liveHash: live.liveHash, bootedAt: new Date(t.createdAt + minute).toISOString(), bootedFrom: { image: image.id as ImageId, checkpoint: null }, listening: [{ port: 5173 }, { port: 3000 }] })];
    });
    const capacity = testCapacity(node === firebat
      ? { cpus: 16, committedCpus: 12, memoryGiB: 64, committedMemoryGiB: 30, diskFreeGiB: 523, committedDiskGiB: 260, disks: health(node, now(), []).disks! }
      : { cpus: 8, committedCpus: 8, memoryGiB: 32, committedMemoryGiB: 26, diskFreeGiB: 33, committedDiskGiB: 120, disks: health(node, now(), []).disks! });
    d.registry.apply({ record: "node", node, state: "online", capacity });
    d.registry.ingested(testObservation(node, { capacity, pylons, artifacts: [image.id], grants: { secrets: ["STRIPE_KEY", "GH_TOKEN", "NEXUS_CHATGPT_TOKEN"], gitSsh: true } }), []);
  }

  for (const spec of threads) {
    const t = world.threads.get(spec.key)!;
    await back(spec.ago - minute, () => spec.extra?.(d, d.registry.thread(t.id)!, world));
    if (spec.working) d.registry.recordActivity(t.id, { agent: now() - (2 + (spec.title.length % 9) * 3) * minute - spec.title.length * 1_000, agentTurnRunning: true });
    else d.registry.recordActivity(t.id, { agent: now() - (spec.replied ?? spec.ago - 10 * minute), agentTurnRunning: false });
    if (spec.replied !== undefined) d.registry.recordReply(t.id, now() - spec.replied);
    if (spec.seen) d.registry.markSeen(t.id, false, now() - spec.replied! + minute);
    if (spec.archived) await d.call("POST", `/v1/threads/${t.id}/archive`);
  }
  world.live.talker = world.threads.get("spin")!;

  seedHealthHistory(d);
  const report = seedHealthChanges(d);
  seedUsage(d, world);
  await seedPipeline(d, world);
  seedNodeExtras(d);
  return { world, health: () => ({ ...report, at: new Date(now()).toISOString() }), stop: liveClock(d, world) };
}
