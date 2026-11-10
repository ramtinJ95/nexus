// The sidebar and the drawers: which panel is open, the thread filter on each swap, copy buttons and the
// inspector's tab.
import { afterSwap } from "./page.js";
import { applyFilter } from "./find.js";
import { kept, narrow, storageKeys } from "./contract.ts";
import { syncMenu, toggleFold } from "./side.js";

/** A drawer, one at a time: the phone's thread list or thread actions, or the inspector of a window 1100px wide or less. */
export function setOpen(panel) {
  if (panel === null) delete document.body.dataset.open;
  else document.body.dataset.open = panel;
  // The phone's thread list is hidden until it opens, so the open thread's row is brought into view then.
  if (panel === "side") document.querySelector(".row.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  syncMenu();
}
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  // A button, as the body's data-open names the open drawer and opens none.
  const opener = target?.closest("button[data-open]");
  if (opener?.dataset.open === "side" && !matchMedia(narrow).matches) return toggleFold();
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

afterSwap(applyFilter);
// A poll swaps the thread page's bar, and its menu button with it.
afterSwap(syncMenu);

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
export function pickPane(pane) {
  const radio = document.querySelector(`.inspect .seg-bar input[value="${CSS.escape(pane)}"]`);
  if (radio === null) return;
  radio.checked = true;
  kept.write(storageKeys.pane, pane);
}
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.matches(".inspect .seg-bar input")) kept.write(storageKeys.pane, event.target.value);
});
