// The node a click on the Cluster page's card picks, as its name link would: a click anywhere on the card but on a
// link or button of its own, which keeps doing its own thing, and not the click that ends selecting the card's text.
export function pickedLink(event, selection) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if (!(event.target instanceof Element) || event.target.closest("a, button") !== null) return null;
  if (selection !== null && !selection.isCollapsed) return null;
  return event.target.closest(".node-card")?.querySelector(".node-card-h a") ?? null;
}
