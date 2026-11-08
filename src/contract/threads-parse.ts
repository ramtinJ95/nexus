/** The request schemas of the thread routes in threads.ts. They need zod, so they stay out of threads.ts, which a browser can bundle. */
import { z } from "zod";
import { maxPromptChars } from "../protocol/commands.ts";
import { minPylonMemoryGiB, minPylonMemoryReason } from "../protocol/spawn.ts";
import { titleOf } from "../thread-title.ts";

/** A pylon's size, which a project gives its threads and a thread's start may change. */
export const resourcesSchema = z.strictObject({ cpus: z.int().positive(), memoryGiB: z.int().min(minPylonMemoryGiB, minPylonMemoryReason), diskGiB: z.int().positive() });

/** The fields of a start or an item that the rules below read together. */
interface Brief { title?: string | undefined; message?: string | null | undefined; claude?: string | undefined; model?: string | undefined; after?: readonly string[] | undefined; planning?: true | undefined }
/** `name` gives a field as the caller knows it: the API's field, or the CLI's flag. */
interface BriefRule { broken(b: Brief): boolean; message(name: (field: keyof Brief) => string): string }

const workerRules: readonly BriefRule[] = [
  { broken: (b) => b.model !== undefined && b.claude === undefined, message: (name) => `${name("model")} requires ${name("claude")}` },
  { broken: (b) => b.message != null && b.claude !== undefined, message: (name) => `${name("message")} is for a Nexus agent thread. A Claude worker's first prompt is its ${name("claude")}` },
];
export const startRules: readonly BriefRule[] = [
  ...workerRules,
  { broken: (b) => b.planning === true && (b.claude !== undefined || b.after !== undefined), message: (name) => `${name("planning")} starts a Nexus agent thread now, so it takes neither ${name("claude")} nor ${name("after")}` },
  { broken: (b) => b.title === undefined && b.message == null && b.claude === undefined, message: (name) => `start needs ${name("title")}, ${name("message")} or ${name("claude")}` },
];
export const itemRules: readonly BriefRule[] = [
  ...workerRules,
  { broken: (b) => b.message == null && b.claude === undefined, message: (name) => `an item needs a brief: ${name("message")} for a Nexus agent thread, or ${name("claude")} for a Claude worker` },
];
/** The message of the first rule `b` breaks, or undefined when it breaks none. */
export const brokenRule = (rules: readonly BriefRule[], b: Brief, name = (field: keyof Brief): string => field) => rules.find((rule) => rule.broken(b))?.message(name);

/** `fields` held to `rules`. Without a title, it takes its brief's first line, which the rules make sure it has. */
export const briefSchema = <S extends z.ZodType<Brief>>(fields: S, rules: readonly BriefRule[]) => fields
  .superRefine((b, ctx) => {
    const broken = brokenRule(rules, b);
    if (broken !== undefined) ctx.addIssue({ code: "custom", message: broken });
  })
  .transform((b: z.output<S>): z.output<S> & { title: string } => b.title !== undefined ? b as z.output<S> & { title: string } : { ...b, title: titleOf(b.message ?? b.claude!) });

export const startFields = z.strictObject({
  model: z.string().trim().min(1).max(200).optional(),
  claude: z.string().trim().min(1).max(maxPromptChars).refine((prompt) => !prompt.includes("\0"), "a Claude prompt cannot hold a NUL character, which no command-line argument can").optional(),
  project: z.string().min(1),
  title: z.string().min(1).optional(),
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
export const startSchema = briefSchema(startFields, startRules);

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
