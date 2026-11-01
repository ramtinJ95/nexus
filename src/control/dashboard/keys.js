// The keyboard: the command palette (⌘K) and the keys that run the console's commands without it. Every command is a
// row of `commands`, so the palette, the keys, the key caps on the page, the status line and the ? sheet read one table.
// A command presses the page's own button or link where there is one, so it does exactly what a click does.
import { el, afterSwap } from "./page.js";
import { openProject, openStart } from "./dialogs.js";
import { pickPane, setOpen } from "./nav.js";
import { placeViews } from "./checkout.js";

const root = document.documentElement;
const main = document.querySelector("main");
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const $ = (selector, within = document) => within.querySelector(selector);
const typing = (node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement || node?.isContentEditable === true;
const shown = (node) => node !== null && node.offsetParent !== null;

/** The items j and k move through: the inbox's cards and every table's rows. */
const listItems = () => [...document.querySelectorAll("main .need, main .ov > tbody > tr")].filter(shown);
/**
 * What an action key acts on: the card or row under the cursor, or on a thread's page the thread. A list page with no
 * cursor has nothing to act on, so a key there never acts on its first card by chance.
 */
function scope() {
  const item = document.activeElement?.closest?.(".need, .ov > tbody > tr") ?? null;
  if (item !== null) return item;
  return $("#convo") !== null || $("#queued") !== null ? document : null;
}
/** Presses the first enabled control `selector` finds in the scope, or says there is none. */
const press = (selector, what) => () => {
  const button = [...(scope()?.querySelectorAll(selector) ?? [])].find((b) => !b.disabled);
  if (button === undefined) return say(scope() === null ? `Move to a card with j or k first, then ${what}` : `Nothing here to ${what}`);
  button.click();
};
const clicks = (selector, missing) => () => {
  const target = $(selector);
  if (target === null || target.hidden) return say(missing);
  target.click();
};

const panesKey = "nexus.panes";
const panes = () => new Set((root.dataset.panes ?? "").split(" ").filter(Boolean));
const narrow = () => matchMedia("(max-width: 760px)").matches;
function togglePane(flag) {
  const set = panes();
  if (!set.delete(flag)) set.add(flag);
  root.dataset.panes = [...set].join(" ");
  try { localStorage.setItem(panesKey, root.dataset.panes); } catch {}
  placeViews();
  markSplit();
  return set.has(flag);
}
function showInspector(pane) {
  if (!$(".inspect")) return say("This page has no inspector");
  if (narrow()) setOpen("inspect");
  else if (panes().has("no-inspect")) togglePane("no-inspect");
  pickPane(pane);
}
function split() {
  const on = togglePane("split");
  say(on ? "Split: the conversation stays beside the file or terminal" : "Split off");
  // A split shows nothing new until a second view opens, so it opens the newest one there is.
  if (on && (main.dataset.view ?? "convo") === "convo") ([...document.querySelectorAll(".tabs .tab-pick")].at(-1) ?? $('.tabs [data-tab="term"]:not([hidden])'))?.click();
}
function markSplit() {
  const button = $("#tab-split");
  button?.setAttribute("aria-pressed", String(panes().has("split")));
}

/** The tabs over a thread's views in order, and a step from the open one. */
function stepTab(step) {
  const tabs = [...document.querySelectorAll('.tabs > .tab:not([hidden])')];
  if (tabs.length === 0) return say("This page has no tabs");
  const at = tabs.findIndex((t) => t.classList.contains("active"));
  const next = tabs[(at + step + tabs.length) % tabs.length];
  (next.querySelector(".tab-pick") ?? next).click();
}

/** Moves the cursor through the page's list, or scrolls a page that has none, as a pager does. */
function move(step) {
  const items = listItems();
  if (items.length === 0) {
    const scroller = $("#scroll:not([hidden])") ?? $(".scroll");
    scroller?.scrollBy({ top: step * Math.round(scroller.clientHeight * 0.3) });
    return;
  }
  const at = items.findIndex((item) => item.contains(document.activeElement));
  const next = items[at === -1 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, at + step))];
  if (!next.hasAttribute("tabindex")) next.tabIndex = -1;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest" });
}
/** Opens the thread or page the cursor is on. */
function openItem(item) {
  const link = $(".need-thread", item) ?? $("a[href]", item);
  if (link !== null) link.click();
}
/** The thread before or after the open one in the sidebar, as it lists them. */
function stepThread(step) {
  const rows = [...document.querySelectorAll("#side-threads a.row")].filter((r) => r.closest("li")?.hidden !== true && r.closest("details:not([open]) > ul") === null);
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r.classList.contains("active"));
  rows[at === -1 ? 0 : (at + step + rows.length) % rows.length].click();
}
function reply() {
  const item = scope();
  const thread = item instanceof Element ? item.dataset.thread : undefined;
  if (thread !== undefined) return location.assign(`/threads/${thread}#write`);
  const text = $("#prompt-text");
  if (text === null) return say("This thread takes no message now");
  text.focus();
}
function filter() {
  if (narrow()) setOpen("side");
  else if (panes().has("no-side")) togglePane("no-side");
  $("#filter")?.focus();
}
const go = (href) => () => location.assign(href);

