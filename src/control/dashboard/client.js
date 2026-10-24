// The dashboard's only script. Pages are rendered on the server. This file sends actions, messages and new projects
// to the JSON API, records a visit as human activity, opens the start and new-project dialogs and the phone's panels,
// and polls the page to swap in each `data-live` region that changed. A thread page also follows its stream, which
// sends the conversation region as the run streams.
"use strict";

const main = document.querySelector("main");
const pollMs = Number(main?.dataset.pollMs);
const scroller = document.getElementById("scroll");
const dialog = document.getElementById("start-dialog");
const projectDialog = document.getElementById("project-dialog");
const filter = document.getElementById("filter");

/** Sends JSON as the API requires, and throws the API's error message. */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const reply = text === "" ? null : JSON.parse(text);
  if (!res.ok) throw Object.assign(new Error(reply?.error ?? `${method} ${path} failed with ${res.status}`), { status: res.status });
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

/** The same format as the server's clock(). */
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function tick() {
  for (const time of document.querySelectorAll("time[data-since]")) time.textContent = clock(Date.now() - Number(time.dataset.since));
}

// What the server last sent for each region. Comparing against it rather than the live DOM means a tool the
// reader opened or the ticking run clock is not a change, so an unchanged region is never swapped.
const comparable = (html) => html.replace(/(<time data-since="\d+">)[^<]*/g, "$1");
const served = new Map([...document.querySelectorAll("[data-live]")].map((el) => [el.id, comparable(el.innerHTML)]));
// The folds the reader opened or closed. The rest follow the server, so a fold that opened for a running step
// closes once the step is done.
const toggled = new Map();
document.addEventListener("click", (event) => {
  const details = event.target instanceof Element ? event.target.closest("summary")?.parentElement : null;
  if (details instanceof HTMLDetailsElement && details.id !== "") toggled.set(details.id, !details.open);
});

const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;
/**
 * The conversation only grows, so its n-th block is the same block after a swap. Keeping the first visible
 * block where it was holds the reader's place while a fold above it opens or closes.
 */
function anchor() {
  if (scroller === null) return () => {};
  if (atBottom(scroller)) return () => { scroller.scrollTop = scroller.scrollHeight; };
  const convo = document.getElementById("convo");
  const top = scroller.getBoundingClientRect().top;
  const blocks = [...(convo?.children ?? [])];
  const index = blocks.findIndex((b) => b.getBoundingClientRect().bottom > top);
  if (index === -1) return () => {};
  const offset = blocks[index].getBoundingClientRect().top;
  return () => {
    const block = document.getElementById("convo")?.children[index];
    if (block !== undefined) scroller.scrollTop += block.getBoundingClientRect().top - offset;
  };
}

/**
 * Swaps in each region whose inside, as the browser serializes it, differs from what the server last sent for it.
 * Regions hold buttons, links, the prompt box and tool output, so focus, the draft, what the reader opened or
 * closed, and their place in the conversation survive the swap.
 */
function swap(regions) {
  const changed = regions.map(([el, html]) => [el, html, comparable(html)]).filter(([el, , key]) => el !== null && served.get(el.id) !== key);
  if (changed.length === 0) return;
  const focused = changed.some(([el]) => el.contains(document.activeElement)) ? focusKey(document.activeElement) : null;
  const draft = document.getElementById("prompt-text");
  const saved = draft === null ? null : { value: draft.value, start: draft.selectionStart, end: draft.selectionEnd };
  const start = startState();
  const restoreScroll = anchor();
  for (const [el, html, key] of changed) {
    el.innerHTML = html;
    served.set(el.id, key);
  }
  const prompt = document.getElementById("prompt-text");
  if (saved !== null && prompt !== null && prompt !== draft) {
    prompt.value = saved.value;
    prompt.setSelectionRange(saved.start, saved.end);
  }
  restoreStart(start);
  for (const d of document.querySelectorAll("details[id]")) if (toggled.has(d.id)) d.open = toggled.get(d.id);
  const send = document.getElementById("send");
  if (send !== null) send.disabled = outgoing?.inFlight === true;
  if (focused !== null) document.querySelector(focused)?.focus({ preventScroll: true });
  restoreScroll();
  applyFilter();
  tick();
}

