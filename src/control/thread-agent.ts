/**
 * What the control plane does with a thread's agent, whichever kind it is. The registry says which agent a thread
 * has (`Registry.agent`), and the API takes that kind's implementation here: the harness for a harness thread, and
 * claude-conversation.ts and the registry for a Claude worker. A bare thread has neither, and its agent refuses
 * everything a conversation would answer.
 *
 * The wire keeps each kind's own shapes: a harness conversation's view and its `/events` stream, and a Claude worker's
 * transcript and its `/claude/events` stream. Only the transcript carries a kind, which `agentView` reads.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ConversationView, Submission } from "@earendil-works/pi-durable";
import type { ClaudeConversation } from "../claude-transcript.ts";
import type { CommandResult, ProbeClient, ProbeError, PylonId } from "../protocol.ts";
import type { HarnessHost } from "../harness/host.ts";
import { claudeTextProblem } from "../sessions.ts";
import { harnessView } from "./agent-conversation.ts";
import type { ClaudeConversations } from "./claude-conversation.ts";
import { claudeFrames, viewFrames, type Frames, type Watch } from "./conversation-view.ts";
import { HttpError } from "./http-error.ts";
import { typeIntoClaude } from "./inbox.ts";
import type { Planning } from "./planning.ts";
import type { ClaudeSent, Registry, Thread } from "./registry.ts";
import type { ThreadDetail } from "./wire.ts";

/** A message for the thread's agent, as `POST /v1/threads/:id/messages` takes it. */
export interface AgentMessage { text: string; requestId: string; mode: "followUp" | "steer" }

/** What a send answers: the harness's submission, or what typing into the Claude worker's session did. */
export type Sent = { submission: Submission["id"] } | { claude: ClaudeSent };

/** Runs `act` in the thread's pylon, as the API's `inPylon` does, mapping the probe's failures to its refusals. */
export type PylonRun = <T>(t: Thread, act: (probe: Pick<ProbeClient, "command" | "stream">, pylonId: PylonId) => Promise<T>) => Promise<T>;

export interface Agent<V> {
  /** The conversation now. A Claude worker's is its transcript as last read, so it never reaches the pylon. */
  view(t: Thread): Promise<V>;
  /** What `GET /v1/threads/:id/conversation` answers. A Claude worker's transcript is read first, for at most 5 s. */
  read(t: Thread): Promise<V>;
  watch(t: Thread): Promise<Watch<V>>;
  /** The frames of one client of the CLI's stream of this kind. */
  frames(): Frames<V>;
  send(t: Thread, message: AgentMessage): Promise<Sent>;
  /** Stops the turn that runs. */
  abort(t: Thread): Promise<void>;
  /** The snapshot ID of the latest turn, which the Changes view's turn base diffs against, or null before any. */
  latestTurn(t: Thread): Promise<string | null>;
  /** What thread detail says of the agent. */
  detail(t: Thread): Pick<ThreadDetail, "claudeWorker" | "agent">;
  /** For a thread just deleted. */
  delete(t: Thread): Promise<void>;
}

/** The drain reads every harness thread's view from its stored row, so a harness view needs only the thread's ID. */
interface HarnessAgent extends Agent<ConversationView> { view(t: Pick<Thread, "id">): Promise<ConversationView> }

export type ThreadHarness = Pick<HarnessHost, "startThread" | "send" | "abort" | "retry" | "watch" | "deleteThread" | "activity" | "latestTurn">;

export interface ThreadAgents { harness: HarnessAgent; claude: Agent<ClaudeConversation>; none: Agent<null> }

export const noConversation = (t: Pick<Thread, "id">) => `thread ${t.id} has no conversation`;

/** How long a read of a Claude worker's conversation waits for its transcript before answering what is stored. */
const claudeReadMs = 5_000;

/**
 * `inPylon` wakes the pylon as the person's activity and `whileRunning` only acts while it runs, and both refuse as
 * the API does. `wake` wakes the thread's pylon. Planning composes what a planning thread's messages start with.
 */
