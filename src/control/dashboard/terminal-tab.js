import { afterSwap, chunk, holdReload } from "./page.js";
import { factsNow, thread } from "./checkout.js";
import { activeTab, showTab, tabShows, tabsBar, terminalTab } from "./tab-bar.js";

/** The Terminal tab shows while the thread is open, so an archive hides it and an unarchive brings it back. */
function terminalFollows() {
  const tab = tabsBar?.querySelector('[data-tab="term"]');
  const facts = factsNow();
  if (tab == null || facts === null) return;
  tab.hidden = !facts.open;
  if (tab.hidden && activeTab === terminalTab) showTab(null, "replace");
}
afterSwap(terminalFollows);

// The terminal tab attaches on its first show, as `nexus attach` does, and stays attached while the reader looks at
// other tabs, so it holds the pylon awake as an attached terminal does until it is detached or the page closes. A
// terminal that ends on its own keeps its last screen until the next attach replaces it.
let terminal = null;
let lastTerminal = null;
/** The terminal the next attach lands in, in place of the Claude worker's. */
let landing = null;
holdReload(() => terminal !== null);
/**
 * Each clipboard notice line's fade, across attaches. A write that did not land has its own line, so output in the
 * pylon cannot hide the notice of one that did.
 */
const fading = new Map();

/**
 * Shows the session in the terminal at `address` in the terminal tab, which shows one terminal at a time: an attached one detaches, and
 * the tab attaches again there. herdr-app shows every session of the pylon at once.
 */
export async function showSession(thread, address) {
  landing = address;
  (await terminal)?.close();
  showTab(terminalTab);
}

export async function showTerminal() {
  if (terminal !== null) return terminal.then((t) => t?.focus());
  const status = document.getElementById("term-status");
  const again = document.getElementById("term-again");
  const detach = document.getElementById("term-detach");
  const shown = ({ text, over }) => {
    status.textContent = text ?? "";
    again.hidden = !over;
    detach.hidden = over;
    if (over) terminal = null;
  };
  shown({ text: "Attaching…", over: false });
  const copied = (text, landed) => {
    const line = document.getElementById(landed ? "term-copied" : "term-refused");
    line.textContent = text;
    line.hidden = false;
    clearTimeout(fading.get(line.id));
    fading.set(line.id, setTimeout(() => { line.hidden = true; }, 15_000));
  };
  const address = landing;
  landing = null;
  terminal = chunk(import("./term-view.js")).then(({ openTerminal }) => {
    lastTerminal?.close();
    document.getElementById("term-host").replaceChildren();
    lastTerminal = openTerminal(document.getElementById("term-host"), thread, shown, address, copied);
    return lastTerminal;
  }).catch((err) => {
    shown({ text: `The terminal did not load: ${err.message}`, over: true });
    return null;
  });
  const opened = await terminal;
  detach.onclick = () => opened?.close();
  again.onclick = () => { void showTerminal(); };
  opened?.focus();
}
tabShows.terminal = showTerminal;
