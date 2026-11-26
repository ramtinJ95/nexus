/**
 * A review's landing past its merge authorization: whose landing it is, the one landing at a time that deploys, and
 * the deploy of the merge commit, rolled back when the fleet is not healthy. The review loop runs the rounds and the
 * merge policy up to the merge, and steps these phases from what the deployers report now, so a pass after the
 * control plane's own deploy restarts it picks up where it was.
 */
import { releaseOutcome, type ReleaseView } from "../protocol/deploy.ts";
import { deployWaitMs } from "../contract/release.ts";
import { isDraining } from "./drain.ts";
import type { Hold } from "./holds.ts";
import { landsOnItsOwn } from "./project.ts";
import { releaseView } from "./releases.ts";
import type { Registry } from "./registry.ts";
import type { Thread } from "./thread-store.ts";
import { landingVerb, type HoldCause, type Phase, type Review, type Round } from "./review-model.ts";

/** The branch the deployer installs releases from: it refuses a commit that is not on it. */
export const releaseBranch = "main";

type LandingRegistry = Pick<Registry, "releases" | "nodes" | "now" | "projects" | "reviews">;
type Releasing = Extract<Phase, { kind: "deploying" | "rolling-back" }>;

export interface LandingDeps {
  registry: LandingRegistry;
  /** The control plane's own node, for the release view, and the repository its releases come from. */
  release: { self: string | undefined; repo: string };
  mayLand(caller: string): boolean;
  now: () => number;
  toPerson(r: Review, cause: HoldCause, ...items: (Hold | string)[]): Review;
}

/** The nodes whose deploy of `commit` failed or rolled back, as a review's reasons name them. */
const failedNodes = (view: ReleaseView, commit: string) => view.nodes.filter((n) => n.target === commit && (n.state === "failed" || n.state === "rolled-back"))
  .map((n) => `${n.node} ${n.role} ${n.state}${n.reason ? ` (${n.reason})` : ""}`).join("; ");

