/**
 * Resumes a Claude builder whose turn died (Thread.turnDied): its session ended during the turn, or the turn ended on
 * a model error after Claude Code's own retries. Nothing else moves such a thread: no reply was recorded or the reply
 * was the error, and the pylon idles until it pauses. Each turn that died gets one fixed message, after a wait that
 * grows with each death in a row, under a request ID of the thread and the turn's death, which the inbox never delivers
 * twice. After the last resume in a row a turn that dies too goes to the person through the `decision` attention, so
 * a provider outage ends there rather than looping. A turn that does not die ends the count, and the person writing to
 * the thread leaves it alone for good.
 *
 * Reviewers, checks and planning threads are left out, and so is a builder whose review the loop handed to the person.
 * Until its review finishes, the loop sends a builder whose turn ended on a model error its request again, or its next
 * message, which resumes it as well, so such a builder gets no resume for one. A planning thread runs in the harness,
 * where no session ends. Only a death in the last hour is resumed, so a control plane that starts, or starts this,
 * leaves the turns that died long before to the person.
 */
import { senders } from "./agent-protocol.ts";
import { singleFlight } from "../single-flight.ts";
import type { Inbox } from "./inbox.ts";
import type { Registry } from "./registry.ts";
import type { ClaudeResume } from "./claude-worker.ts";
import type { Thread } from "./thread-store.ts";
import { requestIds, type ThreadId } from "../ids.ts";
import type { PhaseKind } from "./review-model.ts";
import { threadRole } from "./work-model.ts";
import { isOpenStatus, openStatuses } from "./reconcile.ts";

type ResumeRegistry = Pick<Registry, "agent" | "appendEvent" | "claudeResume" | "claudeTranscript" | "isReviewer" | "planning" | "resumedThreads" | "review" | "saveClaudeResume" | "storedThreads" | "thread">;

const text = `${senders.resume.prefix} Your turn stopped before it finished: its Claude session ended, or its model's API failed. Continue where you stopped.`;

/**
 * The wait before each resume in a row. Claude Code retries a failed API call for minutes before it gives up, so a turn
 * that reaches Nexus outlived a blip, and the waits span the better part of an hour of a provider's outage before the
 * person is asked. Three resumes cover a crash and a short outage, and a fourth death in a row is more likely an
 * outage or something the work itself does, which is the person's.
 */
export const resumeWaitsMs = [1, 10, 30].map((minutes) => minutes * 60_000);
/** A resume types a prompt, whose turn starts at once whatever the model does, so a resume that starts none has a fault of its own. */
const startMs = 10 * 60_000;
/** By the pylon's clock against the control plane's, which an hour leaves room for. */
const freshMs = 60 * 60_000;
const finished: ReadonlySet<PhaseKind> = new Set(["landed", "merged", "closed", "cancelled"]);

