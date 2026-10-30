/**
 * Test support: the registry's fixtures. A node, the "acme" project, and threads whose pylon clones
 * git@example.com:acme.git. What needs no registry is in src/test-kit.ts.
 */
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { testObservation } from "../test-kit.ts";
import { newPylonRecord, type PylonRecord } from "../tick.ts";
import type { LiveHash, NodeName, ProjectId, PylonId, TailnetNodeId, ThreadId } from "../ids.ts";
import type { RemoteProject } from "./project.ts";
import type { NodeObservation } from "../protocol/observations.ts";
import type { PullRequest } from "./github.ts";
import { openRegistry, type Registry } from "./registry.ts";
import type { StoredPylon, Thread } from "./thread-store.ts";
import type { Review } from "./review-model.ts";

export const testNode = "rj-firebat" as NodeName;
/** The tailnet IDs tests assert for their nodes. Another node gets `n<name>`. */
const tailnetNodeIds: Record<string, string> = { "rj-firebat": "nFIREBAT", "infra-testbench": "nTESTBENCH" };

export function testProject(over: Partial<RemoteProject> = {}): RemoteProject {
  return {
    id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: testNode,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null, ...over,
  };
}

/** Opens the registry at `path`, in memory unless a file is named, and closes it once `t` ends. */
export function testRegistry(t: Pick<TestContext, "after">, path = ":memory:", clock?: () => number): Registry {
  const registry = openRegistry(path, clock);
  t.after(() => registry.close());
  return registry;
}

/** Adds the nodes, and the project unless the registry has it, so a test may seed one registry more than once. */
export function seedRegistry(registry: Registry, { nodes = [testNode], project = testProject({ defaultNode: nodes[0] ?? testNode }) }: { nodes?: readonly NodeName[]; project?: RemoteProject } = {}): Registry {
  for (const name of nodes) registry.upsertNode({ name, tailnetHost: `${name}.tail.ts.net`, tailnetNodeId: (tailnetNodeIds[name] ?? `n${name}`) as TailnetNodeId });
  if (registry.project(project.id) === undefined) registry.createProject(project);
  return registry;
}

/** An active thread of "acme" that a person started just now, with a new ID unless `over` names one. */
export function testThread(over: Partial<Thread> = {}): Thread {
  const id = over.id ?? `th-${randomUUID().slice(0, 8)}` as ThreadId;
  return {
    seenAt: null, lastReplyAt: null, id, title: "t", project: "acme" as ProjectId, pylonId: `pylon-${id}` as PylonId, status: "active", conversationId: null,
    startedBy: "nLAPTOP", createdAt: Date.now(), agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: Date.now(), ...over,
  };
}

export interface PylonOptions {
  node?: NodeName;
  boot?: Partial<StoredPylon["boot"]>;
  liveHash?: string;
  firstBoot?: PylonRecord["firstBoot"];
}

/** The thread's new pylon on `node`, booting fresh from a clone of acme's main. */
export function testPylon(thread: Pick<Thread, "id" | "pylonId">, { node = testNode, boot = {}, liveHash = "hash-1", firstBoot = { kind: "fresh", preSetup: null } }: PylonOptions = {}): StoredPylon {
  const { desired: _, ...pylon } = newPylonRecord({
    thread: thread.id, pylonId: thread.pylonId, node, desired: "running",
    boot: {
      pylonId: thread.pylonId, image: "img-000000000000", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, ...boot,
    },
    firstBoot,
    live: { previews: [], overlay: [] },
    liveHash: liveHash as LiveHash,
  });
  return { ...pylon, thread: thread.id };
}

/** Creates a thread and its pylon. `claudePrompt` makes it a Claude thread whose worker gets that prompt. */
export function addThread(registry: Registry, options: PylonOptions & { thread?: Partial<Thread>; claudePrompt?: string | undefined } = {}): Thread {
  const thread = testThread(options.thread);
  registry.createThread(thread, testPylon(thread, options), options.claudePrompt);
  return thread;
}

/** Ingests a snapshot of `over.node` (testNode by default) together with the node online, as the loop ingests one. */
export function observeNode(registry: Registry, over: Partial<NodeObservation> = {}): NodeObservation {
  const observation = testObservation(over.node ?? testNode, over);
  registry.ingested(observation, [{ record: "node", node: observation.node, state: "online", capacity: observation.capacity }]);
  return observation;
}

/** Open pull request #1 of acme/repo, with no checks, no review and no conflict. Its URL follows its repo and number. */
export function testPr(over: Partial<PullRequest> = {}): PullRequest {
  const { repo = "acme/repo", number = 1 } = over;
  return { repo, number, title: "Fix", url: `https://github.com/${repo}/pull/${number}`, state: "open", checks: "none", review: "none", conflict: false, ...over };
}

/** Review rv-1 of acme/repo's PR #7 in its first round, by a harness reviewer on gpt-6-astra of a builder on claude-opus-5-5. */
export function testReview(over: Partial<Review> = {}): Review {
  return {
    id: "rv-1", builder: "th-builder" as ThreadId, reviewer: "th-reviewer" as ThreadId, pr: { repo: "acme/repo", number: 7, url: "https://github.com/acme/repo/pull/7", title: "Cache", branch: "cache" },
    reviewerKind: "harness", models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, maxRounds: 5, land: null, auto: false, merged: null, waiver: null, expect: "rv-1:t", sent: 1,
    outbox: null, asked: "", since: 0, nudges: 0, startedAt: 0, rounds: [{ head: "1".repeat(40), verdict: null, check: null, answers: null }], phase: { kind: "reviewing" }, ...over,
  };
}
