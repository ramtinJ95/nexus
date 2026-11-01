// The dashboard's notices, a check's alerts and the Health page's seen mark, loaded as the page starts but outside its
// first script. It reads the page's pieces when it runs, so a test reads what a change says without a page.
const focused = () => document.visibilityState === "visible" && document.hasFocus();
const refresh = async () => (await import("./page.js")).refreshNow();

const ranks = ["ok", "warn", "fail"];
/**
 * What a health change says. A check that went bad or got worse alerts, and one that got better says so quietly, as a
 * toast only. `key` names the check, so a later change of it replaces the notice.
 */
export function healthNotice(change) {
  const check = `${change.node ?? "Control plane"} ${change.name}`;
  const worse = ranks.indexOf(change.status) > ranks.indexOf(change.from);
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
    for (const change of (await (await import("./request.js")).api("GET", "/v1/checks/changes", undefined, AbortSignal.timeout(10_000))).reverse()) hand(change);
  } catch {
    setTimeout(() => void caughtUp(hand, Math.min(wait * 2, 30_000)), wait);
  }
}

/** Shows a notice on the channel picked, and returns what closes it. */
export async function notice(channel, title, body, url) {
  if (channel === "system") {
    const shown = new Notification(title, { body });
    shown.onclick = () => { window.focus(); location.assign(url); shown.close(); };
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
  document.body.append(toast);
  setTimeout(() => toast.remove(), 15000);
  return () => toast.remove();
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
      await (await import("./request.js")).api("POST", "/v1/checks/seen", owed, AbortSignal.timeout(10_000));
      marked = owed.through;
      void refresh();
    } catch { /* The page's refresh reports connection failures. */ }
    finally { marking = false; }
  }, 1000);
}
