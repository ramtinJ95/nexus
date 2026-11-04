/** A project's standing rules: which starts carry them, how they join a brief, and how an edit counts revisions. */
import type { Project, StandingRules } from "./project.ts";
import type { StartRequest } from "./start-request.ts";

/** The longest rules a project takes, so a brief with them still fits a Claude prompt. */
export const standingRulesLimit = 8_192;

/** The rules a thread's first message carried. */
export interface StandingRulesStamp { revision: number; text: string }

/** The brief as written, then the rules under a heading of their own. */
export const withStandingRules = (brief: string, rules: Pick<StandingRulesStamp, "text"> | null): string =>
  rules === null ? brief : `${brief}\n\n## Standing rules for this project\n\n${rules.text}`;

/**
 * Only a builder's start carries rules, since only its brief can: a Claude worker's prompt, or a Nexus agent's first
 * message. A `raw` start is the review loop's Claude reviewer, a `bare` one a check or live check that runs no agent,
 * and a harness reviewer starts with no message, as the loop sends its request itself. A planning thread gets none,
 * because the builders of the briefs it writes get the rules on their own.
 */
export function standingRulesFor(project: Pick<Project, "standingRules">, request: StartRequest): StandingRulesStamp | null {
  const rules = project.standingRules;
  const builder = request.claude !== undefined ? request.raw !== true : request.message !== undefined && request.planning !== true && request.bare !== true;
  return builder && rules?.text != null ? { revision: rules.revision, text: rules.text } : null;
}

/** The rules once a person sets `text`, or clears them with null. Absent stays absent until something is set. */
export function editedRules(previous: StandingRules | null | undefined, text: string | null): StandingRules | undefined {
  if ((previous?.text ?? null) === text) return previous ?? undefined;
  return { text, revision: (previous?.revision ?? 0) + 1 };
}
