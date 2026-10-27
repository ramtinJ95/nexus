import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { desiredPhase } from "../reconcile.ts";
import type { CommandResult, NodeName, PylonCommand, PylonId, TailnetNodeId, LiveHash } from "../protocol.ts";
import type { ProjectId } from "../project.ts";
import { githubClient, githubRepo, type PrSnapshot } from "./github.ts";
import { prWatcher, prWatchPrefix } from "./pr-watch.ts";
import { waitOf } from "./queue.ts";
import { agentInbox } from "./inbox.ts";
import type { HarnessHost } from "../harness/host.ts";

function fixture(path = ":memory:") {
  const registry = openRegistry(path);
  const node = "node" as NodeName;
  const project = { id: "project" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project);
  function add(id = "th-1", claude = false) {
    const thread: Thread = { id: id as ThreadId, title: "test", project: project.id, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: claude ? null : "1", startedBy: "test", createdAt: 1, seenAt: null, lastReplyAt: null, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false, working: false };
    const { desired: _, ...pylon } = newPylonRecord({ thread: id, pylonId: thread.pylonId, node, desired: "paused", boot: { pylonId: thread.pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: project.repoUrl, ref: "main" } }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
    registry.createThread(thread, pylon, claude ? "/poteto-mode fix it" : undefined);
    if (claude) registry.setClaudeWorker(thread.id, "/poteto-mode fix it", "started", undefined, "c0ffee00-0000-4000-8000-000000000000");
    registry.apply({ record: "output", pylonId: thread.pylonId, kind: "branch", ref: "origin/feature" });
    return thread.id;
  }
  const id = add();
  let snapshot: PrSnapshot = { pr: { repo: "acme/repo", number: 1, title: "Fix", url: "https://github.com/acme/repo/pull/1", state: "open", checks: "passing", review: "none", conflict: false }, detail: { head: "1".repeat(40), branch: "feature", base: "main", body: "", mergeCommit: null }, failures: [], comments: [] };
  const calls: string[] = [];
  const messages: Parameters<HarnessHost["send"]>[] = [];
  let reject = false;
  const harness: Pick<HarnessHost, "send"> = { async send(...args) { messages.push(args); if (reject) throw new Error("delivery interrupted"); return { id: 1 } as never; } };
  const github = { async find(repo: string, branch: string, state = "open") { calls.push(`find:${repo}:${branch}${state === "all" ? ":all" : ""}`); return state === "all" || snapshot.pr.state === "open" ? [1] : []; }, async poll() { calls.push("poll"); return structuredClone(snapshot); } };
  let wakes = 0;
  const inbox = (r = registry, h = harness) => agentInbox({ registry: r, harness: h, probes: new Map(), wake() { wakes++; } });
  const options = { registry, github, inbox: inbox() };
  /** Reports the node online with the thread's pylon running, or with no pylons. */
  function observe(thread: ThreadId, running: boolean) {
    const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
    registry.apply({ record: "node", node, state: "online", capacity });
    const pylon = { pylonId: `pylon-${thread}` as PylonId, phase: "running" as const, liveHash: "hash" as LiveHash, bootedAt: "2027-01-01T00:00:00Z", bootedFrom: { image: "img-000000000000" as const, checkpoint: null }, services: [], listening: [], previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0 };
    registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", capacity, artifacts: [], jobs: [], pylons: running ? [pylon] : [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  }
  return { registry, id, add, observe, node, calls, messages, github, harness, inbox, options, watcher: prWatcher(options), get snapshot() { return snapshot; }, set snapshot(s: PrSnapshot) { snapshot = s; }, reject(value: boolean) { reject = value; }, get wakes() { return wakes; } };
}

test("links origin branches, shares reads, and only deliberate messages wake without human activity", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const second = f.add("th-2");
  f.registry.recordReply(f.id, 1000);
  f.registry.markSeen(f.id, false, 1000);
  await f.watcher.poll();
  assert.deepEqual(f.calls, ["find:acme/repo:feature", "poll"]);
  assert.equal(f.wakes, 0);
  assert.equal(f.registry.prWatch(second)?.links[0]?.pr.number, 1);
  assert.equal(f.registry.outputs(f.id).find((o) => o.kind === "pull-request")?.ref, f.snapshot.pr.url);
  f.snapshot.failures.push({ id: "failed:1", text: "Check failed: build — https://example.com/check" });
  f.snapshot.pr.checks = "failed";
  await f.watcher.poll();
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[0]![1], /Check failed: build/);
  assert.equal(f.messages[0]![4], "pr-watch");
  assert.ok(f.messages[0]![1].startsWith(prWatchPrefix));
  const thread = f.registry.thread(f.id)!;
  assert.equal(thread.lastHumanActivityAt, 1);
  assert.equal(thread.seenAt, 1000);
  assert.equal(thread.lastReplyAt, 1000);
  assert.equal(desiredPhase(thread, thread.lastAgentActivityAt), "running");
  assert.equal(desiredPhase(thread, thread.lastAgentActivityAt + 21 * 60_000), "paused");
});

