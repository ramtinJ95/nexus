// The dashboard client. Pages are rendered on the server. This file sends actions, messages and new projects
// to the JSON API, records a visit as human activity, opens the start and new-project dialogs and the phone's panels,
// and polls the page to swap in each `data-live` region that changed. A thread page also follows its stream, which
// sends the conversation region as the run streams, and reads its checkout's changes into the inspector, opening
// each changed file's diff as a tab beside the conversation.
import { coordinator, notificationChannel, needSelectors, noticeText, noticeUrl, owedSeen } from "./notifications.js";
import { agoText } from "./ago.js";
import { atEnd, endFollower } from "./scroll.js";
import { afterSend, emptyReview, formatReview, kinds, linesLabel, noteOn, place, rangeOf, readReview, rowsOf } from "./review.js";

const main = document.querySelector("main");
const pollMs = Number(main?.dataset.pollMs);
const scroller = document.getElementById("scroll");
const end = scroller === null ? null : endFollower(scroller, (resized) => new ResizeObserver(resized).observe(scroller));
const dialog = document.getElementById("start-dialog");
const projectDialog = document.getElementById("project-dialog");
const filter = document.getElementById("filter");

/** Sends JSON as the API requires, and throws the API's error message. */
async function api(method, path, body, signal) {
  const res = await fetch(path, {
    method, signal,
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
// After t3code's formatElapsedSeconds. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
function clock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
function tick() {
  for (const time of document.querySelectorAll("time[data-since]")) time.textContent = clock(Date.now() - Number(time.dataset.since));
  for (const time of document.querySelectorAll("time[data-ago]")) time.textContent = agoText(Date.parse(time.dateTime), Date.now());
}

// What the server last sent for each region. Comparing against it rather than the live DOM means a tool the
// reader opened or the ticking run clock is not a change, so an unchanged region is never swapped.
const comparable = (html) => html.replace(/(<time data-since="\d+">)[^<]*/g, "$1");
const served = new Map([...document.querySelectorAll("[data-live]")].map((el) => [el.id, comparable(el.innerHTML)]));
// The folds the reader opened or closed. The rest follow the server, so a fold that opened for a running step
// closes once the step is done.
const toggled = new Map();
// The projects the reader folded in the sidebar stay folded on every page.
const foldedKey = "nexus.folded";
const folded = new Set(JSON.parse(localStorage.getItem(foldedKey) ?? "[]"));
for (const id of folded) toggled.set(id, false);
document.addEventListener("click", (event) => {
  const details = event.target instanceof Element ? event.target.closest("summary")?.parentElement : null;
  if (!(details instanceof HTMLDetailsElement) || details.id === "") return;
  toggled.set(details.id, !details.open);
  if (!details.classList.contains("group")) return;
  if (details.open) folded.add(details.id);
  else folded.delete(details.id);
  localStorage.setItem(foldedKey, JSON.stringify([...folded]));
});

/**
 * The conversation only grows, so its n-th block is the same block after a swap. Keeping the first visible
 * block where it was holds the reader's place while a fold above it opens or closes.
 */
function anchor() {
  if (end === null) return () => {};
  if (end.following) return end.settle;
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
  const asks = askDrafts();
  const restoreScroll = anchor();
  for (const [el, html, key] of changed) {
    el.innerHTML = html;
    served.set(el.id, key);
  }
  restoreAskDrafts(asks);
  const prompt = document.getElementById("prompt-text");
  if (saved !== null && prompt !== null && prompt !== draft) {
    prompt.value = saved.value;
    prompt.setSelectionRange(saved.start, saved.end);
  }
  restoreStart(start);
  for (const d of document.querySelectorAll("details[id]")) if (toggled.has(d.id)) d.open = toggled.get(d.id);
  for (const send of document.querySelectorAll("#prompt button[type=submit]")) send.disabled = outgoing?.inFlight === true;
  if (focused !== null) document.querySelector(focused)?.focus({ preventScroll: true });
  restoreScroll();
  applyFilter();
  tick();
  noticeFacts();
  terminalFollows();
}

// While the stream is open it alone writes the conversation, so a poll that started before a frame cannot put
// older text back. Its frames come in order: the region whole, then the parts that grew since.
let stream = null;
let frames = 0;
// Which Claude view the stream last rendered, which a poll of a streaming page names instead of rendering it.
let shows = null;
const streaming = () => stream?.readyState === EventSource.OPEN;
function follow(url) {
  // A hidden page keeps none of the control plane's few streams, even when a refresh it began finishes later.
  if (url === undefined || document.visibilityState !== "visible" || (stream !== null && stream.readyState !== EventSource.CLOSED)) return;
  // EventSource reconnects by itself after a dropped connection. A refused one is closed for good, so the next
  // poll opens another.
  stream = new EventSource(url);
  shows = null;
  stream.addEventListener("message", (event) => {
    frames += 1;
    const frame = JSON.parse(event.data);
    const convo = document.getElementById("convo");
    if (convo === null) return;
    if (frame.convo !== undefined) {
      // Parsed and serialized as the poll's regions are, so an unchanged region compares equal.
      const fresh = document.createElement("template");
      fresh.innerHTML = frame.convo;
      swap([[convo, fresh.innerHTML]]);
    } else if (frame.grow !== undefined) {
      const slots = convo.querySelectorAll("[data-grow]");
      const restoreScroll = anchor();
      for (const [i, inside] of frame.grow) {
        const slot = slots[i];
        if (slot === undefined) continue;
        // A running tool's output scrolls by itself. A reader at its end follows it, as at the conversation's end.
        const stick = atEnd(slot);
        slot.innerHTML = inside;
        if (stick) slot.scrollTop = slot.scrollHeight;
      }
      restoreScroll();
    }
    if (frame.shows !== undefined) shows = frame.shows;
  });
}

let refreshing = null;
async function refresh() {
  const state = document.getElementById("refresh-state");
  try {
    const seen = frames;
    const url = new URL(location.href);
    if (streaming()) url.searchParams.set("streaming", "1");
    // A link that stalls mid-body would otherwise hold the refresh lock forever.
    const res = await fetch(url, { headers: { accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(pollMs * 2) });
    if (!res.ok) throw new Error(`the control plane answered ${res.status}`);
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    // A queued thread that started has a thread page, whose regions the queued page has none of.
    if ((next.getElementById("queued") === null) !== (document.getElementById("queued") === null)) return void location.reload();
    const freshConvo = next.getElementById("convo");
    // A poll of a streaming page names the view it would show rather than rendering it.
    const named = freshConvo?.dataset.shows;
    const followed = streaming() || frames !== seen || named !== undefined;
    swap([...next.querySelectorAll("[data-live]")].filter((fresh) => !(followed && fresh.id === "convo")).map((fresh) => [document.getElementById(fresh.id), fresh.innerHTML]));
    // A stream owns its patch indices. Certify its rendered snapshot without replacing it under those patches.
    if (freshConvo && (named !== undefined ? named === shows : !followed || served.get("convo") === comparable(freshConvo.innerHTML))) {
      document.getElementById("convo").dataset.renderedReplyAt = freshConvo.dataset.renderedReplyAt ?? "";
    }
    follow(next.getElementById("convo")?.dataset.stream);

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

/**
 * Sends a request that needs the pylon running, as the CLI's whenRunning does: the first try wakes a paused pylon,
 * and a 409 is tried again once a second for up to 120 s, unless the thread is archived or deleted. `waiting` hears
 * each refusal while it waits.
 */
async function whenRunning(thread, send, waiting = () => {}) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (err.status !== 409 || Date.now() >= deadline) throw err;
      const detail = await api("GET", `/v1/threads/${thread}`);
      if (detail.thread.status === "archived" || detail.thread.status === "deleted") throw err;
      waiting(err, detail);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const actions = {
  archive: (thread) => api("POST", `/v1/threads/${thread}/archive`),
  unarchive: (thread) => api("POST", `/v1/threads/${thread}/unarchive`),
  // A started thread's page has a conversation and an inspector, which the queued page has no regions for.
  "start-queued": async (thread) => {
    await api("POST", `/v1/threads/${thread}/start`);
    location.assign(`/threads/${thread}`);
  },
  delete: (thread) => api("DELETE", `/v1/threads/${thread}`),
  abort: (thread) => api("POST", `/v1/threads/${thread}/abort`),
  retry: (thread) => api("POST", `/v1/threads/${thread}/retry`),
  "retry-pylon": (thread) => api("POST", `/v1/threads/${thread}/pylon/retry`),
  // Publishes the port. The next refresh shows its preview, which links once the node serves it.
  "link-port": (thread, { port }) => api("POST", `/v1/threads/${thread}/previews`, { port: Number(port) }),
  // As `nexus unpreview`.
  unpublish: (thread, { port }) => whenRunning(thread, () => api("DELETE", `/v1/threads/${thread}/previews/${port}`, {})),
  // As `nexus land`, for the commit the confirmation named, waiving the holds the card names the person may waive. The
  // page then shows the landing's steps as the review moves through them.
  land: (thread, { head, holds }) => api("POST", `/v1/threads/${thread}/land`, holds === undefined ? { head } : { head, waive: JSON.parse(holds) }),
  "approve-item": (_, { item }) => api("POST", `/v1/items/${encodeURIComponent(item)}/approve`, {}),
  "cancel-item": (_, { item }) => api("POST", `/v1/items/${encodeURIComponent(item)}/cancel`, {}),
  answer: (_, { question, option }) => api("POST", `/v1/questions/${encodeURIComponent(question)}/answer`, { option }),
};

document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (button === null) return;
  const { action, thread } = button.dataset;
  if (button.dataset.confirm !== undefined && !confirm(button.dataset.confirm)) return;
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

function showStatus(text) {
  const el = document.getElementById("action-status");
  if (el === null) return;
  el.textContent = text ?? "";
  el.hidden = text === null;
}

// The last message sent. Sending the same text again after a failure reuses its request ID, so a send whose
// reply was lost is not posted twice. One send at a time, so a second one cannot take the first one's ID.
let outgoing = null;
document.addEventListener("submit", async (event) => {
  if (!event.target.matches("#prompt")) return;
  event.preventDefault();
  if (outgoing?.inFlight) return;
  const form = event.target;
  const thread = form.dataset.thread;
  const text = form.elements.text.value;
  // The notes as they are now, so an edit saved while the send is out is not taken as sent.
  const composed = { composed: review.composed, notes: review.notes.filter((n) => review.composed?.ids.includes(n.id)) };
  // The button pressed, or the one its shortcut stands for, says whether the message steers the run or follows it.
  const mode = event.submitter?.value ?? "followUp";
  if (outgoing?.text !== text) outgoing = { text, requestId: newRequestId() };
  outgoing.inFlight = true;
  for (const send of form.querySelectorAll("button[type=submit]")) send.disabled = true;
  const { requestId } = outgoing;
  const post = () => api("POST", `/v1/threads/${thread}/messages`, { text, requestId, mode });
  try {
    // A Claude worker's message is typed in its pylon, so it waits for a paused pylon to wake, under the same request
    // ID, which the API types once however often it is asked.
    await (form.dataset.claude === undefined ? post() : whenRunning(thread, post, (err, detail) => {
      showStatus(detail.pylon.actualState === "running" ? `Not sent yet, trying again: ${err.message}` : "Waking the pylon. The message sends once Claude runs.");
    }));
    showStatus(null);
    outgoing = null;
    reviewSent(composed, text);
    // The poll may have swapped in a new prompt box meanwhile, or none if the thread was archived. Text typed
    // since the send is the next message, so it stays.
    const prompt = document.getElementById("prompt-text");
    if (prompt?.value === text) prompt.value = "";
    showError("action-error", null);
    await refreshAfter();
    end?.toEnd();
  } catch (err) {
    showStatus(null);
    outgoing.inFlight = false;
    // A Claude worker's send that failed partway may have typed the message, so the API refuses its request ID again.
    // The reader checks the conversation, and sending again is a new message. A 503 may still be typed, and its
    // reason says so: sending the same text again keeps the request ID, which answers what became of it.
    if (err.status === 422) outgoing = null;
    showError("action-error", err.status === 422 || err.status === 503 ? err : new Error(`The message was not sent: ${err.message}`));
  } finally {
    for (const send of document.querySelectorAll("#prompt button[type=submit]")) send.disabled = false;
  }
});

/** What the person has filled in on each open AskUserQuestion form, by its question, so a swap of its region keeps it. */
function askDrafts() {
  return new Map([...document.querySelectorAll("form.ask")].map((form) => [form.dataset.question, [...form.elements].filter((f) => f.name !== "").map((f) => ({ name: f.name, value: f.value, checked: f.checked }))]));
}
function restoreAskDrafts(drafts) {
  for (const form of document.querySelectorAll("form.ask")) {
    const draft = drafts.get(form.dataset.question) ?? [];
    for (const field of [...form.elements].filter((f) => f.name !== "")) {
      const choosable = field.type === "radio" || field.type === "checkbox";
      const was = draft.find((d) => d.name === field.name && (!choosable || d.value === field.value));
      if (was === undefined) continue;
      if (choosable) field.checked = was.checked;
      else field.value = was.value;
    }
  }
}

/**
 * An AskUserQuestion form's choices, one per question as the answer route takes them: the options picked and the
 * person's own answer, which on a single-select question counts only while its radio is picked, and the notes.
 */
function askChoices(form) {
  return [...form.querySelectorAll("fieldset.ask-q")].map((question, i) => {
    const picked = [...question.querySelectorAll(`input[name="picked-${i}"]:checked`)].map((input) => input.value);
    const own = form.elements[`own-${i}`].value.trim();
    const notes = form.elements[`notes-${i}`].value.trim();
    const ownCounts = own !== "" && (question.dataset.multi === "true" || picked.includes(""));
    return { picked: picked.filter((label) => label !== ""), ...(ownCounts ? { own } : {}), ...(notes === "" ? {} : { notes }) };
  });
}

// Typing an answer of one's own on a single-select question picks it.
document.addEventListener("input", (event) => {
  const own = event.target instanceof Element ? event.target.closest(".ask-own input[type=text]") : null;
  const radio = own?.parentElement.querySelector("input[type=radio]");
  if (radio != null && own.value.trim() !== "") radio.checked = true;
});

document.addEventListener("submit", async (event) => {
  if (!event.target.matches("form.ask")) return;
  event.preventDefault();
  const form = event.target;
  const choices = askChoices(form);
  const headers = [...form.querySelectorAll("fieldset.ask-q")].map((q) => q.dataset.header);
  const missing = choices.findIndex((c) => c.picked.length === 0 && c.own === undefined);
  if (missing !== -1) return void showError("action-error", new Error(`Answer "${headers[missing]}" first: pick an option or write your own answer.`));
  const summary = choices.map((c, i) => `${headers[i]}: ${[...c.picked, ...(c.own === undefined ? [] : [c.own])].join(", ")}`).join("; ");
  if (!confirm(`Answer Claude "${summary}"? The answer cannot be changed.`)) return;
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await api("POST", `/v1/questions/${encodeURIComponent(form.dataset.question)}/answer`, { choices });
    showError("action-error", null);
    await refreshAfter();
  } catch (err) {
    showError("action-error", err);
    submit.disabled = false;
    // An ask nobody waits for any more is withdrawn, so the page drops its form.
    if (err.status === 409) await refreshAfter();
  }
});

/** The phone's thread list, inspector or thread actions, one at a time. */
function setOpen(panel) {
  if (panel === null) delete document.body.dataset.open;
  else document.body.dataset.open = panel;
  // The phone's thread list is hidden until it opens, so the open thread's row is brought into view then.
  if (panel === "side") document.querySelector(".row.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const opener = target?.closest("[data-open]");
  if (opener !== null && opener !== undefined) {
    setOpen(document.body.dataset.open === opener.dataset.open ? null : opener.dataset.open);
    if (opener.dataset.pane !== undefined) pickPane(opener.dataset.pane);
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
  form.elements.cpus.placeholder = project.dataset.cpus;
  form.elements.memoryGiB.placeholder = project.dataset.memoryGib;
  form.elements.diskGiB.placeholder = project.dataset.diskGib;
  const hint = document.getElementById("start-hint");
  const tag = (name, text) => Object.assign(document.createElement(name), { textContent: text });
  const image = hint.dataset.image;
  const repo = project.dataset.scratch === undefined ? " and checks out " : " and starts an empty repository on ";
  hint.replaceChildren("Boots a pylon on ", node === "auto" ? "the node with the most room left" : tag("b", node), ...(image === "" ? [] : [" from image ", tag("code", image)]), repo, tag("code", branch), ".");
}

/**
 * Shows the fields of the worker picked and disables the others', so the form sends none of them. A Claude worker's
 * title is optional, as it defaults to the prompt's first line.
 */
function syncWorker(form) {
  const claude = form.elements.worker.value === "claude";
  form.querySelector("#start-claude-fields").hidden = !claude;
  form.querySelector("#start-harness-fields").hidden = claude;
  form.elements.claude.disabled = !claude;
  form.elements.model.disabled = !claude;
  form.elements.planning.disabled = claude;
  form.elements.title.required = !claude;
  form.elements.title.placeholder = claude ? "The prompt's first line" : "What should this thread do?";
  form.querySelector("#start-title-label").textContent = claude ? "Title (optional)" : "Title";
}
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === "worker" && event.target.form?.matches("#start")) syncWorker(event.target.form);
});

/** As the CLI's titleOf: the first line that is not blank, cut to 80 characters. */
function titleOf(prompt) {
  const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? prompt;
  return line.length <= 80 ? line : `${line.slice(0, 80)}...`;
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
  return { form, project, worker: form.elements.worker.value, title: form.elements.title.value, claude: form.elements.claude.value, model: form.elements.model.value, planning: form.elements.planning.checked, node: form.elements.node.value, branch: form.elements.branch.value,
    cpus: form.elements.cpus.value, memoryGiB: form.elements.memoryGiB.value, diskGiB: form.elements.diskGiB.value };
}
function restoreStart(saved) {
  const form = document.getElementById("start");
  if (saved === null || form === null || form === saved.form) return;
  for (const radio of form.querySelectorAll("input[name=worker]")) radio.checked = radio.value === saved.worker;
  syncWorker(form);
  form.elements.title.value = saved.title;
  form.elements.claude.value = saved.claude;
  form.elements.model.value = saved.model;
  form.elements.planning.checked = saved.planning;
  form.elements.branch.value = saved.branch;
  for (const field of ["cpus", "memoryGiB", "diskGiB"]) form.elements[field].value = saved[field];
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
  // Empty optional fields mean the project's defaults, which the API applies when the field is absent. The size
  // fields go in `resources`, as the API takes them. The worker picked shows in which fields are sent.
  const { cpus, memoryGiB, diskGiB, ...body } = Object.fromEntries([...new FormData(form)].filter(([key, value]) => value !== "" && key !== "worker"));
  const resources = Object.fromEntries(Object.entries({ cpus, memoryGiB, diskGiB }).flatMap(([key, value]) => value === undefined ? [] : [[key, Number(value)]]));
  if (Object.keys(resources).length > 0) body.resources = resources;
  if (body.claude !== undefined && body.title === undefined) body.title = titleOf(body.claude);
  if (body.planning !== undefined) body.planning = true;
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

/** A scratch project has no URL to ask for, and its branch is the empty repository's first. */
function syncRepoKind(form) {
  const scratch = form.elements.repoKind.value === "scratch";
  const url = form.elements.repoUrl;
  url.disabled = scratch;
  url.hidden = scratch;
  form.querySelector("label[for=project-repo]").hidden = scratch;
  form.querySelector("label[for=project-branch]").textContent = scratch ? "Initial branch" : "Branch";
}
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === "repoKind" && event.target.form?.matches("#project")) syncRepoKind(event.target.form);
});

// The project `nexus project add` sends: the dialog's fields, the resources the form names, and the GitHub grant
// when asked for. Once added, the start dialog opens on it, as the dashboard's next step for a project is its first thread.
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
      id: field("id"), repoUrl: form.elements.repoKind.value === "scratch" ? null : field("repoUrl"), defaultBranch: field("defaultBranch"), defaultNode: field("defaultNode"),
      resources: JSON.parse(form.dataset.resources), allowedHosts: [], secrets: form.elements.github.checked ? [JSON.parse(form.dataset.githubGrant)] : [],
      logins: [], preSetup: null,
    });
    form.reset();
    syncRepoKind(form);
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
    form.requestSubmit(form.querySelector("#send"));
  } else if (event.key === "Enter" && event.altKey && event.target instanceof Element && event.target.closest("#prompt") !== null) {
    event.preventDefault();
    const queue = document.getElementById("queue");
    if (queue !== null) queue.form.requestSubmit(queue);
  } else if (event.key === "Escape" && document.body.dataset.open !== undefined) {
    setOpen(null);
  } else if (event.key === "n" && !event.metaKey && !event.ctrlKey && !event.altKey && !typing(event.target) && dialog !== null && document.querySelector("dialog[open]") === null) {
    // Browsers keep ⌘N for a new window, so the shortcut is the bare key.
    event.preventDefault();
    openStart(null);
  }
});

