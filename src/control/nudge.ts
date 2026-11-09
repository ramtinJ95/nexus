/**
 * Nudges a builder whose turn ended short of a pull request, in a project that reviews its builders' pull requests on
 * its own. A turn stalled once the registry holds the branches the thread pushed before it ended, a PR watch pass that
 * started after that linked no pull request on them, and GitHub finds none that merged or closed. Each stalled turn gets
 * one fixed message under a request ID of the thread and the turn's end, which the inbox never delivers twice, so a
 * pass after a crash between the send and its record sends nothing new. A third stalled turn after two nudges hands the
 * thread to the person through its `decision` attention. A pull request ends it, and the person writing to the thread
 * leaves the thread alone for good. A stalled turn whose replies end with the builder's no-change block gets no nudge:
 * the thread is archived with the block's reason, and a thread queued after it starts (queue.ts).
 */
import { endingBlock, senders } from "./agent-protocol.ts";
import { gitPollMs } from "../protocol/observations.ts";
import { singleFlight } from "../single-flight.ts";
import { githubRepo, type GitHub } from "./github.ts";
import type { Inbox } from "./inbox.ts";
import { pushedBranches } from "./pr-watch-model.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { requestIds, type ThreadId } from "../ids.ts";
import type { Nudge } from "./nudge-store.ts";
import { deliverDurable } from "./durable-message.ts";
import { prLocationOf, threadRole } from "./work-model.ts";
import { isOpenStatus, openStatuses } from "./reconcile.ts";
import { block, noChangeAnswer } from "./prompts.ts";

type NudgeRegistry = Pick<Registry, "reviews" | "nodes" | "nudges" | "threads" | "planning" | "prWatches" | "projects">;

const text = (id: ThreadId) => `${senders.nudge.prefix}
Your turn ended, and Nexus finds no pull request from this thread. This project reviews its builders' pull requests on its own, so the work moves on only once one is open. If the task is not done, go on with it. When it is, commit, push the branch and open a pull request. If you checked that the task needs no change, as when another thread already did it, end your reply with this block, and Nexus archives this thread:
${block(noChangeAnswer, id)}
If you are blocked, say why in one line: after two nudges without a pull request, Nexus hands this thread to the person.`;

export const maxNudges = 2;

