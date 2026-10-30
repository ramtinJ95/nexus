// The JSON API the dashboard's pages call, over the page's fetch or a test's.
export function apiOver({ fetch } = globalThis) {
  /** Sends JSON as the API requires, and throws the API's error message. */
  return async function api(method, path, body, signal) {
    const res = await fetch(path, {
      method, signal,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const reply = text === "" ? null : JSON.parse(text);
    if (!res.ok) throw Object.assign(new Error(reply?.error ?? `${method} ${path} failed with ${res.status}`), { status: res.status });
    return reply;
  };
}
export const api = apiOver();