// A filter shows the threads it matches in folded projects and archived folds, and folds them away again once it
// is cleared.
const openedByFilter = new Set();
function applyFilter() {
  const query = filter?.value.trim().toLowerCase() ?? "";
  for (const group of document.querySelectorAll("#side-threads .group")) {
    for (const row of group.querySelectorAll("li")) {
      row.hidden = query !== "" && !row.querySelector(".row-title").textContent.toLowerCase().includes(query);
    }
    for (const fold of [group, ...group.querySelectorAll("details.archived")]) {
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

// The inspector's tab the reader picked last, on every thread page.
const paneKey = "nexus.pane";
function pickPane(pane) {
  const radio = document.querySelector(`.seg-bar input[value="${CSS.escape(pane)}"]`);
  if (radio === null) return;
  radio.checked = true;
  localStorage.setItem(paneKey, pane);
}
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.matches(".seg-bar input")) localStorage.setItem(paneKey, event.target.value);
});

/** Markup built from the pylon's checkout. Its paths and diffs are the guest's, so they only ever go in as text. */
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...present(children));
  return node;
}
/** The children that are there, so a child given as `cond && el(...)` is left out rather than written as "false". */
const present = (children) => children.filter((c) => c !== null && c !== false && c !== undefined);
/**
 * An image of the conversation or a diff that does not load becomes a note naming it. It stays, hidden, to load again
 * once the pylon runs, since a visit that wakes the pylon asks for its images before it runs.
 */
