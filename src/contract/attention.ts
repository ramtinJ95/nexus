export type Attention = "failed" | "decision" | "died" | "parked" | "limited" | "boot-held" | "reply" | "working" | "waiting" | null;

/**
 * Whether each attention waits on the person, which keeps a thread's row bright and notifies on a change to it. Waiting
 * ranks below working, but only waiting is blocked on the person.
 */
const waitsOnPerson: Record<NonNullable<Attention>, boolean> = {
  failed: true, decision: true, died: true, parked: true, limited: true, "boot-held": true, reply: true, working: false, waiting: true,
};

export const needsPerson = (attention: Attention) => attention !== null && waitsOnPerson[attention];
