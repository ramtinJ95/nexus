export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  checks: "pending" | "passing" | "failed" | "none";
  review: string;
  conflict: boolean | null;
}
/** What the review loop needs of a PR beyond the watch's summary. `mergeCommit` is null until it is merged. */
export interface PrDetail { head: string; branch: string; base: string; body: string; mergeCommit: string | null }
export interface PrSnapshot {
  pr: PullRequest;
  detail: PrDetail;
  failures: { id: string; text: string }[];
  comments: { id: string; text: string }[];
}
export interface ChangedFile { path: string; patch: string }
/** What a merge GitHub refused says: `denied` when the token may not merge, `refused` when the PR cannot be. */
export type MergeResult = { kind: "merged"; commit: string } | { kind: "denied" | "refused"; message: string };
export interface GitHub {
  find(repo: string, branch: string): Promise<number[]>;
  poll(repo: string, number: number): Promise<PrSnapshot>;
  /** Each changed file with its patch, empty for a binary file or one too large for GitHub to diff. */
  files(repo: string, number: number): Promise<ChangedFile[]>;
  /** Squash-merges only while the PR's head is still `head`, so it never merges a commit nobody reviewed. */
  merge(repo: string, number: number, head: string): Promise<MergeResult>;
}

export function githubRepo(url: string | null): string | null {
  return url?.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

interface Pr {
  number: number; title: string; html_url: string; state: string; merged: boolean; body: string | null; merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { ref: string }; mergeable_state: string;
}
interface Comment { author_association: string; id: number; body: string | null; html_url: string; user: { login: string }; state?: string; submitted_at?: string | null }
interface Check { id: number; name: string; status: string; conclusion: string | null; details_url: string | null; html_url?: string; completed_at: string | null }
interface Status { id: number; context: string; state: string; target_url: string | null }

/** Each resource has its own ETag: a PR's ETag says nothing about its checks or comments. */
export function githubClient(token: string, request: typeof fetch = fetch): GitHub {
  const cache = new Map<string, { etag: string | null; value: unknown; next: string | null }>();
  let retryAt = 0;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  function limited(response: Response) {
    const retryAfter = response.headers.get("retry-after");
    const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
    if ((response.status === 403 || response.status === 429) && (exhausted || retryAfter !== null)) {
      const now = Date.now();
      const after = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
      const reset = exhausted ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : NaN;
      const deadlines = [after, reset].filter((at) => Number.isFinite(at) && at >= now);
      retryAt = deadlines.length ? Math.max(...deadlines) : now + 120_000;
      return true;
    }
    return false;
  }
  async function get<T>(path: string): Promise<{ value: T; next: string | null }> {
    if (Date.now() < retryAt) throw new Error("GitHub PR watch is waiting for its rate limit");
    const old = cache.get(path);
    const response = await request(`https://api.github.com${path}`, {
      headers: { ...headers, ...(old?.etag ? { "If-None-Match": old.etag } : {}) },
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 304 && old) return { value: old.value as T, next: old.next };
    if (!response.ok) {
      limited(response);
      throw new Error(`GitHub PR watch: HTTP ${response.status}`);
    }
    const value = await response.json() as T;
    const nextUrl = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];
    const next = nextUrl?.startsWith("https://api.github.com/") ? nextUrl.slice("https://api.github.com".length) : null;
    if (!cache.has(path) && cache.size >= 4096) cache.delete(cache.keys().next().value!);
    cache.set(path, { etag: response.headers.get("etag"), value, next });
    return { value, next };
  }
  async function list<T>(path: string, key?: string): Promise<T[]> {
    const all: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next !== null) {
      const page: { value: T[] | Record<string, T[]>; next: string | null } = await get(next);
      all.push(...(key ? (page.value as Record<string, T[]>)[key]! : page.value as T[]));
      next = page.next;
    }
    return all;
  }
  return {
    async find(repo, branch) {
      const prs = await list<Pr>(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`);
      return prs.filter((p) => p.head.repo?.full_name.toLowerCase() === repo.toLowerCase()).map((p) => p.number);
    },
    async poll(repo, number) {
      const base = `/repos/${repo}`;
      const { value: p } = await get<Pr>(`${base}/pulls/${number}`);
      const detail: PrDetail = { head: p.head.sha, branch: p.head.ref, base: p.base.ref, body: p.body ?? "", mergeCommit: p.merged ? p.merge_commit_sha : null };
      const pr: PullRequest = { repo, number, title: p.title, url: p.html_url, state: p.merged ? "merged" : p.state === "closed" ? "closed" : "open", checks: "none", review: "none", conflict: p.mergeable_state === "unknown" ? null : p.mergeable_state === "dirty" };
      if (pr.state !== "open") return { pr, detail, failures: [], comments: [] };
      const [checks, statuses, reviews, inline, issue] = await Promise.all([
        list<Check>(`${base}/commits/${p.head.sha}/check-runs?filter=latest`, "check_runs"),
        list<Status>(`${base}/commits/${p.head.sha}/statuses`),
        list<Comment>(`${base}/pulls/${number}/reviews`),
        list<Comment>(`${base}/pulls/${number}/comments`),
        list<Comment>(`${base}/issues/${number}/comments`),
      ]);
      const latest = [...new Map(statuses.toReversed().map((s) => [s.context, s])).values()];
      const failed = checks.filter((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(c.conclusion ?? ""));
      const badStatuses = latest.filter((s) => s.state === "failure" || s.state === "error");
      pr.checks = failed.length + badStatuses.length ? "failed" : checks.some((c) => c.status !== "completed" || !["success", "neutral", "skipped"].includes(c.conclusion ?? "")) || latest.some((s) => s.state === "pending") ? "pending" : checks.length + latest.length ? "passing" : "none";
      const verdicts = [...new Map(reviews.filter((r) => r.state !== "COMMENTED" && r.state !== "PENDING").map((r) => [r.user.login, r.state])).values()];
      pr.review = verdicts.includes("CHANGES_REQUESTED") ? "changes_requested" : verdicts.includes("APPROVED") ? "approved" : "none";
      const comments = ([ ["review", reviews.filter((r) => r.submitted_at)], ["review-comment", inline], ["issue-comment", issue] ] as const).flatMap(([kind, items]) => items.filter((c) => ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.author_association)).map((c) => ({ id: `${kind}:${c.id}`, text: `${kind} by ${c.user.login}${c.state ? ` (${c.state})` : ""}: ${c.html_url}\n${(c.body ?? "").slice(0, 4000)}` })));
      return { pr, detail, comments, failures: [
        ...failed.map((c) => ({ id: `check:${c.id}:${c.completed_at}:${c.conclusion}`, text: `Check failed: ${c.name} — ${c.details_url ?? c.html_url ?? pr.url}` })),
        ...badStatuses.map((s) => ({ id: `status:${s.id}`, text: `Check failed: ${s.context} — ${s.target_url ?? pr.url}` })),
      ] };
    },
    async files(repo, number) {
      return (await list<{ filename: string; patch?: string }>(`/repos/${repo}/pulls/${number}/files`)).map((f) => ({ path: f.filename, patch: f.patch ?? "" }));
    },
    async merge(repo, number, head) {
      if (Date.now() < retryAt) throw new Error("GitHub is waiting for its rate limit");
      const response = await request(`https://api.github.com/repos/${repo}/pulls/${number}/merge`, {
        method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ sha: head, merge_method: "squash" }),
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      const reply = await response.json().catch(() => ({})) as { sha?: string; message?: string };
      if (response.ok && typeof reply.sha === "string") return { kind: "merged", commit: reply.sha };
      if (limited(response)) throw new Error(`GitHub merge: HTTP ${response.status}`);
      // A token that cannot write gets 403, or 404 for a repository it may only read through a fine-grained grant.
      const message = `GitHub answered ${response.status}${typeof reply.message === "string" ? `: ${reply.message.slice(0, 500)}` : ""}`;
      if (response.status === 403 || response.status === 404 || response.status === 401) return { kind: "denied", message };
      if (response.status === 405 || response.status === 409 || response.status === 422) return { kind: "refused", message };
      throw new Error(`GitHub merge: HTTP ${response.status}`);
    },
  };
}