function shotGone(img) {
  const shot = img.closest(".shot");
  if (shot.hidden) return;
  shot.hidden = true;
  shot.after(el("p", { className: "shot-gone", textContent: `${img.alt} can't be shown now: its pylon is paused, or the file is gone` }));
}
/**
 * Each image that failed loads again once while the pylon runs, even one whose failure came after the poll that saw
 * the pylon start. A pause lets it try once more after the next start.
 */
function retryShots(running) {
  if (!running) {
    for (const shot of document.querySelectorAll(".shot[data-retried]")) delete shot.dataset.retried;
    return;
  }
  for (const shot of document.querySelectorAll(".shot[hidden]:not([data-retried])")) {
    shot.dataset.retried = "";
    if (shot.nextElementSibling?.matches(".shot-gone")) shot.nextElementSibling.remove();
    shot.hidden = false;
    const img = shot.querySelector("img");
    img.src = img.getAttribute("src");
  }
}
document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement && event.target.matches(".shot img")) shotGone(event.target);
}, true);
// An image that failed before this script ran sent its error to no listener.
for (const img of document.querySelectorAll(".shot img")) if (img.complete && img.currentSrc !== "" && img.naturalWidth === 0) shotGone(img);

// A template's icons are in its content, outside the document.
const iconOf = (name) => document.getElementById("icons").content.querySelector(`.i-${name}`).cloneNode(true);
const statusLetter = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechange: "T" };
const badge = (status) => el("span", { className: `badge badge-${status}`, title: status, textContent: statusLetter[status] });
/** +12 −3, or nothing for a binary file. */
const counts = (additions, deletions) => additions === null ? el("span", { className: "dim small", textContent: "binary" })
  : el("span", { className: "lines" }, el("span", { className: "add", textContent: `+${additions}` }), " ", el("span", { className: "del", textContent: `−${deletions}` }));

// A thread page's checkout: the changes in the inspector, and the diff tabs beside the conversation. Each read
// reaches into the pylon and wakes it if it sleeps, so the changes are read when the pylon runs and a turn of its
// agent ends, when the reader asks, and never on a paused pylon unless the reader says to wake it.
const changesPane = document.getElementById("pane-changes");
const thread = changesPane?.dataset.thread;
const baseKey = "nexus.base";
const checkout = {
  base: ["head", "turn"].includes(localStorage.getItem(baseKey)) ? localStorage.getItem(baseKey) : "start",
  /** The last reply, kept so a fold the reader closed and the open tabs survive a read. */
  changes: null,
  /** Whether the reader asked to wake a paused pylon to read it, so the read happens once it runs. */
  wanted: false,
  /** Tree folders the reader closed. */
  closed: new Set(),
  facts: null,
};
const factsNow = () => {
  const span = document.querySelector("#facts span");
  return span === null ? null : { pylon: span.dataset.pylon, turn: span.dataset.turn === "true", agentAt: span.dataset.agentAt, status: span.dataset.threadStatus };
};
const baseLabel = () => checkout.base === "turn" ? "Since the latest turn began" : checkout.base === "head" ? "Since the last commit" : "Since the pylon booted";