/**
 * Each command: what the palette shows, its group, the keys that run it, where its key cap goes on the page (`marks`),
 * its status-line label (`short`), whether the palette lists it (`listed`, true unless false) and when it applies.
 */
const commands = [
  { id: "palette", title: "Open the command palette", group: "General", keys: ["mod+k"], short: "commands", listed: false, run: () => openPalette() },
  { id: "keys", title: "Show every key", group: "General", keys: ["?"], short: "keys", run: () => openPalette("keys") },
  { id: "home", title: "Go to threads", group: "Go", keys: ["g h"], run: go("/") },
  { id: "needs", title: "Go to Needs you", group: "Go", keys: ["g n"], marks: 'a.side-link[href="/#needs-you"]', run: () => $("#needs-you") === null ? go("/#needs-you")() : move(1) },
  { id: "pipeline", title: "Go to the pipeline", group: "Go", keys: ["g p"], marks: 'a.side-link[href="/pipeline"]', run: go("/pipeline") },
  { id: "usage", title: "Go to usage", group: "Go", keys: ["g u"], marks: 'a.side-link[href="/usage"]', run: go("/usage") },
  { id: "health", title: "Go to health", group: "Go", keys: ["g d"], marks: "#health-link", run: go("/health") },
  { id: "next-thread", title: "Next thread", group: "Go", keys: ["J"], short: "next thread", run: () => stepThread(1) },
  { id: "prev-thread", title: "Previous thread", group: "Go", keys: ["K"], run: () => stepThread(-1) },
  { id: "filter", title: "Filter the threads", group: "Go", keys: ["/"], run: filter },
  { id: "down", title: "Move down", group: "Move", keys: ["j", "ArrowDown"], short: "move", listed: false, run: () => move(1) },
  { id: "up", title: "Move up", group: "Move", keys: ["k", "ArrowUp"], listed: false, run: () => move(-1) },
  { id: "open", title: "Open the card or row under the cursor", group: "Move", keys: ["Enter"], short: "open", listed: false, run: () => { const item = scope(); if (item instanceof Element) openItem(item); } },
  { id: "new", title: "Start a thread", group: "Create", keys: ["n"], short: "new", run: () => openStart(null) },
  { id: "new-project", title: "Add a project", group: "Create", keys: ["P"], run: () => openProject() },
  { id: "reply", title: "Write to the thread", group: "Thread", keys: ["r"], short: "reply", run: reply },
  { id: "archive", title: "Archive or unarchive", group: "Thread", keys: ["e"], short: "archive", marks: 'button[data-action="archive"], button[data-action="unarchive"]', listed: false, run: press('button[data-action="archive"], button[data-action="unarchive"]', "archive") },
  { id: "land", title: "Land the reviewed pull request", group: "Thread", keys: ["l"], short: "land", marks: 'button[data-action="land"]', listed: false, run: press('button[data-action="land"]', "land") },
  { id: "retry", title: "Retry", group: "Thread", keys: ["R"], marks: 'button[data-action="retry"], button[data-action="retry-pylon"]', listed: false, run: press('button[data-action="retry"], button[data-action="retry-pylon"]', "retry") },
  { id: "start-queued", title: "Start the queued thread now", group: "Thread", keys: ["s"], marks: 'button[data-action="start-queued"]', listed: false, run: press('button[data-action="start-queued"]', "start") },
  { id: "approve", title: "Approve the item", group: "Thread", keys: ["a"], marks: 'button[data-action="approve-item"]', listed: false, run: press('button[data-action="approve-item"]', "approve") },
  { id: "delete", title: "Delete the thread", group: "Thread", keys: ["#"], marks: "#delete", listed: false, run: press("#delete", "delete") },
  { id: "convo", title: "Show the conversation", group: "View", keys: ["c"], marks: '.tabs [data-tab="convo"]', run: clicks('.tabs [data-tab="convo"]', "This page has no conversation") },
  { id: "terminal", title: "Show the terminal", group: "View", keys: ["t"], short: "terminal", marks: '.tabs [data-tab="term"]', run: clicks('.tabs [data-tab="term"]', "This thread has no terminal") },
  { id: "next-tab", title: "Next tab", group: "View", keys: ["}"], run: () => stepTab(1) },
  { id: "prev-tab", title: "Previous tab", group: "View", keys: ["{"], run: () => stepTab(-1) },
  { id: "close-tab", title: "Close the file tab", group: "View", keys: ["w"], run: clicks(".tabs .tab-file.active .tab-close", "No file tab is open") },
  { id: "diff", title: "Open a changed file's diff", group: "View", keys: ["d"], short: "diff", run: () => openPalette("diff") },
  { id: "preview", title: "Open a preview", group: "View", keys: ["o"], run: () => openPalette("preview") },
  { id: "split", title: "Split the conversation beside the file or terminal", group: "Panes", keys: ["\\"], short: "split", marks: "#tab-split", run: split },
  { id: "side", title: "Fold or unfold the sidebar", group: "Panes", keys: ["["], run: () => narrow() ? setOpen("side") : say(togglePane("no-side") ? "Sidebar folded: [ brings it back" : "Sidebar shown") },
  { id: "inspector", title: "Fold or unfold the inspector", group: "Panes", keys: ["]"], short: "inspector", run: () => $(".inspect") === null ? say("This page has no inspector") : narrow() ? setOpen("inspect") : say(togglePane("no-inspect") ? "Inspector folded: ] brings it back" : "Inspector shown") },
  { id: "pane-changes", title: "Inspector: changes", group: "Panes", keys: ["1"], marks: '.seg-tab:has(input[value="changes"])', run: () => showInspector("changes") },
  { id: "pane-previews", title: "Inspector: previews", group: "Panes", keys: ["2"], marks: '.seg-tab:has(input[value="previews"])', run: () => showInspector("previews") },
  { id: "pane-pylon", title: "Inspector: pylon, outputs and sessions", group: "Panes", keys: ["3"], marks: '.seg-tab:has(input[value="pylon"])', run: () => showInspector("pylon") },
  { id: "theme-toggle", title: "Switch between light and dark", group: "Theme", keys: ["T"], run: clicks("#theme-toggle", "The theme needs the page's script") },
];
const byId = new Map(commands.map((c) => [c.id, c]));
/** The key sequences each command answers to, keyed by sequence. */
const bound = new Map(commands.flatMap((c) => c.keys.map((k) => [k, c])));

