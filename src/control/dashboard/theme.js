// The page's theme, a block of style.css named on <html> as data-theme. view.ts's themeScript names the stored
// one before the first paint, and this follows the sidebar's picker and toggle, the device and the reader's other tabs.
import { kept, keeping, storageKeys } from "./contract.ts";

const { theme: key, darkTheme: darkKey } = storageKeys;

/** The theme a choice shows: itself, or the device's light or dark for System. */
export const shown = (choice, deviceDark) => choice !== "system" ? choice : deviceDark ? "dark" : "light";

/** What the toggle picks from a theme of `scheme`: light from any dark theme, and the last dark one from light. */
export const toggled = (scheme, lastDark) => scheme === "dark" ? "light" : lastDark ?? "dark";

export const themeValue = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function onThemeChange(changed) {
  const watch = new MutationObserver(changed);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => watch.disconnect();
}

/**
 * The person's choice and the last dark theme they picked, so a reader of Tokyo Night who toggles twice is back in
 * Tokyo Night. They are kept in `storage`, the page's localStorage by default, while it lets them and in memory for
 * the page's life when it refuses a read or a write.
 */
export function themeStore(storage) {
  const { read, write } = storage === undefined ? kept : keeping(() => storage);
  let choice = read(key) ?? "system";
  let lastDark = read(darkKey);
  return {
    get choice() { return choice; },
    get lastDark() { return lastDark; },
    pick(next) {
      choice = next;
      write(key, next === "system" ? null : next);
    },
    pickDark(next) {
      lastDark = next;
      write(darkKey, next);
    },
    /**
     * Takes another tab's change from its storage event, where clearing the storage names no key, and says whether
     * the shown theme may have changed.
     */
    heard(event) {
      if (event.key === darkKey) lastDark = event.newValue;
      else if (event.key === key) choice = event.newValue ?? "system";
      else if (event.key === null) [choice, lastDark] = ["system", null];
      return event.key === key || event.key === null;
    },
  };
}

export function startThemes() {
  const picker = document.getElementById("theme");
  const toggle = document.getElementById("theme-toggle");
  if (picker === null || toggle === null) return;
  const root = document.documentElement;
  const deviceDark = matchMedia("(prefers-color-scheme: dark)");
  const choices = new Set([...picker.options].map((option) => option.value));
  const scheme = () => getComputedStyle(root).colorScheme;
  const store = themeStore();
  const apply = () => {
    const choice = choices.has(store.choice) ? store.choice : "system";
    picker.value = choice;
    const theme = shown(choice, deviceDark.matches);
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
    const label = scheme() === "dark" ? "Switch to the light theme" : "Switch to a dark theme";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  };
  const choose = (choice) => {
    store.pick(choice);
    apply();
    if (choice !== "system" && scheme() === "dark") store.pickDark(choice);
  };
  picker.addEventListener("change", () => choose(picker.value));
  toggle.addEventListener("click", () => choose(toggled(scheme(), store.lastDark)));
  deviceDark.addEventListener("change", apply);
  addEventListener("storage", (event) => { if (store.heard(event)) apply(); });
  apply();
}
