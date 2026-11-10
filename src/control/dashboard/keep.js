// A swap that keeps a region's `data-keep` element, so a textarea keeps its undo, composition, scroll and focus.

/**
 * Puts the fresh fragment's nodes in the region. The `data-keep` element whose counterpart, by the same ID, the fragment
 * holds stays in the document: each node from the region down to it takes the fresh node's attributes, and every
 * child but the one on the way down is replaced. The kept element takes only the attributes. Without that counterpart,
 * or with a node on the way down that is not the fresh one's, the region takes the fragment's nodes whole.
 */
export function swapKeeping(region, fresh) {
  const chain = keptChain(region, fresh);
  if (chain === null) return replaceChildren(region, fresh, null, null);
  for (const [i, [live, next]] of chain.entries()) {
    if (i > 0) syncAttributes(live, next);
    const child = chain[i + 1];
    if (child !== undefined) replaceChildren(live, next, child[0], child[1]);
  }
}

/** The pairs of live and fresh nodes from the region and fragment down to the kept element, or null. */
function keptChain(region, fresh) {
  const kept = region.querySelector("[data-keep]");
  const next = fresh.querySelector("[data-keep]");
  if (kept === null || next === null || kept.id === "" || kept.id !== next.id) return null;
  const chain = [];
  let live = kept;
  let node = next;
  for (; live !== region && node !== fresh; live = live.parentNode, node = node.parentNode) {
    if (live.localName !== node.localName || (node.id !== "" && node.id !== live.id)) return null;
    chain.unshift([live, node]);
  }
  return live === region && node === fresh ? [[region, fresh], ...chain] : null;
}

function syncAttributes(live, next) {
  for (const name of live.getAttributeNames()) if (next.getAttribute(name) === null) live.removeAttribute(name);
  for (const name of next.getAttributeNames()) if (live.getAttribute(name) !== next.getAttribute(name)) live.setAttribute(name, next.getAttribute(name));
}

/** Gives `live` the children of `next` in order, keeping `stay` in place of `standIn`, its counterpart among them. */
function replaceChildren(live, next, stay, standIn) {
  for (const child of [...live.childNodes]) if (child !== stay) child.remove();
  const children = [...next.childNodes];
  const at = children.indexOf(standIn);
  for (const [i, child] of children.entries()) {
    if (i < at) live.insertBefore(child, stay);
    else if (i > at) live.insertBefore(child, null);
  }
}
