// A check's alerts and the Health page's seen mark, loaded once a check changes or the Health page opens. It reads
// the page's pieces when it runs, and the client passes its notices, so a test reads what a change says without a page.
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

// Each check's notice, which its next change closes, so a recovery takes its alert away.
const shown = new Map();
export function showHealth(change, notice, notificationChannel) {
  const n = healthNotice(change);
  shown.get(n.key)?.();
  const page = location.pathname === "/health" ? "health" : null;
  const secure = window.isSecureContext && "Notification" in window;
  const channel = n.quiet ? (focused() && page === null ? "toast" : null) : notificationChannel(focused(), page, "health", secure, secure ? Notification.permission : "unavailable");
  shown.set(n.key, notice(channel, n.title, n.body, n.url));
  // The sidebar's count, and the Health page, show the change without waiting for the next poll.
  void refresh();
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
