/**
 * What every route module is handed: the route types and replies, and the helpers the server builds once.
 */
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { TailnetNodeId, ThreadId } from "../../ids.ts";
import type { ClaudeConversations } from "../claude-conversation.ts";
import type { liveStreams } from "../dashboard/live-frames.ts";
import type { TurnGate } from "../drain.ts";
import { HttpError } from "../http-error.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadAgents, ThreadHarness } from "../thread-agent.ts";
import type { StartKey, StartRequest } from "../start-request.ts";
import type { Access } from "./access.ts";
import type { PylonAccess } from "./pylon-access.ts";
import type { EventStreams } from "./sse.ts";
import type { ThreadViews } from "./thread-view.ts";

/** A file is served as its bytes, a page as its text under its own headers, everything else as JSON. */
export type Reply =
  | { status: number; body?: unknown; headers?: never; file?: never; stream?: never }
  | { status: number; headers: Record<string, string>; body: string; file?: never; stream?: never }
  | { status: number; file: Buffer; type: string; cache?: string; stream?: never }
  | { stream(res: ServerResponse): Promise<void> | void; status?: never; file?: never };
export type Route = (match: RegExpExecArray, req: { query: URLSearchParams; body(empty?: unknown): Promise<unknown>; caller: TailnetNodeId }) => Reply | Promise<Reply>;
/**
 * Who may call a route that changes state: only a person, as `personOnly` checks before the route runs, or any
 * allowed caller, for the reason given, which names the check the route makes itself if it makes one. A route that
 * starts a turn waits out a deploy's drain.
 */
export type Policy = ({ person: string } | { open: string }) & { startsTurn?: true };
export type RouteEntry = readonly ["GET", RegExp, Route] | readonly ["POST" | "PUT" | "PATCH" | "DELETE", RegExp, Policy, Route];
export const ok = (body: unknown): Reply => ({ status: 200, body });
export const created = (body: unknown): Reply => ({ status: 201, body });
export const noContent: Reply = { status: 204 };

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

export interface ApiKit extends Access, PylonAccess, ThreadViews, EventStreams {
  registry: Registry;
  harness: ThreadHarness;
  startThread(request: StartRequest, caller: string, queuedId?: ThreadId, key?: StartKey): Promise<Thread>;
  claude: ClaudeConversations;
  agents: ThreadAgents;
  live: ReturnType<typeof liveStreams>;
  agentOf(t: Thread): ThreadAgents["harness" | "claude"];
  draining(): boolean;
  gate: TurnGate;
}
