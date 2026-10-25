import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, type Thread, type ThreadId } from "./registry.ts";
import { newPylonRecord } from "../tick.ts";
import { desiredPhase } from "../reconcile.ts";
import type { NodeName, PylonId, TailnetNodeId, LiveHash } from "../protocol.ts";
import type { ProjectId } from "../project.ts";
import { githubClient, githubRepo, type PrSnapshot } from "./github.ts";
import { prWatcher, prWatchPrefix } from "./pr-watch.ts";
import type { HarnessHost } from "../harness/host.ts";

function fixture(path = ":memory:") {
  const registry = openRegistry(path);
  const node = "node" as NodeName;
  const project = { id: "project" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project);
  function add(id = "th-1") {
    const thread: Thread = { id: id as ThreadId, title: "test", project: project.id, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: "1", startedBy: "test", createdAt: 1, lastHumanActivityAt: 1, lastAgentActivityAt: 0, agentTurnRunning: false };
    const { desired: _, ...pylon } = newPylonRecord({ thread: id, pylonId: thread.pylonId, node, desired: "paused", boot: { pylonId: thread.pylonId, image: "img-000000000000", resources: project.resources, network: { allowedHosts: [], secrets: [] }, repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: project.repoUrl, ref: "main" } }, firstBoot: { kind: "fresh", preSetup: null }, live: { previews: [], overlay: [] }, liveHash: "hash" as LiveHash });
    registry.createThread(thread, pylon);
    registry.apply({ record: "output", pylonId: thread.pylonId, kind: "branch", ref: "origin/feature" });
    return thread.id;
  }
  const id = add();
  let snapshot: PrSnapshot = { pr: { repo: "acme/repo", number: 1, title: "Fix", url: "https://github.com/acme/repo/pull/1", state: "open", checks: "passing", review: "none", conflict: false }, failures: [], comments: [] };
  const calls: string[] = [];
  const messages: Parameters<HarnessHost["send"]>[] = [];
  let reject = false;
  const harness: Pick<HarnessHost, "send"> = { async send(...args) { messages.push(args); if (reject) throw new Error("delivery interrupted"); return { id: 1 } as never; } };
  const github = { async find(repo: string, branch: string) { calls.push(`find:${repo}:${branch}`); return [1]; }, async poll() { calls.push("poll"); return structuredClone(snapshot); } };
  let wakes = 0;
  const options = { registry, github, harness, wake() { wakes++; } };
  return { registry, id, add, calls, messages, github, options, watcher: prWatcher(options), get snapshot() { return snapshot; }, set snapshot(s: PrSnapshot) { snapshot = s; }, reject(value: boolean) { reject = value; }, get wakes() { return wakes; } };
}

test("links origin branches, shares reads, and only deliberate messages wake without human activity", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  const second = f.add("th-2");
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
  const restarted = prWatcher({ ...f.options, registry }); await restarted.poll();
  assert.equal(f.messages[1]![2], requestId); await restarted.poll(); assert.equal(f.messages.length, 2);
});

test("without a token the watcher is off", async (t) => {
  const f = fixture(); t.after(() => f.registry.close());
  await prWatcher({ ...f.options, github: null }).poll();
  assert.deepEqual(f.calls, []); assert.equal(f.wakes, 0); assert.equal(f.registry.prWatch(f.id), null);
});

test("GitHub reads use per-resource ETags, paginate, and include the owner's reviews", async () => {
  const seen: { path: string; etag: string | null }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    const etag = new Headers(init?.headers).get("if-none-match"); seen.push({ path, etag });
    if (etag) return new Response(null, { status: 304 });
    let value: unknown = [];
    if (path.includes("/pulls?")) value = [{ number: 1, head: { repo: { full_name: "acme/repo" } } }];
    if (path.endsWith("/pulls/1")) value = { number: 1, title: "Fix", html_url: "https://github.com/acme/repo/pull/1", state: "open", merged: false, mergeable_state: "dirty", head: { sha: "abc" } };
    if (path.includes("check-runs")) value = { check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "failure", details_url: "https://example.com/build", completed_at: "now" }] };
    if (path.includes("reviews")) value = [{ id: 2, body: "please fix", html_url: "https://example.com/review", user: { login: "owner" }, state: "CHANGES_REQUESTED", submitted_at: "now" }];
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
