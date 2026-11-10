import { el, end, main, scroller } from "./page.js";
import { keptForTab, storageKeys } from "./contract.ts";
import { badge, thread } from "./checkout.js";

// The tabs beside the conversation: the terminal, and one per changed file the reader opened, kept for the tab's
// session. `activeTab` is the open file's path, `terminalTab` for the terminal, `timelineTab` for the timeline, or null
// for the conversation.
export const tabsBar = document.getElementById("tabs");
export const fileView = document.getElementById("file-view");
const termView = document.getElementById("term-view");
export const terminalTab = Symbol("terminal");
const timelineTab = Symbol("timeline");
const timelineView = document.getElementById("timeline-view");
const fixedTabs = { convo: null, timeline: timelineTab, term: terminalTab };
const tabsKey = storageKeys.tabs(thread);
const maxTabs = 8;
export let openTabs = JSON.parse(keptForTab.read(tabsKey) ?? "[]");
export let activeTab = null;
/** What showing a file's tab and the terminal's tab does. file-view.js and terminal-tab.js fill these in, as they import this module. */
export const tabShows = { file: null, terminal: null };

function saveTabs() {
  keptForTab.write(tabsKey, JSON.stringify(openTabs));
}

/** Draws the file tabs again, keeping focus on the control that had it, or on the tab that took its place. */
export function renderTabs() {
  if (tabsBar === null) return;
  const focused = tabsBar.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
  const fixed = Object.entries(fixedTabs).flatMap(([key, tab]) => {
    const button = tabsBar.querySelector(`[data-tab="${key}"]`);
    if (button === null) return [];
    button.classList.toggle("active", activeTab === tab);
    button.setAttribute("aria-selected", String(activeTab === tab));
    button.dataset.key = key;
    return [button];
  });
  const fileTabs = openTabs.map((file) => {
    const active = activeTab === file.path;
    const pick = el("button", { type: "button", className: "tab-pick", title: file.path }, badge(file.status), el("span", { className: "tab-name", textContent: file.path.split("/").at(-1) }));
    pick.setAttribute("role", "tab");
    pick.setAttribute("aria-selected", String(active));
    pick.setAttribute("aria-controls", "file-view");
    pick.dataset.key = `pick:${file.path}`;
    pick.addEventListener("click", () => showTab(file.path));
    const close = el("button", { type: "button", className: "tab-close", textContent: "×", title: "Close" });
    close.setAttribute("aria-label", `Close ${file.path}`);
    close.dataset.key = `close:${file.path}`;
    close.addEventListener("click", () => closeTab(file.path));
    return el("div", { className: `tab tab-file${active ? " active" : ""}` }, pick, close);
  });
  tabsBar.replaceChildren(...fixed, ...fileTabs);
  tabsBar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  for (const button of document.querySelectorAll(".tree-file")) button.classList.toggle("active", button.dataset.path === activeTab);
  if (focused === undefined) return;
  const controls = [...tabsBar.querySelectorAll("[data-key]")];
  const replacement = typeof activeTab === "string" ? `pick:${activeTab}` : Object.keys(fixedTabs).find((key) => fixedTabs[key] === activeTab);
  (controls.find((b) => b.dataset.key === focused) ?? controls.find((b) => b.dataset.key === replacement))?.focus();
}

export function showTab(path) {
  activeTab = path;
  main.dataset.view = typeof path === "string" ? "file" : Object.keys(fixedTabs).find((key) => fixedTabs[key] === path);
  scroller.hidden = path !== null;
  if (timelineView !== null) timelineView.hidden = path !== timelineTab;
  fileView.hidden = typeof path !== "string";
  if (termView !== null) termView.hidden = path !== terminalTab;
  if (path === null) end.settle();
  renderTabs();
  if (typeof path === "string") void tabShows.file(path);
  if (path === terminalTab) void tabShows.terminal();
}

/**
 * Opens a changed file's tab. A step from file to file passes the path it steps from, whose tab the next file takes,
 * so a review of many files keeps one tab rather than pushing the reader's own tabs out.
 */
export function openFile(file, from = null) {
  const at = openTabs.findIndex((f) => f.path === file.path);
  const stepped = openTabs.findIndex((f) => f.path === from);
  if (at !== -1) openTabs[at] = file;
  else if (stepped !== -1) openTabs = openTabs.with(stepped, file);
  else openTabs = [...openTabs, file].slice(-maxTabs);
  saveTabs();
  showTab(file.path);
}

function closeTab(path) {
  openTabs = openTabs.filter((f) => f.path !== path);
  saveTabs();
  if (activeTab === path) showTab(openTabs.at(-1)?.path ?? null);
  else renderTabs();
}

/** An open tab takes the file's new counts, and keeps its place when the file is no longer changed. */
export function refreshTabs(files) {
  openTabs = openTabs.map((tab) => files.find((f) => f.path === tab.path) ?? tab);
  renderTabs();
  if (typeof activeTab === "string") void tabShows.file(activeTab);
}

// The fixed tabs, and the timeline's and the track's links to the conversation or to a step of the timeline.
document.addEventListener("click", (event) => {
  const go = tabsBar === null || !(event.target instanceof Element) ? null : event.target.closest("#tabs > [data-tab], [data-tab-go]");
  if (go !== null) showTab(fixedTabs[go.dataset.tabGo ?? go.dataset.tab]);
  if (termView !== null && event.target instanceof Element && event.target.closest("[data-terminal]") !== null) showTab(terminalTab);
});
