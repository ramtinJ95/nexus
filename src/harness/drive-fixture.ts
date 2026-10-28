/**
 * Test support for src/harness/drive-tools.test.ts: the control plane's drive wiring, as main.ts builds it, over a
 * registry file and a harness file, with the scripted model and no node. The locator refuses every pylon as paused, so
 * a tool that needs the pylon fails, and each turn's checkout snapshot fails and is logged.
 *
 * Run as a program, it is the control plane the test kills mid-call:
 *   node src/harness/drive-fixture.ts <CrashArgs JSON>
 * It opens the wiring with a kill switch armed, sends `message` to `thread` if given, runs the watch pass every 50 ms,
 * and SIGKILLs itself at the armed point: `start` just after a start wrote its thread's row, `watch` just after a watch's
 * message was sent and before the watch was saved delivered.
 */
import { agentInbox } from "../control/inbox.ts";
import { driveCalls } from "../control/drive.ts";
import { openRegistry, type ThreadId } from "../control/registry.ts";
import { threadStarts } from "../control/starts.ts";
import { threadStarter } from "../control/threads.ts";
import { watchPass } from "../control/watches.ts";
import type { ImageManifest } from "../images.ts";
import type { ProjectId } from "../project.ts";
import type { NodeName, TailnetNodeId } from "../protocol.ts";
import type { Drive } from "./drive-tools.ts";
import { openHarnessHost, type ConversationId } from "./host.ts";
import { scriptedModel, scriptedModels } from "./test-fixture.ts";

export const node = "drive-node" as NodeName;
export const project = "scratch" as ProjectId;
const image = { id: "img-000000000000", gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "0".repeat(64), pins: {} } as unknown as ImageManifest;

export type KillAt = "start" | "watch";
export interface CrashArgs { registryPath: string; storagePath: string; killAt: KillAt; send?: { thread: string; message: string } }

const die = () => process.kill(process.pid, "SIGKILL");

export async function openDriveStack(paths: { registryPath: string; storagePath: string }, killAt?: KillAt) {
  const registry = openRegistry(paths.registryPath);
  if (registry.project(project) === undefined) {
    registry.upsertNode({ name: node, tailnetHost: "drive-node.tail.ts.net", tailnetNodeId: "nDRIVE" as TailnetNodeId });
    registry.createProject({ id: project, repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 }, allowedHosts: [], secrets: [], logins: [], preSetup: null });
    registry.saveImage(image, null);
    registry.setCurrentImage(image.id);
  }
  const drive = Promise.withResolvers<Drive>();
  const conversations = registry.threads().flatMap((t) => t.conversationId === null ? [] : [{ threadId: t.id, conversationId: Number(t.conversationId) as ConversationId, agentTurnRunning: t.agentTurnRunning }]);
  const replies: string[] = [];
  const harness = await openHarnessHost({
    storagePath: paths.storagePath, models: scriptedModels(), model: scriptedModel, tailscaled: "/nonexistent/tailscaled.sock",
    locator: { awaitRunning: async (pylon) => { throw new Error(`${pylon} is paused`); } },
    threads: conversations, deleted: [], drive: drive.promise,
    onReply: (id, at) => { replies.push(id); registry.recordReply(id as ThreadId, at); },
    onActivity: (id, facts) => registry.recordActivity(id as ThreadId, { agent: facts.lastAgentActivityAt, agentTurnRunning: facts.agentTurnRunning }),
    log: () => {},
  });
  const startThread = threadStarter({
    registry, harness, mirror: { setupInputs: () => Promise.reject(new Error("a scratch project has no remote")) }, dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    wake: () => { if (killAt === "start") die(); },
  });
  const delivered = agentInbox({ registry, harness, probes: new Map(), wake: () => {} });
  const inbox: typeof delivered = async (t, message) => {
    const outcome = await delivered(t, message);
    if (killAt === "watch" && message.sender === "watch") die();
    return outcome;
  };
  const watches = watchPass({ registry, inbox, log: () => {} });
  const start = threadStarts({ registry, startThread, send: (id, text, requestId, sender) => harness.send(id, text, requestId, "followUp", ...sender === undefined ? [] : [sender]), queue: () => { throw new Error("no queue"); } });
  drive.resolve(driveCalls({ registry, start, inbox, harness, watches }));
  return {
    registry, harness, watches, start, replies,
    async close() {
      await watches.close();
      await harness.close();
      registry.close();
    },
  };
}

if (import.meta.main) {
  const args = JSON.parse(process.argv[2]!) as CrashArgs;
  const stack = await openDriveStack(args, args.killAt);
  if (args.send !== undefined) await stack.harness.send(args.send.thread, args.send.message, `msg:${args.killAt}`, "followUp");
  setInterval(() => { void stack.watches.poll(); }, 50);
}
