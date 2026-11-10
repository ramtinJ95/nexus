// The sidebar: a drawer on a phone, and above a phone's width a column the reader can fold away. The device keeps the
// fold, which view.ts's themeScript names on <html> before the first paint.
import { kept, narrow, storageKeys } from "./contract.ts";

const folded = () => document.documentElement.dataset.side === "folded";

/** Tells each bar's menu button whether the threads show: a phone's open drawer, or a wider window's unfolded column. */
export function syncMenu() {
  const shown = matchMedia(narrow).matches ? document.body.dataset.open === "side" : !folded();
  for (const button of document.querySelectorAll(".bar .menu")) button.setAttribute("aria-expanded", String(shown));
}

function fold(on) {
  if (on) document.documentElement.dataset.side = "folded";
  else delete document.documentElement.dataset.side;
  kept.write(storageKeys.side, on ? "folded" : null);
  syncMenu();
}
export const toggleFold = () => fold(!folded());

/** Shows the threads, so the filter can take focus. */
export function revealSide() {
  if (matchMedia(narrow).matches) {
    document.body.dataset.open = "side";
    syncMenu();
  } else if (folded()) fold(false);
}

matchMedia(narrow).addEventListener("change", syncMenu);
syncMenu();