export function threadAgents(options: {
  registry: Registry; harness: ThreadHarness; claude: ClaudeConversations; inPylon: PylonRun; whileRunning: PylonRun; wake(t: Thread): void;
  planning: Pick<Planning, "compose" | "sent"> | null;
}): ThreadAgents {
  const { registry, harness, claude, inPylon, whileRunning, wake, planning } = options;
  const refuse = (t: Thread): never => { throw new HttpError(409, noConversation(t)); };
  const worker = (t: Thread) => registry.claudeWorker(t.id)!;

  const view = harnessView(harness);

  return {
    harness: {
      view,
      read: view,
      watch: (t) => harness.watch(t.id),
      frames: viewFrames,
      /** A message is human activity, so the pylon wakes while the model answers. */
      async send(t, message) {
        registry.recordActivity(t.id, { human: Date.now() });
        wake(t);
        const text = planning?.compose(t, message.requestId, message.text) ?? message.text;
        const submission = await harness.send(t.id, text, message.requestId, message.mode);
        planning?.sent(t, message.requestId);
        return { submission: submission.id };
      },
      abort: (t) => harness.abort(t.id),
      latestTurn: (t) => harness.latestTurn(t.id),
      detail: (t) => ({ agent: t.status === "deleted" ? null : { parkedTasks: harness.activity.parked(t.id).length } }),
      // Its run waits for a pylon until the thread is deleted, as the locator refuses a deleted thread's pylon.
      delete: (t) => harness.deleteThread({ threadId: t.id, pylonId: t.pylonId }),
    },
    claude: {
      view: async (t) => claude.view(t),
      async read(t) {
        await Promise.race([claude.refresh(t), sleep(claudeReadMs, undefined, { ref: false })]);
        return claude.view(t);
      },
      watch: (t) => claude.watch(t),
      frames: claudeFrames,
      /**
       * Types a message into the Claude worker's session in the pylon, through inPylon, so it wakes a paused pylon and
       * resumes Claude, and is refused with a 409 until the pylon runs. Both modes go into Claude's prompt, which takes
       * a message sent during a turn at its next step. Claude receives the text exactly, so text that cannot be typed as
       * it is, such as one with a tab, is refused rather than changed.
       *
       * The request ID is recorded as sending before the probe is asked, and as sent with the answer, which a resend of
       * the ID answers again without typing. A send whose answer never came, as one queued in the pylon behind a slow
       * send past the probe's wait, may still be typed, so a resend of it asks the probe what became of it and answers
       * that. A send that failed partway, or that the probe no longer knows, may have typed part of the message, so a
       * resend of it is refused with a 422 for the person to check the conversation. A send that typed nothing, as when
       * the pylon was not running or Claude waits at a prompt in its terminal, is forgotten, so a resend of its ID
       * types it.
       */
      async send(t, message) {
        const text = message.text.replace(/\r\n?/g, "\n").trim();
        const problem = claudeTextProblem(text);
        if (problem !== null) throw new HttpError(400, `Claude cannot take this message as typed: ${problem}`);
        const { session, model } = worker(t);
        if (session === null) throw new HttpError(409, `the Claude worker of ${t.id} has not started a session yet, so it takes no messages. Send it once it has started`, "not-ready");
        const stored = registry.claudeMessage(t.id, message.requestId);
        if (stored?.state === "sent") return { claude: stored.result };
        const typed = await inPylon(t, (probe, pylonId) => typeIntoClaude(registry, t.id, session, model, message.requestId, text, (command) => probe.command(pylonId, command)).catch((err: Partial<ProbeError>) => {
          if (err.code !== "unreachable") throw err;
          throw Object.assign(new Error(`${err.message}. The message may still reach Claude, as one queued in the pylon behind an earlier send does, and reaches it at most once. Send it again under request ID ${message.requestId} to learn what became of it`), { code: "unreachable" });
        }));
        if (typed.kind === "uncertain") throw new HttpError(422, `an earlier send of request ${message.requestId} failed partway, or its pylon no longer knows how far it got, so Claude may have some or all of it. Check the conversation before sending it again under a new request ID`);
        if (typed.kind === "nothing") {
          const [refusal, code] = ({
            blocked: [`Claude waits at a prompt in its terminal, so nothing was typed. Attach to the pylon (\`nexus attach ${t.id}\`) and answer it, then send again`, "blocked"],
            starting: [`Claude is not ready to take a message yet, so nothing was typed. Ask again in a moment`, "not-ready"],
            moved: [`Herdr pane ${typed.herdrPane} stopped running Claude session ${session} before the message was typed, so nothing was typed. Send again to resume the session`, "moved"],
          } as const)[typed.outcome];
          throw new HttpError(409, refusal, code);
        }
        void claude.refresh(t);
        return { claude: typed.sent };
      },
      /**
       * Presses Esc in the Claude worker's pane, which interrupts its turn as Esc at its terminal does. A paused pylon
       * runs no turn, so it is not woken. Nothing is pressed unless Claude works, so a dialog it waits at is never
       * cancelled.
       */
      async abort(t) {
        const { session } = worker(t);
        if (session === null) throw new HttpError(409, `the Claude worker of ${t.id} has not started a session yet, so it has no turn to interrupt`);
        const { outcome } = await whileRunning(t, (probe, pylonId) => probe.command(pylonId, { kind: "interrupt-claude", session })) as Extract<CommandResult, { kind: "interrupt-claude" }>;
        if (outcome === "interrupted") return;
        throw new HttpError(409, {
          blocked: `Claude waits at a prompt in its terminal, which Esc would cancel, so nothing was pressed. Attach to the pylon (\`nexus attach ${t.id}\`) and answer it`,
          idle: `Claude is not working, so there is no turn to interrupt, and nothing was pressed`,
          unknown: `Herdr cannot tell yet whether Claude works or waits at a prompt, so nothing was pressed. Ask again in a moment`,
          "not-running": `no pane runs Claude session ${session}, so there is no turn to interrupt`,
        }[outcome], outcome === "blocked" ? "blocked" : undefined);
      },
      latestTurn: async (t) => registry.latestClaudeTurn(t.id),
      detail(t) {
        const { model, state, message } = worker(t);
        return { claudeWorker: { model, state, ...message === undefined ? {} : { message } }, agent: null };
      },
      // A read that finds the thread deleted lets its reader go.
      delete: async (t) => { void claude.refresh(t); },
    },
    none: {
      view: async () => null,
      read: async (t) => refuse(t),
      watch: async (t) => refuse(t),
      frames: () => () => null,
      send: async (t) => refuse(t),
      abort: async (t) => refuse(t),
      latestTurn: async () => null,
      detail: () => ({ agent: null }),
      delete: async () => {},
    },
  };
}
