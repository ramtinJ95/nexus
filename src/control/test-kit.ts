/**
 * Test support: the registry's fixtures. A node, the "acme" project, and threads whose pylon clones
 * git@example.com:acme.git. What needs no registry is in src/test-kit.ts.
 */
import { randomUUID } from "node:crypto";
import { newPylonRecord } from "../tick.ts";
import type { LiveHash, NodeName, PylonId, TailnetNodeId } from "../protocol.ts";
import type { ProjectId, RemoteProject } from "../project.ts";
import type { Registry, StoredPylon, Thread, ThreadId } from "./registry.ts";

export const testNode = "rj-firebat" as NodeName;
/** The tailnet IDs tests assert for their nodes. Another node gets `n<name>`. */
const tailnetNodeIds: Record<string, string> = { "rj-firebat": "nFIREBAT", "infra-testbench": "nTESTBENCH" };

export function testProject(over: Partial<RemoteProject> = {}): RemoteProject {
  return {
    id: "acme" as ProjectId, repoUrl: "git@example.com:acme.git", defaultBranch: "main", defaultNode: testNode,
    resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null, ...over,
  };
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
}

/** The thread's new pylon on `node`, booting fresh from a clone of acme's main. */
export function testPylon(thread: Pick<Thread, "id" | "pylonId">, { node = testNode, boot = {}, liveHash = "hash-1" }: PylonOptions = {}): StoredPylon {
  const { desired: _, ...pylon } = newPylonRecord({
    thread: thread.id, pylonId: thread.pylonId, node, desired: "running",
    boot: {
      pylonId: thread.pylonId, image: "img-000000000000", resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:acme.git", checkout: { branch: "main", commit: "origin/main" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, ...boot,
    },
    firstBoot: { kind: "fresh", preSetup: null },
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
