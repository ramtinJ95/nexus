/**
 * Nudges a builder whose turn ended short of a pull request, in a project that reviews its builders' pull requests on
 * its own. Each stalled turn gets one fixed message under a request ID of the thread and the turn's end, which the
 * inbox never delivers twice, so a pass after a crash between the send and its record sends nothing new. A third
 * stalled turn after two nudges hands the thread to the person through its `decision` attention. A pull request, or
 * the person writing to the thread, ends it.
 */
import type { HarnessHost } from "../harness/host.ts";
import { singleFlight } from "../single-flight.ts";
import { checkCaller } from "./gate.ts";
import { githubRepo, type GitHub } from "./github.ts";
import type { Inbox } from "./inbox.ts";
import type { Registry, Thread } from "./registry.ts";
import { reviewerCaller } from "./review.ts";

export const nudgePrefix = "[Nexus nudge — automated, not a message from the person]";
const text = `${nudgePrefix}
Your turn ended, and Nexus finds no pull request from this thread. This project reviews its builders' pull requests on its own, so the work moves on only once one is open. If the task is not done, go on with it. When it is, commit, push the branch and open a pull request. If you are blocked or the task needs no pull request, say why in one line: after two nudges without a pull request, Nexus hands this thread to the person.`;

export type Nudge =
  /** `turn` is the end (the thread's lastReplyAt) of the stalled turn the latest nudge answered; `count` nudges in a row. */
  | { state: "nudged"; turn: number; count: number }
  /** The turn after the last nudge stalled too, so the thread waits on the person. */
  | { state: "person"; turn: number };

/** A branch pushed and a pull request opened just before the turn ended reach the registry's outputs and GitHub's search within it. */
const turnGraceMs = 60_000;
const maxNudges = 2;

export function builderNudger(options: { registry: Registry; github: Pick<GitHub, "find">; inbox: Inbox; harness: Pick<HarnessHost, "watch">; now?: () => number; graceMs?: number; log?: (message: string) => void }) {
  const { registry, github, inbox, harness, now = Date.now, graceMs = turnGraceMs, log = (message: string) => console.error(message) } = options;

  /** The repository of a builder whose project reviews its pull requests on its own, or null for any other thread. */
  function builderRepo(t: Thread): string | null {
    if (t.status !== "active" && t.status !== "idle") return null;
    if (t.startedBy === reviewerCaller || t.startedBy === checkCaller || registry.isReviewer(t.id)) return null;
    const project = registry.project(t.project);
    return project?.autoReview == null ? null : githubRepo(project.repoUrl);
  }

  /** The person talking to a thread after its first reply makes it theirs, so it is left alone. */
  async function personWrote(t: Thread): Promise<boolean> {
    if (registry.claudeWorker(t.id) !== undefined) {
      const entries = registry.claudeEntries(t.id);
      const first = entries.findIndex((e) => e.kind === "reply");
      // Nexus types its messages into the session as the person would, so only their prefix tells them apart.
      return first !== -1 && entries.slice(first).some((e) => e.kind === "prompt" && e.from === "person" && !e.text.startsWith("[Nexus "));
    }
    const watch = await harness.watch(t.id);
    try {
      const messages = watch.value.entries.flatMap((entry) => (entry.model ?? []).map((message) => ({ entry, message })));
      const first = messages.findIndex(({ message }) => message.role === "assistant");
      return first !== -1 && messages.slice(first).some(({ entry, message }) => message.role === "user" && !entry.kind.startsWith("nexus."));
    } finally {
      await watch.stop();
    }
  }

  /** The PR watch links pull requests only every two minutes, so GitHub is asked for the builder's branches first. */
  async function opened(t: Thread, repo: string): Promise<boolean> {
    const branches = registry.outputs(t.id).flatMap((o) => o.kind === "branch" && o.ref.startsWith("origin/") ? [o.ref.slice(7)] : []);
    for (const branch of branches) if ((await github.find(repo, branch, "all")).length > 0) return true;
    return false;
  }

  async function judge(t: Thread) {
    const record = registry.nudge(t.id);
    const clear = () => { if (record !== null) registry.saveNudge(t.id, null); };
    const repo = builderRepo(t);
    if (repo === null || (registry.prWatch(t.id)?.links.length ?? 0) > 0 || registry.review(t.id) !== null) return clear();
    const turn = t.lastReplyAt;
    if (record?.state === "person") {
      // The person's message starts a turn, so only a thread that worked since the hold can have one.
      if ((t.working || (turn ?? 0) > record.turn) && await personWrote(t)) clear();
      return;
    }
    if (t.working || turn === null || now() - turn < graceMs || (record !== null && record.turn >= turn)) return;
    try {
      if (await opened(t, repo)) return;
    } catch (err) {
      // Never log transport errors' text: a fetch implementation may put authorization headers in them.
      log(`${t.id}: nudge could not search GitHub for its pull request and will retry (${(err as Error).name})`);
      return;
    }
    if (await personWrote(t)) return clear();
    // The awaits above may have let a turn start, or an archive in.
    const fresh = registry.thread(t.id);
    if (fresh === undefined || builderRepo(fresh) === null || fresh.working || fresh.lastReplyAt !== turn) return;
    if (record !== null && record.count >= maxNudges) return registry.saveNudge(t.id, { state: "person", turn });
    if (await inbox(fresh, { id: `nudge:${t.id}:${turn}`, text, sender: "nudge" }) === "delivered") {
      registry.saveNudge(t.id, { state: "nudged", turn, count: (record?.count ?? 0) + 1 });
    }
  }

  async function pass() {
    for (const { id } of registry.threads()) {
      // Read again after the passes before it, which another thread's sends may have outrun.
      const t = registry.thread(id);
      if (t === undefined) continue;
      try {
        await judge(t);
      } catch (err) {
        log(`${t.id}: nudging the builder failed and will be retried: ${(err as Error).message}`);
      }
    }
  }
  const passes = singleFlight(pass);
  return { poll: passes.join, close: passes.settled };
}