function showChanges(...nodes) {
  document.getElementById("changes-body")?.replaceChildren(...present(nodes));
}

/** An archived or deleted thread, whose pylon stays paused, so its checkout cannot be read. */
const threadClosed = (facts) => facts.status !== "active" && facts.status !== "idle";

/** Why the changes cannot be read now, with a button to wake the pylon when that is what it takes. */
function changesUnreadable(facts) {
  // A closed thread keeps no reply, so nothing shows its stale tree again and an unarchive's start reads anew.
  if (threadClosed(facts)) checkout.changes = null;
  if (facts.status === "deleted") return showChanges(el("p", { className: "empty", textContent: "The thread is deleted, so its checkout is gone." }));
  if (facts.status === "archived") return showChanges(el("p", { className: "empty", textContent: "An archived thread's pylon stays paused, so its changes can't be read. Unarchive the thread to read them." }));
  if (checkout.wanted) return showChanges(el("p", { className: "empty", textContent: "Waking the pylon. Its changes show once it runs." }));
  const wake = el("button", { type: "button", className: "btn btn-xs", textContent: "Wake and read" });
  wake.addEventListener("click", () => { void readChanges(true); });
  showChanges(el("p", { className: "empty", textContent: `The pylon is ${facts.pylon}. Reading its changes wakes it.` }), wake);
}

const canRead = (facts) => facts.pylon === "running" && !threadClosed(facts);

let reading = null;
/**
 * Reads the changes into the inspector. A paused pylon is read only when the reader asked to wake it, and then
 * again once the page shows it running, as the first read only wakes it.
 */
async function readChanges(wake = false) {
  const facts = factsNow();
  if (thread === undefined || facts === null) return;
  if (threadClosed(facts)) return changesUnreadable(facts);
  if (facts.pylon !== "running") {
    if (!wake && !checkout.wanted) return changesUnreadable(facts);
    checkout.wanted = true;
  }
  if (reading !== null) return reading;
  const base = checkout.base;
  if (checkout.changes === null) showChanges(el("p", { className: "empty", textContent: facts.pylon === "running" ? "Reading the changes…" : "Waking the pylon…" }));
  reading = (async () => {
    try {
      const changes = await api("GET", `/v1/threads/${thread}/changes?base=${base}`);
      checkout.wanted = false;
      if (base !== checkout.base) return;
      // The thread closed while the read was out, so the reply is stale.
      if (threadClosed(factsNow())) return changesUnreadable(factsNow());
      checkout.changes = changes;
      // An open tab takes the file's new counts, and keeps its place when the file is no longer changed.
      openTabs = openTabs.map((tab) => changes.files.find((f) => f.path === tab.path) ?? tab);
      renderChanges();
      renderTabs();
      if (typeof activeTab === "string") void readDiff(activeTab);
    } catch (err) {
      if (base !== checkout.base) return;
      // The thread closed while the read was out, so the closing, not the failure it caused, is what to show.
      if (threadClosed(factsNow())) return changesUnreadable(factsNow());
      // A pylon that is not running answers 409 while the read wakes it, even one the page still shows running, as
      // the page's state lags the node's. So the read happens again once the page shows it running.
      if (err.status === 409) {
        checkout.wanted = true;
        return changesUnreadable(factsNow());
      }
      // Any other failure is the answer, so no read waits on a wake any more.
      checkout.wanted = false;
      checkout.changes = null;
      showChanges(el("p", { className: "error", textContent: err.message }));
    } finally {
      reading = null;
    }
  })();
  await reading;
  // The reader switched the base while the read was out, so the switch's read runs now.
  if (base !== checkout.base) return readChanges();
}

/** A tree of the changed files, with each folder that holds only one folder merged into it, as src/checkout. */
function treeOf(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [] });
      dir = dir.dirs.get(part);
    }
    dir.files.push({ name: parts.at(-1), file });
  }
  const merged = (name, dir) => {
    while (dir.files.length === 0 && dir.dirs.size === 1) {
      const [[child, inner]] = dir.dirs;
      name = `${name}/${child}`;
      dir = inner;
    }
    return [name, dir];
  };
  return { root, merged };
}

/** How many of the review's notes are on a file, beside its name in the tree. */
function noteCount(path) {
  const count = review.notes.filter((n) => n.path === path).length;
  return count > 0 && el("span", { className: "note-count", title: `${count} ${count === 1 ? "note" : "notes"} in the review`, textContent: String(count) });
}

function renderChanges() {
  const { files, truncated, base } = checkout.changes;
  const added = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deleted = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  // The base is the empty tree before a checkout's first commit, and at the start of a scratch project's pylon.
  const commit = base.commit === null ? (checkout.base === "head" ? "no commit yet" : "an empty repository") : base.commit.slice(0, 7);
  document.getElementById("changes-base").textContent = `${baseLabel()}, ${commit}`;
  if (files.length === 0) {
    return showChanges(el("p", { className: "empty", textContent: checkout.base === "turn" ? "Nothing has changed since the latest turn began." : checkout.base === "head" ? "No uncommitted changes." : "Nothing has changed since the pylon booted." }));
  }
  const { root, merged } = treeOf(files);
  const branch = (dir, path) => {
    const items = [];
    for (const [part, inner] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const [name, deepest] = merged(part, inner);
      const at = path === "" ? name : `${path}/${name}`;
      const fold = el("details", { className: "tree-dir", open: !checkout.closed.has(at) },
        el("summary", {}, iconOf("chevron"), iconOf("folder"), el("span", { className: "tree-name", textContent: name })),
        branch(deepest, at));
      fold.addEventListener("toggle", () => { if (fold.open) checkout.closed.delete(at); else checkout.closed.add(at); });
      items.push(fold);
    }
    for (const { name, file } of dir.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const open = el("button", {
        type: "button", className: `tree-file${activeTab === file.path ? " active" : ""}`,
        title: file.oldPath === null ? file.path : `${file.path}, ${file.status} from ${file.oldPath}`,
      }, badge(file.status), el("span", { className: "tree-name", textContent: name }), noteCount(file.path), counts(file.additions, file.deletions));
      open.dataset.path = file.path;
      open.addEventListener("click", () => openFile(file));
      items.push(open);
    }
    return el("div", { className: "tree-level" }, ...items);
  };
  showChanges(
    el("div", { className: "ch-sum" }, el("span", { textContent: `${files.length} ${files.length === 1 ? "file" : "files"}` }), counts(added, deleted)),
    el("div", { className: "tree" }, branch(root, "")),
    truncated && el("p", { className: "dim small", textContent: `Showing the first ${files.length} files.` }),
  );
}

/**
 * Reads again when the pylon starts running or runs while a read waits on its wake, and when its agent was active
 * since the last look and no turn is running now, so a turn that began and ended between two polls is read too.
 */
function noticeFacts() {
  const before = checkout.facts;
  const now = factsNow();
  checkout.facts = now;
  if (now !== null) retryShots(now.pylon === "running");
  if (now === null || before === null) return;
  const started = now.pylon === "running" && before.pylon !== "running";
  const agentDone = !now.turn && (before.turn || now.agentAt !== before.agentAt);
  // An unarchive can land before the pylon pauses, so no start follows to read again.
  const reopened = threadClosed(before) && !threadClosed(now);
  if ((started && checkout.changes === null) || ((checkout.wanted || agentDone || reopened) && canRead(now))) void readChanges();
  else if (!canRead(now) && (checkout.changes === null || threadClosed(now))) changesUnreadable(now);
}