test("batches failures, reviews, inline and issue comments, and conflict; then reports recovery once", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  f.snapshot.comments.push({ id: "old", text: "old review" });
  await f.watcher.poll();
  assert.equal(f.messages.length, 0);
  f.snapshot.comments.push(...["review", "review-comment", "issue-comment"].map((kind) => ({ id: kind, text: `${kind} by the token owner` })));
  f.snapshot.failures.push({ id: "failure", text: "failed check" });
  f.snapshot.pr.checks = "failed"; f.snapshot.pr.conflict = true;
  await f.watcher.poll();
  assert.equal(f.messages.length, 1);
  for (const text of ["review by", "review-comment by", "issue-comment by", "failed check", "conflicts"]) assert.ok(f.messages[0]![1].includes(text));
  await f.watcher.poll(); assert.equal(f.messages.length, 1);
  f.snapshot.failures = []; f.snapshot.pr.checks = "passing";
  await f.watcher.poll(); assert.match(f.messages[1]![1], /All checks are passing/);
  await f.watcher.poll(); assert.equal(f.messages.length, 2);
});

for (const state of ["merged", "closed"] as const) test(`${state} is recorded and no longer polled`, async (t) => {
  const f = fixture(); t.after(() => f.registry.close()); await f.watcher.poll();
  f.snapshot.pr.state = state; await f.watcher.poll(); f.calls.length = 0;
  await f.watcher.poll(); assert.ok(!f.calls.includes("poll"));
  assert.equal(f.registry.prWatch(f.id)?.links[0]?.pr.state, state);
  assert.equal(f.messages.length, 0);
});

for (const status of ["archived", "deleted"] as const) test(`${status} threads neither discover nor poll or send`, async (t) => {
  const f = fixture(); t.after(() => f.registry.close()); await f.watcher.poll();
  f.registry.setThreadStatus(f.id, status); f.calls.length = 0;
  f.snapshot.comments.push({ id: "new", text: "new comment" });
  await f.watcher.poll(); assert.deepEqual(f.calls, []); assert.equal(f.messages.length, 0);
  if (status === "archived") {
    f.registry.setThreadStatus(f.id, "active"); await f.watcher.poll(); assert.equal(f.messages.length, 1);
    f.registry.setThreadStatus(f.id, "archived"); await f.watcher.poll();
    f.registry.setThreadStatus(f.id, "active"); await f.watcher.poll(); assert.equal(f.messages.length, 1);
  }
});

test("ten consecutive comment wakes stop all watching, even after unarchive", async (t) => {
  const f = fixture(); t.after(() => f.registry.close()); await f.watcher.poll();
  for (let i = 0; i < 11; i++) { f.snapshot.comments.push({ id: `comment:${i}`, text: "reply" }); await f.watcher.poll(); }
  assert.equal(f.messages.length, 10); assert.equal(f.registry.prWatch(f.id)?.commentWakes, 10);
  assert.match(f.messages[9]![1], /watching stopped/);
  f.registry.setThreadStatus(f.id, "archived"); await f.watcher.poll(); f.registry.setThreadStatus(f.id, "active");
  f.calls.length = 0; await f.watcher.poll(); assert.deepEqual(f.calls, []);
});

test("a non-comment wake resets the consecutive count", async (t) => {
  const f = fixture(); t.after(() => f.registry.close()); await f.watcher.poll();
  f.snapshot.comments.push({ id: "comment", text: "reply" }); await f.watcher.poll();
  assert.equal(f.registry.prWatch(f.id)?.commentWakes, 1);
  f.snapshot.pr.conflict = true; await f.watcher.poll(); assert.equal(f.registry.prWatch(f.id)?.commentWakes, 0);
});

test("durable pending delivery reuses its request id after restart, with no repeated news", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-pr-watch-")); t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "registry.db"); const f = fixture(path);
  await f.watcher.poll(); f.snapshot.pr.conflict = true; f.reject(true); await f.watcher.poll();
  const requestId = f.messages[0]![2]; f.registry.close();
  const registry = openRegistry(path); t.after(() => registry.close()); f.reject(false);
  const restarted = prWatcher({ ...f.options, registry, inbox: f.inbox(registry) }); await restarted.poll();
  assert.equal(f.messages[1]![2], requestId); await restarted.poll(); assert.equal(f.messages.length, 2);
});

test("without a token the watcher is off", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  await prWatcher({ ...f.options, github: null }).poll();
  assert.deepEqual(f.calls, []); assert.equal(f.wakes, 0); assert.equal(f.registry.prWatch(f.id), null);
});

