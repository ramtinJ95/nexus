// xterm.js for the thread page's terminal tab, which client.js loads on the tab's first show.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import css from "@xterm/xterm/css/xterm.css";
import { attachUrl, clipboardOf, keepAttached, keyFor, linkText, opensLink, refusalUrl } from "./terminal.js";
import { onThemeChange, themeValue } from "./theme.js";
import { refusalAt } from "./request.js";
import { styleAdopter } from "./term-styles.js";

const base = new CSSStyleSheet();
base.replaceSync(css);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, base];

const { adoptStyles } = styleAdopter();

const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
function terminalTheme() {
  const colors = themeValue("--term-ansi").split(/\s+/);
  return {
    background: themeValue("--term-bg"), foreground: themeValue("--term-text"), cursor: themeValue("--term-cursor"),
    selectionBackground: themeValue("--term-selection"), selectionForeground: themeValue("--term-selection-text"),
    ...Object.fromEntries(ansi.flatMap((name, i) => [[name, colors[i]], [`bright${name[0].toUpperCase()}${name.slice(1)}`, colors[i + 8]]])),
  };
}

/** Opens a link in the terminal in a new tab. A printed URL is its own text, so it opens without xterm.js's confirm. */
const openLink = (event, uri) => window.open(uri, "_blank", "noopener");

/**
 * A terminal in `host` attached to the thread's pylon, landing in `pane` when it is not null, and fitted to `host`
 * whenever it shows at a new size. An attach again after a drop lands as the first one did. `told` hears what each
 * clipboard write from the pylon did.
 */
export function openTerminal(host, thread, status, pane, told) {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: getComputedStyle(host).fontFamily,
    theme: terminalTheme(),
    macOptionClickForcesSelection: true,
    linkHandler: { activate: (event, uri, range) => { if (opensLink(uri, linkText(term.buffer.active, range), confirm)) openLink(event, uri); } },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new ClipboardAddon(undefined, clipboardOf(navigator.clipboard, () => document.hasFocus() && host.contains(document.activeElement), told)));
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
  const detach = keepAttached(term, () => new WebSocket(attachUrl(location, thread, { cols: term.cols, rows: term.rows }, pane)), status, document, (socket) => refusalAt(refusalUrl(socket.url)));
  const sized = new ResizeObserver(() => { if (host.offsetParent !== null) fit.fit(); });
  sized.observe(host);
  const unwatch = onThemeChange(() => { term.options.theme = terminalTheme(); });
  return {
    focus: () => term.focus(),
    close() {
      sized.disconnect();
      unwatch();
      detach();
      term.dispose();
      unstyle();
    },
  };
}
