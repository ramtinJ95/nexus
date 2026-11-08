import type { ThreadId } from "../ids.ts";
import type { Project, StandingRules } from "./project.ts";
import type { Start } from "./start-request.ts";

/** The longest rules a project takes, so a brief with them still fits a Claude prompt. */
export const standingRulesLimit = 8_192;

/**
 * The rules a thread was started with. `carriedBy` is the request ID of the first message the harness took with them,
 * `prompt` for a Claude worker's prompt, which its launch retries until it starts, or null until a message carries them.
 */
export interface StandingRulesStamp { revision: number; text: string; carriedBy: string | null }

export const withStandingRules = (brief: string, rules: Pick<StandingRulesStamp, "text"> | null): string =>
  rules === null ? brief : `${brief}\n\n## Standing rules for this project\n\n${rules.text}`;

/**
 * Only a builder carries rules. The review loop briefs its reviewers itself, a check or verify thread runs no agent, and
 * the builders of the briefs a planning thread writes get the rules on their own.
 */
export function standingRulesFor(project: Pick<Project, "standingRules">, { request, role }: Pick<Start, "request" | "role">): StandingRulesStamp | null {
  const rules = project.standingRules;
  return role === "builder" && rules?.text != null ? { revision: rules.revision, text: rules.text, carriedBy: request.claude === undefined ? null : "prompt" } : null;
}

/**
 * Sends a person's message to a Nexus agent thread, with the thread's rules until a message the harness took carried
 * them. A resend of that message's request ID gets them again, so it composes the text the harness already took. Sends
 * wait for each other until one carried them, so two at once never both carry them, and one that failed leaves them
 * for the next. Each store gets its own chain of sends in flight.
 */
export function standingRulesSender(store: { standingRulesOf(id: ThreadId): StandingRulesStamp | null; standingRulesCarried(id: ThreadId, requestId: string): void }) {
  const uncarried = new Map<ThreadId, Promise<unknown>>();
  return async function sendWithStandingRules<T>(thread: ThreadId, requestId: string, text: string, send: (text: string) => Promise<T>): Promise<T> {
    const compose = async () => {
      const stamp = store.standingRulesOf(thread);
      const carries = stamp !== null && (stamp.carriedBy === null || stamp.carriedBy === requestId);
      const sent = await send(carries ? withStandingRules(text, stamp) : text);
      if (carries) store.standingRulesCarried(thread, requestId);
      return sent;
    };
    if (store.standingRulesOf(thread)?.carriedBy !== null && !uncarried.has(thread)) return compose();
    const turn = (uncarried.get(thread) ?? Promise.resolve()).catch(() => {}).then(compose);
    uncarried.set(thread, turn);
    try {
      return await turn;
    } finally {
      if (uncarried.get(thread) === turn) uncarried.delete(thread);
    }
  };
}

/** The rules once a person sets `text`, or clears them with null. Absent stays absent until something is set. */
export function editedRules(previous: StandingRules | null | undefined, text: string | null): StandingRules | undefined {
  if ((previous?.text ?? null) === text) return previous ?? undefined;
  return { text, revision: (previous?.revision ?? 0) + 1 };
}
