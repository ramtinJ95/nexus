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
export interface PrSnapshot {
  pr: PullRequest;
  failures: { id: string; text: string }[];
  comments: { id: string; text: string }[];
}
export interface GitHub {
  find(repo: string, branch: string): Promise<number[]>;
  poll(repo: string, number: number): Promise<PrSnapshot>;
}

export function githubRepo(url: string | null): string | null {
  return url?.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

interface Pr {
  number: number; title: string; html_url: string; state: string; merged: boolean;
  head: { sha: string; repo: { full_name: string } | null }; mergeable_state: string;
}
interface Comment { author_association: string; id: number; body: string | null; html_url: string; user: { login: string }; state?: string; submitted_at?: string | null }
interface Check { id: number; name: string; status: string; conclusion: string | null; details_url: string | null; html_url?: string; completed_at: string | null }
interface Status { id: number; context: string; state: string; target_url: string | null }

/** Each resource has its own ETag: a PR's ETag says nothing about its checks or comments. */
export function githubClient(token: string, request: typeof fetch = fetch): GitHub {
  const cache = new Map<string, { etag: string | null; value: unknown; next: string | null }>();
  let retryAt = 0;
  async function get<T>(path: string): Promise<{ value: T; next: string | null }> {
    if (Date.now() < retryAt) throw new Error("GitHub PR watch is waiting for its rate limit");
    const old = cache.get(path);
    const response = await request(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(old?.etag ? { "If-None-Match": old.etag } : {}) },
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 304 && old) return { value: old.value as T, next: old.next };
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
      if ((response.status === 403 || response.status === 429) && (exhausted || retryAfter !== null)) {
        const now = Date.now();
        const after = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
        const reset = exhausted ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : NaN;
        const deadlines = [after, reset].filter((at) => Number.isFinite(at) && at >= now);
        retryAt = deadlines.length ? Math.max(...deadlines) : now + 120_000;
      }
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
      const pr: PullRequest = { repo, number, title: p.title, url: p.html_url, state: p.merged ? "merged" : p.state === "closed" ? "closed" : "open", checks: "none", review: "none", conflict: p.mergeable_state === "unknown" ? null : p.mergeable_state === "dirty" };
      if (pr.state !== "open") return { pr, failures: [], comments: [] };
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
      return { pr, comments, failures: [
        ...failed.map((c) => ({ id: `check:${c.id}:${c.completed_at}:${c.conclusion}`, text: `Check failed: ${c.name} — ${c.details_url ?? c.html_url ?? pr.url}` })),
        ...badStatuses.map((s) => ({ id: `status:${s.id}`, text: `Check failed: ${s.context} — ${s.target_url ?? pr.url}` })),
      ] };
    },
  };
}