/** A key sequence as the caps a person reads: ⌘K on a Mac, Ctrl K elsewhere. */
const caps = (keys) => keys.split(" ").flatMap((k) => k.startsWith("mod+") ? [mac ? "⌘" : "Ctrl", k.slice(4).toUpperCase()] : [{ Enter: mac ? "↵" : "Enter", ArrowDown: "↓", ArrowUp: "↑" }[k] ?? k]);
const capsText = (keys) => caps(keys).join(mac ? "" : " ");
const kbds = (keys) => caps(keys).map((k) => el("kbd", { textContent: k }));

// ---- the status line: a transient message, the chord in progress, and the keys this page answers to

const pending = document.getElementById("sl-pending");
let sayTimer = null;
function say(text) {
  if (pending === null) return;
  pending.textContent = text;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => { pending.textContent = ""; }, 2600);
}
const pageKind = () => $("#convo") !== null ? "thread" : $("#needs-you") !== null ? "home" : listItems().length > 0 ? "list" : "page";
const hints = {
  thread: ["reply", "archive", "terminal", "diff", "split", "inspector", "next-thread", "keys"],
  home: ["down", "open", "reply", "archive", "land", "new", "keys"],
  list: ["down", "open", "new", "keys"],
  page: ["new", "next-thread", "keys"],
};
function drawHints() {
  const line = document.getElementById("sl-keys");
  line?.replaceChildren(...hints[pageKind()].map((id) => {
    const c = byId.get(id);
    return el("span", {}, ...kbds(c.keys[0]), id === "down" ? el("kbd", { textContent: "k" }) : null, c.short);
  }));
}

