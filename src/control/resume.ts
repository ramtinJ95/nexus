/**
 * Resumes a Claude builder whose turn died (Thread.turnDied): its session ended during the turn, or the turn ended on
 * a model error after Claude Code's own retries. Nothing else moves such a thread: no reply was recorded or the reply
 * was the error, and the pylon idles until it pauses. Each turn that died gets one fixed message, after a wait that
 * grows with each death in a row, under a request ID of the thread and the turn's death, which the inbox never delivers
 * twice. After the last resume in a row a turn that dies too goes to the person through the `died` attention, so a
 * provider outage ends there rather than looping. A turn that does not die ends the count. The person's message after
 * a death answers that death, so Nexus sends no resume for it, and one that starts no turn goes to the person too. A
 * message the person wrote before the death answers nothing, so a conductor who steers a builder keeps its resumes.
 * Every death Nexus does not resume goes to the person with why, so none reads as a reply.
 *
 * Reviewers, checks and planning threads are left out, and so is a builder whose review the loop handed to the person.
 * Until its review finishes, the loop sends a builder whose turn ended on a model error its request again, or its next
 * message, which resumes it as well, so such a builder gets no resume for one. A planning thread runs in the harness,
 * where no session ends. Only a death in the last hour is resumed, so a control plane that starts, or starts this,
 * leaves the turns that died long before to the person. The ten minutes a resume has to start a turn count from its
 * node's last return, so a link to the node that was down does not use them up.
 */
import { senders } from "./agent-protocol.ts";
import { singleFlight } from "../single-flight.ts";
import type { Inbox } from "./inbox.ts";
import type { Registry } from "./registry.ts";
import { resumeStartMs, type ClaudeResume } from "./claude-worker.ts";
import type { Thread } from "./thread-store.ts";
import { requestIds, type ThreadId } from "../ids.ts";
import type { PhaseKind } from "./review-model.ts";
import { threadRole } from "./work-model.ts";
import { isOpenStatus, openStatuses } from "./reconcile.ts";

type ResumeRegistry = Pick<Registry, "threads" | "reviews" | "planning" | "nodes">;

const text = `${senders.resume.prefix} Your turn stopped before it finished: its Claude session ended, or its model's API failed. Continue where you stopped.`;

/**
 * The wait before each resume in a row. Claude Code retries a failed API call for minutes before it gives up, so a turn
 * that reaches Nexus outlived a blip, and the waits span the better part of an hour of a provider's outage before the
 * person is asked. Three resumes cover a crash and a short outage, and a fourth death in a row is more likely an
 * outage or something the work itself does, which is the person's.
 */
export const resumeWaitsMs = [1, 10, 30].map((minutes) => minutes * 60_000);
/** By the pylon's clock against the control plane's, which an hour leaves room for. */
const freshMs = 60 * 60_000;
const finished: ReadonlySet<PhaseKind> = new Set(["landed", "merged", "closed", "cancelled"]);

