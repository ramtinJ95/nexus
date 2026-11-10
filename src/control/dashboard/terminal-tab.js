import { request } from "./request.js";
import { pylonRoutes } from "../../contract/pylon.ts";
import { afterSwap, chunk, holdReload } from "./page.js";
import { factsNow, thread } from "./checkout.js";
import { activeTab, showTab, tabShows, tabsBar, terminalTab } from "./tab-bar.js";

/** The Terminal tab shows while the thread is open, so an archive hides it and an unarchive brings it back. */
function terminalFollows() {
  const tab = tabsBar?.querySelector('[data-tab="term"]');
  const facts = factsNow();
  if (tab == null || facts === null) return;
  tab.hidden = !facts.open;
  if (tab.hidden && activeTab === terminalTab) showTab(null);
}
afterSwap(terminalFollows);

// The terminal tab attaches on its first show, as `nexus attach` does, and stays attached while the reader looks at
// other tabs, so it holds the pylon awake as an attached terminal does until it is detached or the page closes. A
// terminal that ends on its own keeps its last screen until the next attach replaces it.
let terminal = null;
let lastTerminal = null;
/** The pane the next attach lands in, in place of the Claude worker's. */
let landing = null;
holdReload(() => terminal !== null);

/**
 * Shows `pane` in the terminal tab. A terminal that is not attached attaches there. An attached one has Herdr focus
 * it, which moves every terminal attached to the pylon, once its current connection has landed, so that an attach or
 * a reattach does not undo it.
 */
export async function showSession(thread, pane) {
  const opened = await terminal;
  if (opened != null && await opened.landed()) await request(pylonRoutes.focusSession, { thread, session: pane });
  else landing = pane;
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
  // A write that did not land has its own line, so output in the pylon cannot hide the notice of one that did.
  const fading = new Map();
  const copied = (text, landed) => {
    const line = document.getElementById(landed ? "term-copied" : "term-refused");
    line.textContent = text;
    line.hidden = false;
    clearTimeout(fading.get(line.id));
    fading.set(line.id, setTimeout(() => { line.hidden = true; }, 15_000));
  };
  const pane = landing;
  landing = null;
  terminal = chunk(import("./term-view.js")).then(({ openTerminal }) => {
    lastTerminal?.close();
    document.getElementById("term-host").replaceChildren();
    lastTerminal = openTerminal(document.getElementById("term-host"), thread, shown, pane, copied);
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
