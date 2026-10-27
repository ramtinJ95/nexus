export type Attention = "failed" | "decision" | "parked" | "limited" | "reply" | "working" | "waiting" | null;

/**
 * How each attention shows. `needsPerson` keeps a thread's row bright, counts it in the dashboard's badge and notifies
 * on a change to it. Waiting ranks below working, but only waiting is blocked on the person.
 */
export const attentions = {
  failed: { label: "failed", tone: "bad", needsPerson: true },
  decision: { label: "needs your decision", tone: "bad", needsPerson: true },
  parked: { label: "parked", tone: "bad", needsPerson: true },
  limited: { label: "stopped on its usage limit", tone: "bad", needsPerson: true },
  reply: { label: "new reply", tone: "ok", needsPerson: true },
  working: { label: "agent working", tone: "work", needsPerson: false },
  waiting: { label: "waiting for input", tone: "idle", needsPerson: true },
} as const satisfies Record<NonNullable<Attention>, { label: string; tone: string; needsPerson: boolean }>;

export const needsPerson = (attention: Attention) => attention !== null && attentions[attention].needsPerson;

/**
 * `decision` is a review that ended for the person: rounds that ran out, or a landing the merge policy holds. `limited`
 * is a Claude session stopped on its usage limit, which outranks `reply` because the turn end that recorded the reply is the stop itself.
 */
export function attentionOf(failed: boolean, parked: boolean, lastReplyAt: number | null, seenAt: number | null, working: boolean, waiting = false, decision = false, limited = false): Attention {
  if (failed) return "failed";
  if (decision) return "decision";
  if (parked) return "parked";
  if (limited) return "limited";
  if (lastReplyAt !== null && (seenAt === null || lastReplyAt > seenAt)) return "reply";
  return working ? "working" : waiting ? "waiting" : null;
}
