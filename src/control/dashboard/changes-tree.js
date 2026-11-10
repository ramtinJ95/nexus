import { request } from "./request.js";
import { pylonRoutes } from "../../contract/pylon.ts";
import { afterSwap, el, present, retryShots } from "./page.js";
import { bases } from "./checkout-text.js";
import { kept, storageKeys } from "./contract.ts";
import { badge, canRead, changesPane, checkout, counts, factsNow, thread, unreadable } from "./checkout.js";
import { activeTab, openFile, refreshTabs } from "./tab-bar.js";
import { noteCount } from "./review-notes.js";

// A template's icons are in its content, outside the document.
const iconOf = (name) => document.getElementById("icons").content.querySelector(`.i-${name}`).cloneNode(true);

/**
 * The changed files the reader marked viewed, by path, each with the file's look then: its status, its old path and
 * its counts. A file whose look changed since reads as not viewed, as the agent changed it again.
 */
const viewedKey = thread === undefined ? null : storageKeys.viewed(thread);
const lookOf = (file) => JSON.stringify([file.status, file.oldPath, file.additions, file.deletions]);
let viewed = (() => {
  try {
    const saved = JSON.parse(viewedKey === null ? "null" : kept.read(viewedKey) ?? "null");
    return typeof saved === "object" && saved !== null && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
})();
export const isViewed = (file) => viewed[file.path] === lookOf(file);
export function markViewed(file, on) {
  const { [file.path]: _, ...rest } = viewed;
  viewed = on ? { ...rest, [file.path]: lookOf(file) } : rest;
  kept.write(viewedKey, Object.keys(viewed).length === 0 ? null : JSON.stringify(viewed));
  if (checkout.changes !== null) renderChanges();
}

function showChanges(...nodes) {
  document.getElementById("changes-body")?.replaceChildren(...present(nodes));
}

export function changesUnreadable(facts) {
  // A closed thread keeps no reply, so nothing shows its stale tree again and an unarchive's start reads anew.
  if (!facts.open) checkout.changes = null;
  showChanges(...unreadable(facts, "its changes", () => { void readChanges(true); }));
}

// Each read reaches into the pylon and wakes it if it sleeps, so the changes are read when the pylon runs and a turn
// of its agent ends, when the reader asks, and never on a paused pylon unless the reader says to wake it.
let reading = null;
/**
 * Reads the changes into the inspector. A paused pylon is read only when the reader asked to wake it, and then
 * again once the page shows it running, as the first read only wakes it.
 */
export async function readChanges(wake = false) {
  const facts = factsNow();
  if (thread === undefined || facts === null) return;
  if (!facts.open) return changesUnreadable(facts);
  if (facts.pylon !== "running") {
    if (!wake && !checkout.wanted) return changesUnreadable(facts);
    checkout.wanted = true;
  }
  if (reading !== null) return reading;
  const base = checkout.base;
  if (checkout.changes === null) showChanges(el("p", { className: "empty", textContent: facts.pylon === "running" ? "Reading the changes…" : "Waking the pylon…" }));
  reading = (async () => {
    try {
      const changes = await request(pylonRoutes.changes, { thread, query: { base } });
      checkout.wanted = false;
      if (base !== checkout.base) return;
      // The thread closed while the read was out, so the reply is stale.
      if (!factsNow().open) return changesUnreadable(factsNow());
      checkout.changes = changes;
      renderChanges();
      refreshTabs(changes.files);
    } catch (err) {
      if (base !== checkout.base) return;
      // The thread closed while the read was out, so the closing, not the failure it caused, is what to show.
      if (!factsNow().open) return changesUnreadable(factsNow());
      // A pylon that is not running refuses the read as retryable while the read wakes it, even one the page still
      // shows running, as the page's state lags the node's. So the read happens again once the page shows it running.
      if (err.retryable) {
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

/**
 * A tree of the changed files, each level's folders and then its files by name, with each folder that holds only one
 * folder merged into it, as src/checkout.
 */
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
  const sort = (dir) => {
    dir.dirs = new Map([...dir.dirs].sort(([a], [b]) => a.localeCompare(b)));
    dir.files.sort((a, b) => a.name.localeCompare(b.name));
    for (const inner of dir.dirs.values()) sort(inner);
  };
  sort(root);
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

/** The changed files as the tree lists them, top to bottom, or none before the changes are read. */
export function changedFiles() {
  if (checkout.changes === null) return [];
  const { root, merged } = treeOf(checkout.changes.files);
  const walk = (dir) => [...[...dir.dirs].flatMap(([part, inner]) => walk(merged(part, inner)[1])), ...dir.files.map(({ file }) => file)];
  return walk(root);
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
    for (const [part, inner] of dir.dirs) {
      const [name, deepest] = merged(part, inner);
      const at = path === "" ? name : `${path}/${name}`;
      const fold = el("details", { className: "tree-dir", open: !checkout.closed.has(at) },
        el("summary", {}, iconOf("chevron"), iconOf("folder"), el("span", { className: "tree-name", textContent: name })),
        branch(deepest, at));
      fold.addEventListener("toggle", () => { if (fold.open) checkout.closed.delete(at); else checkout.closed.add(at); });
      items.push(fold);
    }
    for (const { name, file } of dir.files) {
      const seen = isViewed(file);
      const open = el("button", {
        type: "button", className: `tree-file${activeTab === file.path ? " active" : ""}${seen ? " viewed" : ""}`,
        title: `${file.oldPath === null ? file.path : `${file.path}, ${file.status} from ${file.oldPath}`}${seen ? ", viewed" : ""}`,
      }, badge(file.status), el("span", { className: "tree-name", textContent: name }), seen && el("span", { className: "tree-viewed", textContent: "✓" }),
      noteCount(file.path), counts(file.additions, file.deletions));
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
  const reopened = !before.open && now.open;
  if ((started && checkout.changes === null) || ((checkout.wanted || agentDone || reopened) && canRead(now))) void readChanges();
  else if (!canRead(now) && (checkout.changes === null || !now.open)) changesUnreadable(now);
}
afterSwap(noticeFacts);

if (changesPane !== null) {
  // "Only uncommitted" and "Latest turn" are one choice of base, and with neither checked it is the boot.
  const boxes = { head: document.getElementById("changes-head"), turn: document.getElementById("changes-turn") };
  const setBase = (next) => {
    for (const [base, box] of Object.entries(boxes)) box.checked = base === next;
    checkout.base = next;
    kept.write(storageKeys.base, next);
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