/** A watcher whose GitHub searches wait for `released`, and a reader of whether a promise has settled yet. */
function held(f: ReturnType<typeof fixture>) {
  const released = Promise.withResolvers<void>();
  const searched = Promise.withResolvers<void>();
  const watcher = prWatcher({ ...f.options, github: { ...f.github, async find(...args: Parameters<typeof f.github.find>) { searched.resolve(); await released.promise; return f.github.find(...args); } } });
  const watch = (promise: Promise<unknown>) => {
    let settled = false;
    void promise.then(() => { settled = true; });
    return async () => { await new Promise((resolve) => setImmediate(resolve)); return settled; };
  };
  return { watcher, release: released.resolve, searched: searched.promise, watch };
}

test("a poll while a pass runs joins it and settles after it, and a poll after it settles runs a new pass", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const h = held(f);
  const first = h.watcher.poll();
  await h.searched;
  const second = h.watch(h.watcher.poll());
  assert.equal(await second(), false, "the joined poll waits for the pass it joined");
  h.release();
  await first;
  assert.equal(await second(), true);
  assert.deepEqual(f.calls, ["find:acme/repo:feature", "poll"], "one pass ran for both polls");
  await h.watcher.poll();
  assert.deepEqual(f.calls, ["find:acme/repo:feature", "poll", "find:acme/repo:feature", "poll"]);
});

test("close waits for the pass in flight", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const h = held(f);
  void h.watcher.poll();
  await h.searched;
  const closed = h.watch(h.watcher.close());
  assert.equal(await closed(), false);
  h.release();
  assert.equal(await closed(), true);
  assert.deepEqual(f.calls, ["find:acme/repo:feature", "poll"], "the pass finished before close resolved");
});

test("GitHub reads use per-resource ETags, paginate, and include the owner's reviews", async () => {
  const seen: { path: string; etag: string | null }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    const etag = new Headers(init?.headers).get("if-none-match"); seen.push({ path, etag });
    if (etag) return new Response(null, { status: 304 });
    let value: unknown = [];
    if (path.includes("/pulls?")) value = [{ number: 1, head: { repo: { full_name: "acme/repo" } } }];
    if (path.endsWith("/pulls/1")) value = { number: 1, title: "Fix", html_url: "https://github.com/acme/repo/pull/1", state: "open", merged: false, mergeable_state: "dirty", head: { sha: "abc", ref: "feature" }, base: { ref: "main" } };
    if (path.includes("check-runs")) value = { check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "failure", details_url: "https://example.com/build", completed_at: "now" }] };
    if (path.includes("reviews")) value = [{ id: 2, body: "please fix", html_url: "https://example.com/review", user: { login: "owner" }, author_association: "OWNER", state: "CHANGES_REQUESTED", submitted_at: "now" }];
    const headers: Record<string, string> = { etag: '"v1"' };
    if (path.includes("issues/1/comments") && !path.includes("page=2")) headers.link = '<https://api.github.com/repos/acme/repo/issues/1/comments?per_page=100&page=2>; rel="next"';
    return Response.json(value, { headers });
  };
  const client = githubClient("secret", fake);
  assert.deepEqual(await client.find("acme/repo", "feature"), [1]);
  const snapshot = await client.poll("acme/repo", 1);
  assert.equal(snapshot.pr.checks, "failed"); assert.equal(snapshot.pr.review, "changes_requested");
  assert.match(snapshot.comments[0]!.text, /owner/); assert.equal(snapshot.pr.conflict, true);
  const count = seen.length; await client.find("acme/repo", "feature"); await client.poll("acme/repo", 1);
  assert.equal(seen.length, count * 2); assert.ok(seen.slice(count).every((r) => r.etag === '"v1"'));
  assert.ok(seen.some((r) => r.path.includes("page=2")));
});

test("repository parsing only accepts GitHub SSH and HTTPS project repositories", () => {
  for (const url of ["git@github.com:acme/repo.git", "https://github.com/acme/repo", "ssh://git@github.com/acme/repo.git"]) assert.equal(githubRepo(url), "acme/repo");
  assert.equal(githubRepo(null), null); assert.equal(githubRepo("https://elsewhere/acme/repo"), null);
});

test("an archive during a GitHub read does not consume or deliver the new event", async (t) => {
  const f = fixture(); t.after(() => f.registry.close()); await f.watcher.poll();
  const github = { ...f.github, async poll() { f.registry.setThreadStatus(f.id, "archived"); return { ...f.snapshot, comments: [{ id: "new", text: "review" }] }; } };
  await prWatcher({ ...f.options, github }).poll();
  assert.equal(f.messages.length, 0); assert.deepEqual(f.registry.prWatch(f.id)?.links[0]?.seen, []);
  f.registry.setThreadStatus(f.id, "active"); f.snapshot.comments.push({ id: "new", text: "review" });
  await f.watcher.poll(); assert.equal(f.messages.length, 1);
});

