// Ctrl/⌘K's switcher, which find.js loads and opens: the open threads the thread list last read, matched as the
// sidebar's filter matches, picked by the keyboard, and last a search of the archived and deleted ones, which only their
// page lists.
import { findText, found } from "./contract.ts";

const dialog = document.getElementById("switcher");
const input = document.getElementById("switcher-q");
const list = document.getElementById("switcher-list");
const shown = 50;

let rows = [];
let entries = [];
let picked = 0;

const lastActive = (r) => Math.max(r.createdAt, r.lastAgentActivityAt ?? 0, r.lastHumanActivityAt ?? 0);
function entriesFor(query) {
  const matched = rows.filter((r) => found(findText(r, r.pullRequestNumbers), query)).toSorted((a, b) => lastActive(b) - lastActive(a)).slice(0, shown)
    .map((r) => ({ href: `/threads/${r.id}`, title: r.title, note: r.project }));
  const q = query.trim();
  if (q === "") return matched;
  return [...matched, { href: `/threads/closed?${new URLSearchParams({ q })}`, title: `Search archived and deleted threads for “${q}”`, note: "" }];
}

function draw() {
  entries = entriesFor(input.value);
  picked = Math.max(0, Math.min(picked, entries.length - 1));
  list.replaceChildren(...entries.map((entry, i) => {
    const link = Object.assign(document.createElement("a"), { href: entry.href, textContent: entry.title, tabIndex: -1 });
    const note = Object.assign(document.createElement("span"), { className: "dim", textContent: entry.note });
    const item = Object.assign(document.createElement("li"), { id: `switcher-${i}` });
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(i === picked));
    item.append(link, note);
    return item;
  }));
  if (entries.length === 0) input.removeAttribute("aria-activedescendant");
  else input.setAttribute("aria-activedescendant", `switcher-${picked}`);
  list.children[picked]?.scrollIntoView({ block: "nearest" });
}

/** The rows the thread list read last, which the switcher lists. */
export function switchOver(next) {
  rows = next;
  if (dialog?.open) draw();
}

if (dialog !== null) {
  // A click on the dialog itself is on its backdrop.
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  input.addEventListener("input", () => {
    picked = 0;
    draw();
  });
  input.addEventListener("keydown", (event) => {
    // An input method's Enter or arrow is its own, choosing what the reader composes.
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length === 0) return;
      picked = (picked + (event.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length;
      draw();
    } else if (event.key === "Enter" && entries[picked] !== undefined) {
      event.preventDefault();
      location.assign(entries[picked].href);
    }
  });
}

/** Opens the switcher over `listed`, or closes it when it is open. */
export function toggle(listed) {
  if (dialog === null) return;
  rows = listed;
  if (dialog.open) return dialog.close();
  if (document.querySelector("dialog[open]") !== null) return;
  input.value = "";
  picked = 0;
  draw();
  dialog.showModal();
  input.focus();
}
