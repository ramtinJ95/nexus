// The JSON API the dashboard's pages call, over the page's fetch or a test's.
import { callOf } from "../../contract/route.ts";

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

/** Calls one of the contract's routes with its path's parameters, its query and its body. */
export function request(route, args, signal) {
  const { path, body } = callOf(route, args);
  return api(route.method, path, body, signal);
}
