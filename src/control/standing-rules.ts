/** A project's standing rules: which starts carry them, how they join a brief, and how an edit counts revisions. */
import { roleOf } from "./agent-protocol.ts";
import type { ThreadId } from "../ids.ts";
import type { Project, StandingRules } from "./project.ts";
import type { StartRequest } from "./start-request.ts";

/** The longest rules a project takes, so a brief with them still fits a Claude prompt. */
export const standingRulesLimit = 8_192;

/**
 * The rules a thread was started with. `carriedBy` is the request ID of the first message the harness took with them,
 * `prompt` for a Claude worker's prompt, which its launch retries until it starts, or null until a message carries them.
 */
export interface StandingRulesStamp { revision: number; text: string; carriedBy: string | null }

/** The brief as written, then the rules under a heading of their own. */
export const withStandingRules = (brief: string, rules: Pick<StandingRulesStamp, "text"> | null): string =>
  rules === null ? brief : `${brief}\n\n## Standing rules for this project\n\n${rules.text}`;

/**
 * Only a builder carries rules. A `raw` start is the review loop's Claude reviewer, and the review loop's harness
 * reviewer, check and live-check threads are known by their caller: the loop briefs them itself, and a check runs no
 * agent. A planning thread gets none, because the builders of the briefs it writes get the rules on their own.
 */
export function standingRulesFor(project: Pick<Project, "standingRules">, request: StartRequest, caller: string): StandingRulesStamp | null {
  const rules = project.standingRules;
  const role = roleOf(caller);
  const builder = request.raw !== true && request.bare !== true && request.planning !== true && role !== "reviewer" && role !== "check" && role !== "verify";
  return builder && rules?.text != null ? { revision: rules.revision, text: rules.text, carriedBy: request.claude === undefined ? null : "prompt" } : null;
}

/** Each thread's send in flight while no message has carried its rules yet. */
const uncarried = new Map<ThreadId, Promise<unknown>>();

/**
 * Sends a person's message to a Nexus agent thread, with the thread's rules until a message the harness took carried
 * them. A resend of that message's request ID gets them again, so it composes the text the harness already took. Sends
 * wait for each other until one carried them, so two at once never both carry them, and one that failed leaves them
 * for the next.
 */
export async function sendWithStandingRules<T>(
  registry: { standingRulesOf(id: ThreadId): StandingRulesStamp | null; standingRulesCarried(id: ThreadId, requestId: string): void },
  thread: ThreadId, requestId: string, text: string, send: (text: string) => Promise<T>,
): Promise<T> {
  const compose = async () => {
    const stamp = registry.standingRulesOf(thread);
    const carries = stamp !== null && (stamp.carriedBy === null || stamp.carriedBy === requestId);
    const sent = await send(carries ? withStandingRules(text, stamp) : text);
    if (carries) registry.standingRulesCarried(thread, requestId);
    return sent;
  };
  if (registry.standingRulesOf(thread)?.carriedBy !== null && !uncarried.has(thread)) return compose();
  const turn = (uncarried.get(thread) ?? Promise.resolve()).catch(() => {}).then(compose);
  uncarried.set(thread, turn);
  try {
    return await turn;
  } finally {
    if (uncarried.get(thread) === turn) uncarried.delete(thread);
  }
}

/** The rules once a person sets `text`, or clears them with null. Absent stays absent until something is set. */
export function editedRules(previous: StandingRules | null | undefined, text: string | null): StandingRules | undefined {
  if ((previous?.text ?? null) === text) return previous ?? undefined;
  return { text, revision: (previous?.revision ?? 0) + 1 };
}
