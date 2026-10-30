/**
 * The JSON the control plane's API serves that the CLI, the dashboard and the on-node checks read.
 */
import type { Submission } from "@earendil-works/pi-durable";
import type { Attention } from "./attention.ts";
import type { ActualState, DesiredPhase } from "../reconcile.ts";
import type { BootInputs } from "../spawn.ts";
import type { NodeName, PylonId, TailnetNodeId } from "../ids.ts";
import type { SessionHarness } from "../session-harness.ts";
import type { ClaudeSent, Output, Preview, Session, Thread } from "./thread-store.ts";
import type { NodeRecord } from "./node-store.ts";
import type { PullRequest } from "./github.ts";
import type { Question } from "./questions.ts";
import type { JudgmentView } from "./judgment.ts";
import type { NodePylons } from "./placement.ts";
import type { Review } from "./review-model.ts";
import type { ImageEntry } from "./image-rollout.ts";
import type { BackfillPlanRow, UsageBackfill } from "./usage.ts";

/** A session `POST /v1/threads/<id>/sessions` opened. Its observed state shows in ThreadDetail.sessions. */
export interface OpenedSession { herdrPane: string; harness: SessionHarness; title: string }

export interface ThreadDetail {
  claudeWorker?: { model: string | null; state: string; message?: string };
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
  };
  sessions: readonly Session[];
  previews: readonly Preview[];
  /**
   * The TCP ports the pylon listens on that a preview can reach, as its node last reported them, in order. Empty
   * while the pylon is not running, and null when its node could not read them.
   */
  ports: readonly ListeningPort[] | null;
  outputs: readonly Output[];
  prWatch: { enabled: boolean; stopped: boolean; error: string | null };
  pullRequests: readonly PullRequest[];
  /** The thread's latest review as a builder, or null. */
  review: Review | null;
  /** Every question the thread asked, answered or not, in the order they were asked. */
  questions: readonly Question[];
  /** Every judgment of the thread's failed pylon, oldest failure first. */
  judgments: readonly JudgmentView[];
  /** A planning thread's proposals become questions, and the items the person accepts. */
  planning: boolean;
  /** The command that attaches to the pylon's Herdr sessions from a shell in the pylon. */
  attach: string;
  /** Null for a thread that has no conversation. A parked task holds the run until it is retried. */
  agent: { parkedTasks: number } | null;
}

/**
 * `service` is the service the port belongs to: declared, ad hoc, or `port-<port>` once it is linked. `preview` is
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

/** `GET /v1/images/current`: the current and previous images, each null when none is. */
export interface ImagesCurrent { current: ImageEntry | null; previous: ImageEntry | null }

/** `GET /v1/usage/backfill`: the backfill's state, and the archived threads a start would read. */
export interface BackfillView { backfill: UsageBackfill; plan: BackfillPlanRow[] }
