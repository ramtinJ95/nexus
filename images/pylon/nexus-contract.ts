/**
 * What the control plane and the image's helpers agree on. It imports nothing, so the helpers load it at run time from
 * beside them in /usr/local/bin, and the control plane imports it from the repo.
 */

/** Where the image installs the hook, which the control plane runs through the probe. */
export const claudeHook = "/usr/local/bin/nexus-claude-hook";

/**
 * What the control plane hands `nexus-claude-hook answer`: the session and question texts that name the ask, the
 * call's ID, and Claude's `answers` and `annotations`. An answer maps each question's text to the picked labels and
 * the person's own answer, joined with ", ".
 */
export interface AskAnswer {
  session: string;
  questions: readonly string[];
  toolUseId: string;
  answers: Readonly<Record<string, string>>;
  annotations: Readonly<Record<string, { notes?: string }>>;
}

/**
 * `nexus-claude-hook answer`'s exit codes. A delivery also prints answerDelivered, since the hook of an image from
 * before asks exits 0 for a kind it does not know.
 */
export const answerExits = { delivered: 0, nobodyWaits: 20, answeredOtherwise: 21, malformed: 64 } as const;
export const answerDelivered = "delivered";

/** The most `nexus-claude-hook asks` prints. */
export const maxAsksBytes = 1 << 20;

/** The control plane expects this ID for the latest session.turn-started it recorded, so the hook stamps both with `at`. */
export const claudeTurn = (session: string, at: number): string => `claude:${session}:${at}`;
