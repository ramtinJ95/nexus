/**
 * The drive tools, with which a Nexus agent thread reads, starts, messages and watches other threads: `nexus_read`,
 * `nexus_start`, `nexus_send` and `nexus_wait`. Only a conversation a person started with them selects this extension.
 *
 * They run in the control-plane process and never read `api.env`, so a call answers while the thread's pylon is
 * paused. Each call's request ID is its conversation and call ID, which survive a restart, and the control plane makes
 * every call idempotent under it, so each tool is replay-safe: a call a crash cut is run again under the same ID, and
 * finds the thread it started or the watch it made rather than making a second.
 *
 * What a call may do is the control plane's to decide, from the calling thread's record. These tools only carry it.
 */
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import { readThread } from "./thread-doc.ts";

/** What a watch waits for, of the watched thread. Its archive or delete ends every watch on it too. */
export const untils = ["turn-ended", "review-ended", "merged", "failed"] as const;
export type Until = typeof untils[number];

export interface DriveStart { project: string; title: string; brief: string; agent: "nexus" | "claude"; model?: string; branch?: string }

/** The control plane's side of each tool. `caller` is the calling thread's ID. A refusal throws, with its reason. */
export interface Drive {
  read(caller: string, thread: string): Promise<unknown>;
  start(caller: string, start: DriveStart, requestId: string): Promise<unknown>;
  send(caller: string, thread: string, text: string, requestId: string): Promise<unknown>;
  wait(caller: string, thread: string, until: Until, watchId: string): Promise<unknown>;
}

const thread = Type.String({ description: "A thread ID, such as th-0123456789ab" });

async function call(api: ToolExecutionApi, context: Context, act: (caller: string, requestId: string) => Promise<unknown>): Promise<ToolExecutionResult> {
  try {
    const { threadId } = await readThread(api, api.conversationId, context);
    const answer = await act(threadId, `tool:${api.conversationId}:${api.callId}`);
    return { output: [{ type: "text", text: JSON.stringify(answer, null, 2) }] };
  } catch (err) {
    return { isError: true, output: [{ type: "text", text: (err as Error).message }] };
  }
}

/** `drive` resolves once the control plane is wired, which a call that a restart resumes waits for. */
export function driveTools(drive: Promise<Drive>): Extension {
  return defineExtension({
    name: "nexus.drive",
    tools: [
      defineTool({
        name: "nexus_read",
        description: "Read a Nexus thread: its status, attention, pylon, pull requests, review, open questions, children, and the last messages of its conversation.",
        parameters: Type.Object({ thread }),
        replay: "safe",
        execute: (args, api, context) => call(api, context, async (caller) => (await drive).read(caller, args.thread)),
      }),
      defineTool({
        name: "nexus_start",
        description: "Start a thread on a project with a brief, as a child of this one. A Nexus agent thread gets the brief as its first message, and a Claude worker as its prompt. A thread may have 3 live children, and a child starts none.",
        parameters: Type.Object({
          project: Type.String({ description: "The project's ID" }),
          title: Type.String({ description: "A short title for the thread list" }),
          brief: Type.String({ description: "Everything the child needs to do its task: it sees none of this conversation" }),
          agent: Type.Union([Type.Literal("claude"), Type.Literal("nexus")], { description: "claude for a Claude Code worker in the pylon, nexus for a Nexus agent thread" }),
          model: Type.Optional(Type.String({ description: "A Claude worker's model. The project's default when omitted" })),
          branch: Type.Optional(Type.String({ description: "The branch to check out. The project's default branch when omitted" })),
        }),
        replay: "safe",
        execute: (args, api, context) => call(api, context, async (caller, requestId) => (await drive).start(caller, args, requestId)),
      }),
      defineTool({
        name: "nexus_send",
        description: "Send a message to another thread's agent, marked as from this thread. It waits for a busy agent's turn to end.",
        parameters: Type.Object({ thread, text: Type.String({ description: "The message" }) }),
        replay: "safe",
        execute: (args, api, context) => call(api, context, async (caller, requestId) => (await drive).send(caller, args.thread, args.text, requestId)),
      }),
      defineTool({
        name: "nexus_wait",
        description: "Watch a thread and return at once. When its turn ends, its review ends, its pull request merges, or it fails, as `until` names, or when it is archived or deleted, Nexus sends this thread a message saying so, once. End your turn after calling it, rather than polling.",
        parameters: Type.Object({ thread, until: Type.Union(untils.map((u) => Type.Literal(u))) }),
        replay: "safe",
        execute: (args, api, context) => call(api, context, async (caller, requestId) => (await drive).wait(caller, args.thread, args.until, requestId)),
      }),
    ],
  });
}
