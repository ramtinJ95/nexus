// The overlay that ? opens, which lists the shortcuts this page has. keys.js loads it on the first press.
import { kinds } from "./review.js";
import { el } from "./page.js";

const mac = /^(Mac|iP)/.test(navigator.platform);
const mod = mac ? "⌘" : "Ctrl";
const alt = mac ? "⌥" : "Alt";
const has = (selector) => document.querySelector(selector) !== null;

/** Each shortcut the client handles, as its keys, what it does and whether this page has what it acts on. */
const shortcuts = [
  { keys: ["?"], what: "Show these shortcuts", here: () => true },
  { keys: ["/"], what: "Filter threads", here: () => has("#filter") },
  { keys: [mod, "K"], what: "Go to a thread", here: () => has("#switcher") },
  { keys: ["N"], what: "Start a thread", here: () => has("#start-dialog") },
  { keys: [mod, "↵"], what: "Send the message, or the open form", here: () => has("#prompt, #start, #project") },
  { keys: [alt, "↵"], what: "Queue the message after the run", here: () => has("#queue") },
  { keys: ["←", "→", "Home", "End"], what: "Move between tabs, or to the first or the last", here: () => has('[role="tablist"]') },
  { keys: ["[", "]"], what: "In a diff, open the previous or the next changed file", here: () => has("#file-view") },
  { keys: ["J", "K"], what: "In a diff, move through its lines, with Shift to select them", here: () => has("#file-view") },
  { keys: Object.values(kinds).map((k) => k.key.toUpperCase()), what: `In a diff, note the selected lines: ${Object.values(kinds).map((k) => k.label.toLowerCase()).join(", ")}`, here: () => has("#file-view") },
  { keys: ["Esc"], what: "Close a dialog, a panel or a preview", here: () => true },
];

export function showKeys() {
  document.getElementById("keys-list").replaceChildren(...shortcuts.filter((s) => s.here()).flatMap((s) => [
    el("dt", {}, ...s.keys.map((key) => el("kbd", { textContent: key }))),
    el("dd", { textContent: s.what }),
  ]));
  document.getElementById("keys").showModal();
}
