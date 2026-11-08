/**
 * The shape of the control plane's API routes: each route's method, path template, query codec, and the types of its
 * reply and body, with the call a client makes of one. It imports only src/util at run time, so a browser can bundle it.
 */
import { filledPath, type ParamsOf } from "../util/route-path.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A query's format, which the client encodes and the server decodes. `encode` answers "" or "?" and the parameters. */
export interface QueryCodec<Q> {
  encode(query: Q): string;
  decode(params: URLSearchParams): Q;
}

/** A route of the control plane's API. `reply` and `body` are never set: they carry the reply's and the request body's types. */
export interface ApiRoute<M extends Method = Method, P extends string = string, Reply = unknown, Body = unknown, Q = unknown> {
  method: M;
  path: P;
  query?: QueryCodec<Q>;
  readonly reply?: Reply;
  readonly body?: Body;
}
export type ReplyOf<R> = R extends ApiRoute<Method, string, infer Reply> ? Reply : never;
export type BodyOf<R> = R extends ApiRoute<Method, string, unknown, infer Body> ? Body : never;
export type QueryOf<R> = R extends ApiRoute<Method, string, unknown, unknown, infer Q> ? Q : never;

/** A route that answers `Reply` and takes `Body`, which is undefined for a route that takes none. */
export function route<Reply, Body = undefined>() {
  return <const M extends Method, const P extends string, Q = undefined>(method: M, path: P, query?: QueryCodec<Q>): ApiRoute<M, P, Reply, Body, Q> =>
    query === undefined ? { method, path } : { method, path, query };
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
