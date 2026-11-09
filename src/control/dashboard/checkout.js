import { changesBases, statusLetters } from "../../contract/pylon.ts";
import { el } from "./page.js";
import { checkoutText } from "./checkout-text.js";
import { factsOf, kept, storageKeys } from "./contract.ts";

// A thread page's checkout, which the changes in the inspector and the diff tabs beside the conversation share.
export const changesPane = document.getElementById("pane-changes");
export const thread = changesPane?.dataset.thread;
export const checkout = {
  base: changesBases.includes(kept.read(storageKeys.base)) ? kept.read(storageKeys.base) : "start",
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
  return span === null ? null : factsOf(span.dataset);
};

export const canRead = (facts) => facts.pylon === "running" && facts.open;

export const { unreadable } = checkoutText({ el, checkout });
export const badge = (status) => el("span", { className: `badge badge-${status}`, title: status, textContent: statusLetters[status] });
export const counts = (additions, deletions) => additions === null ? el("span", { className: "dim small", textContent: "binary" })
  : el("span", { className: "lines" }, el("span", { className: "add", textContent: `+${additions}` }), " ", el("span", { className: "del", textContent: `−${deletions}` }));