/** Puts each command's key cap on the controls it presses, again after each swap brings new ones. */
function markKeys() {
  for (const c of commands) {
    if (c.marks === undefined) continue;
    for (const target of document.querySelectorAll(c.marks)) target.dataset.kbd = capsText(c.keys[0]);
  }
}

// ---- the palette

let palette = null;
/** Builds the dialog on its first use, so a page that never opens it carries none of it. */
function paletteDialog() {
  if (palette !== null) return palette;
  const input = el("input", { id: "palette-input", type: "text", autocomplete: "off", spellcheck: false, placeholder: "Type a thread, a page or an action" });
  for (const [name, value] of [["role", "combobox"], ["aria-expanded", "true"], ["aria-controls", "palette-list"], ["aria-autocomplete", "list"], ["aria-label", "Command"]]) input.setAttribute(name, value);
  const scopeChip = el("span", { className: "pal-scope", hidden: true });
  const list = el("ul", { id: "palette-list", className: "pal-list" });
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Commands");
  const foot = el("div", { className: "pal-foot" },
    el("span", {}, el("kbd", { textContent: "↑" }), el("kbd", { textContent: "↓" }), "move"),
    el("span", {}, ...kbds("Enter"), "run"),
    el("span", {}, el("kbd", { textContent: "esc" }), "close"),
    el("span", {}, el("kbd", { textContent: "?" }), "every key"));
  const dialog = el("dialog", { id: "palette", className: "palette" },
    el("div", { className: "pal-input" }, el("span", { className: "pal-prompt", textContent: "›" }), scopeChip, input), list, foot);
  dialog.setAttribute("aria-label", "Command palette");
  document.body.append(dialog);
  palette = { dialog, input, list, scopeChip, scope: null, origin: null, shown: [], at: 0 };
  input.addEventListener("input", () => { palette.at = 0; renderPalette(); });
  input.addEventListener("keydown", paletteKey);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  list.addEventListener("pointermove", (event) => {
    const option = event.target instanceof Element ? event.target.closest(".pal-item") : null;
    if (option !== null && Number(option.dataset.at) !== palette.at) { palette.at = Number(option.dataset.at); markSelected(); }
  });
  list.addEventListener("click", (event) => {
    const option = event.target instanceof Element ? event.target.closest(".pal-item") : null;
    if (option !== null) runAt(Number(option.dataset.at));
  });
  return palette;
}

const scopes = { diff: "Diffs", preview: "Previews", keys: "Keys" };
function openPalette(only = null) {
  const p = paletteDialog();
  if (p.dialog.open && only === p.scope) return p.dialog.close();
  p.scope = only;
  // What the cursor was on, which the palette's focus would otherwise hide, so its keys show beside its actions.
  if (!p.dialog.open) p.origin = scope();
  p.scopeChip.hidden = only === null;
  p.scopeChip.textContent = only === null ? "" : scopes[only];
  p.input.value = "";
  p.at = 0;
  renderPalette();
  if (!p.dialog.open) p.dialog.showModal();
  p.input.focus();
}

