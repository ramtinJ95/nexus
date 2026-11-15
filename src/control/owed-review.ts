/**
 * The reviews a builder is owed: each open pull request the PR watch linked to it, in a project that reviews on its own,
 * that no review has started for. The review loop starts the one that is due once the builder's review before it
 * settled, and the thread's attention, `nexus doctor`, `nexus items` and the dashboard name the rest by what they wait
 * for, or by why nothing will move them. Pure, over facts its callers read, so the registry's attention reads it too.
 */
import { agentKinds } from "../protocol/agent-kinds.ts";
import type { SecretGrant } from "../protocol/secret-grants.ts";
import type { AutoReview } from "./project.ts";
import { wasRead, type WatchedPr } from "./pr-watch-store.ts";
import type { ThreadStatus } from "./reconcile.ts";
import { settled, waitsOnPerson, type Review } from "./review-model.ts";

// A Claude worker logs in from a granted token. Interactive /login needs a person, so it cannot serve a reviewer.
export const grantsClaude = (secrets: readonly SecretGrant[]) =>
  agentKinds["claude-code"].signIn.grants.some((grant) => secrets.some((s) => s.name === grant.name && grant.hosts.every((host) => s.hosts.includes(host))));

export interface OwedFacts {
  status: ThreadStatus;
  /** Whether the thread serves another builder's review, as a reviewer, check or verify thread does. */
  serves: boolean;
  /** Whether the builder is a Claude worker, which a harness reviewer reviews. A harness builder's needs a Claude token. */
  claude: boolean;
  project: { autoReview?: AutoReview | null | undefined; secrets: readonly SecretGrant[] } | undefined;
  prs: readonly WatchedPr[];
  /** The builder's review, the latest one started, or null. */
  review: Review | null;
  /** Whether a review ever started for the pull request, of this builder or another. */
  reviewed(repo: string, number: number): boolean;
}

/**
 * `due` starts on the review loop's next pass. `waiting` starts on its own once what `why` names ends, and `asks` when
 * only GitHub's word that it merges cleanly is missing, which the loop asks GitHub for itself, since the PR watch may
 * have stopped reading it. `unmoved` never starts until the person acts, for `why`.
 */
export type Owed = { kind: "due"; pr: WatchedPr } | { kind: "waiting"; pr: WatchedPr; why: string; asks?: true } | { kind: "unmoved"; pr: WatchedPr; why: string };

/**
 * Each owed review, oldest pull request first. One at a time per builder, behind a review that has not settled, since a
 * review that waits on the person, approved or held, is the person's to land or end, and the next would replace it. A
 * review that ended stays ended: its pull request is reviewed, so it is owed nothing. A queued pull request starts only
 * once GitHub says it merges cleanly, so a builder whose earlier pull request landed rebases before the review.
 */
export function owedReviews(f: OwedFacts): Owed[] {
  if (f.project?.autoReview == null || f.serves) return [];
  const prs = f.prs.filter((pr) => wasRead(pr) && pr.state === "open" && !f.reviewed(pr.repo, pr.number)).toSorted((a, b) => a.number - b.number);
  if (prs.length === 0) return [];
  const unmoved = (why: string): Owed[] => prs.map((pr) => ({ kind: "unmoved", pr, why }));
  if (f.status !== "active") return unmoved(`its thread is ${f.status}, so no review of it starts${f.status === "archived" ? ". Unarchive the thread, and its review starts on its own" : " until it is active"}`);
  if (!f.claude && !grantsClaude(f.project.secrets)) return unmoved("no review of it can start: its builder runs in the harness, and its project grants no Claude token for a reviewer on another model. Grant CLAUDE_CODE_OAUTH_TOKEN for api.anthropic.com to the project (`nexus project edit`)");
  const r = f.review;
  if (r !== null && !settled(r)) {
    const why = `its review starts once review ${r.id} of #${r.pr.number} ends, which is ${r.phase.kind}${waitsOnPerson(r) ? " and waits on the person" : ""}`;
    return prs.map((pr) => ({ kind: "waiting", pr, why }));
  }
  const first = prs.find((pr) => pr.conflict === false);
  return prs.map((pr): Owed => pr === first ? { kind: "due", pr }
    : pr.conflict === true ? { kind: "waiting", pr, why: "it conflicts with its base, so its review starts once the builder rebases it", asks: true }
    : pr.conflict === null ? { kind: "waiting", pr, why: "its review starts once GitHub says whether it conflicts with its base", asks: true }
    : { kind: "waiting", pr, why: `its review starts after #${first!.number}'s` });
}
