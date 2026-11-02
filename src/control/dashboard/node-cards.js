// The Cluster page's node cards, which client.js loads when the page has them: a click anywhere on a card picks its
// node, as its name link would, but for a click on a link or button of its own, which keeps doing its own thing, and
// the click that ends selecting the card's text. A click on the picked card picks nothing, so a double-click there
// selects a word rather than reloading the page.
function pickedLink(event, selection) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if (!(event.target instanceof Element) || event.target.closest("a, button") !== null) return null;
  if (selection !== null && !selection.isCollapsed) return null;
  const card = event.target.closest(".node-card");
  return card === null || card.matches(".picked") ? null : card.querySelector(".node-card-h a");
}

document.addEventListener("click", (event) => pickedLink(event, getSelection())?.click());
