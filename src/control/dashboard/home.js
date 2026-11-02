// The home page's two sides: the phone's switch between Needs you and the work in flight, the way the stack lists the
// work, and the preview, which the page renders from `?peek=` so a poll keeps it fresh. Picking a line swaps the
// preview in place without leaving home. Work in Needs you previews in its card instead: picking its line brings the
// card into view, and opening the card reads its latest reply into it.
import { refreshAfter } from "./page.js";

const split = document.getElementById("split");
const desk = matchMedia("(min-width: 761px)");
const viewKey = "nexus.flight-view";

const carded = (key) => [...document.querySelectorAll(".need")].some((n) => (n.dataset.thread ?? n.dataset.peekKey) === key);

function peek(key, hash = "") {
  const url = new URL(location.href);
  if (key === "") url.searchParams.delete("peek");
  else url.searchParams.set("peek", key);
  if (hash !== "") url.hash = hash;
  const moved = url.href !== location.href;
  if (moved) history.replaceState(history.state, "", url);
  // A replaced hash fires no hashchange, which brings the card into view.
  if (hash !== "") dispatchEvent(new HashChangeEvent("hashchange"));
  if (!moved) return;
  split.classList.toggle("peeking", key !== "" && !carded(key));
  for (const row of document.querySelectorAll(".fl-row")) {
    if (row.dataset.peek === key) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
  void refreshAfter();
}

if (split !== null) {
  const view = document.getElementById(`view-${localStorage.getItem(viewKey)}`);
  if (view !== null) view.checked = true;
  const showSide = () => {
    const side = location.hash === "#in-flight" ? "flight" : location.hash.startsWith("#needs-you") ? "needs" : null;
    if (side !== null) document.getElementById(`side-${side}`).checked = true;
  };
  showSide();
  addEventListener("hashchange", showSide);
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
      const key = need.dataset.thread ?? need.dataset.peekKey;
      if (key !== undefined) peek(key);
    }
    if (link === null || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    // On a phone a Needs you card's thread link opens the thread, as the card it heads is the preview there.
    const head = link.closest(".need-sum");
    if (head !== null && !desk.matches && link.getAttribute("href").startsWith("/threads/")) return;
    event.preventDefault();
    if (head !== null) {
      const fold = head.parentElement;
      if (!fold.open) head.click();
    }
    // The card comes into view only once its side shows.
    if (link.hash.startsWith("#needs-you")) document.getElementById("side-needs").checked = true;
    peek(link.dataset.peek, link.hash);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !split.classList.contains("peeking") || document.querySelector("dialog[open]") !== null) return;
    peek("");
  });
}
