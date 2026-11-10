// The JSON API the dashboard's pages call, over the page's fetch or a test's.
import { apiIdleMs, callOf } from "../../contract/route.ts";

export function apiOver({ fetch } = globalThis) {
  /** Sends JSON as the API requires, and throws the API's error message with its status, code and whether it is retryable. */
  return async function api(method, path, body, signal) {
    const res = await fetch(path, {
      method, signal,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const reply = text === "" ? null : JSON.parse(text);
    if (!res.ok) throw Object.assign(new Error(reply?.error ?? `${method} ${path} failed with ${res.status}`), { status: res.status, code: reply?.code ?? null, retryable: reply?.retryable === true });
    return reply;
  };
}
export const api = apiOver();

/**
 * Calls one of the contract's routes over `api`, with its path's parameters, its query and its body. A call given no
 * `signal` gives up once the route has been silent as long as the CLI lets it be, so a stalled connection fails the
 * action rather than holding its button for good.
 */
export function requestOver(api, timeout = (ms) => AbortSignal.timeout(ms)) {
  return async function request(route, args, signal) {
    const { path, body } = callOf(route, args);
    if (signal !== undefined) return api(route.method, path, body, signal);
    const ms = route.idleMs ?? apiIdleMs;
    try {
      return await api(route.method, path, body, timeout(ms));
    } catch (err) {
      if (err?.name !== "TimeoutError") throw err;
      throw Object.assign(new Error(`the control plane did not answer in ${ms / 1000} s`), { timedOut: true, retryable: false });
    }
  };
}
export const request = requestOver(api);

/**
 * Why the server refuses `url`, read from a plain GET of it, since a refused EventSource or WebSocket cannot read the
 * reply. Null when the server would take it now, as a stream answers 200 and the attach route 426.
 */
export async function refusalAt(url, { fetch, AbortSignal } = globalThis) {
  const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(apiIdleMs) });
  if (res.ok || res.status === 426) {
    await res.body?.cancel();
    return null;
  }
  let reply = null;
  try {
    reply = JSON.parse(await res.text());
  } catch {}
  return reply?.error ?? `the control plane answered ${res.status}`;
}