test("several PRs for one thread batch into one wake", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const github = { async find() { return [1, 2]; }, async poll(repo: string, number: number) { return { ...f.snapshot, pr: { ...f.snapshot.pr, repo, number, conflict: true } }; } };
  await prWatcher({ ...f.options, github }).poll();
  assert.equal(f.messages.length, 1); assert.match(f.messages[0]![1], /#1 Fix/); assert.match(f.messages[0]![1], /#2 Fix/);
});

test("unknown mergeability does not turn a continuing conflict into new news", async (t) => {
  const f = fixture(); t.after(() => f.registry.close()); f.snapshot.pr.conflict = true;
  await f.watcher.poll(); f.snapshot.pr.conflict = null; await f.watcher.poll(); f.snapshot.pr.conflict = true; await f.watcher.poll();
  assert.equal(f.messages.length, 1);
  f.snapshot.pr.conflict = false; await f.watcher.poll(); f.snapshot.pr.conflict = true; await f.watcher.poll();
  assert.equal(f.messages.length, 2);
});

test("GitHub failures retain the cursor and expose only a credential-free retry notice", async (t) => {
  const f = fixture(); t.after(() => f.registry.close()); await f.watcher.poll();
  await prWatcher({ ...f.options, github: { ...f.github, async poll() { throw new Error("secret-token"); } } }).poll();
  assert.ok(f.registry.prWatch(f.id)?.error); assert.ok(!JSON.stringify(f.registry.prWatch(f.id)).includes("secret-token"));
  await f.watcher.poll(); assert.equal(f.registry.prWatch(f.id)?.error, null);
});

test("legacy statuses use the latest context and missing detail URLs still link to GitHub", async () => {
  let passing = false;
  const fake: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/1")) return Response.json({ number: 1, title: "Fix", html_url: "https://github.com/acme/repo/pull/1", state: "open", merged: false, mergeable_state: "clean", head: { sha: "abc", ref: "feature" }, base: { ref: "main" } });
    if (path.endsWith("/statuses")) return Response.json([{ id: 2, context: "legacy", state: passing ? "success" : "failure", target_url: null }, { id: 1, context: "legacy", state: "pending", target_url: null }]);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: [{ id: 3, name: "build", status: "completed", conclusion: passing ? "success" : "failure", details_url: null, html_url: "https://github.com/acme/repo/runs/3", completed_at: "now" }] });
    return Response.json([]);
  };
  const client = githubClient("secret", fake);
  const failed = await client.poll("acme/repo", 1);
  assert.equal(failed.pr.checks, "failed");
  assert.match(failed.failures[0]!.text, /https:\/\/github.com\/acme\/repo\/runs\/3/);
  assert.match(failed.failures[1]!.text, /https:\/\/github.com\/acme\/repo\/pull\/1/);
  passing = true;
  assert.equal((await client.poll("acme/repo", 1)).pr.checks, "passing");
});

test("only trusted reviews and comments wake, and untrusted feedback cannot exhaust the cap", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  let generation = 0;
  let trusted = false;
  let failed = false;
  const associations = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN", undefined];
  const fake: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls")) return Response.json([{ number: 1, head: { repo: { full_name: "acme/repo" } } }]);
    if (path.endsWith("/pulls/1")) return Response.json({ number: 1, title: "Fix", html_url: f.snapshot.pr.url, state: "open", merged: false, mergeable_state: "clean", head: { sha: "abc", ref: "feature" }, base: { ref: "main" }, user: { login: "pr-author" }, author_association: "NONE" });
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: failed ? [{ id: 1, name: "build", status: "completed", conclusion: "failure", details_url: "https://example.com/build", completed_at: "now" }] : [] });
    if (path.endsWith("/reviews") || path.endsWith("/comments")) return Response.json(associations.flatMap((association, i) => {
      if (i < 3 && !trusted) return [];
      return [{ id: generation * 100 + i, body: `feedback-${association ?? "missing"}`, html_url: "https://example.com/comment", user: { login: i === 6 ? "pr-author" : `user-${i}` }, author_association: association, state: "COMMENTED", submitted_at: "now" }];
    }));
    return Response.json([]);
  };
  const watch = prWatcher({ ...f.options, github: githubClient("secret", fake) });
  await watch.poll();
  for (generation = 1; generation <= 11; generation++) await watch.poll();
  assert.equal(f.messages.length, 0);
  assert.equal(f.registry.prWatch(f.id)?.commentWakes, 0);
  assert.deepEqual(f.registry.prWatch(f.id)?.links[0]?.seen, []);
  trusted = true;
  await watch.poll();
  assert.equal(f.messages.length, 1);
  for (const kind of ["review", "review-comment", "issue-comment"]) assert.match(f.messages[0]![1], new RegExp(`${kind} by`));
  for (const association of associations.slice(0, 3)) assert.ok(f.messages[0]![1].includes(`feedback-${association}`));
  for (const association of associations.slice(3)) assert.ok(!f.messages[0]![1].includes(`feedback-${association ?? "missing"}`));
  assert.ok(!f.messages[0]![1].includes("pr-author"));
  assert.equal(f.registry.prWatch(f.id)?.commentWakes, 1);
  failed = true;
  await watch.poll();
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1]![1], /Check failed: build/);
});