if (changesPane !== null) {
  const head = document.getElementById("changes-head");
  const turn = document.getElementById("changes-turn");
  turn.checked = checkout.base === "turn";
  head.checked = checkout.base === "head";
  document.getElementById("changes-base").textContent = baseLabel();
  head.addEventListener("change", () => {
    turn.checked = false;
    checkout.base = head.checked ? "head" : "start";
    localStorage.setItem(baseKey, checkout.base);
    checkout.changes = null;
    document.getElementById("changes-base").textContent = baseLabel();
    void readChanges();
  });
  turn.addEventListener("change", () => {
    head.checked = false;
    checkout.base = turn.checked ? "turn" : "start";
    localStorage.setItem(baseKey, checkout.base);
    checkout.changes = null;
    document.getElementById("changes-base").textContent = baseLabel();
    void readChanges();
  });
  document.getElementById("changes-reload").addEventListener("click", () => { void readChanges(true); });
}

// The tabs beside the conversation: the terminal, and one per changed file the reader opened, kept for the tab's
// session. `activeTab` is the open file's path, `terminalTab` for the terminal, or null for the conversation.
const tabsBar = document.getElementById("tabs");
const fileView = document.getElementById("file-view");
const termView = document.getElementById("term-view");
const terminalTab = Symbol("terminal");
const tabsKey = `nexus.tabs.${thread}`;
const maxTabs = 8;
let openTabs = JSON.parse(sessionStorage.getItem(tabsKey) ?? "[]");
let activeTab = null;

function saveTabs() {
  sessionStorage.setItem(tabsKey, JSON.stringify(openTabs));
}

/** Draws the file tabs again, keeping focus on the control that had it, or on the tab that took its place. */
function renderTabs() {
  if (tabsBar === null) return;
  const focused = tabsBar.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
  const convoTab = tabsBar.querySelector('[data-tab="convo"]');
  convoTab.classList.toggle("active", activeTab === null);
  convoTab.setAttribute("aria-selected", String(activeTab === null));
  convoTab.dataset.key = "convo";
  const termTab = tabsBar.querySelector('[data-tab="term"]');
  termTab?.classList.toggle("active", activeTab === terminalTab);
  termTab?.setAttribute("aria-selected", String(activeTab === terminalTab));
  if (termTab !== null) termTab.dataset.key = "term";
  const fileTabs = openTabs.map((file) => {
    const active = activeTab === file.path;
    const pick = el("button", { type: "button", className: "tab-pick", title: file.path }, badge(file.status), el("span", { className: "tab-name", textContent: file.path.split("/").at(-1) }));
    pick.setAttribute("role", "tab");
    pick.setAttribute("aria-selected", String(active));
    pick.setAttribute("aria-controls", "file-view");
    pick.dataset.key = `pick:${file.path}`;
    pick.addEventListener("click", () => showTab(file.path));
    const close = el("button", { type: "button", className: "tab-close", textContent: "×", title: "Close" });
    close.setAttribute("aria-label", `Close ${file.path}`);
    close.dataset.key = `close:${file.path}`;
    close.addEventListener("click", () => closeTab(file.path));
    return el("div", { className: `tab tab-file${active ? " active" : ""}` }, pick, close);
  });
  tabsBar.replaceChildren(...[convoTab, termTab].filter((tab) => tab !== null), ...fileTabs);
  tabsBar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  for (const button of document.querySelectorAll(".tree-file")) button.classList.toggle("active", button.dataset.path === activeTab);
  if (focused === undefined) return;
  const controls = [...tabsBar.querySelectorAll("[data-key]")];
  const replacement = activeTab === null ? "convo" : activeTab === terminalTab ? "term" : `pick:${activeTab}`;
  (controls.find((b) => b.dataset.key === focused) ?? controls.find((b) => b.dataset.key === replacement))?.focus();
}

function showTab(path) {
  activeTab = path;
  main.dataset.view = path === null ? "convo" : path === terminalTab ? "term" : "file";
  scroller.hidden = path !== null;
  fileView.hidden = typeof path !== "string";
  if (termView !== null) termView.hidden = path !== terminalTab;
  if (path === null) end.settle();
  renderTabs();
  if (typeof path === "string") void readDiff(path);
  if (path === terminalTab) void showTerminal();
}

function openFile(file) {
  const at = openTabs.findIndex((f) => f.path === file.path);
  if (at === -1) openTabs = [...openTabs, file].slice(-maxTabs);
  else openTabs[at] = file;
  saveTabs();
  showTab(file.path);
}

function closeTab(path) {
  openTabs = openTabs.filter((f) => f.path !== path);
  saveTabs();
  if (activeTab === path) showTab(openTabs.at(-1)?.path ?? null);
  else renderTabs();
}

tabsBar?.querySelector('[data-tab="convo"]').addEventListener("click", () => showTab(null));
tabsBar?.querySelector('[data-tab="term"]')?.addEventListener("click", () => showTab(terminalTab));
document.addEventListener("click", (event) => {
  if (termView !== null && event.target instanceof Element && event.target.closest("[data-terminal]") !== null) showTab(terminalTab);
});

/** The Terminal tab shows while the thread is open, so an archive hides it and an unarchive brings it back. */
function terminalFollows() {
  const tab = tabsBar?.querySelector('[data-tab="term"]');
  const facts = factsNow();
  if (tab == null || facts === null) return;
  tab.hidden = threadClosed(facts);
  if (tab.hidden && activeTab === terminalTab) showTab(null);
}

// The terminal tab attaches on its first show, as `nexus attach` does, and stays attached while the reader looks at
// other tabs, so it holds the pylon awake as an attached terminal does until it is detached or the page closes. A
// terminal that ends on its own keeps its last screen until the next attach replaces it.
let terminal = null;
let lastTerminal = null;
async function showTerminal() {
  if (terminal !== null) return terminal.then((t) => t?.focus());
  const status = document.getElementById("term-status");
  const again = document.getElementById("term-again");
  const detach = document.getElementById("term-detach");
  const shown = ({ text, over }) => {
    status.textContent = text ?? "";
    again.hidden = !over;
    detach.hidden = over;
    if (over) terminal = null;
  };
  shown({ text: "Attaching…", over: false });
  terminal = import("./term-view.js").then(({ openTerminal }) => {
    lastTerminal?.close();
    document.getElementById("term-host").replaceChildren();
    lastTerminal = openTerminal(document.getElementById("term-host"), thread, shown);
    return lastTerminal;
  }).catch((err) => {
    shown({ text: `The terminal did not load: ${err.message}`, over: true });
    return null;
  });
  const opened = await terminal;
  detach.onclick = () => opened?.close();
  again.onclick = () => { void showTerminal(); };
  opened?.focus();
}

// The layout the reader picked for diffs, on every thread page.
const layoutKey = "nexus.diff-layout";
let diffLayout = localStorage.getItem(layoutKey) === "split" ? "split" : "unified";
/** A window as narrow as a phone's, which draws unified, as split leaves each side too few characters to read. */
const narrow = matchMedia("(max-width: 760px)");
/** The open diff as last read, so a change of layout draws it again without reading the pylon. */
let openDiff = null;

function layoutPicker() {
  const picker = el("span", { className: "fv-layout" }, ...["unified", "split"].map((layout) => {
    const button = el("button", { type: "button", value: layout, textContent: layout === "unified" ? "Unified" : "Split" });
    button.setAttribute("aria-pressed", String(layout === diffLayout));
    button.addEventListener("click", () => pickLayout(layout));
    return button;
  }));
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Diff layout");
  return picker;
}

function pickLayout(layout) {
  diffLayout = layout;
  localStorage.setItem(layoutKey, layout);
  for (const button of fileView.querySelectorAll(".fv-layout button")) button.setAttribute("aria-pressed", String(button.value === layout));
  redrawDiff();
}

/** Draws the open diff again without reading the pylon. While a read is under way, it draws in the new layout when done. */
function redrawDiff() {
  if (openDiff === null || openDiff.read !== diffRead) return;
  openDiff = { ...openDiff, read: ++diffRead };
  void drawDiff(openDiff);
}
narrow.addEventListener("change", redrawDiff);
// The head script has painted the theme, so the picker's module loads after the page's own.
void import("./theme.js").then(({ onThemeChange, startThemes }) => {
  startThemes();
  onThemeChange(redrawDiff);
});