/** The first heading or label that names what a control belongs to, so "Land" reads as "Land · Retry flaky probe reconnects". */
function contextOf(control) {
  const text = (node) => node?.textContent.replace(/\s+/g, " ").trim() ?? "";
  const need = control.closest(".need");
  if (need !== null) return text($(".need-thread", need));
  const row = control.closest("tr");
  if (row !== null) return text($(".ov-title", row));
  const card = control.closest(".landing, section, .pv");
  return text(card === null ? null : $(".pv-name, legend, h2, .land-top, .question-text, .ask-question", card)).slice(0, 80);
}
const labelOf = (control) => (control.getAttribute("aria-label") ?? [...control.childNodes].filter((n) => n.nodeName !== "KBD").map((n) => n.textContent).join("")).replace(/\s+/g, " ").trim();
const actionKeys = { archive: "e", unarchive: "e", land: "l", retry: "R", "retry-pylon": "R", "start-queued": "s", "approve-item": "a", delete: "#" };

/** Everything the palette can offer on this page, as commands of the same shape as the table's. */
function offers(only) {
  if (only === "keys") return commands;
  const diffs = () => [...document.querySelectorAll(".tree-file")].map((file) => ({
    title: file.dataset.path ?? labelOf(file), group: "Diffs", glyph: $(".badge", file)?.textContent ?? "±", detail: $(".lines", file)?.textContent ?? "", run: () => file.click(),
  }));
  const previews = () => [...document.querySelectorAll('#pane-previews a[href^="http"], #strip a.mini[href]')].filter((a, i, all) => all.findIndex((b) => b.href === a.href) === i).map((a) => ({
    title: a.getAttribute("aria-label")?.replace(/^Open /, "") ?? a.textContent.replace("↗", "").trim(), group: "Previews", glyph: "@", detail: a.href.replace(/^https?:\/\//, ""), run: () => window.open(a.href, "_blank", "noopener"),
  }));
  if (only === "diff") return diffs();
  if (only === "preview") return previews();
  const actions = [...document.querySelectorAll("main button[data-action], .inspect button[data-action], main button[data-copy], main button[data-start][data-title]")].filter((b) => !b.disabled).map((b) => {
    const keys = actionKeys[b.dataset.action];
    return { title: labelOf(b), detail: contextOf(b), group: "Actions", glyph: "•", keys: keys !== undefined && palette.origin?.contains(b) ? [keys] : [], run: () => b.click() };
  });
  const threads = [...document.querySelectorAll("#side-threads a.row")].map((row) => ({
    title: $(".row-title", row).textContent, group: "Threads", dot: $(".dot", row),
    detail: `${row.closest(".group")?.querySelector(".group-name > span")?.textContent ?? ""} · ${$(".dot", row)?.getAttribute("aria-label") ?? ""}`, run: () => row.click(),
  }));
  const nodes = [...document.querySelectorAll("#side-nodes a.link")].map((a) => ({ title: `Node ${a.textContent}`, group: "Go", glyph: "#", detail: "health, cleanup and graphs", run: () => a.click() }));
  const starts = [...document.querySelectorAll("#side-threads .group-new")].map((a) => ({ title: `Start a thread in ${a.dataset.start}`, group: "Create", glyph: "+", run: () => openStart(a.dataset.start) }));
  const picker = $("#theme");
  const themes = picker === null ? [] : [...picker.options].map((o) => ({ title: `Theme: ${o.textContent}`, group: "Theme", glyph: o.value === picker.value ? "*" : " ", run: () => { picker.value = o.value; picker.dispatchEvent(new Event("change")); } }));
  const listed = commands.filter((c) => c.listed !== false);
  return [...actions, ...listed.filter((c) => c.group === "Go"), ...nodes, ...threads, ...listed.filter((c) => c.group === "Create"), ...starts, ...diffs(), ...previews(),
    ...listed.filter((c) => !["Go", "Create"].includes(c.group)), ...themes];
}

/** Where each character of `query` falls in `text`, in order, scored for runs and word starts, or null when it does not. */
function fuzzy(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  const whole = t.indexOf(q);
  if (whole !== -1) return { score: q.length * 4 + (whole === 0 || /[\s/·:._-]/.test(t[whole - 1]) ? 3 : 0) - whole * 0.05 - t.length * 0.01, at: [...q].map((_, i) => whole + i) };
  const at = [];
  let score = 0;
  let from = 0;
  let runs = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i === -1) return null;
    if (i !== at.at(-1) + 1) runs += 1;
    score += i === at.at(-1) + 1 ? 4 : i === 0 || /[\s/·:._-]/.test(t[i - 1]) ? 3 : 1;
    at.push(i);
    from = i + 1;
  }
  // Letters strewn one by one across a long title match by chance, not by what the person typed.
  if (runs > Math.max(2, Math.ceil(q.length / 2))) return null;
  return { score: score - at[0] * 0.05 - t.length * 0.01, at };
}