test("a repository's ordinary 403 does not cool down other repositories", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname; calls.push(path);
    return path.includes("/denied/") ? new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "9999999999" } }) : Response.json([]);
  };
  const client = githubClient("secret", fake);
  await assert.rejects(client.find("denied/repo", "main"), /HTTP 403/);
  assert.deepEqual(await client.find("allowed/repo", "main"), []);
  assert.deepEqual(calls, ["/repos/denied/repo/pulls", "/repos/allowed/repo/pulls"]);
});

for (const [name, headers, delay] of [
  ["short Retry-After", { "retry-after": "5" }, 5_000],
  ["long Retry-After", { "retry-after": "360" }, 360_000],
  ["dated Retry-After", { "retry-after": "Fri, 01 Jan 2027 00:03:00 GMT" }, 180_000],
  ["exhausted primary limit", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1798761660" }, 60_000],
  ["both limits", { "retry-after": "90", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1798761660" }, 90_000],
] as const) test(`GitHub honours ${name} before another repository's request`, async (t) => {
  let now = Date.parse("2027-01-01T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const fake: typeof fetch = async () => ++calls === 1 ? new Response(null, { status: 403, headers }) : Response.json([]);
  const client = githubClient("secret", fake);
  await assert.rejects(client.find("acme/repo", "main"), /HTTP 403/);
  now += delay - 1;
  await assert.rejects(client.find("other/repo", "main"), /waiting for its rate limit/);
  assert.equal(calls, 1);
  now++;
  assert.deepEqual(await client.find("other/repo", "main"), []);
  assert.equal(calls, 2);
});

test("rediscovery reactivates a reopened PR without replaying its consumed feedback", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  await f.watcher.poll();
  f.snapshot.comments.push({ id: "comment:old", text: "old feedback" });
  f.snapshot.failures.push({ id: "check:old", text: "old failed check" });
  f.snapshot.pr.checks = "failed";
  await f.watcher.poll();
  assert.equal(f.messages.length, 1);
  const seen = f.registry.prWatch(f.id)!.links[0]!.seen;
  f.snapshot.pr.state = "closed";
  await f.watcher.poll();
  assert.equal(f.registry.prWatch(f.id)?.links[0]?.pr.state, "closed");
  const restarted = prWatcher(f.options);
  f.calls.length = 0;
  await restarted.poll();
  assert.ok(!f.calls.includes("poll"));
  f.snapshot.pr.state = "open";
  await restarted.poll();
  assert.ok(f.calls.includes("poll"));
  assert.equal(f.registry.prWatch(f.id)?.links[0]?.pr.state, "open");
  assert.deepEqual(f.registry.prWatch(f.id)?.links[0]?.seen, seen);
  assert.equal(f.messages.length, 1);
  f.snapshot.comments.push({ id: "comment:new", text: "new feedback" });
  await restarted.poll();
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1]![1], /new feedback/);
  assert.doesNotMatch(f.messages[1]![1], /old feedback|old failed check/);
  f.snapshot.pr.checks = "passing"; f.snapshot.failures = [];
  await restarted.poll();
  assert.equal(f.messages.length, 3);
  assert.match(f.messages[2]![1], /All checks are passing/);
  await restarted.poll();
  assert.equal(f.messages.length, 3);
});

test("deployment drain retains PR-watch feedback for delivery after the barrier releases", async (t) => {
  const { turnGate } = await import("./drain.ts");
  const f = fixture();
  t.after(() => f.registry.close());
  let draining = true;
  const gate = turnGate(() => draining);
  const watcher = prWatcher({ ...f.options, inbox: f.inbox(f.registry, { send: (...args) => gate.run(() => f.harness.send(...args)) }) });
  f.snapshot.failures.push({ id: "failed:drain", text: "failed while draining" });
  await watcher.poll();
  assert.equal(f.messages.length, 0);
  const pending = f.registry.prWatch(f.id)!.pending;
  assert.ok(pending);
  draining = false;
  await watcher.poll();
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0]![2], pending.id);
  assert.equal(f.registry.prWatch(f.id)!.pending, null);
});