export function deadTurnResumer(options: {
  registry: ResumeRegistry; inbox: Inbox;
  /** The person talking to a thread after its first reply makes it theirs, so it is left alone. */
  personWroteTo(t: Thread): Promise<boolean>;
  clock?: () => number; log?: (message: string) => void;
}) {
  const { registry, inbox, personWroteTo, clock = Date.now, log = (message: string) => console.error(message) } = options;

  function covered(t: Thread): boolean {
    if (!isOpenStatus(t.status)) return false;
    if (registry.agent(t).kind !== "claude" || threadRole(registry, t) !== "builder") return false;
    const phase = registry.review(t.id)?.phase.kind;
    if (phase === "needs-person") return false;
    return !(t.turnDied?.cause === "model-error" && phase !== undefined && !finished.has(phase));
  }

  /** Whether `t` still waits on the death `turn` and no turn of it runs. */
  const stillDead = (t: Thread, turn: number) => covered(t) && !t.working && t.turnDied?.at === turn;

  async function judge(t: Thread) {
    const record = registry.claudeResume(t.id);
    if (record?.state === "left-alone") return;
    const save = (next: ClaudeResume | null) => registry.saveClaudeResume(t.id, next);
    if (!covered(t)) return record === null ? undefined : save(null);
    // The turn the person's message starts may outlast the transcript's hold on that message, so look while it runs.
    if (t.working && t.lastHumanActivityAt > (t.lastReplyAt ?? 0) && await personWroteTo(t)) return save({ state: "left-alone" });
    const died = t.turnDied;
    if (record?.state === "sending") {
      // It may never have gone out, so it goes only to a thread that still waits on that death and is not the person's.
      if (await personWroteTo(t)) return save({ state: "left-alone" });
      const fresh = registry.thread(t.id);
      if (fresh === undefined) return;
      if (stillDead(fresh, record.turn)) return deliver(fresh, record);
      // Only a turn that started since ends a death, so the resume went out before a crash lost its answer.
      if (covered(fresh) && fresh.turnDied?.at !== record.turn) save({ state: "resumed", turn: record.turn, count: record.count, at: clock() });
      return;
    }
    if (died === undefined) {
      // A turn started since the one that died. Once it ended and the transcript was read past its end without a death
      // in it, the deaths in a row are over: a read that lags the end would show no model error yet.
      const readAt = registry.claudeTranscript(t.id)?.readAt ?? -Infinity;
      if (record !== null && !t.working && t.lastReplyAt !== null && readAt >= t.lastReplyAt) save(null);
      return;
    }
    if (t.working) return;
    if (record !== null && record.turn >= died.at) {
      if (record.state === "resumed" && clock() - record.at >= startMs) {
        return save({ state: "person", turn: record.turn, count: record.count, why: `Nexus resumed it after its turn died, and no turn started within ${startMs / 60_000} minutes.` });
      }
      if (record.state !== "waiting" || clock() < record.due) return;
      if (await personWroteTo(t)) return save({ state: "left-alone" });
      // The await above may have let a turn start or an archive in.
      const fresh = registry.thread(t.id);
      if (fresh === undefined || !stillDead(fresh, record.turn)) return;
      const sending: ClaudeResume = { state: "sending", turn: record.turn, count: record.count, since: clock() };
      save(sending);
      return deliver(fresh, sending);
    }
    if (clock() - died.at > freshMs) return;
    if (await personWroteTo(t)) return save({ state: "left-alone" });
    const count = (record?.count ?? 0) + 1;
    if (count > resumeWaitsMs.length) return save({ state: "person", turn: died.at, count: count - 1, why: `Its turn died ${count} times in a row (last: ${died.reason}), so Nexus stopped resuming it.` });
    save({ state: "waiting", turn: died.at, count, due: clock() + resumeWaitsMs[count - 1]! });
  }

  /**
   * A send the inbox could not take yet stays saved, so the next pass sends it again under the same request ID, until
   * it has tried for as long as a resume may take to start a turn.
   */
  async function deliver(t: Thread, { turn, count, since }: Extract<ClaudeResume, { state: "sending" }>) {
    const requestId = requestIds.resume(t.id, turn);
    if (await inbox(t, { id: requestId, text, sender: "resume" }) !== "delivered") {
      if (clock() - since >= startMs) registry.saveClaudeResume(t.id, { state: "person", turn, count, why: `Its turn died, and Nexus could not type its resume into the session for ${startMs / 60_000} minutes.` });
      return;
    }
    registry.saveClaudeResume(t.id, { state: "resumed", turn, count, at: clock() });
    registry.appendEvent("thread.resumed", t.id, { turn, count, reason: t.turnDied?.reason ?? null, requestId });
  }

  async function pass() {
    // A thread archived since its resume has its record cleared, so an unarchived one starts its count over.
    const ids = new Set([...registry.storedThreads({ status: openStatuses }).map((t) => t.id), ...registry.resumedThreads()]);
    for (const id of ids) {
      // Read again after the passes before it, which another thread's sends may have outrun.
      const t = registry.thread(id as ThreadId);
      if (t === undefined) continue;
      try {
        await judge(t);
      } catch (err) {
        log(`${t.id}: resuming the turn that died failed and will be retried: ${(err as Error).message}`);
      }
    }
  }
  const passes = singleFlight(pass);
  return { poll: passes.join, close: passes.settled };
}
