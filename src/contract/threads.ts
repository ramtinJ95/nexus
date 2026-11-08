/**
 * The thread and queued-thread routes of the control plane's API: each route's method, path, query and the types of
 * its body and reply. The server registers its handlers against them and the CLI calls them. It imports nothing at
 * run time, so a browser can bundle it. threads-parse.ts holds the request schemas.
 */
import type { z } from "zod";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ProjectId, ThreadId } from "../ids.ts";
import type { BootInputs } from "../protocol/spawn.ts";
import type { ClaudeConversation } from "../control/claude-transcript.ts";
import type { Thread } from "../control/thread-store.ts";
import type { Sent, ThreadDetail, ThreadRow } from "../control/wire.ts";
import type { activitySchema, messageSchema, seenSchema, startSchema } from "./threads-parse.ts";
import { pylonWaitMs, queryOf, route, type QueryCodec } from "./route.ts";

/** What one predecessor means for the queued thread. */
export interface Wait { thread: ThreadId; state: "waiting" | "landed" | "blocked"; why: string }

/** The API's view of a thread that has not started, which `show` and `threads --queued` print. */
export interface QueuedThread {
  id: ThreadId;
  title: string;
  project: ProjectId;
  startedBy: string;
  createdAt: number;
  /** Archived means cancelled. */
  status: "queued" | "archived" | "deleted";
  after: readonly ThreadId[];
  /** One per predecessor, in `after` order. */
  waits: readonly Wait[];
  /** Some wait is blocked, or the queue holds a start refused for a branch the remote does not have. */
  blocked: boolean;
  /** A node, or "auto". */
  node: string;
  worker: "harness" | "claude";
  model: string | null;
  /** The first message, or the Claude prompt as given, without the `/poteto-mode` a start puts in front. */
  prompt: string | null;
  branch: string | null;
  commit: string | null;
  resources: BootInputs["resources"];
  startNow: { by: string; at: number } | null;
  lastError: string | null;
}

/** `deleted: false` leaves out deleted threads. */
export interface ThreadsQuery { project?: string | undefined; deleted?: false }
const threadsQuery: QueryCodec<ThreadsQuery> = {
  encode: ({ project, deleted }) => queryOf([["project", project], ["deleted", deleted === false ? "false" : undefined]]),
  decode: (params) => ({ ...params.has("project") ? { project: params.get("project")! } : {}, ...params.get("deleted") === "false" ? { deleted: false } : {} }),
};

/** `status: "queued"` leaves out cancelled and deleted queued threads. */
export interface QueuedQuery { project?: string | undefined; status?: "queued" }
const queuedQuery: QueryCodec<QueuedQuery> = {
  encode: ({ project, status }) => queryOf([["project", project], ["status", status]]),
  decode: (params) => ({ ...params.has("project") ? { project: params.get("project")! } : {}, ...params.get("status") === "queued" ? { status: "queued" } : {} }),
};

export const threadRoutes = {
  list: route<ThreadRow[]>()("GET", "/v1/threads", threadsQuery),
  start: route<Thread | QueuedThread, z.input<typeof startSchema>>()("POST", "/v1/threads"),
  queued: route<QueuedThread[]>()("GET", "/v1/queued", queuedQuery),
  queuedThread: route<QueuedThread>()("GET", "/v1/queued/{thread}"),
  startQueued: route<Thread>()("POST", "/v1/threads/{thread}/start"),
  show: route<ThreadDetail>()("GET", "/v1/threads/{thread}"),
  delete: route<Thread | QueuedThread>()("DELETE", "/v1/threads/{thread}"),
  seen: route<null, z.input<typeof seenSchema>>()("POST", "/v1/threads/{thread}/seen"),
  unseen: route<null, z.input<typeof seenSchema>>()("POST", "/v1/threads/{thread}/unseen"),
  archive: route<Thread | QueuedThread>()("POST", "/v1/threads/{thread}/archive"),
  unarchive: route<Thread | QueuedThread>()("POST", "/v1/threads/{thread}/unarchive"),
  activity: route<null, z.input<typeof activitySchema>>()("POST", "/v1/threads/{thread}/activity"),
  /** A Claude worker's message waits for the pylon to type it in. */
  message: route<Sent, z.input<typeof messageSchema>>()("POST", "/v1/threads/{thread}/messages", undefined, pylonWaitMs),
  abort: route<null>()("POST", "/v1/threads/{thread}/abort"),
  retry: route<null>()("POST", "/v1/threads/{thread}/retry"),
  retryPylon: route<null>()("POST", "/v1/threads/{thread}/pylon/retry"),
  /** Null only in its type: a thread with no conversation is refused. */
  conversation: route<ConversationView | ClaudeConversation | null>()("GET", "/v1/threads/{thread}/conversation"),
} as const;
