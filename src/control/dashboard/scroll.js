/** Whether a scroller shows its end, give or take a line. */
export const atEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;

/**
 * Keeps a scroller at its end for as long as the reader leaves it there: while the conversation grows, and while the
 * scroller shrinks under it, as when the dock gains a card, the composer a line or a phone its keyboard. A reader who
 * scrolls up, or opens a fold at the end, keeps their place until they scroll back to the end. `observe` calls its
 * argument whenever the scroller changes size.
 */
export function endFollower(el, observe) {
  let following = true;
  const toEnd = () => { el.scrollTop = el.scrollHeight; };
  // A hidden scroller reads as empty, which says nothing of where the reader left it.
  const read = () => { if (!el.hidden) following = atEnd(el); };
  el.addEventListener("scroll", read);
  // A fold that opens grows the content without scrolling, and its toggle does not bubble.
  el.addEventListener("toggle", read, true);
  observe(() => { if (following) toEnd(); });
  return {
    get following() { return following; },
    /** Scrolls to the end, as after the reader sent a message, and follows it from there. */
    toEnd() {
      following = true;
      toEnd();
    },
    /** Goes back to the end if the reader was following it, as when the scroller shows again after a change. */
    settle() { if (following) toEnd(); },
  };
}
