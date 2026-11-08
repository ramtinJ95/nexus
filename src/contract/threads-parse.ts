/** The request schemas of the thread routes in threads.ts. They need zod, so they stay out of threads.ts, which a browser can bundle. */
import { z } from "zod";
import { maxPromptChars } from "../protocol/commands.ts";
import { minPylonMemoryGiB, minPylonMemoryReason } from "../protocol/spawn.ts";

/** A pylon's size, which a project gives its threads and a thread's start may change. */
export const resourcesSchema = z.strictObject({ cpus: z.int().positive(), memoryGiB: z.int().min(minPylonMemoryGiB, minPylonMemoryReason), diskGiB: z.int().positive() });

export const startSchema = z.strictObject({
  model: z.string().trim().min(1).max(200).optional(),
  claude: z.string().trim().min(1).max(maxPromptChars).refine((prompt) => !prompt.includes("\0"), "a Claude prompt cannot hold a NUL character, which no command-line argument can").optional(),
  project: z.string().min(1),
  title: z.string().min(1),
  node: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  /**
   * Until the control plane mirrors repos, the caller may pin a commit. The default is the branch tip at clone time.
   * A scratch project has none to pin.
   */
  commit: z.string().min(1).optional(),
  /** The thread's size where it differs from its project's. Its pylon boots this size on every wake. */
  resources: resourcesSchema.partial().optional(),
  /** Queue the thread to start once each of these threads' pull requests has merged. */
  after: z.array(z.string().min(1)).min(1).max(32).optional(),
  /** A Nexus agent thread's first message, sent as the person's once it starts. */
  message: z.string().min(1).optional(),
  /** Minted by the client per start, such as start:<uuid>. A retry with the same ID and body is the same start. */
  requestId: z.string().min(1).max(200).optional(),
  /** A Nexus agent thread that plans: its proposals become questions for the person. */
  planning: z.literal(true).optional(),
});

export const seenSchema = z.strictObject({ lastReplyAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional() });
// Agent activity comes from the harness.
export const activitySchema = z.strictObject({ kind: z.literal("human") });
export const messageSchema = z.strictObject({
  text: z.string().min(1),
  /** Minted by the client per message, such as msg:<uuid>. A retry with the same ID is the same message. */
  requestId: z.string().min(1),
  /** followUp waits for the current run. steer joins it after its current tool round. */
  mode: z.enum(["followUp", "steer"]).default("followUp"),
});