test("feedback reaches a Claude worker thread typed into its session once its pylon runs, as agent activity only", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const claude = f.add("th-claude", true);
  const typed: PylonCommand[] = [];
  let outcome: "sent" | "blocked" = "blocked";
  const probe = { async command(_: PylonId, command: PylonCommand): Promise<CommandResult> { typed.push(command); return { kind: "send-claude", outcome, herdrPane: "w1:p1", resumed: false }; } };
  const woken: ThreadId[] = [];
  const watcher = prWatcher({ ...f.options, inbox: agentInbox({ registry: f.registry, harness: f.harness, probes: new Map([[f.node, probe]]), wake(t) { woken.push(t.id); } }) });
  await watcher.poll();
  f.snapshot.comments.push({ id: "review:1", text: "review by owner (CHANGES_REQUESTED): https://example.com\r\n\tUse the cache\r\n" });
  await watcher.poll();
  assert.equal(typed.length, 0, "a paused pylon is woken, not typed into");
  assert.deepEqual(woken.filter((id) => id === claude).length, 1);
  const pending = f.registry.prWatch(claude)!.pending!;
  assert.ok(pending);
  f.observe(claude, true);
  await watcher.poll();
  assert.equal(typed.length, 1);
  assert.equal(f.registry.prWatch(claude)!.pending?.id, pending.id, "Claude at a dialog typed nothing, so the message waits");
  outcome = "sent";
  await watcher.poll();
  assert.equal(typed.length, 2);
  const command = typed[1] as Extract<PylonCommand, { kind: "send-claude" }>;
  assert.ok(command.text.startsWith(prWatchPrefix));
  assert.match(command.text, /CHANGES_REQUESTED\): https:\/\/example.com\n  Use the cache$/, "line ends and tabs made typeable");
  assert.equal(f.registry.prWatch(claude)!.pending, null);
  assert.deepEqual(f.registry.claudeMessage(claude, pending.id), { state: "sent", result: { session: "c0ffee00-0000-4000-8000-000000000000", outcome: "sent", resumed: false } });
  assert.equal(f.registry.thread(claude)!.lastHumanActivityAt, 1, "automated feedback is never human activity");
  assert.equal(f.messages.filter(([thread]) => thread === claude).length, 0, "nothing reaches the harness");
  await watcher.poll();
  assert.equal(typed.length, 2);
});

test("the client reads a PR's head, base and body, its changed files, and merges only the head it is given", async () => {
  const merges: unknown[] = [];
  let answer = (): Response => Response.json({ sha: "m".repeat(40), merged: true });
  const fake: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/merge")) { merges.push(JSON.parse(String(init?.body))); return answer(); }
    if (path.endsWith("/pulls/1")) return Response.json({ number: 1, title: "Fix", html_url: "https://github.com/acme/repo/pull/1", state: "open", merged: false, mergeable_state: "clean", body: "Not checked live: the deploy", merge_commit_sha: "t".repeat(40), head: { sha: "abc", ref: "feature" }, base: { ref: "main" } });
    if (path.endsWith("/files")) return Response.json([{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }, { filename: "logo.png", previous_filename: "img/logo.png" }]);
    return Response.json(path.endsWith("/check-runs") ? { check_runs: [] } : []);
  };
  const client = githubClient("secret", fake);
  assert.deepEqual((await client.poll("acme/repo", 1)).detail, { head: "abc", branch: "feature", base: "main", body: "Not checked live: the deploy", mergeCommit: null }, "an unmerged PR's test merge commit is not its merge commit");
  assert.deepEqual(await client.files("acme/repo", 1), [{ path: "src/a.ts", previous: null, patch: "@@ -1 +1 @@\n-a\n+b" }, { path: "logo.png", previous: "img/logo.png", patch: "" }]);
  assert.deepEqual(await client.merge("acme/repo", 1, "abc"), { kind: "merged", commit: "m".repeat(40) });
  assert.deepEqual(merges, [{ sha: "abc", merge_method: "squash" }]);
  answer = () => Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
  assert.deepEqual(await client.merge("acme/repo", 1, "abc"), { kind: "denied", message: "GitHub answered 403: Resource not accessible by personal access token" });
  answer = () => Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 });
  assert.equal((await client.merge("acme/repo", 1, "abc")).kind, "refused");
  answer = () => Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) } });
  await assert.rejects(client.merge("acme/repo", 1, "abc"), /HTTP 403/, "a rate limit is retried, not reported as a denial");
});

