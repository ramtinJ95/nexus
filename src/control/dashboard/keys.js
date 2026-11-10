// The page's keyboard: the arrow keys move between a tab list's tabs, and ? opens the list of the page's shortcuts.
import { typing } from "./find.js";
import { chunk } from "./page.js";

const overlay = document.getElementById("keys");
let shortcuts = null;

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tab = event.target instanceof Element ? event.target.closest('[role="tablist"] [role="tab"]') : null;
  const tabs = tab === null ? [] : [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')].filter((t) => !t.hidden);
  const at = tabs.indexOf(tab);
  const to = tab === null ? undefined : { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (to !== undefined) {
    event.preventDefault();
    tabs.at(to % tabs.length).focus();
  } else if (event.key === "?" && overlay !== null && !typing(event.target) && document.querySelector("dialog[open]") === null) {
    event.preventDefault();
    shortcuts ??= chunk(import("./shortcuts.js")).catch(() => { shortcuts = null; });
    void shortcuts.then((m) => m?.showKeys());
  }
});
