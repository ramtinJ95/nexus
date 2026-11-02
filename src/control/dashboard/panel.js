// The panels: the pipeline, usage, health and a node's page, which a sidebar link opens over the page the reader is on,
// so a thread's conversation stays where it was. The panel is the page's own main column, read again each poll while it
// is open. Each of them is also a page at its own address, which a reader who opens it in a new tab gets. client.js
// loads this on the first panel link the reader follows.
import { el, pollMs } from "./page.js";

const sheet = document.getElementById("sheet");
const panelPath = /^\/(?:pipeline|usage|health|nodes\/[^/]+)$/;
let shown = null;
let opener = null;
let healthSeen = false;

const isOpen = () => document.body.dataset.open === "sheet";

/** The fetched page's main column, made to sit inside this page without taking the ids or regions of the page's own. */
function panelOf(doc, url) {
  const main = doc.querySelector("main");
  if (main === null) throw new Error("the control plane answered with no page");
  for (const node of main.querySelectorAll("[id]")) {
    const same = document.getElementById(node.id);
    if (same !== null && !sheet.contains(same)) node.removeAttribute("id");
  }
  for (const node of main.querySelectorAll("[data-live]")) delete node.dataset.live;
  // A link to another panel, such as a usage filter or a node, opens there too.
  for (const link of main.querySelectorAll("a[href]")) if (panelPath.test(new URL(link.getAttribute("href"), location.href).pathname)) link.dataset.panel = "";
  for (const node of main.querySelectorAll(".bar .menu, .bar .phone-only")) node.remove();
  // A node's graphs draw with uPlot on the node's own page, which a link opens.
  main.querySelector("#node-graphs")?.replaceWith(el("p", { className: "sheet-more" }, "The 31-day graphs draw on ", el("a", { className: "link", href: url.pathname, textContent: "the node's own page" }), "."));
  return main;
}

async function load(url) {
  const res = await fetch(url, { headers: { accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(pollMs * 2) });
  if (!res.ok) throw new Error(`the control plane answered ${res.status}`);
  const main = panelOf(new DOMParser().parseFromString(await res.text(), "text/html"), url);
  if (shown?.href !== url.href || !isOpen()) return;
  const top = sheet.querySelector(".scroll")?.scrollTop ?? 0;
  const focused = sheet.contains(document.activeElement) && document.activeElement.id !== "" ? document.activeElement.id : null;
  sheet.replaceChildren(...main.childNodes);
  const scroller = sheet.querySelector(".scroll");
  if (scroller !== null) scroller.scrollTop = top;
  if (focused !== null) document.getElementById(focused)?.focus({ preventScroll: true });
  if (url.pathname === "/health" && !healthSeen) {
    healthSeen = true;
    void import("./health.js").then((m) => m.markHealthSeen());
  }
}

/** Opens the panel at `url` over the page, as client.js does for a panel link. */
export async function open(url) {
  opener = document.activeElement;
  shown = url;
  sheet.setAttribute("aria-label", url.pathname.slice(1).split("/")[0]);
  sheet.replaceChildren(el("p", { className: "empty sheet-loading", textContent: "Loading…" }));
  document.body.dataset.open = "sheet";
  for (const link of document.querySelectorAll(".side-nav a, .nodes a")) link.classList.toggle("active", link.pathname === url.pathname);
  try {
    await load(url);
    sheet.focus({ preventScroll: true });
  } catch (err) {
    sheet.replaceChildren(el("p", { className: "error sheet-loading", textContent: `The panel could not be read: ${err.message}` }));
  }
}

if (sheet !== null) {
  sheet.tabIndex = -1;
  // The panel's own close link goes home on its own page, and here gives the page back.
  sheet.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || event.target.closest(".bar-close") === null) return;
    event.preventDefault();
    delete document.body.dataset.open;
  });
  new MutationObserver(() => {
    if (isOpen() || shown === null) return;
    shown = null;
    sheet.replaceChildren();
    for (const link of document.querySelectorAll(".side-nav a, .nodes a")) link.classList.toggle("active", link.getAttribute("aria-current") === "page");
    if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
  }).observe(document.body, { attributes: true, attributeFilter: ["data-open"] });
  setInterval(() => {
    if (shown !== null && isOpen() && document.visibilityState === "visible") void load(shown).catch(() => {});
  }, pollMs);
}
