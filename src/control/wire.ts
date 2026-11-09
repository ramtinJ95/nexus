/**
 * The JSON the control plane's API serves that the CLI, the dashboard and the on-node checks read.
 */
import type { Submission } from "@earendil-works/pi-durable";
import type { Attention } from "./attention.ts";
import type { PersonNeed } from "./work-model.ts";
import type { ActualState, DesiredPhase } from "./reconcile.ts";
import type { BootInputs } from "../protocol/spawn.ts";
import type { GuestNotAnswering } from "../protocol/observations.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { ClaudeResume, ClaudeSent, ClaudeWorkerState } from "./claude-worker.ts";
import type { Output, Preview, Session, Thread } from "./thread-store.ts";
import type { NodeRecord } from "./node-store.ts";
import type { WatchedPr } from "./pr-watch-store.ts";
import type { ThreadQuestion } from "./questions.ts";
import type { JudgmentView } from "./judgment.ts";
import type { NodePylons } from "./placement.ts";
import type { Review } from "./review-model.ts";
import type { ReviewView } from "./review-view.ts";

/** One card of the inbox for a thread. */
export type ThreadNeed = PersonNeed & { d: ServerDetail };
/** A thread's detail as the control plane's dashboard and inbox read it: what the API serves, and the stored review, which it does not serve. */
export type ServerDetail = ThreadDetail & { review: Review | null };
export interface ThreadDetail {
  claudeWorker?: { model: string | null; state: ClaudeWorkerState; message?: string };
  /** Nexus resuming the Claude worker after its turns died, or null. */
  resume?: ClaudeResume | null;
  /** Why the builder found that its task needs no change, as it declared instead of opening a pull request, or null. */
  noChange: string | null;
  attention: Attention;
  seenAt: number | null;
  lastReplyAt: number | null;
  thread: Thread;
  /** What the planner wants of the pylon now, from the thread's status and activity. */
  desired: DesiredPhase;
  pylon: {
    grantsOutdated: boolean;
    id: PylonId; node: NodeName; actualState: ActualState; failed: string | null; observedAt: string | null;
    /** The size the pylon boots with, fixed when its thread started. */
    resources: BootInputs["resources"];
    /** Why a retry of the pylon, as its node last reported it, cannot help. Null when a retry can. */
    retryRefused: string | null;
    /** Set while its node reports the running pylon's guest gives no answer to its guest commands. */
    notAnswering?: GuestNotAnswering;
  };
  /** Every Herdr pane in the pylon and every failed session, as its node last reported them, or what its wake brings back while it is paused. */
  sessions: readonly Session[];
  /** Every preview of the thread, served or not, listening or not. */
  previews: readonly Preview[];
  /**
   * The TCP ports the pylon listens on that a preview can reach, as its node last reported them, in order. Empty
   * while the pylon is not running, and null when its node could not read them.
   */
  ports: readonly ListeningPort[] | null;
  outputs: readonly Output[];
  prWatch: { enabled: boolean; stopped: boolean; error: string | null };
  pullRequests: readonly WatchedPr[];
  /** The thread's review, what the person's Land press does to it now and the holds it reads, or null without a review. */
  reviewView: ReviewView | null;
  /** Why the archived thread's disk is kept past its 24 hours, or null. */
  keptPastDay: string | null;
  /** Every question the thread asked, answered or not, in the order they were asked. */
  questions: readonly ThreadQuestion[];
  /** Every judgment of the thread's failed pylon, oldest failure first. */
  judgments: readonly JudgmentView[];
  /** A planning thread's proposals become questions, and the items the person accepts. */
  planning: boolean;
  /** The command that attaches to the pylon's Herdr sessions from a shell in the pylon. */
  attach: string;
  /** Null for a thread that has no conversation. A parked task holds the run until it is retried. */
  agent: { parkedTasks: number } | null;
  said: ThreadSaid;
}

/** The sentences `nexus show` prints of a thread's state, as control/wording.ts words them, null where the state is not. */
export interface ThreadSaid {
  /** What a guest that stopped answering fails and what gives it a fresh VM, which follows when it stopped. */
  guest: string | null;
  disk: string | null;
  usage: string | null;
  /** A paused session's state. */
  paused: string;
  prWatch: string;
  review: readonly string[] | null;
}

/**
 * A TCP port in the pylon that a preview can reach. `service` is the service the port belongs to: declared, ad hoc, or
 * `port-<port>` once it is linked, and null for a process no service runs. `preview` is
 * that service's preview, or null while it has none, which `POST /v1/threads/<id>/previews` gives it.
 */
export interface ListeningPort { port: number; service: string | null; preview: Preview | null }

/** A thread as the list reports it, with what the planner wants of its pylon and what its node last reported. */
export type ThreadRow = Thread & { attention: Attention; desired: DesiredPhase; pylon: Pick<ThreadDetail["pylon"], "node" | "actualState" | "failed"> };

/** What `GET /v1/whoami` tells a caller about itself: its tailnet node, and what this control plane lets it do. */
export interface Whoami { node: TailnetNodeId; allowed: boolean; person: boolean; deployer: boolean }

/**
 * A node without its probe's latest observation, which thread detail already reports per pylon. `pylons` sorts the
 * observation's pylons by what they hold, and is null for a node never observed.
 */
export type NodeSummary = Omit<NodeRecord, "observation"> & { observedAt: string | null; overcommitted: boolean; pylons: NodePylons | null };

/** What a send answers: the harness's submission, or what typing into the Claude worker's session did. */
export type Sent = { submission: Submission["id"] } | { claude: ClaudeSent };
