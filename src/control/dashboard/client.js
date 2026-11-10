// The dashboard client. Pages are rendered on the server. This file sends actions, messages and new projects
// to the JSON API, records a visit as human activity, opens the start and new-project dialogs and the phone's panels,
// and polls the page to swap in each `data-live` region that changed. A thread page also follows its stream, which
// sends the conversation region as the run streams, and reads its checkout's changes into the inspector, opening
// each changed file's diff as a tab beside the conversation.
import { coordinator, notificationChannel } from "./notifications.js";
import { api } from "./request.js";
import { chunk, el, end, follow, main, pollMs, recordVisit, refreshAfter, refreshNow, stream, tick, toggled } from "./page.js";
import { pickPane, setOpen } from "./nav.js";
import { applyFilter, listRows } from "./find.js";
import { dialog, openProject, openStart, projectDialog } from "./dialogs.js";
import { canRead, changesPane, checkout, factsNow } from "./checkout.js";
import { changesUnreadable, readChanges } from "./changes-tree.js";
import { activeTab, renderTabs, showTab, tabsBar, terminalTab } from "./tab-bar.js";
import "./file-view.js";
import "./terminal-tab.js";
import "./composer.js";
import "./actions.js";
import "./keys.js";
import { startRows } from "./rows.js";
import { pageModules } from "./pages.js";
import { kept, storageKeys } from "./contract.ts";
const pageModule = pageModules[main?.dataset.page];
if (pageModule !== undefined) void chunk(pageModule());

for (const d of document.querySelectorAll("details[id]")) if (toggled.has(d.id)) d.open = toggled.get(d.id);
applyFilter();
const savedPane = kept.read(storageKeys.pane);
if (savedPane !== null) pickPane(savedPane);
if (changesPane !== null) {
  checkout.facts = factsNow();
  renderTabs();
  if (canRead(checkout.facts)) void readChanges();
  else changesUnreadable(checkout.facts);
}
end?.toEnd();
follow(document.getElementById("convo")?.dataset.stream);
// The nudge card's Write to it, from Needs you or from the thread's own page.
const writeTo = () => {
  if (location.hash !== "#write") return;
  if (tabsBar !== null && activeTab !== null) showTab(null);
  document.getElementById("prompt-text")?.focus();
};
writeTo();
addEventListener("hashchange", writeTo);
if (location.hash === "#terminal" && tabsBar?.querySelector('[data-tab="term"]')?.hidden === false) showTab(terminalTab);
if (dialog?.dataset.autoopen !== undefined) void openStart(null);
if (projectDialog?.dataset.autoopen !== undefined) openProject();
tick();
setInterval(tick, 1000);
setInterval(() => { if (document.visibilityState === "visible") void refreshNow(); }, pollMs);
recordVisit();
document.addEventListener("visibilitychange", () => {
  // The first frame on return is the region whole.
  if (document.visibilityState !== "visible") {
    stream?.close();
    return;
  }
  recordVisit();
  follow(document.getElementById("convo")?.dataset.stream);
  void refreshNow();
  askRows();
  // The visit wakes the pylon anyway, so a running one is worth reading again on return.
  if (changesPane !== null && canRead(factsNow())) void readChanges();
});

// On a phone the link is in the drawer, which a jump within the page would leave open over the inbox.
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest('a[href^="/#needs-you"]') !== null) setOpen(null);
});

const currentThread = () => /^\/threads\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;
const focused = () => document.visibilityState === "visible" && document.hasFocus();
// Loaded now, before the page's first poll, so it reads the newest change the page showed.
const checks = import("./health.js");
const showRow = (row, raises) => {
  const tab = { focused: focused(), current: currentThread(), secure: window.isSecureContext,
    permission: window.isSecureContext && "Notification" in window ? Notification.permission : "unavailable", raises };
  void checks.then((m) => m.showRow(row, tab));
};
// A focused tab shows its own notice, and the tab that follows the events says which tab raises a background one.
const notifications = coordinator((row) => showRow(row, !focused() && raises(row)));
const health = (change) => void checks.then((m) => m.showHealth(change, notificationChannel));
const caughtUp = (hand) => void checks.then((m) => m.caughtUp(hand));
if (location.pathname === "/health") void checks.then((m) => m.markHealthSeen());
const permission = el("button", { type: "button", className: "btn side-add", disabled: true });
document.querySelector("aside")?.append(permission);
void checks.then((m) => m.permissionControl(permission));
// After the button, which shortens the list it joins.
document.querySelector(".row.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
const listed = (rows, now) => {
  listRows(rows);
  return notifications(rows, now);
};
const { markSeen, askRows, raises } = startRows({ api, notifications: listed, raise: (row) => showRow(row, true), health, caughtUp, changed: () => { if (document.visibilityState === "visible") void refreshAfter(); }, currentThread, focused, activeTab: () => activeTab });
setInterval(markSeen, 1000);