const groupOrder = ["Actions", "Go", "Threads", "Create", "Diffs", "Previews", "Thread", "View", "Panes", "Move", "General", "Theme"];
function renderPalette() {
  const p = palette;
  const query = p.input.value.trim();
  const ranked = offers(p.scope).flatMap((o) => {
    if (query === "") return [{ o, score: 0, at: [] }];
    const own = fuzzy(query, o.title);
    if (own !== null) return [{ o, score: own.score + 1, at: own.at }];
    const detail = o.detail ? fuzzy(query, o.detail) : null;
    return detail === null ? [] : [{ o, score: detail.score * 0.5, at: [] }];
  });
  const groups = Map.groupBy(ranked, (r) => r.o.group);
  const ordered = query === "" ? groupOrder : [...groups.keys()].sort((a, b) => Math.max(...groups.get(b).map((r) => r.score)) - Math.max(...groups.get(a).map((r) => r.score)));
  p.shown = [];
  const rows = [];
  for (const name of ordered) {
    const members = groups.get(name);
    if (members === undefined) continue;
    if (query !== "") members.sort((a, b) => b.score - a.score);
    const cap = query === "" && p.scope === null ? 6 : 40;
    rows.push(el("li", { className: "pal-group", textContent: name, role: "presentation" }));
    for (const r of members.slice(0, cap)) {
      const index = p.shown.push(r.o) - 1;
      rows.push(optionRow(r, index));
    }
  }
  if (p.shown.length === 0) {
    const none = p.scope === "diff" ? "No changed files read yet. The Changes pane (1) reads them once the pylon runs."
      : p.scope === "preview" ? "This page has no preview to open." : `Nothing matches “${query}”.`;
    rows.push(el("li", { className: "pal-empty", textContent: none, role: "presentation" }));
  }
  p.list.replaceChildren(...rows);
  p.at = Math.min(p.at, Math.max(0, p.shown.length - 1));
  markSelected();
}
function optionRow({ o, at }, index) {
  const title = el("span", { className: "pal-title" });
  const marks = new Set(at);
  title.append(...[...o.title].map((ch, i) => marks.has(i) ? el("mark", { textContent: ch }) : ch));
  const glyph = o.dot ? o.dot.cloneNode(true) : el("span", { className: "pal-glyph", textContent: o.glyph ?? "›" });
  glyph.removeAttribute?.("role");
  glyph.setAttribute?.("aria-hidden", "true");
  const li = el("li", { className: "pal-item", id: `pal-${index}` }, glyph, title,
    el("span", { className: "pal-detail", textContent: o.detail ?? "" }),
    (o.keys?.length ?? 0) > 0 ? el("span", { className: "pal-keys" }, ...kbds(o.keys[0])) : null);
  li.dataset.at = String(index);
  li.setAttribute("role", "option");
  return li;
}
function markSelected() {
  const p = palette;
  for (const option of p.list.querySelectorAll(".pal-item")) option.setAttribute("aria-selected", String(Number(option.dataset.at) === p.at));
  const current = document.getElementById(`pal-${p.at}`);
  if (current === null) p.input.removeAttribute("aria-activedescendant");
  else {
    p.input.setAttribute("aria-activedescendant", current.id);
    current.scrollIntoView({ block: "nearest" });
  }
}
function runAt(index) {
  const command = palette.shown[index];
  if (command === undefined) return;
  palette.dialog.close();
  command.run();
}
function paletteKey(event) {
  const p = palette;
  const step = event.key === "ArrowDown" || (event.ctrlKey && (event.key === "n" || event.key === "j")) ? 1
    : event.key === "ArrowUp" || (event.ctrlKey && (event.key === "p" || event.key === "k")) ? -1 : 0;
  if (step !== 0) {
    event.preventDefault();
    if (p.shown.length > 0) p.at = (p.at + step + p.shown.length) % p.shown.length;
    markSelected();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runAt(p.at);
  } else if ((event.key === "Escape" || event.key === "Backspace") && p.scope !== null && p.input.value === "") {
    // A scoped palette widens to everything before it closes.
    event.preventDefault();
    p.scope = null;
    p.scopeChip.hidden = true;
    renderPalette();
  } else if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    p.dialog.close();
  }
}