// While the stream is open it alone writes the conversation, so a poll that started before a frame cannot put
// older text back. Its frames come in order: the region whole, then the parts that grew since.
let stream = null;
let frames = 0;
const streaming = () => stream?.readyState === EventSource.OPEN;
function follow(url) {
  // A hidden page keeps none of the control plane's few streams, even when a refresh it began finishes later.
  if (url === undefined || document.visibilityState !== "visible" || (stream !== null && stream.readyState !== EventSource.CLOSED)) return;
  // EventSource reconnects by itself after a dropped connection. A refused one is closed for good, so the next
  // poll opens another.
  stream = new EventSource(url);
  stream.addEventListener("message", (event) => {
    frames += 1;
    const frame = JSON.parse(event.data);
    const convo = document.getElementById("convo");
    if (convo === null) return;
    if (frame.convo !== undefined) {
      // Parsed and serialized as the poll's regions are, so an unchanged region compares equal.
      const fresh = document.createElement("template");
      fresh.innerHTML = frame.convo;
      return swap([[convo, fresh.innerHTML]]);
    }
    const slots = convo.querySelectorAll("[data-grow]");
    const restoreScroll = anchor();
    for (const [i, inside] of frame.grow) {
      const slot = slots[i];
      if (slot === undefined) continue;
      // A running tool's output scrolls by itself. A reader at its end follows it, as at the conversation's end.
      const stick = atBottom(slot);
      slot.innerHTML = inside;
      if (stick) slot.scrollTop = slot.scrollHeight;
    }
    restoreScroll();
  });
}

let refreshing = null;
async function refresh() {
  const state = document.getElementById("refresh-state");
  try {
    const seen = frames;
    // A link that stalls mid-body would otherwise hold the refresh lock forever.
    const res = await fetch(location.href, { headers: { accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(pollMs * 2) });
    if (!res.ok) throw new Error(`the control plane answered ${res.status}`);
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    const followed = streaming() || frames !== seen;
    swap([...next.querySelectorAll("[data-live]")].filter((fresh) => !(followed && fresh.id === "convo")).map((fresh) => [document.getElementById(fresh.id), fresh.innerHTML]));
    follow(next.getElementById("convo")?.dataset.stream);
    document.title = next.title;
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
  "retry-pylon": (thread) => api("POST", `/v1/threads/${thread}/pylon/retry`),
  // Publishes the port. The next refresh shows its preview, which links once the node serves it.
  "link-port": (thread, { port }) => api("POST", `/v1/threads/${thread}/previews`, { port: Number(port) }),
  // As `nexus unpreview`: the first try wakes a paused pylon, and a 409 is tried again once a second until it runs,
  // unless the thread is archived or deleted.
  async unpublish(thread, { port }) {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        return await api("DELETE", `/v1/threads/${thread}/previews/${port}`, {});
      } catch (err) {
        if (err.status !== 409 || Date.now() >= deadline) throw err;
        const { status } = (await api("GET", `/v1/threads/${thread}`)).thread;
        if (status === "archived" || status === "deleted") throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  },
};

document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (button === null) return;
  const { action, thread, title } = button.dataset;
  if (action === "delete" && !confirm(`Delete "${title}"? Its pylon and disk are removed.`)) return;
  button.disabled = true;
  setOpen(null);
  try {
    await actions[action](thread, button.dataset);
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
  if (!event.target.matches("#prompt")) return;
  event.preventDefault();
  if (outgoing?.inFlight) return;
  const form = event.target;
  const text = form.elements.text.value;
  if (outgoing?.text !== text) outgoing = { text, requestId: newRequestId() };
  outgoing.inFlight = true;
  form.querySelector("#send").disabled = true;
  try {
    // A busy run queues the message as a follow-up, which is the API's default.
    await api("POST", `/v1/threads/${form.dataset.thread}/messages`, { text, requestId: outgoing.requestId });
    outgoing = null;
    // The poll may have swapped in a new prompt box meanwhile, or none if the thread was archived. Text typed
    // since the send is the next message, so it stays.
    const prompt = document.getElementById("prompt-text");
    if (prompt?.value === text) prompt.value = "";
    showError("action-error", null);
    await refreshAfter();
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  } catch (err) {
    outgoing.inFlight = false;
    showError("action-error", new Error(`The message was not sent: ${err.message}`));
  } finally {
    const send = document.getElementById("send");
    if (send !== null) send.disabled = false;
  }
});

/** The phone's thread list, inspector or thread actions, one at a time. */
function setOpen(panel) {
  if (panel === null) delete document.body.dataset.open;
  else document.body.dataset.open = panel;
}
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const opener = target?.closest("[data-open]");
  if (opener !== null && opener !== undefined) {
    setOpen(document.body.dataset.open === opener.dataset.open ? null : opener.dataset.open);
    return;
  }
  const closer = target?.closest("[data-close]");
  if (closer === null || closer === undefined) return;
  const modal = closer.closest("dialog");
  if (modal !== null) modal.close();
  else setOpen(null);
});

