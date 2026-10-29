// xterm.js for the thread page's terminal tab, which client.js loads on the tab's first show.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import css from "@xterm/xterm/css/xterm.css";
import { attachUrl, joinTerminal } from "./terminal.js";

const base = new CSSStyleSheet();
base.replaceSync(css);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, base];

/**
 * The page's content security policy blocks <style> elements, and xterm.js writes its theme and cell sizes into
 * them, so each one's rules go into a constructed sheet, which the policy allows. Returns what stops it.
 */
function adoptStyles(host) {
  const sheets = new Map();
  const copy = () => {
    for (const style of host.querySelectorAll("style")) {
      if (!sheets.has(style)) {
        sheets.set(style, new CSSStyleSheet());
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheets.get(style)];
      }
      sheets.get(style).replaceSync(style.textContent);
    }
  };
  const watch = new MutationObserver(copy);
  watch.observe(host, { subtree: true, childList: true, characterData: true });
  copy();
  return () => {
    watch.disconnect();
    const ours = new Set(sheets.values());
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => !ours.has(sheet));
  };
}

/** A terminal in `host` attached to the thread's pylon, fitted to `host` whenever it shows at a new size. */
export function openTerminal(host, thread, status) {
  const unstyle = adoptStyles(host);
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: getComputedStyle(host).fontFamily,
    // A terminal reads as one in both of the page's themes, and Herdr and Claude Code draw for a dark one.
    theme: { background: "#16181d", foreground: "#e3e5e8", cursor: "#e3e5e8", selectionBackground: "#3b4252" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  const detach = joinTerminal(term, new WebSocket(attachUrl(location, thread, { cols: term.cols, rows: term.rows })), status);
  const sized = new ResizeObserver(() => { if (host.offsetParent !== null) fit.fit(); });
  sized.observe(host);
  return {
    focus: () => term.focus(),
    close() {
      sized.disconnect();
      detach();
      term.dispose();
      unstyle();
    },
  };
}
