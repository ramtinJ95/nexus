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
import { landingVerb, type HoldCause, type Phase, type Review } from "./review-model.ts";

type LandingRegistry = Pick<Registry, "desiredRelease" | "drain" | "nodes" | "now" | "project" | "releaseReports" | "reviews" | "setDesiredRelease">;
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
  /** Only a PR of the repository releases come from deploys once it merges. */
  const deploys = (r: { pr: Pick<Review["pr"], "repo"> }) => r.pr.repo.toLowerCase() === release.repo.toLowerCase();
  const view = () => releaseView(registry, release.self, now());
  /** Makes `commit` the desired release, unless it is already, and marks the deploy or rollback requested. */
  const requestRelease = (r: Review, phase: Releasing, commit: string, by: string): Review => {
    if (registry.desiredRelease()?.commit !== commit) registry.setDesiredRelease({ commit, requestedBy: by, requestedAt: now() });
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

    /**
     * Why `r` may not merge yet, read fresh: a pass saves after every step, so it sees what earlier reviews did in it.
     * Landings deploy one at a time, so each deploy's rollback target is a release that was healthy.
     */
    ahead(r: Review): string | null {
      if (!deploys(r)) return null;
      if (isDraining(registry.drain(), registry.now())) return "a deploy drains the control plane";
      for (const other of registry.reviews.reviews()) {
        const verb = other.id === r.id || !deploys(other) ? null : landingVerb(other);
        if (verb !== null) return `${other.id} ${verb}`;
      }
      // A landing whose deploy and rollback both failed, or one with no release to roll back to, leaves its release
      // desired, which must not become the next landing's rollback target.
      const desired = registry.desiredRelease();
      if (desired !== null && releaseOutcome(view(), desired.commit) !== "healthy") return `not every service reports ${desired.commit.slice(0, 12)} healthy`;
      return null;
    },

    /** Why the caller `r`'s landing merges and deploys for may not, now. The project's landing is for whoever turned it on, while it stays on. */
    unauthorized(r: Review, builder: Thread): Hold[] {
      const land = r.land!;
      const setting = registry.project(builder.project)?.autoReview;
      if (land.fromProject && !landsOnItsOwn(setting)) return [{ code: "loop", text: `Project ${builder.project} no longer lands its builders' pull requests on its own, so this one is the person's to land.` }];
      const by = land.fromProject ? setting!.enabledBy : land.requestedBy;
      return mayLand(by) ? [] : [{ code: "loop", text: `${by}, who ${land.fromProject ? `turned on landing for project ${builder.project}` : "asked for this landing"}, is not among the control plane's deployers, so only the person can land it.` }];
    },

    /** `r` once its PR merged as `commit`: landed, or deploying it with the desired release as its rollback target. */
    merged(r: Review, commit: string): Review {
      if (!deploys(r)) return { ...r, merged: commit, phase: { kind: "landed", commit } };
      return { ...r, merged: commit, phase: { kind: "deploying", commit, previous: registry.desiredRelease()?.commit ?? null, requested: false, deadline: now() + deployWaitMs } };
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
        const revert = `${phase.commit} is still on the default branch, so revert it before the next deploy.`;
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
