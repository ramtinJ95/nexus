// Live change made visible: after a poll swaps a region, each row, tile or card in it whose text changed, or that is
// new, glows once and fades. Clocks and ages are left out of the comparison, so time passing never flashes.
import { onSwap } from "./page.js";

const units = ".row, .ov tbody tr, .kpi, .node-tile, .need, .pv, .side-link";

/** What changes on its own as time passes: clocks, and a row's or card's age. */
const ages = "time, .row-at, .need-at";

/** A unit's text without its clocks and ages. */
function textOf(el) {
  let text = "";
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(ages) !== null ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  while (walk.nextNode()) text += walk.currentNode.data;
  return text.replace(/\s+/g, " ").trim();
}

/** Where a unit is: its id, else its first link, else its place among its region's units. */
function keysOf(region) {
  const seen = new Map();
  const list = [...region.querySelectorAll(units)];
  return list.map((el, i) => {
    const base = el.id || el.getAttribute("href") || el.querySelector("a[href]")?.getAttribute("href") || `#${i}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [`${base}|${n}`, el];
  });
}

onSwap((regions) => {
  const before = new Map(regions.map((region) => [region.id, new Map(keysOf(region).map(([k, el]) => [k, textOf(el)]))]));
  return () => {
    for (const region of regions) {
      const was = before.get(region.id);
      if (was === undefined || was.size === 0) continue;
      for (const [k, el] of keysOf(region)) {
        if (was.get(k) === textOf(el)) continue;
        el.classList.remove("flash");
        // A second change before the first glow ends starts it again.
        void el.offsetWidth;
        el.classList.add("flash");
        el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
      }
    }
  };
});
