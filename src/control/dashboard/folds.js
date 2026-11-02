// Which fold a click opens or closes, as the reader's own choice. A click whose default a handler prevented, such as
// a card's title that opens the preview instead, toggles nothing, so it records nothing.
export function toggledBy(event) {
  if (event.defaultPrevented) return null;
  const details = event.target instanceof Element ? event.target.closest("summary")?.parentElement : null;
  if (!(details instanceof HTMLDetailsElement) || details.id === "") return null;
  return { details, open: !details.open };
}
