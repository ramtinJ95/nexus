export type Attention = "failed" | "decision" | "parked" | "reply" | "working" | "waiting" | null;

/** `decision` is a review that ended for the person: rounds that ran out, or a landing the merge policy holds. */
export function attentionOf(failed: boolean, parked: boolean, lastReplyAt: number | null, seenAt: number | null, working: boolean, waiting = false, decision = false): Attention {
  if (failed) return "failed";
  if (decision) return "decision";
  if (parked) return "parked";
  if (lastReplyAt !== null && (seenAt === null || lastReplyAt > seenAt)) return "reply";
  return working ? "working" : waiting ? "waiting" : null;
}