export function landing({ registry, release, mayLand, now, toPerson }: LandingDeps) {
  /**
   * A PR of the repository releases come from, into any of its branches. A branch other than the release branch
   * reaches it by a later merge, so a PR into it meets the reserved paths' holds and second reviewer all the same.
   */
  const ofReleaseRepo = (r: { pr: Pick<Review["pr"], "repo"> }) => r.pr.repo.toLowerCase() === release.repo.toLowerCase();
  /**
   * Only a PR of that repository into the release branch deploys once it merges. A retarget gets a round of its own
   * before any merge, so the latest round's base is the one it merges into. A round from before rounds recorded their
   * base deploys, as every landing of the repository did then.
   */
  const deploys = (r: { pr: Pick<Review["pr"], "repo">; rounds: readonly Pick<Round, "base">[] }) => {
    const base = r.rounds.at(-1)?.base;
    return ofReleaseRepo(r) && (base === undefined || base === releaseBranch);
  };
  const view = () => releaseView(registry, release.self, now());
  /** Makes `commit` the desired release, unless it is already, and marks the deploy or rollback requested. */
  const requestRelease = (r: Review, phase: Releasing, commit: string, by: string): Review => {
    if (registry.releases.desiredRelease()?.commit !== commit) registry.releases.setDesiredRelease({ commit, requestedBy: by, requestedAt: now() });
    return { ...r, phase: { ...phase, requested: true } };
  };
  /** `r` while its release is pending before the deadline, which moves on while a node waits for idle to deploy, or null. */
  const pending = (r: Review, phase: Releasing, at: ReleaseView, outcome: ReturnType<typeof releaseOutcome>): Review | null => {
    if (outcome !== "pending") return null;
    if (at.nodes.some((n) => n.target === at.desired?.commit && n.state === "waiting-for-idle")) return { ...r, phase: { ...phase, deadline: now() + deployWaitMs } };
    return now() < phase.deadline ? r : null;
  };

  return {
    deploys,
    ofReleaseRepo,

    /**
     * Why `r` may not merge yet, read fresh: a pass saves after every step, so it sees what earlier reviews did in it.
     * Landings deploy one at a time, so each deploy's rollback target is a release that was healthy.
     */
    ahead(r: Review): string | null {
      if (!deploys(r)) return null;
      if (isDraining(registry.releases.drain(), registry.now())) return "a deploy drains the control plane";
      for (const other of registry.reviews.reviews()) {
        const verb = other.id === r.id || !deploys(other) ? null : landingVerb(other);
        if (verb !== null) return `${other.id} ${verb}`;
      }
      // A landing whose deploy and rollback both failed, or one with no release to roll back to, leaves its release
      // desired, which must not become the next landing's rollback target.
      const desired = registry.releases.desiredRelease();
      if (desired !== null && releaseOutcome(view(), desired.commit) !== "healthy") return `not every service reports ${desired.commit.slice(0, 12)} healthy`;
      return null;
    },

    /** Why the caller `r`'s landing merges and deploys for may not, now. The project's landing is for whoever turned it on, while it stays on. */
    unauthorized(r: Review, builder: Thread): Hold[] {
      const land = r.land!;
      const setting = registry.projects.project(builder.project)?.autoReview;
      if (land.fromProject && !landsOnItsOwn(setting)) return [{ code: "loop", text: `Project ${builder.project} no longer lands its builders' pull requests on its own, so this one is the person's to land.` }];
      const by = land.fromProject ? setting!.enabledBy : land.requestedBy;
      return mayLand(by) ? [] : [{ code: "loop", text: `${by}, who ${land.fromProject ? `turned on landing for project ${builder.project}` : "asked for this landing"}, is not among the control plane's deployers, so only the person can land it.` }];
    },

    /**
     * The release a failed deploy of `r`'s merge rolls back to, for a turn `r` takes now: the desired release, read in
     * the same tick as `ahead` found it healthy everywhere, or null when there is none. Undefined for a PR that does
     * not deploy.
     */
    rollbackTarget: (r: Review): string | null | undefined => deploys(r) ? registry.releases.desiredRelease()?.commit ?? null : undefined,

    /**
     * Whether the desired release is no longer the one `r` took its turn at, as after the person's `nexus deploy`. Its
     * merge would replace a release that has not run yet, and a failed deploy would roll back past it.
     */
    turnLost: (r: Review, previous: string | null | undefined): boolean =>
      deploys(r) && previous !== undefined && (registry.releases.desiredRelease()?.commit ?? null) !== previous,

    /**
     * `r` once its PR merged as `commit`: landed, or deploying it with `previous`, the release its turn was taken at,
     * as its rollback target. A turn saved before Nexus recorded that release rolls back to the desired one.
     */
    merged(r: Review, commit: string, previous: string | null | undefined): Review {
      if (!deploys(r)) return { ...r, merged: commit, phase: { kind: "landed", commit } };
      const target = previous === undefined ? registry.releases.desiredRelease()?.commit ?? null : previous;
      return { ...r, merged: commit, phase: { kind: "deploying", commit, previous: target, requested: false, deadline: now() + deployWaitMs } };
    },

    steps: {
      async deploying(r: Review, phase: Extract<Phase, { kind: "deploying" }>): Promise<Review> {
        if (!phase.requested) return requestRelease(r, phase, phase.commit, `nexus review ${r.id}`);
        const at = view();
        const outcome = releaseOutcome(at, phase.commit);
        if (outcome === "healthy") return { ...r, phase: { kind: "landed", commit: phase.commit } };
        if (outcome === "superseded") return toPerson(r, "deploy", `Another release, ${at.desired?.commit ?? "none"}, replaced ${phase.commit} before every service reported healthy.`);
        const waiting = pending(r, phase, at, outcome);
        if (waiting !== null) return waiting;
        const why = outcome === "failed"
          ? `The deploy of ${phase.commit} failed: ${failedNodes(at, phase.commit)}.`
          : `Not every service reported healthy at ${phase.commit} within ${deployWaitMs / 60_000} minutes.`;
        if (phase.previous === null) return toPerson(r, "deploy", why, "There is no previous release to roll back to.");
        return { ...r, phase: { kind: "rolling-back", commit: phase.commit, previous: phase.previous, why, requested: false, deadline: now() + deployWaitMs } };
      },
      async "rolling-back"(r: Review, phase: Extract<Phase, { kind: "rolling-back" }>): Promise<Review> {
        if (!phase.requested) return requestRelease(r, phase, phase.previous, `nexus review ${r.id} rollback`);
        const at = view();
        const outcome = releaseOutcome(at, phase.previous);
        const revert = `${phase.commit} is still on the default branch. Revert it before the next deploy only if it caused the failure: a deploy that failed before the release ran, as when the deployer could not reach the control plane, needs no revert.`;
        if (outcome === "healthy") return toPerson(r, "deploy", phase.why, `Rolled back to the previous release, ${phase.previous}, which every service reports healthy.`, revert);
        if (outcome === "superseded") return toPerson(r, "deploy", phase.why, `Another release, ${at.desired?.commit ?? "none"}, replaced the rollback to ${phase.previous} before it was healthy.`, revert);
        const waiting = pending(r, phase, at, outcome);
        if (waiting !== null) return waiting;
        const failed = outcome === "failed"
          ? failedNodes(at, phase.previous)
          : `not every service reported healthy within ${deployWaitMs / 60_000} minutes`;
        return toPerson(r, "deploy", phase.why, `The rollback to ${phase.previous} failed too: ${failed}. The fleet needs the person now.`, revert);
      },
    },
  };
}
