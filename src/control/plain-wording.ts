/**
 * The wording that runs no other module's code, so client.js bundles it and the stores wording.ts reads from can
 * write it. wording.ts holds every other sentence.
 */
import type { Attention } from "./attention.ts";
import type { ServiceFact } from "../protocol/observations.ts";

/** How each attention reads on a thread's row, its page's head and a notice. */
export const attentionLabels: Record<NonNullable<Attention>, string> = {
  failed: "failed", decision: "needs your decision", parked: "parked", limited: "stopped on its usage limit",
  reply: "new reply", working: "agent working", waiting: "waiting for input",
};

/** A check's name with the node it runs on, as the Health page lists a change and a notice titles it. */
export const checkName = (c: { node: string | null; name: string }) => `${c.node ?? "Control plane"} ${c.name}`;

export const problemsText = (open: number) => open === 0 ? "Every check is ok" : `${open} open ${open === 1 ? "problem" : "problems"}`;

export const answerFinal = "The answer cannot be changed.";

/** Why a running pylon's preview does not answer: its port has no route in, or its service failed. */
export const previewFailed = (fact: ServiceFact) => fact.unrouted ?? (fact.state === "failed" ? `the service ${fact.name} failed. \`nexus service logs ${fact.name}\` in the pylon shows why` : null);
