/**
 * What every route module is handed: the route types and replies, and the helpers the server builds once.
 */
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { TailnetNodeId } from "../../ids.ts";
import type { ClaudeConversations } from "../claude-conversation.ts";
import type { TurnGate } from "../drain.ts";
import { HttpError } from "../http-error.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadAgents, ThreadHarness } from "../thread-agent.ts";
import type { Start } from "../start-request.ts";
import type { Access, Policy, Role } from "./access.ts";
import type { PylonAccess } from "./pylon-access.ts";
import type { EventStreams } from "./sse.ts";
import type { ThreadViews } from "./thread-view.ts";
import type { ApiRoute, EventStream, FileBytes, RawQueryOf, ReplyOf } from "../../contract/route.ts";
import type { Encode } from "./encoding.ts";
import { matchedParams, pathPattern, type ParamsOf } from "../../util/route-path.ts";

/** A file is served as its bytes, a page as its text under its own headers, everything else as JSON. */
export type Reply =
  | { status: number; body?: unknown; headers?: never; file?: never; stream?: never }
  | { status: number; headers: Record<string, string>; body: string | Buffer; encode?: Encode; file?: never; stream?: never }
  | { status: number; file: Buffer; type: string; cache?: string; stream?: never }
  | { stream(res: ServerResponse): Promise<void> | void; status?: never; file?: never };
/** `roles` are what roleOf gives the caller, and `host` its MagicDNS name, which only the join's whois gives. */
interface Request { query: URLSearchParams; body(empty?: unknown): Promise<unknown>; caller: TailnetNodeId; roles: ReadonlySet<Role>; host: string | null }
export type Route = (match: RegExpExecArray, req: Request) => Reply | Promise<Reply>;
/** A route any allowed caller or tailnet node changes state with says why it may. */
type WritePolicy = Policy & ({ role: Exclude<Policy["role"], "allowed" | "tailnet"> } | { why: string });
export type RouteEntry = readonly ["GET", RegExp, Policy, Route] | readonly ["POST" | "PUT" | "PATCH" | "DELETE", RegExp, WritePolicy, Route];
export const ok = <T>(body: T) => ({ status: 200, body });
export const created = <T>(body: T) => ({ status: 201, body });
export const noContent = { status: 204 } as const;

/**
 * A reply of the route's reply type: JSON whose body is it, a file for FileBytes, or a stream for an EventStream. A
 * route that answers null answers 204 with none.
 */
type RouteReply<T> = [T] extends [null] ? typeof noContent
  : | ([Exclude<T, FileBytes | EventStream<unknown>>] extends [never] ? never : { status: number; body: Exclude<T, FileBytes | EventStream<unknown>> })
    | ([Extract<T, FileBytes>] extends [never] ? never : Extract<Reply, { file: Buffer }>)
    | ([Extract<T, EventStream<unknown>>] extends [never] ? never : Extract<Reply, { stream: unknown }>);

/** Registers `handle` as the contract's route, with its path's parameters and its decoded query. */
export function on<R extends ApiRoute>(
  route: R,
  policy: R["method"] extends "GET" ? Policy : WritePolicy,
  handle: (params: ParamsOf<R["path"]>, req: Omit<Request, "query"> & { query: RawQueryOf<R> }) => RouteReply<ReplyOf<R>> | Promise<RouteReply<ReplyOf<R>>>,
): RouteEntry {
  const entry: Route = (m, r) => handle(matchedParams<R["path"]>(route.path, m), { ...r, query: route.query?.decode(r.query) as RawQueryOf<R> });
  return [route.method, pathPattern(route.path), policy, entry] as RouteEntry;
}

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

export interface ApiKit extends Access, PylonAccess, ThreadViews, EventStreams {
  registry: Registry;
  harness: ThreadHarness;
  startThread(start: Start): Promise<Thread>;
  claude: ClaudeConversations;
  agents: ThreadAgents;
  agentOf(t: Thread): ThreadAgents["harness" | "claude"];
  draining(): boolean;
  gate: TurnGate;
}