function updateStartHint() {
  const form = document.getElementById("start");
  const project = form?.querySelector("input[name=project]:checked");
  if (form === null || project === null || project === undefined) return;
  const node = form.elements.node.value || project.dataset.node;
  const branch = form.elements.branch.value || project.dataset.branch;
  form.querySelector("#start-node option[value='']").textContent = `${project.dataset.node} (project default)`;
  form.elements.branch.placeholder = project.dataset.branch;
  const hint = document.getElementById("start-hint");
  const tag = (name, text) => Object.assign(document.createElement(name), { textContent: text });
  const image = hint.dataset.image;
  hint.replaceChildren("Boots a pylon on ", tag("b", node), ...(image === "" ? [] : [" from image ", tag("code", image)]), " and checks out ", tag("code", branch), ".");
}

const projectRadios = () => [...document.querySelectorAll("#start input[name=project]")];

/** Picks the project, or says it is not offered and picks none, so the thread cannot start on another repo. */
function selectProject(project) {
  const radio = projectRadios().find((r) => r.value === project);
  for (const r of projectRadios()) r.checked = r === radio;
  showError("start-error", radio === undefined ? new Error(`Project ${project} is not offered here yet. Reload the page to see it.`) : null);
  updateStartHint();
}

async function openStart(project, title) {
  if (dialog === null) return;
  setOpen(null);
  if (!dialog.open) dialog.showModal();
  if (project) {
    // The dialog's projects refresh with the page, so a project added since the last poll may be on its way.
    if (!projectRadios().some((r) => r.value === project)) await refreshAfter();
    selectProject(project);
  }
  const input = document.getElementById("start-title");
  if (title && input !== null) input.value = title;
  updateStartHint();
}
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-start]") : null;
  if (link === null || dialog === null) return;
  event.preventDefault();
  void openStart(link.dataset.start, link.dataset.title);
});
dialog?.addEventListener("close", () => {
  if (location.pathname === "/threads/new") history.replaceState(null, "", "/");
});
document.addEventListener("input", (event) => {
  if (event.target instanceof Element && event.target.closest("#start") !== null) updateStartHint();
});

/** What the reader entered in the start dialog, which a refresh of its projects and nodes must keep. */
function startState() {
  const form = document.getElementById("start");
  if (form === null) return null;
  const project = form.querySelector("input[name=project]:checked")?.value ?? null;
  return { form, project, title: form.elements.title.value, node: form.elements.node.value, branch: form.elements.branch.value };
}
function restoreStart(saved) {
  const form = document.getElementById("start");
  if (saved === null || form === null || form === saved.form) return;
  form.elements.title.value = saved.title;
  form.elements.branch.value = saved.branch;
  if ([...form.elements.node.options].some((o) => o.value === saved.node)) form.elements.node.value = saved.node;
  if (saved.project !== null) selectProject(saved.project);
  form.querySelector("button[type=submit]").disabled = starting;
}

// ⌘↵ submits as well as the button, so a second press while the first is in flight must not start a second thread.
let starting = false;
document.addEventListener("submit", async (event) => {
  if (!event.target.matches("#start")) return;
  event.preventDefault();
  if (starting) return;
  starting = true;
  const form = event.target;
  // Empty optional fields mean the project's defaults, which the API applies when the field is absent.
  const body = Object.fromEntries([...new FormData(form)].filter(([, value]) => value !== ""));
  form.querySelector("button[type=submit]").disabled = true;
  try {
    const thread = await api("POST", "/v1/threads", body);
    location.assign(`/threads/${thread.id}`);
  } catch (err) {
    starting = false;
    showError("start-error", err);
    const submit = document.querySelector("#start button[type=submit]");
    if (submit !== null) submit.disabled = false;
  }
});

