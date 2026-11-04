// The Cluster page's switch between nodes, which client.js loads with the node cards: a plain click on another node's
// name, as a click on its card is, shows that node in place from its page, `/nodes/<name>`, read as the poll reads it,
// so the graphs keep their frame and nothing else loads again. Back and forward switch the same way.
import { readPage, swap } from "./page.js";

const detail = document.querySelector(".node-detail");
const heading = detail.querySelector(".node-detail-h");
const crumb = document.querySelector(".crumb h1");
const graphs = document.getElementById("node-graphs");
// Focus stays on the name the reader picked, so the heading that names the shown node says the switch.
heading.setAttribute("aria-live", "polite");

let shown = location.pathname;
let asked = 0;

/** Marks `node`'s card picked, and names it in the headings and the graphs. */
function pick(node) {
  for (const card of document.querySelectorAll(".node-card")) {
    const picked = card.dataset.node === node;
    card.classList.toggle("picked", picked);
    const link = card.querySelector(".node-card-h a");
    if (picked) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  crumb.textContent = node;
  // A screen reader says the live heading on each write.
  if (heading.textContent !== node) heading.textContent = node;
  // The graphs load again on any write of their node, even the same one.
  if (graphs.dataset.node !== node) graphs.dataset.node = node;
}

/**
 * Shows the Cluster page at `url` in place, or loads it when it can't be read, as for a node that is gone. The probe's
 * read can take a while, so the card is picked and the detail marked loading at once.
 */
async function show(url) {
  const ask = ++asked;
  shown = url.pathname;
  // `/cluster` names no node until it comes.
  const link = [...document.querySelectorAll(".node-card-h a")].find((a) => a.getAttribute("href") === url.pathname);
  if (link !== undefined) pick(link.closest(".node-card").dataset.node);
  detail.setAttribute("aria-busy", "true");
  let next;
  try {
    next = await readPage(url);
  } catch {
    if (ask === asked) location.replace(url.href);
    return;
  }
  if (ask !== asked) return;
  document.title = next.title;
  swap([...next.querySelectorAll("[data-live]")].map((fresh) => [document.getElementById(fresh.id), fresh.innerHTML]));
  // Cards the server sends as it last did are not swapped, so they keep the pick made above until it is made again.
  pick(next.getElementById("node-graphs").dataset.node);
  detail.removeAttribute("aria-busy");
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest(".node-card-h a") : null;
  if (link === null) return;
  const url = new URL(link.href);
  if (url.pathname === location.pathname) return;
  event.preventDefault();
  history.pushState(null, "", url);
  void show(url);
});
addEventListener("popstate", () => {
  if (location.pathname !== shown) void show(new URL(location.href));
});
