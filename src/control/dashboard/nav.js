// The sidebar and the phone's panels: which panel is open, the thread filter, copy buttons and the inspector's tab.
import { afterSwap } from "./page.js";

const filter = document.getElementById("filter");

/** The phone's thread list, inspector or thread actions, one at a time. */
export function setOpen(panel) {
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
afterSwap(applyFilter);

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
export const paneKey = "nexus.pane";
export function pickPane(pane) {
  const radio = document.querySelector(`.seg-bar input[value="${CSS.escape(pane)}"]`);
  if (radio === null) return;
  radio.checked = true;
  localStorage.setItem(paneKey, pane);
}
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.matches(".seg-bar input")) localStorage.setItem(paneKey, event.target.value);
});