function openProject() {
  if (projectDialog === null) return;
  setOpen(null);
  // Offered from the start dialog when there is no project to start a thread on.
  if (dialog?.open) dialog.close();
  if (!projectDialog.open) projectDialog.showModal();
}
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-new-project]") : null;
  if (link === null || projectDialog === null) return;
  event.preventDefault();
  openProject();
});
projectDialog?.addEventListener("close", () => {
  if (location.pathname === "/projects/new") history.replaceState(null, "", "/");
});

// The project `nexus project add` sends without flags: the dialog's fields and the resources the form names. Once
// added, the start dialog opens on it, as the dashboard's next step for a project is its first thread.
let adding = false;
document.addEventListener("submit", async (event) => {
  // Not event.target.id: a form's field named "id" shadows its id.
  if (!event.target.matches("#project")) return;
  event.preventDefault();
  if (adding) return;
  adding = true;
  const form = event.target;
  const field = (name) => form.elements[name].value.trim();
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const project = await api("POST", "/v1/projects", {
      id: field("id"), repoUrl: field("repoUrl"), defaultBranch: field("defaultBranch"), defaultNode: field("defaultNode"),
      resources: JSON.parse(form.dataset.resources), allowedHosts: [], secrets: [], logins: [], preSetup: null,
    });
    form.reset();
    showError("project-error", null);
    projectDialog.close();
    await openStart(project.id);
  } catch (err) {
    showError("project-error", err);
  } finally {
    adding = false;
    submit.disabled = false;
  }
});

const typing = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el?.isContentEditable === true;
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    const form = event.target instanceof Element ? event.target.closest("#prompt, #start, #project") : null;
    if (form === null) return;
    event.preventDefault();
    form.requestSubmit();
  } else if (event.key === "Escape" && document.body.dataset.open !== undefined) {
    setOpen(null);
  } else if (event.key === "n" && !event.metaKey && !event.ctrlKey && !event.altKey && !typing(event.target) && dialog !== null && document.querySelector("dialog[open]") === null) {
    // Browsers keep ⌘N for a new window, so the shortcut is the bare key.
    event.preventDefault();
    openStart(null);
  }
});

// A filter shows the archived threads it matches, and folds them away again once it is cleared.
const openedByFilter = new Set();
function applyFilter() {
  const query = filter?.value.trim().toLowerCase() ?? "";
  for (const group of document.querySelectorAll("#side-threads .group")) {
    for (const row of group.querySelectorAll("li")) {
      row.hidden = query !== "" && !row.querySelector(".row-title").textContent.toLowerCase().includes(query);
    }
    for (const fold of group.querySelectorAll("details.archived")) {
      const matched = query !== "" && fold.querySelector("li:not([hidden])") !== null;
      if (matched && !fold.open) { fold.open = true; openedByFilter.add(fold.id); }
      if (!matched && openedByFilter.delete(fold.id)) fold.open = false;
    }
    group.hidden = query !== "" && group.querySelector("li:not([hidden])") === null;
  }
}
filter?.addEventListener("input", applyFilter);

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-copy]") : null;
  if (button === null) return;
  const range = document.createRange();
  range.selectNodeContents(document.getElementById(button.dataset.copy));
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  // navigator.clipboard needs a secure context too. A failed copy leaves the text selected to copy by hand.
  const copied = document.execCommand("copy");
  if (copied) selection.removeAllRanges();
  button.textContent = copied ? "Copied" : "Selected";
  setTimeout(() => { button.textContent = "Copy"; }, 1500);
});

if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
document.querySelector(".row.active")?.scrollIntoView({ block: "nearest" });
follow(document.getElementById("convo")?.dataset.stream);
if (dialog?.dataset.autoopen !== undefined) void openStart(null);
if (projectDialog?.dataset.autoopen !== undefined) openProject();
setInterval(tick, 1000);
if (pollMs > 0) {
  setInterval(() => { if (document.visibilityState === "visible") void refreshNow(); }, pollMs);
}
recordVisit();
document.addEventListener("visibilitychange", () => {
  // The first frame on return is the region whole.
  if (document.visibilityState !== "visible") {
    stream?.close();
    return;
  }
  recordVisit();
  follow(document.getElementById("convo")?.dataset.stream);
  if (pollMs > 0) void refreshNow();
});