/** Shows a diff read from the pylon, once its lines are drawn. */
async function drawDiff({ read, head, shown, truncated }) {
  try {
    const { diffView, imagePair } = await import("./diff.js");
    const view = shown.kind === "lines" ? await diffView(shown.files, narrow.matches ? "unified" : diffLayout) : null;
    if (read !== diffRead) return;
    const typing = document.activeElement?.matches?.(".note-text") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    head.querySelector(".fv-layout").hidden = view === null;
    fileView.replaceChildren(...present([head, reviewBox,
      shown.kind !== "none" && shown.meta.length > 0 && el("div", { className: "fv-meta dim small" }, ...shown.meta.map((line) => el("div", { textContent: line }))),
      (truncated || (shown.kind === "lines" && shown.cut)) && el("p", { className: "dim small fv-note", textContent: "Only the start of the diff shows, because the whole of it is too long to show." }),
      view?.node ?? ((shown.kind === "binary" && imagePair(openTabs.find((f) => f.path === fileView.dataset.path), checkout.base, thread))
        || el("p", { className: "empty fv-note", textContent: shown.kind === "binary" ? "The file is binary, so there is no diff to show." : shown.kind === "meta" ? "No lines changed." : "The file has no changes now." }))]));
    if (view === null) {
      annotated = null;
      decorate();
    } else {
      annotate(view, fileView.dataset.path, shown.files);
    }
    const text = typing === null ? null : fileView.querySelector(".note-text");
    text?.focus({ preventScroll: true });
    text?.setSelectionRange(...typing);
  } catch (err) {
    if (read !== diffRead) return;
    fileView.replaceChildren(head, el("p", { className: "error fv-note", textContent: err.message }));
  }
}

let diffRead = 0;
async function readDiff(path) {
  const file = openTabs.find((f) => f.path === path);
  if (file === undefined || fileView === null) return;
  const read = ++diffRead;
  const dir = file.path.slice(0, file.path.lastIndexOf("/") + 1);
  const head = el("header", { className: "fv-head" }, badge(file.status),
    el("span", { className: "fv-path", title: file.path }, dir !== "" && el("span", { className: "fv-dir", textContent: dir }), el("span", { className: "fv-name", textContent: file.path.slice(dir.length) })),
    el("span", { className: "dim small", textContent: checkout.base === "turn" ? "vs turn start" : checkout.base === "head" ? "vs last commit" : "vs boot" }), counts(file.additions, file.deletions), layoutPicker());
  // A diff reaches into the pylon as the changes do, so a paused one is woken only when the reader says to, and
  // the read of the changes that wakes it reads the open diff again.
  const facts = factsNow();
  if (!canRead(facts)) {
    const open = !threadClosed(facts);
    const wake = el("button", { type: "button", className: "btn btn-xs", textContent: "Wake and read" });
    wake.addEventListener("click", () => {
      void readChanges(true);
      void readDiff(path);
    });
    return fileView.replaceChildren(head, el("div", { className: "fv-note" },
      el("p", { className: "empty", textContent: !open ? "The pylon stays paused, so the diff can't be read." : checkout.wanted ? "Waking the pylon. The diff shows once it runs." : `The pylon is ${facts.pylon}. Reading the diff wakes it.` }),
      open && !checkout.wanted && wake));
  }
  if (fileView.dataset.path !== path || fileView.querySelector(".diff-view") === null) fileView.replaceChildren(head, el("p", { className: "empty fv-note", textContent: "Reading the diff…" }));
  fileView.dataset.path = path;
  // A renamed file's old path goes too, or the diff shows it as added.
  const query = [file.path, ...(file.oldPath === null ? [] : [file.oldPath])].map((p) => `&path=${encodeURIComponent(p)}`).join("");
  try {
    const [{ diff, truncated }, { diffOf }] = await Promise.all([api("GET", `/v1/threads/${thread}/diff?base=${checkout.base}${query}`), import("./diff.js")]);
    if (read !== diffRead) return;
    openDiff = { read, head, shown: diffOf(diff), truncated };
    await drawDiff(openDiff);
  } catch (err) {
    if (read !== diffRead) return;
    fileView.replaceChildren(head, el("p", { className: "error fv-note", textContent: err.message }));
  }
}

