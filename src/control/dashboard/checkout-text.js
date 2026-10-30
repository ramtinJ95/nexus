// What the changes pane and the diff say of the checkout: the bases they are read against, and why they cannot be
// read now.
/** What the changes are read against: its label, its commit when that is the empty tree, an empty list and a diff's. */
export const bases = {
  start: { label: "Since the pylon booted", emptyTree: "an empty repository", unchanged: "Nothing has changed since the pylon booted.", vs: "vs boot" },
  head: { label: "Since the last commit", emptyTree: "no commit yet", unchanged: "No uncommitted changes.", vs: "vs last commit" },
  turn: { label: "Since the latest turn began", emptyTree: "an empty repository", unchanged: "Nothing has changed since the latest turn began.", vs: "vs turn start" },
};
export function checkoutText({ el, checkout }) {
  /** Why `noun` of the checkout cannot be read now, with a button to wake the pylon when that is what it takes. */
  function unreadable(facts, noun, onWake) {
    const say = (text) => el("p", { className: "empty", textContent: text });
    if (facts.status === "deleted") return [say("The thread is deleted, so its checkout is gone.")];
    if (facts.status === "archived") return [say(`An archived thread's pylon stays paused, so ${noun} can't be read until the thread is unarchived.`)];
    if (checkout.wanted) return [say(`Waking the pylon to read ${noun}.`)];
    const wake = el("button", { type: "button", className: "btn btn-xs", textContent: "Wake and read" });
    wake.addEventListener("click", onWake);
    return [say(`The pylon is ${facts.pylon}. Reading ${noun} wakes it.`), wake];
  }
  return { unreadable };
}