export function builderNudger(options: {
  registry: NudgeRegistry; github: Pick<GitHub, "find">; inbox: Inbox;
  /** The person talking to a thread after its first reply makes it theirs, so it is left alone. */
  personWroteTo(t: Thread): Promise<boolean>;
  /** The agent's replies, oldest first, where a builder declares that its task needs no change. */
  replies(t: Thread): Promise<string[]>;
  /** Tells the planner a thread's status changed, so an archived thread's pylon pauses at once. */
  wake(t: Thread): void;
  watch: { passes(): { started: number; finished: number } }; log?: (message: string) => void;
}) {
  const { registry, github, inbox, personWroteTo, replies, wake, watch, log = (message: string) => console.error(message) } = options;
  /** The PR watch pass each thread's latest ended turn waits for. A restart only makes a turn wait for another. */
  const awaited = new Map<ThreadId, { turn: number; pass: number }>();

  /** The repository of a builder whose project reviews its pull requests on its own, or null for any other thread. */
  function builderRepo(t: Thread): string | null {
    if (!isOpenStatus(t.status)) return null;
    if (threadRole(registry, t) !== "builder") return null;
    const project = registry.projects.project(t.project);
    return project?.autoReview == null ? null : githubRepo(project.repoUrl);
  }

  /**
   * Whether the registry's outputs hold every branch the thread pushed before `turn` ended. The probe takes a snapshot's
   * observedAt before it reads any pylon, so a running pylon's snapshot holds those pushed gitPollMs before it. A paused
   * pylon's snapshot says nothing of git, so a turn whose pushes were not known before the pause waits for a wake.
   */
  function pushedKnown(t: Thread, turn: number): boolean {
    const pylon = registry.threads.pylon(t.pylonId);
    const observation = pylon === undefined ? null : registry.nodes.node(pylon.node)?.observation ?? null;
    const facts = observation?.pylons.find((p) => p.pylonId === t.pylonId);
    return facts?.phase === "running" && facts.git !== null && Date.parse(observation!.observedAt) - gitPollMs >= turn;
  }

  /** Whether a PR watch pass that started once the registry knew the turn's branches has finished. */
  function watched(t: Thread, turn: number): boolean {
    const wait = awaited.get(t.id);
    if (wait?.turn === turn) return watch.passes().finished >= wait.pass;
    if (pushedKnown(t, turn)) awaited.set(t.id, { turn, pass: watch.passes().started + 1 });
    return false;
  }

  /** The PR watch links only pull requests it finds open, so GitHub is asked for any on the builder's branches. */
  async function opened(t: Thread, repo: string): Promise<boolean> {
    for (const branch of pushedBranches(registry, t.id)) if ((await github.find(repo, branch, "all")).length > 0) return true;
    return false;
  }

  const hasPullRequest = (t: Thread) => prLocationOf(registry, t.id).kind !== "none";
  /** The thread as the registry has it now, if a nudge may still go to it: an await may have let a turn, a PR link, or an archive in. */
  const idleBuilder = (id: Thread["id"]) => {
    const fresh = registry.threads.thread(id);
    return fresh === undefined || builderRepo(fresh) === null || hasPullRequest(fresh) || fresh.usageLimit !== undefined || fresh.turnDied !== undefined || fresh.working ? undefined : fresh;
  };

  /** Archives a builder that declared no change, unless the person has been to it since, as by unarchiving it. */
  function archive(id: ThreadId, { turn }: Extract<Nudge, { state: "no-change" }>) {
    const t = registry.threads.thread(id);
    if (t === undefined || !isOpenStatus(t.status) || t.working || t.lastHumanActivityAt > turn) return;
    registry.threads.setThreadStatus(id, "archived");
    wake(t);
  }

  async function judge(t: Thread) {
    const record = registry.nudges.nudge(t.id);
    if (record?.state === "left-alone") return;
    // A crash may have come between the record and the archive. A pull request opened since supersedes the declaration.
    if (record?.state === "no-change") return hasPullRequest(t) ? registry.nudges.saveNudge(t.id, null) : archive(t.id, record);
    const clear = () => { if (record !== null) registry.nudges.saveNudge(t.id, null); };
    const leaveAlone = () => registry.nudges.saveNudge(t.id, { state: "left-alone" });
    const repo = builderRepo(t);
    if (repo === null || hasPullRequest(t)) return clear();
    // A turn its usage limit stopped did not stall, and the next turn ends the limit. One that died is the resumer's.
    if (t.usageLimit !== undefined || t.turnDied !== undefined) return;
    const turn = t.lastReplyAt;
    // The turn the person's message starts may outlast the transcript's hold on that message, so look while it runs.
    if (t.working && t.lastHumanActivityAt > (turn ?? 0) && await personWroteTo(t)) return leaveAlone();
    if (record?.state === "sending") {
      // It may never have gone out, so it waits for an ended turn and goes only to a thread that is not the person's.
      if (t.working) return;
      if (await personWroteTo(t)) return leaveAlone();
      const fresh = idleBuilder(t.id);
      if (fresh === undefined) return;
      return deliver(fresh, record);
    }
    if (record?.state === "person") {
      // The person's message starts a turn, so only a thread that worked since the hold can have one.
      if ((t.working || (turn ?? 0) > record.turn) && await personWroteTo(t)) leaveAlone();
      return;
    }
    if (t.working || turn === null || (record !== null && record.turn >= turn) || !watched(t, turn)) return;
    if (await personWroteTo(t)) return leaveAlone();
    try {
      if (await opened(t, repo)) return registry.nudges.saveNudge(t.id, { state: "opened", turn });
    } catch (err) {
      // Never log transport errors' text: a fetch implementation may put authorization headers in them.
      log(`${t.id}: nudge could not search GitHub for its pull request and will retry (${(err as Error).name})`);
      return;
    }
    // Only a block that ends the final answer counts, so a reply after it, such as a correction, takes it back.
    const declared = endingBlock((await replies(t)).at(-1) ?? "", noChangeAnswer.fence, noChangeAnswer.schema, t.id);
    const fresh = idleBuilder(t.id);
    if (fresh === undefined || fresh.lastReplyAt !== turn) return;
    if (declared !== null) {
      const done: Nudge = { state: "no-change", turn, reason: declared.reason };
      registry.nudges.saveNudge(t.id, done);
      return archive(t.id, done);
    }
    const count = record?.state === "nudged" ? record.count : 0;
    if (count >= maxNudges) return registry.nudges.saveNudge(t.id, { state: "person", turn });
    const sending: Nudge = { state: "sending", turn, count: count + 1 };
    registry.nudges.saveNudge(t.id, sending);
    await deliver(fresh, sending);
  }

  async function deliver(t: Thread, { turn, count }: Extract<Nudge, { state: "sending" }>) {
    await deliverDurable({ id: requestIds.nudge(t.id, turn), text: text(t.id) }, (m) => inbox(t, { ...m, sender: "nudge" }), () => registry.nudges.saveNudge(t.id, { state: "nudged", turn, count }));
  }

  async function pass() {
    // A thread archived since its nudge has its record cleared, so an unarchived one starts its count over.
    const ids = new Set([...registry.threads.storedThreads({ status: openStatuses }).map((t) => t.id), ...registry.nudges.nudgedThreads()]);
    for (const id of ids) {
      // Read again after the passes before it, which another thread's sends may have outrun.
      const t = registry.threads.thread(id);
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
