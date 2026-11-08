/**
 * The wording the dashboard's browser code prints as well as its pages. It imports nothing that needs Node, so
 * client.js bundles it. wording.ts holds every other sentence.
 */
import type { Attention } from "./attention.ts";

/** How each attention reads on a thread's row, its page's head and a notice. */
export const attentionLabels: Record<NonNullable<Attention>, string> = {
  failed: "failed", decision: "needs your decision", parked: "parked", limited: "stopped on its usage limit",
  reply: "new reply", working: "agent working", waiting: "waiting for input",
};

/** A check's name with the node it runs on, as the Health page lists a change and a notice titles it. */
export const checkName = (c: { node: string | null; name: string }) => `${c.node ?? "Control plane"} ${c.name}`;

export const problemsText = (open: number) => open === 0 ? "Every check is ok" : `${open} open ${open === 1 ? "problem" : "problems"}`;

export const answerFinal = "The answer cannot be changed.";