// The review: notes on rows of the open diff, kept per thread until they go to the composer and are sent, or are
// discarded.
// After t3code's AnnotatableCodeView and DiffCommentAnnotation. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
const reviewKey = `nexus.review.${thread}`;
let review = readReview(localStorage.getItem(reviewKey));
const saveReview = () => localStorage.setItem(reviewKey, JSON.stringify(review));
const newNoteId = () => `note:${Date.now().toString(36)}${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
/** The diff on show, `{ view, path, rows }` with each entry's rows, or null when no diff's lines are drawn. */
let annotated = null;
/** The rows the reader selected, `{ entry, anchor, head }` as places in that entry's rows. `head` moves with the keyboard. */
let selection = null;
let dragging = false;
const reviewBox = el("div", { className: "fv-review" });
const picker = el("div", { className: "note-pick", hidden: true });
picker.setAttribute("role", "toolbar");
picker.setAttribute("aria-label", "Add a note");

const selectedRange = () => selection === null ? null
  : { entry: selection.entry, first: Math.min(selection.anchor, selection.head), last: Math.max(selection.anchor, selection.head) };
const unified = (entry, first, last) => ({ entry, from: annotated.rows[entry][first].index, to: annotated.rows[entry][last].index });

function showSelection() {
  if (annotated === null) return;
  const range = selectedRange();
  annotated.view.select(range && unified(range.entry, range.first, range.last));
  annotated.view.cursor(selection && { entry: selection.entry, index: annotated.rows[selection.entry][selection.head].index });
  placePicker(range);
}

/** Shows the kinds of note under the selection's last row, unless a note is being written. */
function placePicker(range) {
  const row = range && review.draft === null ? annotated.view.rowElement(range.entry, annotated.rows[range.entry][range.last].index) : null;
  picker.hidden = row === null;
  if (row === null) return;
  const rows = annotated.rows[range.entry].slice(range.first, range.last + 1);
  const lines = noteOn({ id: "", kind: "comment", path: "", entry: 0, rows, first: 0, last: rows.length - 1 }).lines;
  picker.replaceChildren(el("span", { className: "dim small", textContent: linesLabel(lines) }), ...Object.entries(kinds).map(([kind, { label, key }]) => {
    const button = el("button", { type: "button", className: "btn btn-xs", textContent: label, title: `${label} (${key.toUpperCase()})` });
    button.addEventListener("click", () => startDraft(kind));
    return button;
  }));
  if (picker.parentElement !== fileView) fileView.append(picker);
  const view = fileView.getBoundingClientRect();
  const at = row.getBoundingClientRect();
  picker.style.top = `${at.bottom - view.top + fileView.scrollTop + 4}px`;
  picker.style.left = `${Math.max(12, at.left - view.left + 12)}px`;
}

function startDraft(kind) {
  const range = selectedRange();
  if (range === null || annotated === null) return;
  review.draft = noteOn({ id: newNoteId(), kind, path: annotated.path, entry: range.entry, rows: annotated.rows[range.entry], first: range.first, last: range.last });
  saveReview();
  decorate();
  focusDraft();
}
const focusDraft = () => {
  const text = fileView.querySelector(".note-text");
  text?.focus({ preventScroll: true });
  text?.setSelectionRange(text.value.length, text.value.length);
  text?.scrollIntoView({ block: "nearest", inline: "nearest" });
};

function saveDraft() {
  const body = review.draft?.body.trim() ?? "";
  if (body === "") return;
  const note = { ...review.draft, body };
  const at = review.notes.findIndex((n) => n.id === note.id);
  review.notes = at === -1 ? [...review.notes, note] : review.notes.with(at, note);
  if (at !== -1 && review.composed !== null) review.composed = { ...review.composed, ids: review.composed.ids.filter((id) => id !== note.id) };
  review.draft = null;
  selection = null;
  saveReview();
  decorate();
  annotated?.view.node.focus({ preventScroll: true });
}

function cancelDraft() {
  review.draft = null;
  saveReview();
  decorate();
  annotated?.view.node.focus({ preventScroll: true });
}

/** Marks a note's rows while the reader points at or focuses its card, and the selection again after. */
function marksRows(card, entry, range) {
  if (range === null) return;
  const on = () => annotated?.view.select(unified(entry, range.first, range.last));
  const off = () => showSelection();
  card.addEventListener("mouseenter", on);
  card.addEventListener("mouseleave", off);
  card.addEventListener("focusin", on);
  card.addEventListener("focusout", off);
}

/** A saved note, with its quote when the diff no longer shows its rows. */
function noteCard(note, entry = null, range = null) {
  const edit = el("button", { type: "button", className: "btn btn-xs btn-ghost", textContent: "Edit" });
  edit.addEventListener("click", () => {
    if (review.draft !== null && review.draft.id !== note.id && review.draft.body.trim() !== "" && !confirm("Discard the note you are writing?")) return;
    review.draft = { ...note };
    saveReview();
    decorate();
    focusDraft();
  });
  const remove = el("button", { type: "button", className: "btn btn-xs btn-ghost danger", textContent: "Delete" });
  remove.addEventListener("click", () => {
    review.notes = review.notes.filter((n) => n.id !== note.id);
    saveReview();
    decorate();
  });
  const card = el("div", { className: `note note-${note.kind}` },
    el("div", { className: "note-head" }, el("span", { className: "note-kind", textContent: kinds[note.kind].label }),
      el("span", { className: "dim small", textContent: `${range === null ? `${note.path} ` : ""}${linesLabel(note.lines)}` }), edit, remove),
    range === null && el("pre", { className: "note-quote", textContent: note.quote.join("\n") }),
    el("p", { className: "note-body", textContent: note.body }));
  marksRows(card, entry, range);
  return card;
}

/** The note being written: its kind, which the reader can change, and its text. */
function draftCard(draft, entry = null, range = null) {
  const label = () => `${kinds[review.draft.kind].label} on ${linesLabel(draft.lines)}`;
  const title = el("span", { className: "note-kind", textContent: label() });
  const text = el("textarea", { className: "note-text", rows: 3, value: draft.body, placeholder: "Write the note. Ctrl+Enter saves it, Esc cancels." });
  text.setAttribute("aria-label", label());
  const save = el("button", { type: "button", className: "btn btn-xs btn-primary", textContent: "Save", disabled: draft.body.trim() === "" });
  const cancel = el("button", { type: "button", className: "btn btn-xs btn-ghost", textContent: "Cancel" });
  const picks = Object.entries(kinds).map(([kind, { label: name }]) => {
    const button = el("button", { type: "button", value: kind, textContent: name });
    button.setAttribute("aria-pressed", String(kind === draft.kind));
    button.addEventListener("click", () => {
      review.draft.kind = kind;
      saveReview();
      for (const b of picks) b.setAttribute("aria-pressed", String(b.value === kind));
      title.textContent = label();
      text.setAttribute("aria-label", label());
      text.focus();
    });
    return button;
  });
  const choice = el("span", { className: "fv-layout note-kinds" }, ...picks);
  choice.setAttribute("role", "group");
  choice.setAttribute("aria-label", "Kind of note");
  text.addEventListener("input", () => {
    review.draft.body = text.value;
    save.disabled = text.value.trim() === "";
    saveReview();
  });
  text.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDraft();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      saveDraft();
    }
  });
  save.addEventListener("click", saveDraft);
  cancel.addEventListener("click", cancelDraft);
  const card = el("div", { className: `note note-draft note-${draft.kind}` },
    el("div", { className: "note-head" }, title, choice),
    range === null && el("pre", { className: "note-quote", textContent: draft.quote.join("\n") }),
    text, el("div", { className: "note-actions" }, cancel, save));
  marksRows(card, entry, range);
  return card;
}

/**
 * Draws the review: each note under its last row in the open diff, the draft where it was started, and above the
 * diff the review's bar and the notes on this file whose rows the diff no longer shows.
 */
function decorate() {
  const typing = document.activeElement?.matches?.(".note-text") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const path = activeTab !== null && fileView?.dataset.path === activeTab ? activeTab : null;
  let draftPlaced = false;
  const editing = review.draft?.id;
  const notes = review.notes.filter((n) => n.id !== editing);
  const gone = [];
  if (annotated !== null && annotated.path === path && annotated.view.node.isConnected) {
    const groups = new Map();
    annotated.rows.forEach((rows, entry) => {
      const { placed, outdated } = place(notes, rows, path, entry);
      gone.push(...outdated);
      const cards = placed.map(({ note, first, last }) => [note, noteCard(note, entry, { first, last })]);
      const draft = review.draft?.path === path && review.draft.entry === entry ? review.draft : null;
      const at = draft && rangeOf(draft, rows);
      if (at !== null && at !== undefined) {
        cards.push([draft, draftCard(draft, entry, at)]);
        draftPlaced = true;
      }
      const names = annotated.view.slots(entry, cards.map(([note]) => note.end));
      cards.forEach(([, card], i) => groups.set(names[i], [...(groups.get(names[i]) ?? []), card]));
    });
    annotated.view.node.replaceChildren(...[...groups].map(([name, cards]) => Object.assign(el("div", { className: "notes" }, ...cards), { slot: name })));
  } else if (path !== null) {
    gone.push(...notes.filter((n) => n.path === path));
  }
  const count = review.notes.length;
  const add = el("button", { type: "button", className: "btn btn-xs btn-primary", textContent: "Add to message" });
  add.addEventListener("click", composeReview);
  const discard = el("button", { type: "button", className: "btn btn-xs btn-ghost danger", textContent: "Discard" });
  discard.addEventListener("click", () => {
    if (!confirm(`Discard the review's ${count === 1 ? "note" : `${count} notes`}?`)) return;
    review = emptyReview();
    saveReview();
    selection = null;
    decorate();
  });
  reviewBox.replaceChildren(...present([
    count > 0 && el("div", { className: "review-bar" },
      el("span", { textContent: `Review: ${count} ${count === 1 ? "note" : "notes"}${review.composed !== null ? ", in the message box" : ""}` }), add, discard),
    gone.length > 0 && el("div", { className: "notes-outdated" },
      el("p", { className: "dim small", textContent: "The diff no longer shows these lines as quoted. The notes stay in the review with their quotes." }),
      ...gone.map((note) => noteCard(note))),
    review.draft !== null && !draftPlaced && el("div", { className: "notes-outdated" },
      el("p", { className: "dim small", textContent: `A note on ${review.draft.path} is not saved. Save or cancel it to start another.` }),
      draftCard(review.draft)),
  ]));
  showSelection();
  for (const button of document.querySelectorAll(".tree-file")) {
    button.querySelector(".note-count")?.remove();
    const count = noteCount(button.dataset.path);
    if (count !== false) button.lastElementChild.before(count);
  }
  const text = typing === null ? null : fileView.querySelector(".note-text");
  if (text !== null && text !== document.activeElement) {
    text.focus({ preventScroll: true });
    text.setSelectionRange(...typing);
  }
}

/** Puts the review in the composer, in place of the review put there before if the composer still holds it. */
function composeReview() {
  const prompt = document.getElementById("prompt-text");
  if (prompt === null) return showError("action-error", new Error("This thread takes no messages now, so the review can't go to the composer."));
  const text = formatReview(review.notes);
  const before = review.composed?.text;
  prompt.value = before !== undefined && prompt.value.includes(before) ? prompt.value.replace(before, () => text)
    : prompt.value.trim() === "" ? text : `${prompt.value.trimEnd()}\n\n${text}`;
  review.composed = { text, ids: review.notes.map((n) => n.id) };
  saveReview();
  decorate();
  showTab(null);
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
}

/** After a message from the composer is sent, drops the notes it carried. A note cut from it, or edited since, stays. */
function reviewSent(sent, text) {
  const after = afterSend(review, sent, text);
  if (after === review) return;
  review = after;
  saveReview();
  decorate();
}

/** The place in an entry's rows of the row an event is on, or null. */
function rowAt(event) {
  const row = annotated?.view.rowOf(event);
  if (row === null || row === undefined) return null;
  const at = annotated.rows[row.entry].findIndex((r) => r.index === row.index);
  return at === -1 ? null : { ...row, at };
}

/** Lets the reader select rows of a newly drawn diff by their line numbers and with the keyboard. */
function annotate(view, path, files) {
  annotated = { view, path, rows: files.map(rowsOf) };
  selection = null;
  view.node.tabIndex = 0;
  view.node.setAttribute("aria-label", "Diff. Up and Down move between lines, Shift with them extends the selection, C, Q, S or R starts a comment, question, suggestion or requested change on it, and Escape clears it.");
  view.node.addEventListener("pointerdown", (event) => {
    const row = rowAt(event);
    if (row === null || !row.number || event.button !== 0) return;
    event.preventDefault();
    selection = event.shiftKey && selection?.entry === row.entry ? { ...selection, head: row.at } : { entry: row.entry, anchor: row.at, head: row.at };
    dragging = true;
    view.node.focus({ preventScroll: true });
    showSelection();
  });
  view.node.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const row = rowAt(event);
    if (row === null || row.entry !== selection.entry || row.at === selection.head) return;
    selection = { ...selection, head: row.at };
    showSelection();
  });
  view.node.addEventListener("keydown", (event) => {
    if (event.target !== view.node || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[key];
    const kind = Object.keys(kinds).find((k) => kinds[k].key === key);
    if (step !== undefined) {
      event.preventDefault();
      moveSelection(step, event.shiftKey);
    } else if (key === "Escape" && selection !== null) {
      selection = null;
      showSelection();
    } else if (kind !== undefined && review.draft !== null) {
      event.preventDefault();
      focusDraft();
    } else if (kind !== undefined && selection !== null) {
      event.preventDefault();
      startDraft(kind);
    }
  });
  decorate();
}
addEventListener("pointerup", () => { dragging = false; });
// Another tab on this thread changed the review, so this one draws that review rather than saving over it.
addEventListener("storage", (event) => {
  if (event.key !== reviewKey) return;
  review = readReview(event.newValue);
  decorate();
});