test("the client creates the label once, adds it to the PR, and reports a token that may not write as denied", async () => {
  const calls: [string, unknown][] = [];
  let create = (): Response => Response.json({}, { status: 201 });
  let add = (): Response => Response.json([{ name: "needs human review" }]);
  const fake: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push([`${init?.method} ${path}`, JSON.parse(String(init?.body))]);
    return path.endsWith("/issues/1/labels") ? add() : create();
  };
  const client = githubClient("secret", fake);
  assert.deepEqual(await client.label("acme/repo", 1, "needs human review"), { kind: "labelled" });
  assert.deepEqual(calls, [
    ["POST /repos/acme/repo/labels", { name: "needs human review", color: "d93f0b", description: "The Nexus review ran out of rounds" }],
    ["POST /repos/acme/repo/issues/1/labels", { labels: ["needs human review"] }],
  ]);
  create = () => Response.json({ message: "Validation Failed", errors: [{ code: "already_exists" }] }, { status: 422 });
  assert.deepEqual(await client.label("acme/repo", 1, "needs human review"), { kind: "labelled" }, "a label the repository has already is added");
  create = () => Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
  add = () => Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
  assert.deepEqual(await client.label("acme/repo", 1, "needs human review"), { kind: "denied", message: "GitHub answered 403: Resource not accessible by personal access token" });
  add = () => Response.json({ message: "Server Error" }, { status: 502 });
  await assert.rejects(client.label("acme/repo", 1, "needs human review"), /HTTP 502/, "a server error is retried, not reported as a denial");
});

test("the review loop hears of each PR the watch links open, once, and again after a call that failed", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const heard: string[] = [];
  let fail = true;
  // GitHub's search can list a PR that its own read already reports closed.
  const watcher = prWatcher({ ...f.options, github: { ...f.github, find: async () => [1] }, async linked(thread, pr) { heard.push(`${thread.id} #${pr.number} ${pr.state}`); if (fail) throw new Error("GitHub read failed"); } });
  await watcher.poll();
  assert.deepEqual(heard, ["th-1 #1 open"]);
  assert.equal(f.registry.prWatch(f.id)?.links.length ?? 0, 0, "the link waits until the review loop heard of it");
  fail = false;
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(heard, ["th-1 #1 open", "th-1 #1 open"], "a saved link is not news again");
  assert.equal(f.registry.prWatch(f.id)?.links[0]?.pr.number, 1);
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "closed" } };
  f.add("th-2");
  await watcher.poll();
  assert.equal(f.registry.prWatch("th-2" as ThreadId)?.links[0]?.pr.state, "closed");
  assert.equal(heard.length, 2, "a PR first read closed is not news");
});

test("a thread a queued thread waits for has its PR's merge seen when archived, capped or closed, and only then", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const queued = (after: ThreadId[], status: "queued" | "archived" = "queued") => f.registry.saveQueued({
    id: `th-q${after.length}${status}` as ThreadId, title: "after", project: "project" as ProjectId, startedBy: "test", createdAt: 1, after,
    request: { project: "project", title: "after", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } }, message: null, status, startNow: null, lastError: null, startedAt: null, firstMessage: null,
  });
  const merged = (id: ThreadId) => f.registry.prWatch(id)?.links[0]?.pr.state;
  await f.watcher.poll();
  f.registry.setThreadStatus(f.id, "archived");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" } };
  await f.watcher.poll();
  assert.equal(merged(f.id), "open", "an archived thread nothing waits for is not polled");
  queued([f.id], "archived");
  await f.watcher.poll();
  assert.equal(merged(f.id), "open", "a cancelled queued thread waits for nothing");
  queued([f.id]);
  await f.watcher.poll();
  assert.equal(merged(f.id), "merged", "an archived predecessor's merge is seen");

  const capped = f.add("th-capped");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "open" } };
  await f.watcher.poll();
  f.registry.savePrWatch(capped, { ...f.registry.prWatch(capped)!, commentWakes: 10 });
  queued([f.id, capped]);
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" } };
  await f.watcher.poll();
  assert.equal(merged(capped), "merged", "a capped watch still sees the merge");

  const reopened = f.add("th-reopened");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "closed" } };
  f.registry.savePrWatch(reopened, { links: [{ pr: { ...f.snapshot.pr }, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  queued([f.id, capped, reopened]);
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" } };
  await f.watcher.poll();
  assert.equal(merged(reopened), "merged", "a PR reopened and merged between two reads is seen merged");
});

test("a predecessor's PR that opened and merged between two reads, or behind a message the watch cannot deliver, is seen merged", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  f.registry.saveQueued({
    id: "th-queued" as ThreadId, title: "after", project: "project" as ProjectId, startedBy: "test", createdAt: 1, after: [f.id],
    request: { project: "project", title: "after", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } }, message: null, status: "queued", startNow: null, lastError: null, startedAt: null, firstMessage: null,
  });
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" } };
  await f.watcher.poll();
  assert.equal(f.registry.prWatch(f.id)?.links[0]?.pr.state, "merged", "a PR first found after its merge is linked merged");
  assert.ok(f.calls.includes("find:acme/repo:feature:all"));

  const held = f.add("th-held");
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, number: 2, state: "open" } };
  await f.watcher.poll();
  f.registry.savePrWatch(held, { ...f.registry.prWatch(held)!, pending: { id: "pr-watch:held", text: "news" } });
  f.registry.saveQueued({ ...f.registry.queuedThread("th-queued" as ThreadId)!, after: [f.id, held] });
  f.reject(true);
  f.snapshot = { ...f.snapshot, pr: { ...f.snapshot.pr, state: "merged" } };
  await f.watcher.poll();
  await f.watcher.poll();
  assert.equal(f.registry.prWatch(held)?.pending?.id, "pr-watch:held", "the message still waits");
  assert.equal(f.registry.prWatch(held)?.links.find((l) => l.pr.number === 2)?.pr.state, "merged", "its PR's merge is seen all the same");
});

