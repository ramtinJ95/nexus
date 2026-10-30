// xterm.js for the thread page's terminal tab, which client.js loads on the tab's first show.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import css from "@xterm/xterm/css/xterm.css";
import { attachUrl, clipboardOf, keepAttached, keyFor, landing } from "./terminal.js";
import { onThemeChange, themeValue } from "./theme.js";

const base = new CSSStyleSheet();
base.replaceSync(css);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, base];

/**
 * The page's content security policy blocks <style> elements, and xterm.js writes its theme and cell sizes into
 * them, so each one's rules go into a constructed sheet, which the policy allows. xterm.js appends them to its screen
 * element, beside the rows it rewrites on every frame, so only the screen's own children and each style's text are
 * watched. Returns what stops it.
 */
function adoptStyles(screen) {
  const sheets = new Map();
  const copied = new Map();
  const copy = () => {
    for (const style of screen.querySelectorAll(":scope > style")) {
      if (!sheets.has(style)) {
        sheets.set(style, new CSSStyleSheet());
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheets.get(style)];
        watch.observe(style, { subtree: true, childList: true, characterData: true });
      }
      if (copied.get(style) === style.textContent) continue;
      sheets.get(style).replaceSync(style.textContent);
      copied.set(style, style.textContent);
    }
  };
  const watch = new MutationObserver(copy);
  watch.observe(screen, { childList: true });
  copy();
  return () => {
    watch.disconnect();
    const ours = new Set(sheets.values());
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => !ours.has(sheet));
  };
}

const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
/** The shown theme's terminal colours in xterm.js's terms. */
function terminalTheme() {
  const colors = themeValue("--term-ansi").split(/\s+/);
  return {
    background: themeValue("--term-bg"), foreground: themeValue("--term-text"), cursor: themeValue("--term-cursor"),
    selectionBackground: themeValue("--term-selection"), selectionForeground: themeValue("--term-selection-text"),
    ...Object.fromEntries(ansi.flatMap((name, i) => [[name, colors[i]], [`bright${name[0].toUpperCase()}${name.slice(1)}`, colors[i + 8]]])),
  };
}

/** Opens a link in the terminal, a URL or an OSC 8 hyperlink, in a new tab without xterm.js's confirm. */
const openLink = (event, uri) => window.open(uri, "_blank", "noopener");

/**
 * A terminal in `host` attached to the thread's pylon, landing in `pane` when it is not null, and fitted to `host`
 * whenever it shows at a new size. An attach again after a drop lands where any attach does. `landed()` waits for the
 * current connection to land, as landing says.
 */
export function openTerminal(host, thread, status, pane) {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: getComputedStyle(host).fontFamily,
    theme: terminalTheme(),
    macOptionClickForcesSelection: true,
    linkHandler: { activate: openLink },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new ClipboardAddon(undefined, clipboardOf(navigator.clipboard)));
  term.loadAddon(new WebLinksAddon(openLink));
  // A keypress xterm.js still saw would send a CR of its own, so every event of the key stops here.
  term.attachCustomKeyEventHandler((event) => {
    const bytes = keyFor(event);
    if (bytes === undefined) return true;
    if (event.type === "keydown") {
      term.input(bytes);
      event.preventDefault();
    }
    return false;
  });
  term.open(host);
  const unstyle = adoptStyles(host.querySelector(".xterm-screen"));
  fit.fit();
  const lands = landing(term);
  let first = pane;
  const detach = keepAttached(term, () => {
    const socket = new WebSocket(attachUrl(location, thread, { cols: term.cols, rows: term.rows }, first));
    first = null;
    return socket;
  }, (s) => {
    lands.heard(s);
    status(s);
  });
  const sized = new ResizeObserver(() => { if (host.offsetParent !== null) fit.fit(); });
  sized.observe(host);
  const unwatch = onThemeChange(() => { term.options.theme = terminalTheme(); });
  return {
    focus: () => term.focus(),
    landed: lands.landed,
    close() {
      sized.disconnect();
      unwatch();
      detach();
      term.dispose();
      unstyle();
    },
  };
}
