// The dashboard client. Pages are rendered on the server. This file sends actions, messages and new projects
// to the JSON API, records a visit as human activity, opens the start and new-project dialogs and the phone's panels,
// and polls the page to swap in each `data-live` region that changed. A thread page also follows its stream, which
// sends the conversation region as the run streams, and reads its checkout's changes into the inspector, opening
// each changed file's diff as a tab beside the conversation.
import { coordinator, notificationChannel, needSelectors, noticeText, noticeUrl } from "./notifications.js";
import { api } from "./request.js";
import { el, end, follow, pollMs, recordVisit, refreshNow, stream, tick, toggled } from "./page.js";
import { paneKey, pickPane, setOpen } from "./nav.js";
import { dialog, openProject, openStart, projectDialog } from "./dialogs.js";
import { activeTab, canRead, changesPane, changesUnreadable, checkout, factsNow, readChanges, renderTabs, showTab, tabsBar, terminalTab } from "./checkout.js";
import "./composer.js";
import "./actions.js";
import { startRows } from "./rows.js";

for (const d of document.querySelectorAll("details[id]")) if (toggled.has(d.id)) d.open = toggled.get(d.id);
const savedPane = localStorage.getItem(paneKey);
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
const writeTo = () => { if (location.hash === "#write") document.getElementById("prompt-text")?.focus(); };
writeTo();
addEventListener("hashchange", writeTo);
if (location.hash === "#terminal" && tabsBar?.querySelector('[data-tab="term"]')?.hidden === false) showTab(terminalTab);
// A node's graphs bring uPlot, which no other page needs.
if (document.getElementById("node-graphs") !== null) void import("./node-graphs.js");
if (dialog?.dataset.autoopen !== undefined) void openStart(null);
if (projectDialog?.dataset.autoopen !== undefined) openProject();
setInterval(tick, 1000);
if (pollMs > 0) {
  setInterval(() => { if (document.visibilityState === "visible") void refreshNow(); }, pollMs);
}
recordVisit();
document.addEventListener("visibilitychange", () => {
  // The first frame on return is the region whole.
  if (document.visibilityState !== "visible") {
    stream?.close();
    return;
  }
  recordVisit();
  follow(document.getElementById("convo")?.dataset.stream);
  if (pollMs > 0) void refreshNow();
  askRows();
  // The visit wakes the pylon anyway, so a running one is worth reading again on return.
  if (changesPane !== null && canRead(factsNow())) void readChanges();
});

/**
 * Brings the inbox card a notice opened into view, or the inbox when that card is gone. A notice can come before the
 * poll that brings its card, so the page is read once more before it settles for the inbox.
 */
async function showNeed() {
  const selectors = needSelectors(location.hash);
  if (selectors === null) return;
  const find = () => selectors.map((s) => document.querySelector(s)).find((found) => found !== null) ?? null;
  if (find() === null && document.getElementById("needs-you") !== null) await refreshNow();
  const card = find() ?? document.getElementById("needs-you");
  for (const picked of document.querySelectorAll(".need.picked")) picked.classList.remove("picked");
  card?.classList.add("picked");
  card?.scrollIntoView({ block: "start" });
  card?.focus({ preventScroll: true });
}
void showNeed();
addEventListener("hashchange", () => void showNeed());
// On a phone the link is in the drawer, which a jump within the page would leave open over the inbox.
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest('a[href^="/#needs-you"]') !== null) setOpen(null);
});

const currentThread = () => /^\/threads\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;
const focused = () => document.visibilityState === "visible" && document.hasFocus();
const notifications = coordinator((row) => {
  const channel = notificationChannel(focused(), currentThread(), row.id, window.isSecureContext,
    window.isSecureContext && "Notification" in window ? Notification.permission : "unavailable");
  const url = noticeUrl(row);
  if (channel === "system") {
    const notice = new Notification(row.title, { body: noticeText(row) });
    notice.onclick = () => { window.focus(); location.assign(url); notice.close(); };
  } else if (channel === "toast") {
    const toast = el("div", { className: "attention-toast", role: "status" },
      el("span", { textContent: `${row.title}: ${noticeText(row)}` }),
      el("a", { href: url, textContent: "Open" }));
    const dismiss = el("button", { textContent: "Dismiss", type: "button" });
    dismiss.onclick = () => toast.remove();
    toast.append(dismiss);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 15000);
  }
});
const permission = el("button", { type: "button", className: "btn side-add", textContent: "Enable system notifications" });
if (window.isSecureContext && "Notification" in window) {
  permission.onclick = async () => { permission.textContent = `Notifications: ${await Notification.requestPermission()}`; };
} else {
  permission.disabled = true;
  permission.textContent = "System notifications need HTTPS";
}
document.querySelector("aside")?.append(permission);
// After the button, which shortens the list it joins.
document.querySelector(".row.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
const { markSeen, askRows } = startRows({ api, notifications, currentThread, focused, activeTab: () => activeTab });
setInterval(markSeen, 1000);
