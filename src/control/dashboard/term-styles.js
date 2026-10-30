// Copies xterm.js's style elements into constructed sheets. The page passes nothing and a test its fakes.
export function styleAdopter({ CSSStyleSheet, MutationObserver, document } = globalThis) {
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
  return { adoptStyles };
}