// ---- the keys

/** The key a press names: mod+k for ⌘K or Ctrl K, else the character typed, so Shift is in the character. */
const keyOf = (event) => (mac ? event.metaKey : event.ctrlKey) ? `mod+${event.key.toLowerCase()}` : event.metaKey || event.ctrlKey || event.altKey ? null : event.key;
let chord = null;
let chordTimer = null;
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  const key = keyOf(event);
  if (key === null) return;
  const target = event.target instanceof Element ? event.target : null;
  if (key === "mod+k") {
    if (document.querySelector("dialog[open]:not(#palette)") !== null) return;
    event.preventDefault();
    return openPalette();
  }
  // A dialog, a field, the terminal and a diff's own keys keep their keys, but Esc leaves the composer for the keys.
  if (document.querySelector("dialog[open]") !== null || target?.closest(".diff-view, .xterm, .tv-host") != null) return;
  if (typing(target)) {
    if (key === "Escape" && target.id === "prompt-text") target.blur();
    return;
  }
  const interactive = target?.closest("a[href], button, summary, label") ?? null;
  if (key === "Enter" && (interactive !== null || !(target?.matches(".need, .ov > tbody > tr")))) return;
  const sequence = chord === null ? key : `${chord} ${key}`;
  const command = bound.get(sequence);
  clearTimeout(chordTimer);
  if (command === undefined && chord === null && [...bound.keys()].some((k) => k.startsWith(`${key} `))) {
    chord = key;
    say(`${key} …`);
    chordTimer = setTimeout(() => { chord = null; say(""); }, 1500);
    event.preventDefault();
    return;
  }
  chord = null;
  if (command === undefined) return;
  if ((key === "ArrowDown" || key === "ArrowUp") && listItems().length === 0) return;
  event.preventDefault();
  if (pending?.textContent.endsWith("…")) say("");
  command.run();
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("[data-palette]") != null) openPalette();
  else if (target?.closest("#tab-split") != null) split();
});

// The page's caps are a Mac's. Elsewhere the same keys are Ctrl and Alt, as the handlers read them.
const named = { "⌘": "Ctrl", "⌘↵": "Ctrl Enter", "⌥↵": "Alt Enter" };
function localCaps() {
  if (!mac) for (const node of document.querySelectorAll("kbd")) if (Object.hasOwn(named, node.textContent)) node.textContent = named[node.textContent];
}
localCaps();
const mode = $(".sl-mode");
if (mode !== null) mode.textContent = capsText("mod+k");
markSplit();
markKeys();
drawHints();
afterSwap(() => {
  markKeys();
  localCaps();
});
