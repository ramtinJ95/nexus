// The home page's two sides: the phone's switch between Needs you and the work in flight, the way the stack lists the
// work, and the preview, which the page renders from `?peek=` so a poll keeps it fresh. Picking a line swaps the
// preview in place without leaving home. Work in Needs you previews in its card instead: picking its line brings the
// card into view, as a notice's link does, and opening the card reads its latest reply into it.
import { afterSwap, refreshAfter, refreshNow, toggled } from "./page.js";
import { needSelectors } from "./notifications.js";
import { narrow } from "./contract.ts";

const split = document.getElementById("split");
const phone = matchMedia(narrow);
const viewKey = "nexus.flight-view";

const cardOf = (key) => document.querySelector(`.need[data-thread="${key}"],.need[data-peek-key="${key}"]`);
const keyOf = (card) => card.dataset.thread ?? card.dataset.peekKey;

/** Brings work's card in Needs you into view, opened and marked, as a notice's link does. */
function pick(card) {
  document.getElementById("side-needs").checked = true;
  for (const picked of document.querySelectorAll(".need.picked")) picked.classList.remove("picked");
  card.classList.add("picked");
  // Opened as the reader's own toggle is, so a poll's swap keeps it open.
  const fold = card.querySelector(".need-fold");
  if (fold) toggled.set(fold.id, fold.open = true);
  card.scrollIntoView({ block: "start" });
  card.focus({ preventScroll: true });
}

/** Previews `key`, or for work in Needs you picks its card, `card` naming which of a thread's cards so a poll keeps it. */
function peek(key, card) {
  const url = new URL(location.href);
  if (key === "") url.searchParams.delete("peek");
  else url.searchParams.set("peek", key);
  if (card) url.searchParams.set("card", card);
  else url.searchParams.delete("card");
  if (url.href === location.href) return;
  history.replaceState(history.state, "", url);
  split.classList.toggle("peeking", key !== "" && !cardOf(key));
  for (const row of document.querySelectorAll(".fl-row")) {
    if (row.dataset.peek === key) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
  void refreshAfter();
}

if (split !== null) {
  const view = document.getElementById(`view-${localStorage.getItem(viewKey)}`);
  if (view !== null) view.checked = true;
  /**
   * Brings the inbox card a notice opened into view, or the inbox when that card is gone. A notice can come before the
   * poll that brings its card, so the page is read once more before it settles for the inbox.
   */
  const showSide = async () => {
    const side = location.hash === "#in-flight" ? "flight" : location.hash.startsWith("#needs-you") ? "needs" : null;
    if (side !== null) document.getElementById(`side-${side}`).checked = true;
    const selectors = needSelectors(location.hash);
    if (selectors === null) return;
    const find = () => selectors.map((s) => document.querySelector(s)).find((found) => found !== null);
    const at = location.href;
    if (!find()) await refreshNow();
    // The reader's own pick while the page was read again stands.
    if (location.href !== at) return;
    const card = find();
    pick(card ?? document.getElementById("needs-you"));
    // Picking the card is what reads its latest reply into it.
    if (card) peek(keyOf(card), card.id);
  };
  void showSide();
  addEventListener("hashchange", showSide);
  // A link to work in Needs you, opened afresh, brings the card the server picked for it into view, and names that
  // card's work in the address, as an item that became a thread is the thread's work.
  const picked = document.querySelector(".need.picked");
  if (picked && !location.hash.startsWith("#needs-you")) {
    pick(picked);
    peek(keyOf(picked), new URL(location.href).searchParams.has("card") && picked.id);
  }
  // A link to the hash the page is already at fires no hashchange.
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest('a[href^="/#needs-you"]') !== null) document.getElementById("side-needs").checked = true;
  });
  addEventListener("change", ({ target }) => { if (target.name === "flight-view") localStorage.setItem(viewKey, target.value); });

  split.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a[data-peek]");
    const opening = event.target.closest(".need-sum");
    // Only the reader's opening of a card picks it: a poll's swap reopens folds too, and picks nothing.
    if (link === null && opening !== null && !opening.parentElement.open) {
      const need = opening.closest(".need");
      if (keyOf(need) !== undefined) peek(keyOf(need), need.id);
    }
    if (link === null || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    // On a phone a Needs you card's thread link opens the thread, as the card it heads is the preview there.
    const head = link.closest(".need-sum");
    if (head !== null && phone.matches && link.getAttribute("href").startsWith("/threads/")) return;
    event.preventDefault();
    if (head !== null) {
      const fold = head.parentElement;
      if (!fold.open) head.click();
    }
    const card = head === null && cardOf(link.dataset.peek);
    if (card) pick(card);
    peek(link.dataset.peek, head?.closest(".need").id);
  });
  // A card that goes, as its answer takes it off, leaves its work's preview to show.
  afterSwap(() => split.classList.toggle("peeking", document.getElementById("peek").childElementCount > 0));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !split.classList.contains("peeking") || document.querySelector("dialog[open]") !== null) return;
    peek("");
  });
}
