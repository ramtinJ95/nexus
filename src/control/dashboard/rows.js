// The thread list's rows, read for every tab of the browser by the one that follows the events, and the seen mark
// a thread page owes. The page passes its own pieces and a test its fakes, with the browser globals last.
import { owedSeen } from "./notifications.js";

export function startRows({ api, notifications, health = () => {}, currentThread, focused, activeTab }, { window, navigator, document, BroadcastChannel, EventSource, Date, AbortSignal, setTimeout, clearTimeout, setInterval } = globalThis) {
  // The events that change a row's attention, its reply or whether it works, and a check's change, which every tab
  // hears from the one that follows the events, as it hears the rows.
  const rowEvents = ["attention.changed", "thread.turn-ended", "session.turn-started", "session.turn-ended", "session.waiting", "session.ended", "health.changed"];
  // One tab of the browser holds the lock, follows those events and reads the thread list, and the other tabs show the
  // rows it hands them, so a hidden tab notifies without a request or a stream of its own. Every tab showing that one
  // tab's reads, in order, means none shows older rows over newer ones, and each holds a reply back to the same moment.
  // Web Locks need a secure context, so over plain HTTP each tab follows the events itself while it is visible. A
  // hidden tab there cannot notify, and keeps none of the control plane's few streams.
  const rowsChannel = "BroadcastChannel" in window && navigator.locks !== undefined ? new BroadcastChannel("nexus-rows") : null;
  const sharing = rowsChannel !== null;
  let following = false;
  let due;
  function showRows(rows, now) {
    const held = notifications(rows, now);
    // A turn over an unread reply may stop with no event, and the reply notifies once a read finds it stopped.
    const next = rows.some((row) => row.attention === "reply" && row.working) ? Math.min(held ?? Infinity, now + 1000) : held;
    // A held-back reply notifies once a read at its time finds no turn running.
    clearTimeout(due);
    if (following && next !== null) due = setTimeout(readRows, next - Date.now());
  }
  let readingRows = false;
  let stale = false;
  let retry;
  async function readRows() {
    // An event during a read may have come after the list was read.
    if (readingRows) return void (stale = true);
    readingRows = true;
    try {
      do {
        stale = false;
        const rows = await api("GET", "/v1/threads?deleted=false", undefined, AbortSignal.timeout(10_000));
        const now = Date.now();
        if (following) rowsChannel?.postMessage({ rows, now });
        showRows(rows, now);
      } while (stale);
    } catch {
      // The event that asked for the read may be the last for a while.
      clearTimeout(retry);
      if (following) retry = setTimeout(readRows, 1000);
    } finally { readingRows = false; }
  }
  const askRows = () => sharing && !following ? rowsChannel.postMessage("read") : void readRows();
  rowsChannel?.addEventListener("message", ({ data }) => {
    if (data === "read") {
      if (following) void readRows();
    } else if (data.health !== undefined) health(data.health);
    else showRows(data.rows, data.now);
  });
  let events = null;
  function followEvents() {
    if (events !== null || (!sharing && document.visibilityState !== "visible")) return;
    // Each connection reads the list, so it needs none of the events before it.
    const query = new URLSearchParams([["follow", "true"], ["since", "latest"], ...rowEvents.map((kind) => ["kind", kind])]);
    events = new EventSource(`/v1/events?${query}`);
    events.onopen = () => void readRows();
    events.onmessage = ({ data }) => {
      const event = data?.includes('"health.changed"') ? JSON.parse(data) : null;
      if (event?.kind !== "health.changed") return void readRows();
      rowsChannel?.postMessage({ health: event.payload });
      health(event.payload);
    };
    events.onerror = () => {
      events.close();
      events = null;
      setTimeout(() => { void readRows(); followEvents(); }, 3000);
    };
  }
  function followRows() {
    following = true;
    followEvents();
    // A delete, a harness turn that starts or stops without a reply, or a session whose lease lapsed sends no event.
    setInterval(readRows, 10_000);
  }
  if (sharing) {
    void navigator.locks.request("nexus-rows", () => { followRows(); return new Promise(() => {}); });
  } else {
    followRows();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") return followEvents();
      events?.close();
      events = null;
    });
  }
  askRows();

  let marking = false;
  let marked = null;
  async function markSeen() {
    const convo = document.getElementById("convo");
    const id = currentThread();
    if (marking || id === null || !focused() || activeTab() !== null || convo === null || convo.querySelector(".error")) return;
    const body = owedSeen(convo, marked);
    if (body === null) return;
    marking = true;
    try {
      await api("POST", `/v1/threads/${id}/seen`, body, AbortSignal.timeout(10_000));
      marked = body.lastReplyAt;
    } catch { /* The page's refresh reports connection failures. */ }
    finally { marking = false; }
  }
  return { readRows, markSeen, askRows };
}
