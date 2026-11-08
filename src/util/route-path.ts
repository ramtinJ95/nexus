/**
 * Route path templates, for the control plane's API and the probe's alike. A template names each parameter in braces,
 * as `/v1/threads/{thread}`, and each parameter is one path segment. It imports nothing, so a browser can bundle it.
 */
export type ParamsOf<P extends string> = P extends `${string}{${infer K}}${infer Rest}` ? Record<K, string> & ParamsOf<Rest> : unknown;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
/** One route's literal path only, since a union of routes or a widened route cannot say which parameters it needs. */
type PathArgs<P extends string> = string extends P ? never : true extends IsUnion<P> ? never : P extends `${string}{${string}` ? [ParamsOf<P>] : [];

/** The route's path with each parameter URI-encoded. */
export function routePath<P extends string>(route: { path: P }, ...params: PathArgs<P>): string {
  return filledPath(route.path, params[0] ?? {});
}

export function filledPath(path: string, given: Partial<Record<string, string>>): string {
  return path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = given[key];
    if (value === undefined) throw new Error(`${path} needs ${key}`);
    return encodeURIComponent(value);
  });
}

const names = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

/** The path a server matches for the template, with each parameter captured in order. */
export function pathPattern(path: string): RegExp {
  return new RegExp(`^${path.split(/\{\w+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([^/]+)")}$`);
}

/** The parameters a match of `pathPattern(path)` captured, as they came in the path. */
export function matchedParams<P extends string>(path: P, match: RegExpExecArray): ParamsOf<P> {
  return Object.fromEntries(names(path).map((name, i) => [name, match[i + 1]!])) as ParamsOf<P>;
}
