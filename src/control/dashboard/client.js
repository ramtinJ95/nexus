// The dashboard's only script. Pages are rendered on the server. This file sends actions and messages to the
// JSON API, records a visit as human activity, and polls the page to swap in a fresh `#live` region.
"use strict";

const main = document.querySelector("main");
const pollMs = Number(main?.dataset.pollMs);

/** Sends JSON as the API requires, and throws the API's error message. */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const reply = text === "" ? null : JSON.parse(text);
  if (!res.ok) throw new Error(reply?.error ?? `${method} ${path} failed with ${res.status}`);
  return reply;
}

function showError(id, err) {
  const el = document.getElementById(id);
  if (el === null) return;
  el.textContent = err === null ? "" : err.message;
  el.hidden = err === null;
}

const focusKey = (el) => el.id !== "" ? `#${CSS.escape(el.id)}`
  : el instanceof HTMLAnchorElement ? `a[href="${CSS.escape(el.getAttribute("href"))}"]`
  : null;

let refreshing = null;
async function refresh() {
  const state = document.getElementById("refresh-state");
  try {
    // A link that stalls mid-body would otherwise hold the refresh lock forever.
    const res = await fetch(location.href, { headers: { accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(pollMs * 2) });
    if (!res.ok) throw new Error(`the control plane answered ${res.status}`);
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    const fresh = next.getElementById("live");
    const live = document.getElementById("live");
    if (fresh !== null && live !== null && fresh.innerHTML !== live.innerHTML) {
      // The region holds buttons, links, the prompt box and tool output, so keep focus, the draft and what the
      // reader opened or closed after the swap.
      const focused = live.contains(document.activeElement) ? focusKey(document.activeElement) : null;
      const draft = live.querySelector("#prompt-text");
      const opened = new Map([...live.querySelectorAll("details[id]")].map((d) => [d.id, d.open]));
      live.replaceWith(fresh);
      const prompt = fresh.querySelector("#prompt-text");
      if (draft !== null && prompt !== null) {
        prompt.value = draft.value;
        prompt.setSelectionRange(draft.selectionStart, draft.selectionEnd);
      }
      for (const d of fresh.querySelectorAll("details[id]")) d.open = opened.get(d.id) ?? d.open;
      const send = fresh.querySelector("#send");
      if (send !== null) send.disabled = outgoing?.inFlight === true;
      if (focused !== null) document.querySelector(focused)?.focus();
      document.title = next.title;
    }
    // An archived or deleted thread stops counting visits, so follow the fresh page.
    const activity = next.querySelector("main")?.dataset.activity;
    if (activity === undefined) delete main.dataset.activity;
    else main.dataset.activity = activity;
    if (state !== null) state.textContent = "";
  } catch (err) {
    if (state !== null) state.textContent = `Not updated: ${err.message}. Retrying.`;
  }
}
const refreshNow = () => (refreshing ??= refresh().finally(() => { refreshing = null; }));
/** A refresh that starts after an action, so the page shows its effect. One already in flight may predate it. */
const refreshAfter = async () => { await refreshing; await refreshNow(); };

function recordVisit() {
  const thread = main?.dataset.activity;
  if (thread === undefined) return;
  // A visit wakes a paused pylon, so a failed record is worth saying.
  api("POST", `/v1/threads/${thread}/activity`, { kind: "human" }).catch((err) => {
    showError("action-error", new Error(`This visit was not recorded, so a paused pylon stays paused: ${err.message}`));
  });
}

const actions = {
  archive: (thread) => api("POST", `/v1/threads/${thread}/archive`),
  unarchive: (thread) => api("POST", `/v1/threads/${thread}/unarchive`),
  delete: (thread) => api("DELETE", `/v1/threads/${thread}`),
  abort: (thread) => api("POST", `/v1/threads/${thread}/abort`),
  retry: (thread) => api("POST", `/v1/threads/${thread}/retry`),
};

document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (button === null) return;
  const { action, thread, title } = button.dataset;
  if (action === "delete" && !confirm(`Delete "${title}"? Its pylon and disk are removed.`)) return;
  button.disabled = true;
  try {
    await actions[action](thread);
    showError("action-error", null);
    await refreshAfter();
  } catch (err) {
    showError("action-error", err);
    button.disabled = false;
  }
});

// crypto.randomUUID needs a secure context, and the dashboard is plain HTTP on the tailnet.
const newRequestId = () => `msg:${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

// The last message sent. Sending the same text again after a failure reuses its request ID, so a send whose
// reply was lost is not posted twice. One send at a time, so a second one cannot take the first one's ID.
let outgoing = null;
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "prompt") return;
  event.preventDefault();
  if (outgoing?.inFlight) return;
  const form = event.target;
  const text = form.elements.text.value;
  if (outgoing?.text !== text) outgoing = { text, requestId: newRequestId() };
  outgoing.inFlight = true;
  form.querySelector("#send").disabled = true;
  try {
    await api("POST", `/v1/threads/${form.dataset.thread}/messages`, { text, requestId: outgoing.requestId });
    outgoing = null;
    // The poll may have swapped in a new prompt box meanwhile, or none if the thread was archived. Text typed
    // since the send is the next message, so it stays.
    const prompt = document.getElementById("prompt-text");
    if (prompt?.value === text) prompt.value = "";
    showError("action-error", null);
    await refreshAfter();
  } catch (err) {
    outgoing.inFlight = false;
    showError("action-error", new Error(`The message was not sent: ${err.message}`));
  } finally {
    const send = document.getElementById("send");
    if (send !== null) send.disabled = false;
  }
});

document.getElementById("start")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type=submit]");
  // Empty optional fields mean the project's defaults, which the API applies when the field is absent.
  const body = Object.fromEntries([...new FormData(form)].filter(([, value]) => value !== ""));
  submit.disabled = true;
  try {
    const thread = await api("POST", "/v1/threads", body);
    location.assign(`/threads/${thread.id}`);
  } catch (err) {
    showError("start-error", err);
    submit.disabled = false;
  }
});

if (pollMs > 0) {
  setInterval(() => { if (document.visibilityState === "visible") void refreshNow(); }, pollMs);
}
recordVisit();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  recordVisit();
  if (pollMs > 0) void refreshNow();
});
