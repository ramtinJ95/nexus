// The home page's two sides: the phone's switch between Needs you and the work in flight, the way the stack lists the
// work, and the preview, which the page renders from `?peek=` so a poll keeps it fresh. Picking a line, or opening a
// Needs you card on a desk, swaps the preview in place without leaving home.
import { refreshAfter } from "./page.js";

const split = document.getElementById("split");
const desk = matchMedia("(min-width: 761px)");
const viewKey = "nexus.flight-view";

function peek(key) {
  const url = new URL(location.href);
  if (key === "") url.searchParams.delete("peek");
  else url.searchParams.set("peek", key);
  if (url.href === location.href) return;
  history.replaceState(history.state, "", url);
  split.classList.toggle("peeking", key !== "");
  for (const row of document.querySelectorAll(".fl-row")) {
    if (row.dataset.peek === key) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
  void refreshAfter();
}

if (split !== null) {
  const view = document.getElementById(`view-${localStorage.getItem(viewKey)}`);
  if (view !== null) view.checked = true;
  const showFlight = () => { if (location.hash === "#in-flight") document.getElementById("side-flight").checked = true; };
  showFlight();
  addEventListener("hashchange", showFlight);
  addEventListener("change", ({ target }) => { if (target.name === "flight-view") localStorage.setItem(viewKey, target.value); });

  split.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a[data-peek]");
    const opening = event.target.closest(".need-sum");
    // Only the reader's opening of a card previews it on a desk: a poll's swap reopens folds too, and picks nothing.
    if (link === null && opening !== null && desk.matches && !opening.parentElement.open) {
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
    peek(link.dataset.peek);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !split.classList.contains("peeking") || document.querySelector("dialog[open]") !== null) return;
    peek("");
  });
}
