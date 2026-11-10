// Finding a thread: the sidebar's filter, which `/` focuses, and Ctrl/⌘K's switcher, loaded on its first press. The
// filter matches each row's `data-find` as a fold page's `?q=` does, and the tab keeps it, so it filters the next page a
// click loads too.
import { found, keptForTab, narrow, storageKeys } from "./contract.ts";

export const typing = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el?.isContentEditable === true;

const filter = document.getElementById("filter");

// A filter shows the threads it matches in folded projects and archived folds, and folds them away again once it
// is cleared.
const openedByFilter = new Set();
export function applyFilter() {
  if (filter === null) return;
  const query = filter.value.trim();
  for (const group of document.querySelectorAll("#side-threads .group")) {
    const rows = [...group.querySelectorAll("li")];
    for (const row of rows) row.hidden = query !== "" && !found(row.querySelector("a.row")?.dataset.find ?? "", query);
    for (const fold of [group, ...group.querySelectorAll("details.archived")]) {
      const matched = query !== "" && [...fold.querySelectorAll("li")].some((row) => !row.hidden);
      if (matched && !fold.open) { fold.open = true; openedByFilter.add(fold.id); }
      if (!matched && openedByFilter.delete(fold.id)) fold.open = false;
    }
    group.hidden = query !== "" && rows.every((row) => row.hidden);
  }
}

if (filter !== null) {
  // client.js filters once it has folded the projects the reader folded.
  filter.value = keptForTab.read(storageKeys.filter) ?? "";
  filter.addEventListener("input", () => {
    keptForTab.write(storageKeys.filter, filter.value === "" ? null : filter.value);
    applyFilter();
  });
}

// The rows the thread list read last, which the switcher lists.
let rows = [];
let switcher = null;
export function listRows(next) {
  rows = next;
  void switcher?.then((m) => m?.switchOver(rows));
}
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    switcher ??= import("./switcher.js").catch(() => { switcher = null; });
    void switcher.then((m) => m?.toggle(rows));
  } else if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && filter !== null && !typing(event.target) && document.querySelector("dialog[open]") === null) {
    event.preventDefault();
    // A phone's sidebar is a drawer, hidden until it opens.
    if (matchMedia(narrow).matches) document.body.dataset.open = "side";
    filter.focus();
    filter.select();
  }
});
// The page's policy refuses every form's own submit, so a search goes where its form would.
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.getAttribute("role") !== "search") return;
  event.preventDefault();
  location.assign(`${form.getAttribute("action")}?${new URLSearchParams(new FormData(form))}`);
});
