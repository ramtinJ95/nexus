// What the chart of the landing model shows: the life of one landing, in the words of the person who lands it.
// Review A is the landing the chart follows. Other reviews, GitHub and the fleet act in the background.
const r = "A";

export const title = "One landing in Nexus, from approval to deployed or held";

export const state = (v) => {
  const phase = v.phase[r];
  if (phase === "review") return "Under review";
  if (phase === "merging") return v.auth[r] ? "Holds the turn" : v.waiting[r] ? "Waits for its turn" : "Approved, asks for its turn";
  if (phase === "deploying") return "Merged, deploying";
  if (phase === "rollingBack") return "Rolling back";
  if (phase === "landed") return "Landed and deployed";
  return v.merged[r] ? "With you, after its deploy" : v.prMergedHead[r] !== 0 ? "With you, merged outside the review" : "With you, before any merge";
};

export const group = (v) => {
  const phase = v.phase[r];
  return phase === "review" ? "Review" : phase === "landed" ? "Done" : phase === "person" ? "Yours" : "Landing";
};

export const colors = { Review: "blue", Landing: "orange", Done: "teal", Yours: "pink" };

const labels = {
  Approve: "the reviewers approve and the checks pass",
  Wait: "an unhealthy release or another landing is ahead",
  Authorize: "nothing is ahead",
  BaseMoved: "the base branch moves",
  Merge: "GitHub merges the approved commit",
  OwnMergeSeen: "after a crash it finds its own merge",
  OthersMergeSeen: "it finds that someone merged the approved commit",
  MergedAtOtherHead: "it finds a merge of a commit no round approved",
  NewRound: "it finds a newer commit",
  Held: "a hold or GitHub's refusal stops it",
  DeployHealthy: "every service reports healthy",
  DeploySuperseded: "another release replaces it",
  RolledBack: "the previous release is healthy again",
  RollbackFails: "the rollback fails or is replaced",
  HeldNewHead: "the builder pushes a commit",
  PersonLand: "you press Land",
  OutsideMerge: "someone merges it on GitHub",
  Push: "the builder pushes a commit",
  MergeThenCrash: "GitHub merges, and the control plane stops before it records that",
  RequestDeploy: "it asks the fleet to run the merge",
  RequestRollback: "it asks the fleet to run the previous release",
  PersonDeploy: "you deploy a release by hand",
  InstallOk: "the fleet reports the release healthy",
  InstallFails: "the fleet fails to install the release",
  InstallFailsStuck: "the fleet fails to install the release",
  Done: "nothing more happens",
};

// The review a step is about, or null for a step of the person's deploy or the fleet.
const perReview = ["phase", "auth", "waiting", "round", "requested", "previous", "merged", "prHead", "prOpen", "prMergedHead"];
const about = (from, to) => Object.keys(from.phase).find((q) => perReview.some((name) => from[name][q] !== to[name][q])) ?? null;

export const step = (action, from, to) => {
  const who = about(from, to);
  const other = who !== null && who !== r;
  const label = action === "DeployFails"
    ? to.phase[who ?? r] === "rollingBack" ? "the deploy fails or runs out of time" : "the deploy fails with nothing to roll back to"
    : labels[action] ?? null;
  return label !== null && other ? `for another landing, ${label}` : label;
};
