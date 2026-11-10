// The dashboard's notices, a check's alerts, the notifications control and the Health page's seen mark, loaded as
// the page starts but outside its first script. It reads the page's pieces when it runs, so a test reads what a change says without a page.
import { doctorRoutes } from "../../contract/reports.ts";
import { checkName } from "../plain-wording.ts";
import { statuses } from "../doctor-model.ts";
import { notificationChannel, noticeText, noticeUrl } from "./notifications.js";

const focused = () => document.visibilityState === "visible" && document.hasFocus();
const refresh = async () => (await import("./page.js")).refreshNow();

/**
 * What a health change says. A check that went bad or got worse alerts, and one that got better says so quietly, as a
 * toast only. `key` names the check, so a later change of it replaces the notice.
 */
export function healthNotice(change) {
  const check = checkName(change);
  const worse = statuses.indexOf(change.status) > statuses.indexOf(change.from);
  const title = worse ? `${check}: ${change.status}` : change.status === "ok" ? `${check} recovered` : `${check}: ${change.status}, better than ${change.from}`;
  return { key: JSON.stringify([change.node, change.name]), title, body: change.text, url: "/health", quiet: !worse };
}

/** The seen mark a Health page owes for the newest problem it shows, or null when it marked that one or shows none. */
export function owedHealthSeen(page, marked) {
  const through = Number(page?.dataset.healthThrough ?? 0);
  return through > (marked ?? 0) ? { through } : null;
}

/**
 * Whether a change is news to a tab whose page showed every change up to `baseline`: newer than that, and newer than
 * the latest change of its check handed on, as a reconnect's catch-up may hand on a change the stream already passed.
 */
export function newChanges(baseline) {
  const latest = new Map();
  return (change) => {
    const key = healthNotice(change).key;
    if (change.id <= Math.max(baseline, latest.get(key) ?? 0)) return false;
    latest.set(key, change.id);
    return true;
  };
}

/**
 * Hands on every change kept, oldest first, for a stream that opened again. A failed read tries again, from 1 s and
 * doubling up to 30 s, since an open stream gives no other chance to.
 */
export async function caughtUp(hand, wait = 1000) {
  try {
    for (const change of (await (await import("./request.js")).request(doctorRoutes.changes, {}, AbortSignal.timeout(10_000))).reverse()) hand(change);
  } catch {
    setTimeout(() => void caughtUp(hand, Math.min(wait * 2, 30_000)), wait);
  }
}

/**
 * Shows a notice in `channel`. A system notification with a `tag` replaces the browser's one of that tag and alerts
 * again. Its click brings the tab forward, and opens `url` there unless it is null.
 */
export async function notice(channel, title, body, url, tag) {
  if (channel === "system") {
    const shown = new Notification(title, tag === undefined ? { body } : { body, tag, renotify: true });
    shown.onclick = () => {
      window.focus();
      if (url !== null) location.assign(url);
      shown.close();
    };
    return () => shown.close();
  }
  if (channel !== "toast") return () => {};
  const { el } = await import("./page.js");
  const toast = el("div", { className: "attention-toast", role: "status" },
    el("span", { textContent: `${title}: ${body}` }),
    el("a", { href: url, textContent: "Open" }));
  const dismiss = el("button", { textContent: "Dismiss", type: "button" });
  dismiss.onclick = () => toast.remove();
  toast.append(dismiss);
  const stack = document.querySelector(".toast-stack") ?? document.body.appendChild(el("div", { className: "toast-stack" }));
  stack.append(toast);
  // Past five, the oldest go, so the stack never covers the page.
  while (stack.children.length > 5) stack.children[0].remove();
  setTimeout(() => toast.remove(), 15000);
  return () => toast.remove();
}

/**
 * The notice a row's change shows in this tab. Its tag is the row's ID and attention, so a system notification
 * replaces one the browser shows for the same need. A tab already on the thread has no page to open, so its notice
 * only brings the tab forward.
 */
export function rowNotice(row, { focused, current, secure, permission, raises }) {
  return {
    channel: notificationChannel(focused, current, row.id, secure, permission, raises),
    title: row.title, body: noticeText(row), url: current === row.id ? null : noticeUrl(row), tag: `${row.id}:${row.attention}`,
  };
}
/** Shows a row's notice, as `rowNotice` says it, in this tab. */
export const showRow = (row, tab) => { const n = rowNotice(row, tab); return notice(n.channel, n.title, n.body, n.url, n.tag); };

const permissionStates = {
  default: { text: "Enable system notifications", ask: true },
  granted: { text: "System notifications on", ask: false },
  denied: { text: "System notifications blocked in the browser's site settings", ask: false },
  unavailable: { text: "System notifications need HTTPS", ask: false },
};
/** The sidebar's control for system notifications, which says the browser's permission and asks for it while unasked. */
export function permissionControl(button, { window, navigator } = globalThis) {
  const available = window.isSecureContext && "Notification" in window;
  const show = () => {
    const state = permissionStates[available ? window.Notification.permission : "unavailable"] ?? permissionStates.default;
    button.textContent = state.text;
    button.disabled = !state.ask;
  };
  show();
  if (!available) return;
  button.onclick = async () => { await window.Notification.requestPermission(); show(); };
  // A change in the browser's site settings reaches an open page too.
  navigator.permissions?.query({ name: "notifications" }).then((status) => status.addEventListener("change", show), () => {});
}

// Each check's notice, which its next change closes, so a recovery takes its alert away.
const shown = new Map();
// The newest change the page showed, so no change from before it notifies.
const fresh = newChanges(Number(globalThis.document?.getElementById("health-link")?.dataset.change ?? 0));
export function showHealth(change, notificationChannel, refreshed = refresh) {
  if (!fresh(change)) return;
  const n = healthNotice(change);
  void shown.get(n.key)?.then((close) => close());
  const page = location.pathname === "/health" ? "health" : null;
  const secure = window.isSecureContext && "Notification" in window;
  const channel = n.quiet ? (focused() && page === null ? "toast" : null) : notificationChannel(focused(), page, "health", secure, secure ? Notification.permission : "unavailable");
  shown.set(n.key, notice(channel, n.title, n.body, n.url));
  // The sidebar's count, and the Health page, show the change without waiting for the next poll.
  void refreshed();
}

/** Marks the problems the Health page shows seen once the person looks at it, which clears the sidebar's count. */
export function markHealthSeen() {
  let marked = null;
  let marking = false;
  setInterval(async () => {
    const owed = focused() ? owedHealthSeen(document.querySelector("[data-health-through]"), marked) : null;
    if (owed === null || marking) return;
    marking = true;
    try {
      await (await import("./request.js")).request(doctorRoutes.seen, { body: owed }, AbortSignal.timeout(10_000));
      marked = owed.through;
      void refresh();
    } catch { /* The page's refresh reports connection failures. */ }
    finally { marking = false; }
  }, 1000);
}
