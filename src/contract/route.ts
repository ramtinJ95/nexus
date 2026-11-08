/**
 * The shape of the control plane's API routes: each route's method, path template, query codec, and the types of its
 * reply and body, with the call a client makes of one. It imports only src/util at run time, so a browser can bundle it.
 */
import { filledPath, type ParamsOf } from "../util/route-path.ts";

/** How long the API's server keeps an idle connection open, Node's default made explicit. A client lets go of a pooled one before then. */
export const apiKeepAliveMs = 5_000;
/** No byte in either direction for this long fails a client's request: a proxy or node that hangs rather than refusing. */
export const apiIdleMs = 30_000;
/** How often the server pings a quiet event stream or terminal. Under apiIdleMs, so a client's idle timeout spares a quiet link. */
export const apiPingMs = 15_000;
/** The idle timeout of a route that waits on the pylon: longer than the probe takes to answer a command or read the checkout, at most 90 s. */
export const pylonWaitMs = 120_000;

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A query's format, which the client encodes and the server decodes. `encode` answers "" or "?" and the parameters.
 * `decode` answers `Raw`, the parameters as they came, where the server still has to check them, as it does a body.
 */
export interface QueryCodec<Q, Raw = Q> {
  encode(query: Q): string;
  decode(params: URLSearchParams): Raw;
}

/** "" for no parameters, or "?" and them, in order. A parameter given undefined is left out. */
export function queryOf(entries: readonly (readonly [string, string | undefined])[]): string {
  const params = new URLSearchParams(entries.filter((entry): entry is [string, string] => entry[1] !== undefined));
  return params.size === 0 ? "" : `?${params}`;
}

/** The reply type of a route that answers a file's bytes rather than JSON. */
export interface FileBytes { readonly bytes: true }
/** The reply type of a route that answers server-sent events, each one's data an `E`. */
export interface EventStream<E> { readonly event: E }

/**
 * A route of the control plane's API. `reply` and `body` are never set: they carry the reply's and the request body's
 * types. `idleMs` is how long a client lets the route stay silent, apiIdleMs when unset.
 */
export interface ApiRoute<M extends Method = Method, P extends string = string, Reply = unknown, Body = unknown, Q = unknown, Raw = Q> {
  method: M;
  path: P;
  query?: QueryCodec<Q, Raw>;
  idleMs?: number;
  readonly reply?: Reply;
  readonly body?: Body;
}
export type ReplyOf<R> = R extends ApiRoute<Method, string, infer Reply> ? Reply : never;
export type BodyOf<R> = R extends ApiRoute<Method, string, unknown, infer Body> ? Body : never;
export type QueryOf<R> = R extends ApiRoute<Method, string, unknown, unknown, infer Q, unknown> ? Q : never;
export type RawQueryOf<R> = R extends ApiRoute<Method, string, unknown, unknown, unknown, infer Raw> ? Raw : never;

/** A route that answers `Reply` and takes `Body`, which is undefined for a route that takes none. */
export function route<Reply, Body = undefined>() {
  return <const M extends Method, const P extends string, Q = undefined, Raw = Q>(method: M, path: P, query?: QueryCodec<Q, Raw>, idleMs?: number): ApiRoute<M, P, Reply, Body, Q, Raw> =>
    ({ method, path, ...query === undefined ? {} : { query }, ...idleMs === undefined ? {} : { idleMs } });
}

/** What a call of the route takes: its path's parameters, its query when it has one, and its body when it takes one. */
export type CallArgs<R extends ApiRoute> = Every<R extends ApiRoute ? ParamsOf<R["path"]> & (QueryOf<R> extends undefined ? unknown : { query?: QueryOf<R> }) & (BodyOf<R> extends undefined ? unknown : { body: BodyOf<R> }) : never>;
/** For a union of routes, arguments that each of them takes. */
type Every<U> = (U extends unknown ? (u: U) => void : never) extends (all: infer I) => void ? I : never;

/** The path and query a call of the route asks for, and the body it sends. */
export function callOf<R extends ApiRoute>(route: R, args: CallArgs<R>): { path: string; body: unknown } {
  const { query, body, ...params } = args as { query?: unknown; body?: unknown } & Record<string, string>;
  return { path: filledPath(route.path, params) + (query === undefined ? "" : route.query!.encode(query as QueryOf<R>)), body };
}
