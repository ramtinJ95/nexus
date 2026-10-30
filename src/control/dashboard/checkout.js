// A thread page's checkout: the changes pane, the tabs beside the conversation with each file's diff and the
// terminal, and the review notes on a diff.
import { afterSend, emptyReview, formatReview, kinds, linesLabel, noteOn, place, rangeOf, readReview, rowsOf } from "./review.js";
import { api } from "./request.js";
import { afterSwap, el, end, main, present, retryShots, scroller, showError } from "./page.js";
import { bases, checkoutText } from "./checkout-text.js";

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
export const changesPane = document.getElementById("pane-changes");
const thread = changesPane?.dataset.thread;
const baseKey = "nexus.base";
export const checkout = {
  base: Object.hasOwn(bases, localStorage.getItem(baseKey)) ? localStorage.getItem(baseKey) : "start",
  /** The last reply, kept so a fold the reader closed and the open tabs survive a read. */
  changes: null,
  /** Whether the reader asked to wake a paused pylon to read it, so the read happens once it runs. */
  wanted: false,
  /** Tree folders the reader closed. */
  closed: new Set(),
  facts: null,
};
export const factsNow = () => {
  const span = document.querySelector("#facts span");
  return span === null ? null : { pylon: span.dataset.pylon, turn: span.dataset.turn === "true", agentAt: span.dataset.agentAt, status: span.dataset.threadStatus };
};

function showChanges(...nodes) {
  document.getElementById("changes-body")?.replaceChildren(...present(nodes));
}

/** An archived or deleted thread, whose pylon stays paused, so its checkout cannot be read. */
const threadClosed = (facts) => facts.status !== "active" && facts.status !== "idle";

const { unreadable } = checkoutText({ el, checkout });


export function changesUnreadable(facts) {
  // A closed thread keeps no reply, so nothing shows its stale tree again and an unarchive's start reads anew.
  if (threadClosed(facts)) checkout.changes = null;
  showChanges(...unreadable(facts, "its changes", () => { void readChanges(true); }));
}

export const canRead = (facts) => facts.pylon === "running" && !threadClosed(facts);

let reading = null;
/**
 * Reads the changes into the inspector. A paused pylon is read only when the reader asked to wake it, and then
 * again once the page shows it running, as the first read only wakes it.
 */
export async function readChanges(wake = false) {
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
  const shown = bases[checkout.base];
  document.getElementById("changes-base").textContent = `${shown.label}, ${base.commit === null ? shown.emptyTree : base.commit.slice(0, 7)}`;
  if (files.length === 0) return showChanges(el("p", { className: "empty", textContent: shown.unchanged }));
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
afterSwap(noticeFacts);

if (changesPane !== null) {
  // "Only uncommitted" and "Latest turn" are one choice of base, and with neither checked it is the boot.
  const boxes = { head: document.getElementById("changes-head"), turn: document.getElementById("changes-turn") };
  const setBase = (next) => {
    for (const [base, box] of Object.entries(boxes)) box.checked = base === next;
    checkout.base = next;
    localStorage.setItem(baseKey, next);
    checkout.changes = null;
    document.getElementById("changes-base").textContent = bases[next].label;
    void readChanges();
  };
  for (const [base, box] of Object.entries(boxes)) {
    box.checked = checkout.base === base;
    box.addEventListener("change", () => setBase(box.checked ? base : "start"));
  }
  document.getElementById("changes-base").textContent = bases[checkout.base].label;
  document.getElementById("changes-reload").addEventListener("click", () => { void readChanges(true); });
}

// The tabs beside the conversation: the terminal, and one per changed file the reader opened, kept for the tab's
// session. `activeTab` is the open file's path, `terminalTab` for the terminal, or null for the conversation.
export const tabsBar = document.getElementById("tabs");
const fileView = document.getElementById("file-view");
const termView = document.getElementById("term-view");
export const terminalTab = Symbol("terminal");
const tabsKey = `nexus.tabs.${thread}`;
const maxTabs = 8;
let openTabs = JSON.parse(sessionStorage.getItem(tabsKey) ?? "[]");
export let activeTab = null;

function saveTabs() {
  sessionStorage.setItem(tabsKey, JSON.stringify(openTabs));
}

/** Draws the file tabs again, keeping focus on the control that had it, or on the tab that took its place. */
export function renderTabs() {
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

export function showTab(path) {
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
afterSwap(terminalFollows);

// The terminal tab attaches on its first show, as `nexus attach` does, and stays attached while the reader looks at
// other tabs, so it holds the pylon awake as an attached terminal does until it is detached or the page closes. A
// terminal that ends on its own keeps its last screen until the next attach replaces it.
let terminal = null;
let lastTerminal = null;
/** The pane the next attach lands in, in place of the Claude worker's. */
let landing = null;

/**
 * Shows `pane` in the terminal tab. A terminal that is not attached attaches there. An attached one has Herdr focus
 * it, which moves every terminal attached to the pylon, once its current connection has landed, so that an attach or
 * a reattach does not undo it.
 */
export async function showSession(thread, pane) {
  const opened = await terminal;
  if (opened != null && await opened.landed()) await api("POST", `/v1/threads/${thread}/sessions/${encodeURIComponent(pane)}/focus`, {});
  else landing = pane;
  showTab(terminalTab);
}

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
  const pane = landing;
  landing = null;
  terminal = import("./term-view.js").then(({ openTerminal }) => {
    lastTerminal?.close();
    document.getElementById("term-host").replaceChildren();
    lastTerminal = openTerminal(document.getElementById("term-host"), thread, shown, pane);
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
    el("span", { className: "dim small", textContent: bases[checkout.base].vs }), counts(file.additions, file.deletions), layoutPicker());
  // A diff reaches into the pylon as the changes do, so a paused one is woken only when the reader says to, and
  // the read of the changes that wakes it reads the open diff again.
  const facts = factsNow();
  if (!canRead(facts)) {
    return fileView.replaceChildren(head, el("div", { className: "fv-note" }, ...unreadable(facts, "the diff", () => {
      void readChanges(true);
      void readDiff(path);
    })));
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
export let review = readReview(localStorage.getItem(reviewKey));
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
  const card = el("div", { className: `rnote rnote-${note.kind}` },
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
  const card = el("div", { className: `rnote note-draft rnote-${draft.kind}` },
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
export function reviewSent(sent, text) {
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
