/** What a route says when the optional feature it needs (features.ts) is not configured. Imports nothing, so planning.ts and the dashboard read it without a cycle. */
const githubToken = "the control plane's GitHub token (github.tokenFile), which is not configured";

export const notConfigured = {
  reviews: `the review loop needs ${githubToken}`,
  queue: `queued threads need ${githubToken}`,
  pipeline: `pipeline items need ${githubToken}`,
  planning: "this control plane has no planning pass",
  cleanup: "this control plane runs no cleanup, so it records no releases",
  images: "image builds are not configured",
  usageBackfill: "the usage backfill is not configured",
  doctor: "this control plane runs no doctor",
} as const;
