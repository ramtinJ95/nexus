// The page's theme, a block of style.css named on <html> as data-theme. dashboard.ts's head script names the stored
// one before the first paint, and this follows the sidebar's picker and toggle, the device and the reader's other tabs.

const key = "nexus.theme";
/** The dark theme the toggle goes back to, so a reader of Tokyo Night who toggles twice is back in Tokyo Night. */
const darkKey = "nexus.theme.dark";

/** The theme a choice shows: itself, or the device's light or dark for System. */
export const shown = (choice, deviceDark) => choice !== "system" ? choice : deviceDark ? "dark" : "light";

/** What the toggle picks from a theme of `scheme`: light from any dark theme, and the last dark one from light. */
export const toggled = (scheme, lastDark) => scheme === "dark" ? "light" : lastDark ?? "dark";

/** A value of the shown theme's colours, such as `--term-bg`. */
export const themeValue = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Calls `changed` each time the shown theme changes, until the returned stop. */
export function onThemeChange(changed) {
  const watch = new MutationObserver(changed);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => watch.disconnect();
}

export function startThemes() {
  const picker = document.getElementById("theme");
  const toggle = document.getElementById("theme-toggle");
  if (picker === null || toggle === null) return;
  const root = document.documentElement;
  const deviceDark = matchMedia("(prefers-color-scheme: dark)");
  const choices = new Set([...picker.options].map((option) => option.value));
  const scheme = () => getComputedStyle(root).colorScheme;
  const apply = () => {
    const stored = localStorage.getItem(key);
    const choice = choices.has(stored) ? stored : "system";
    picker.value = choice;
    const theme = shown(choice, deviceDark.matches);
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
    const label = scheme() === "dark" ? "Switch to the light theme" : "Switch to a dark theme";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  };
  const choose = (choice) => {
    if (choice === "system") localStorage.removeItem(key);
    else localStorage.setItem(key, choice);
    apply();
    if (choice !== "system" && scheme() === "dark") localStorage.setItem(darkKey, choice);
  };
  picker.addEventListener("change", () => choose(picker.value));
  toggle.addEventListener("click", () => choose(toggled(scheme(), localStorage.getItem(darkKey))));
  deviceDark.addEventListener("change", apply);
  addEventListener("storage", (event) => { if (event.key === key) apply(); });
  apply();
}