test("a predecessor with one PR merged and another open, neither linked yet, still waits", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  f.registry.saveQueued({
    id: "th-queued" as ThreadId, title: "after", project: "project" as ProjectId, startedBy: "test", createdAt: 1, after: [f.id],
    request: { project: "project", title: "after", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } }, message: null, status: "queued", startNow: null, lastError: null, startedAt: null, firstMessage: null,
  });
  f.registry.savePrWatch(f.id, { links: [], commentWakes: 10, pending: null, error: null });
  const pr = (number: number, state: "open" | "merged") => ({ ...structuredClone(f.snapshot), pr: { ...f.snapshot.pr, number, state, url: `https://github.com/acme/repo/pull/${number}` } });
  const watcher = prWatcher({ ...f.options, github: { find: async (_repo: string, _branch: string, state = "open") => state === "all" ? [1, 2] : [2], poll: async (_repo: string, n: number) => pr(n, n === 1 ? "merged" : "open") } });
  await watcher.poll();
  const links = f.registry.prWatch(f.id)!.links;
  assert.deepEqual(links.map((l) => [l.pr.number, l.pr.state, l.pr.url === ""]), [[1, "merged", false], [2, "open", true]], "the open PR is linked unread, so the watch baselines it");
  assert.deepEqual(waitOf(f.registry, f.id), { thread: f.id, state: "waiting", why: "PR #2 is open" });
});

test("a predecessor's PRs are read before any is saved, and a known one that closes or reopens keeps its state current", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  f.registry.saveQueued({
    id: "th-queued" as ThreadId, title: "after", project: "project" as ProjectId, startedBy: "test", createdAt: 1, after: [f.id],
    request: { project: "project", title: "after", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 } }, message: null, status: "queued", startNow: null, lastError: null, startedAt: null, firstMessage: null,
  });
  f.registry.savePrWatch(f.id, { links: [], commentWakes: 10, pending: null, error: null });
  const pr = (number: number, state: "open" | "merged" | "closed") => ({ ...structuredClone(f.snapshot), pr: { ...f.snapshot.pr, number, state, url: `https://github.com/acme/repo/pull/${number}` } });
  const states = new Map<number, "open" | "merged" | "closed">([[1, "merged"], [2, "open"]]);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let asked = () => {};
  const second = new Promise<void>((resolve) => { asked = resolve; });
  let hold = true;
  const watcher = prWatcher({ ...f.options, github: {
    find: async (_repo: string, _branch: string, state = "open") => state === "all" ? [1, 2] : [],
    poll: async (_repo: string, n: number) => { if (n === 2 && hold) { asked(); await held; } return pr(n, states.get(n)!); },
  } });
  const pass = watcher.poll();
  await second;
  assert.equal(waitOf(f.registry, f.id).state, "waiting", "while the open PR's read is under way, the merge beside it lands nothing");
  release();
  await pass;
  hold = false;
  assert.deepEqual(waitOf(f.registry, f.id), { thread: f.id, state: "waiting", why: "PR #2 is open" });

  states.set(2, "closed");
  await watcher.poll();
  assert.deepEqual(f.registry.prWatch(f.id)!.links.map((l) => [l.pr.number, l.pr.state]), [[1, "merged"], [2, "closed"]]);
  assert.equal(waitOf(f.registry, f.id).state, "landed", "once the open one closes, the merged one lands the thread");

  states.set(2, "open");
  await watcher.poll();
  assert.deepEqual(waitOf(f.registry, f.id), { thread: f.id, state: "waiting", why: "PR #2 is open" }, "a reopened PR holds it again");
  assert.equal(f.registry.prWatch(f.id)!.links[1]!.pr.url, "", "a PR the watch never read stays unread, so its comments are baselined");
});
