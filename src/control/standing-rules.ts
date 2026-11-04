/** A project's standing rules: how an edit counts revisions. */
import type { StandingRules } from "./project.ts";

/** The longest rules a project takes, so a brief with them still fits a Claude prompt. */
export const standingRulesLimit = 8_192;

/** The rules once a person sets `text`, or clears them with null. Absent stays absent until something is set. */
export function editedRules(previous: StandingRules | null | undefined, text: string | null): StandingRules | undefined {
  if ((previous?.text ?? null) === text) return previous ?? undefined;
  return { text, revision: (previous?.revision ?? 0) + 1 };
}
