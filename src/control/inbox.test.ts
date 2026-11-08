import { test } from "node:test";
import assert from "node:assert/strict";
import { testPylon, testRegistry, testThread, claudeWorkerAt } from "../test-support/registry-kit.ts";
import { agentInbox } from "./inbox.ts";
import type { LiveHash, NodeName, ProjectId, PylonId, TailnetNodeId, ThreadId } from "../ids.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import { runningPylon, testCapacity, testObservation } from "../test-support/kit.ts";

const node = "node" as NodeName;
const session = "c0ffee00-0000-4000-8000-000000000000";

test("a message whose earlier send failed partway counts as delivered, is not typed again, and says so in the injected log", async (t) => {
  const registry = testRegistry(t);
  const project = { id: "project" as ProjectId, repoUrl: "https://github.com/acme/repo.git", defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
  registry.upsertNode({ name: node, tailnetHost: "node.ts.net", tailnetNodeId: "nNODE" as TailnetNodeId });
  registry.createProject(project);
  const thread = testThread({ id: "th-1" as ThreadId, title: "test", project: project.id, startedBy: "test", createdAt: 1, lastHumanActivityAt: 1 });
  registry.createThread(thread, testPylon(thread, { node, liveHash: "hash", boot: { repo: { kind: "clone", url: project.repoUrl, checkout: { branch: "main", commit: "main" } }, dotfiles: { repo: project.repoUrl, ref: "main" } } }), { claude: { prompt: "/poteto-mode fix it" } });
  claudeWorkerAt(registry, thread.id, "started", { session });
  registry.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  registry.ingested(testObservation(node, { pylons: [runningPylon(thread.pylonId, { liveHash: "hash" as LiveHash })] }), []);
  const asked: PylonCommand["kind"][] = [];
  const probe = {
    async command(_: PylonId, command: PylonCommand): Promise<CommandResult> {
      asked.push(command.kind);
      if (command.kind === "send-claude") throw new Error("the connection reset");
      return { kind: "send-claude-outcome", send: "unknown" };
    },
  };
  const logged: string[] = [];
  const inbox = agentInbox({ log: (message) => { logged.push(message); }, registry, harness: { async send() { throw new Error("a Claude worker's message never reaches the harness"); } }, probes: new Map([[node, probe]]), wake() {} });
  const message = { id: "msg-1", text: "Continue.", sender: "usage-limit" } as const;

  await assert.rejects(inbox(registry.thread(thread.id)!, message), /the connection reset/);
  assert.equal(await inbox(registry.thread(thread.id)!, message), "delivered");
  assert.deepEqual(asked, ["send-claude", "send-claude-outcome"]);
  assert.deepEqual(logged, ["th-1: an earlier send of msg-1 failed partway, so it is not typed again"]);
});