export function deadTurnResumer(options: {
  registry: ResumeRegistry; inbox: Inbox;
  /** Whether the person wrote to the thread after `since`, by the pylon's clock, as a turn's death is stamped. */
  personWroteTo(t: Thread, since: number): Promise<boolean>;
  clock?: () => number; log?: (message: string) => void;
}) {
  const { registry, inbox, personWroteTo, clock = Date.now, log = (message: string) => console.error(message) } = options;

  function covered(t: Thread): boolean {
    if (!isOpenStatus(t.status)) return false;
    if (registry.threads.agent(t).kind !== "claude" || threadRole(registry, t) !== "builder") return false;
    const phase = registry.reviews.review(t.id)?.phase.kind;
    if (phase === "needs-person") return false;
    return !(t.turnDied?.cause === "model-error" && phase !== undefined && !finished.has(phase));
  }

  /** Whether `t` still waits on the death `turn` and no turn of it runs. */
  const stillDead = (t: Thread, turn: number) => covered(t) && !t.working && t.turnDied?.at === turn;
  /** Whether the thread's node is offline, so no message reaches it and no report of a turn comes from it. */
  const offline = (t: Thread) => {
    const pylon = registry.threads.pylon(t.pylonId);
    return pylon !== undefined && registry.nodes.node(pylon.node)?.state !== "online";
  };

  async function judge(t: Thread) {
    const record = registry.threads.claudeResume(t.id);
    const save = (next: ClaudeResume | null) => registry.threads.saveClaudeResume(t.id, next);
    if (!covered(t)) return record === null ? undefined : save(null);
    const died = t.turnDied;
    const answered = (r: { turn: number; count: number; from?: number }): ClaudeResume => ({ state: "answered", turn: r.turn, count: r.count, from: r.from ?? clock(), at: clock() });
    if (record?.state === "sending") {
      // It may never have gone out, so it goes only to a thread that still waits on that death and that the person did not answer.
      if (await personWroteTo(t, record.turn)) return save(answered(record));
      const fresh = registry.threads.thread(t.id);
      if (fresh === undefined) return;
      if (stillDead(fresh, record.turn)) return deliver(fresh, record);
      // Only a turn that started since ends a death, so the resume went out before a crash lost its answer.
      if (covered(fresh) && fresh.turnDied?.at !== record.turn) save({ state: "resumed", turn: record.turn, count: record.count, from: record.from, at: clock() });
      return;
    }
    if (died === undefined) {
      // A turn started since the one that died. Once it ended and the transcript was read past its end without a death
      // in it, the deaths in a row are over: a read that lags the end would show no model error yet.
      const readAt = registry.threads.claudeTranscript(t.id)?.readAt ?? -Infinity;
      if (record !== null && !t.working && t.lastReplyAt !== null && readAt >= t.lastReplyAt) save(null);
      return;
    }
    if (t.working) return;
    if (record !== null && record.turn >= died.at) {
      if (record.state === "resumed" || record.state === "answered") {
        // A turn its node has not been able to report yet may have started, so the wait counts from the node's return.
        if (offline(t)) return save({ ...record, at: clock() });
        if (clock() - record.at < resumeStartMs) return;
        return save({ state: "person", turn: record.turn, count: record.count, why: record.state === "resumed"
          ? `Its turn died (${died.reason}). Nexus resumed it, and no turn started within ${resumeStartMs / 60_000} minutes.`
          : `Its turn died (${died.reason}). You wrote to it since, and no turn started within ${resumeStartMs / 60_000} minutes.` });
      }
      if (record.state !== "waiting" || clock() < record.due) return;
      if (await personWroteTo(t, record.turn)) return save(answered(record));
      // The await above may have let a turn start or an archive in.
      const fresh = registry.threads.thread(t.id);
      if (fresh === undefined || !stillDead(fresh, record.turn)) return;
      const sending: ClaudeResume = { state: "sending", turn: record.turn, count: record.count, from: record.from, since: clock() };
      save(sending);
      return deliver(fresh, sending);
    }
    const count = record?.count ?? 0;
    const toPerson = (why: string) => save({ state: "person", turn: died.at, count, why: `Its turn died (${died.reason}). ${why}` });
    if (clock() - died.at > freshMs) return toPerson(`It died more than ${freshMs / 60_000} minutes before Nexus saw it, so Nexus did not resume it.`);
    if (await personWroteTo(t, died.at)) return save(answered({ turn: died.at, count }));
    if (count >= resumeWaitsMs.length) return toPerson(`It died ${count + 1} times in a row, so Nexus stopped resuming it.`);
    save({ state: "waiting", turn: died.at, count: count + 1, from: clock(), due: clock() + resumeWaitsMs[count]! });
  }

  /**
   * A send the inbox could not take yet stays saved, so the next pass sends it again under the same request ID, until
   * it has tried for as long as a resume may take to start a turn.
   */
  async function deliver(t: Thread, { turn, count, from, since }: Extract<ClaudeResume, { state: "sending" }>) {
    const requestId = requestIds.resume(t.id, turn);
    if (await inbox(t, { id: requestId, text, sender: "resume" }) !== "delivered") {
      if (offline(t)) registry.threads.saveClaudeResume(t.id, { state: "sending", turn, count, from, since: clock() });
      else if (clock() - since >= resumeStartMs) registry.threads.saveClaudeResume(t.id, { state: "person", turn, count, why: `Its turn died (${t.turnDied?.reason ?? "its Claude session ended"}). Nexus could not type its resume into the session for ${resumeStartMs / 60_000} minutes.` });
      return;
    }
    registry.threads.saveClaudeResume(t.id, { state: "resumed", turn, count, from, at: clock() });
    registry.threads.appendEvent("thread.resumed", t.id, { turn, count, reason: t.turnDied?.reason ?? null, requestId });
  }

  async function pass() {
    // A thread archived since its resume has its record cleared, so an unarchived one starts its count over.
    const ids = new Set([...registry.threads.storedThreads({ status: openStatuses }).map((t) => t.id), ...registry.threads.resumedThreads()]);
    for (const id of ids) {
      // Read again after the passes before it, which another thread's sends may have outrun.
      const t = registry.threads.thread(id as ThreadId);
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