/** Moves the keyboard's row one step, into the next entry at an entry's end, and extends the selection with Shift. */
function moveSelection(step, extend) {
  const { rows } = annotated;
  if (selection === null) {
    const entry = rows.findIndex((r) => r.length > 0);
    if (entry === -1) return;
    selection = { entry, anchor: 0, head: 0 };
  } else {
    let { entry, head } = selection;
    head += step;
    if (head < 0 || head >= rows[entry].length) {
      if (extend) return;
      do entry += step; while (entry >= 0 && entry < rows.length && rows[entry].length === 0);
      if (entry < 0 || entry >= rows.length) return;
      head = step > 0 ? 0 : rows[entry].length - 1;
    }
    selection = extend ? { ...selection, head } : { entry, anchor: head, head };
  }
  showSelection();
  annotated.view.rowElement(selection.entry, rows[selection.entry][selection.head].index)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

for (const d of document.querySelectorAll("details[id]")) if (toggled.has(d.id)) d.open = toggled.get(d.id);
const savedPane = localStorage.getItem(paneKey);
if (savedPane !== null) pickPane(savedPane);
if (changesPane !== null) {
  checkout.facts = factsNow();
  renderTabs();
  if (canRead(checkout.facts)) void readChanges();
  else changesUnreadable(checkout.facts);
}
end?.toEnd();
follow(document.getElementById("convo")?.dataset.stream);
if (location.hash === "#terminal" && tabsBar?.querySelector('[data-tab="term"]')?.hidden === false) showTab(terminalTab);
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
  askRows();
  // The visit wakes the pylon anyway, so a running one is worth reading again on return.
  if (changesPane !== null && canRead(factsNow())) void readChanges();
});

/**
 * Brings the inbox card a notice opened into view, or the inbox when that card is gone. A notice can come before the
 * poll that brings its card, so the page is read once more before it settles for the inbox.
 */
async function showNeed() {
  const selectors = needSelectors(location.hash);
  if (selectors === null) return;
  const find = () => selectors.map((s) => document.querySelector(s)).find((found) => found !== null) ?? null;
  if (find() === null && document.getElementById("needs-you") !== null) await refreshNow();
  const card = find() ?? document.getElementById("needs-you");
  for (const picked of document.querySelectorAll(".need.picked")) picked.classList.remove("picked");
  card?.classList.add("picked");
  card?.scrollIntoView({ block: "start" });
  card?.focus({ preventScroll: true });
}
void showNeed();
addEventListener("hashchange", () => void showNeed());
// On a phone the link is in the drawer, which a jump within the page would leave open over the inbox.
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest('a[href^="/#needs-you"]') !== null) setOpen(null);
});

const currentThread = () => /^\/threads\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;
const focused = () => document.visibilityState === "visible" && document.hasFocus();
const notifications = coordinator((row) => {
  const channel = notificationChannel(focused(), currentThread(), row.id, window.isSecureContext,
    window.isSecureContext && "Notification" in window ? Notification.permission : "unavailable");
  const url = noticeUrl(row);
  if (channel === "system") {
    const notice = new Notification(row.title, { body: noticeText(row) });
    notice.onclick = () => { window.focus(); location.assign(url); notice.close(); };
  } else if (channel === "toast") {
    const toast = el("div", { className: "attention-toast", role: "status" },
      el("span", { textContent: `${row.title}: ${noticeText(row)}` }),
      el("a", { href: url, textContent: "Open" }));
    const dismiss = el("button", { textContent: "Dismiss", type: "button" });
    dismiss.onclick = () => toast.remove();
    toast.append(dismiss);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 15000);
  }
});
const permission = el("button", { type: "button", className: "btn side-add", textContent: "Enable system notifications" });
if (window.isSecureContext && "Notification" in window) {
  permission.onclick = async () => { permission.textContent = `Notifications: ${await Notification.requestPermission()}`; };
} else {
  permission.disabled = true;
  permission.textContent = "System notifications need HTTPS";
}
document.querySelector("aside")?.append(permission);
// After the button, which shortens the list it joins.
document.querySelector(".row.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
// The events that change a row's attention, its reply or whether it works.
const rowEvents = ["attention.changed", "thread.turn-ended", "session.turn-started", "session.turn-ended", "session.waiting", "session.ended"];
// One tab of the browser holds the lock, follows those events and reads the thread list, and the other tabs show the
// rows it hands them, so a hidden tab notifies without a request or a stream of its own. Every tab showing that one
// tab's reads, in order, means none shows older rows over newer ones, and each holds a reply back to the same moment.
const rowsChannel = "BroadcastChannel" in window ? new BroadcastChannel("nexus-rows") : null;
const sharing = rowsChannel !== null && navigator.locks !== undefined;
let leading = false;
let due;
function showRows(rows, now) {
  const held = notifications(rows, now);
  // A turn over an unread reply may stop with no event, and the reply notifies once a read finds it stopped.
  const next = rows.some((row) => row.attention === "reply" && row.working) ? Math.min(held ?? Infinity, now + 1000) : held;
  // A held-back reply notifies once a read at its time finds no turn running.
  clearTimeout(due);
  if (leading && next !== null) due = setTimeout(readRows, next - Date.now());
}
let readingRows = false;
let stale = false;
let retry;
async function readRows() {
  // An event during a read may have come after the list was read.
  if (readingRows) return void (stale = true);
  readingRows = true;
  try {
    do {
      stale = false;
      const rows = await api("GET", "/v1/threads?deleted=false", undefined, AbortSignal.timeout(10_000));
      const now = Date.now();
      if (leading) rowsChannel.postMessage({ rows, now });
      showRows(rows, now);
    } while (stale);
  } catch {
    // The event that asked for the read may be the last for a while.
    clearTimeout(retry);
    if (leading) retry = setTimeout(readRows, 1000);
  } finally { readingRows = false; }
}
const askRows = () => sharing && !leading ? rowsChannel.postMessage("read") : void readRows();
rowsChannel?.addEventListener("message", ({ data }) => {
  if (data === "read") {
    if (leading) void readRows();
  } else showRows(data.rows, data.now);
});
function followRows() {
  leading = true;
  const open = () => {
    // Each connection reads the list, so it needs none of the events before it.
    const query = new URLSearchParams([["follow", "true"], ["since", "latest"], ...rowEvents.map((kind) => ["kind", kind])]);
    const events = new EventSource(`/v1/events?${query}`);
    events.onopen = () => void readRows();
    events.onmessage = () => void readRows();
    events.onerror = () => {
      events.close();
      setTimeout(() => { void readRows(); open(); }, 3000);
    };
  };
  open();
  // A delete, a harness turn that starts or stops without a reply, or a session whose lease lapsed sends no event.
  setInterval(readRows, 10_000);
}
if (sharing) {
  void navigator.locks.request("nexus-rows", () => { followRows(); return new Promise(() => {}); });
  askRows();
} else {
  // Web Locks need a secure context, so each tab of a page over plain HTTP reads the list itself.
  void readRows();
  setInterval(readRows, 1000);
}

let marking = false;
let marked = null;
async function markSeen() {
  const convo = document.getElementById("convo");
  const id = currentThread();
  if (marking || id === null || !focused() || activeTab !== null || convo === null || convo.querySelector(".error")) return;
  const body = owedSeen(convo, marked);
  if (body === null) return;
  marking = true;
  try {
    await api("POST", `/v1/threads/${id}/seen`, body, AbortSignal.timeout(10_000));
    marked = body.lastReplyAt;
  } catch { /* The page's refresh reports connection failures. */ }
  finally { marking = false; }
}
setInterval(markSeen, 1000);
