import type { ThreadQuestion } from "./questions.ts";
import type { Attention } from "../contract/attention.ts";

export { needsPerson, type Attention } from "../contract/attention.ts";

/**
 * A thing of a thread's that waits on the person: its review, held for them or stopped at an approval only they land,
 * a question no one has answered, a builder that stopped short of a pull request after its nudges, or a Claude worker
 * whose turns kept dying. `since` is when it began to wait, so far as the records say.
 */
export type Need =
  | { kind: "review"; review: string; since: number }
  | { kind: "question"; question: ThreadQuestion; since: number }
  | { kind: "nudge"; since: number }
  | { kind: "resume"; why: string; since: number };

/** What a thread's attention is read from. `waiting` is a dialog its session waits on, and `limited` its Claude session stopped on its usage limit. */
export interface AttentionFacts {
  failed: boolean; parked: boolean; lastReplyAt: number | null; seenAt: number | null; working: boolean; waiting: boolean; needs: readonly Need[]; limited: boolean;
}

/**
 * The first that holds: `decision` is anything that waits on the person, as its needs say. `limited` outranks `reply`
 * because the turn end that recorded the reply is the stop itself.
 */
export function attentionOf(f: AttentionFacts): Attention {
  if (f.failed) return "failed";
  if (f.needs.length > 0) return "decision";
  if (f.parked) return "parked";
  if (f.limited) return "limited";
  if (f.lastReplyAt !== null && (f.seenAt === null || f.lastReplyAt > f.seenAt)) return "reply";
  return f.working ? "working" : f.waiting ? "waiting" : null;
}
