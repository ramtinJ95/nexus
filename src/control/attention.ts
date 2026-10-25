export type Attention = "failed" | "parked" | "reply" | "working" | "waiting" | null;

export function attentionOf(failed: boolean, parked: boolean, lastReplyAt: number | null, seenAt: number | null, working: boolean, waiting = false): Attention {
  if (failed) return "failed";
  if (parked) return "parked";
  if (lastReplyAt !== null && (seenAt === null || lastReplyAt > seenAt)) return "reply";
  return working ? "working" : waiting ? "waiting" : null;
}
