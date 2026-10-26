export type Attention = "failed" | "decision" | "parked" | "limited" | "reply" | "working" | "waiting" | null;

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
