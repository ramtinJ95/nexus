// The thread list's rows, read for every tab of the browser by the one that follows the events, and the seen mark
// a thread page owes. The page passes its own pieces and a test its fakes, with the browser globals last.
import { owedSeen, raiser } from "./notifications.js";
import { requestOver } from "./request.js";
import { callOf } from "../../contract/route.ts";
import { streamRoutes } from "../../contract/streams.ts";
import { threadRoutes } from "../../contract/threads.ts";
import { rowEvents } from "./contract.ts";

/** Whether a notice's row no longer needs the person as it did: gone, with another attention, or a reply worked past. */
const movedOn = (saved, rows) => {
  const now = rows.find((row) => row.id === saved.id);
  return now?.attention !== saved.attention || (saved.attention === "reply" && (now.working || now.lastReplyAt !== saved.lastReplyAt));
};

export function startRows({ api, notifications, raise = () => {}, health = () => {}, caughtUp = () => {}, changed = () => {}, currentThread, focused, activeTab }, { window, navigator, document, crypto, BroadcastChannel, EventSource, Date, AbortSignal, setTimeout, clearTimeout, setInterval } = globalThis) {
  const request = requestOver(api);
  // One tab of the browser holds the lock, follows those events and reads the thread list, and the other tabs show the
  // rows it hands them, so a hidden tab notifies without a request or a stream of its own. Every tab showing that one
  // tab's reads, in order, means none shows older rows over newer ones, and each holds a reply back to the same moment.
  // Web Locks need a secure context, so over plain HTTP each tab follows the events itself while it is visible. A
  // hidden tab there cannot notify, and keeps none of the control plane's few streams.
  const rowsChannel = "BroadcastChannel" in window && navigator.locks !== undefined ? new BroadcastChannel("nexus-rows") : null;
  const sharing = rowsChannel !== null;
  let following = false;
  let due;
  let shownRows = null;
  function showRows(rows, now) {
    // The page's regions show these rows too, so a change reads them now rather than at the next poll, which would
    // leave the sidebar and Needs you behind the notice.
    const text = JSON.stringify(rows);
    if (shownRows !== null && text !== shownRows) changed();
    shownRows = text;
    const held = notifications(rows, now);
    // A notice whose need these rows no longer show is neither raised by a fallback nor handed to another tab.
    for (const [key, notice] of handed) if (movedOn(notice.row, rows)) {
      clearTimeout(notice.timer);
      handed.delete(key);
    }
    for (const [tag, notice] of kept) if (movedOn(notice.row, rows)) kept.delete(tag);
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
        const rows = await request(threadRoutes.list, { query: { status: "open" } }, AbortSignal.timeout(10_000));
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
  // Each tab tells the others which thread it shows and whether it has focus, so one tab alone raises a system
  // notification, and none does while the person looks at a tab. Over plain HTTP, which has no randomUUID, a tab
  // shares nothing and is the only tab it knows.
  const id = sharing ? crypto.randomUUID() : "";
  const tabs = new Map();
  const view = () => ({ id, thread: currentThread(), focused: focused(), leading: following });
  // A tab that left says nothing more until it comes back, as the hide that follows its pagehide would list it again.
  let left = false;
  const tell = (ask = false) => { if (!left) rowsChannel?.postMessage({ tab: view(), ask }); };
  const gone = () => {
    left = true;
    rowsChannel?.postMessage({ gone: id });
  };
  const back = () => {
    left = false;
    tell(true);
  };
  // The notices this tab handed to another, by that tab and the notice, until it says it raised them.
  const handed = new Map();
  const takeBack = (key) => {
    const notice = handed.get(key);
    if (notice === undefined) return;
    handed.delete(key);
    clearTimeout(notice.timer);
    if (![...tabs.values(), view()].some((tab) => tab.focused)) void raise(notice.row);
  };
  /**
   * Whether this tab raises a row's background notice now. The tab that follows the events decides for every tab, as
   * each read reaches it first and it is open as long as any is. It hands the notice to a tab on the thread, and takes
   * it back if that tab leaves or does not say within a second that it raised it. A tab that answers later than that
   * raises it too, a second alert of the same notice, which is better than none.
   */
  function raises(row) {
    if (!following) return false;
    const to = raiser([...tabs.values(), view()], row.id);
    if (to === null || to === id) return to === id;
    const key = JSON.stringify([to, row.id, row.attention]);
    clearTimeout(handed.get(key)?.timer);
    handed.set(key, { to, row, timer: setTimeout(() => takeBack(key), 1000) });
    rowsChannel.postMessage({ raise: row, to, key });
    return false;
  }
  /** Whether another tab shows `thread`. */
  const elsewhere = (thread) => [...tabs.values()].some((tab) => tab.thread === thread);
  // The system notices this tab shows that would open a page, by tag, until clicked or closed or their thread's
  // attention moves on. A tab that comes to show the thread takes each over, raising it again under the same tag
  // without a new alert, so the click lands there. One that shows nothing, as the person looks at the thread there,
  // answers so, and this tab closes the notice. Until an answer comes this tab keeps it.
  const kept = new Map();
  const keep = (row, close) => {
    const tag = JSON.stringify([row.id, row.attention]);
    const notice = { row, close, to: null };
    kept.set(tag, notice);
    return () => { if (kept.get(tag) === notice) kept.delete(tag); };
  };
  function handOver(to) {
    for (const [tag, notice] of kept) if (notice.row.id === to.thread && to.id !== id && notice.to === null) {
      notice.to = to.id;
      rowsChannel.postMessage({ raise: notice.row, to: to.id, take: tag });
    }
  }
  rowsChannel?.addEventListener("message", ({ data }) => {
    if (data.tab !== undefined) {
      tabs.set(data.tab.id, data.tab);
      handOver(data.tab);
      if (data.ask) tell();
    } else if (data.gone !== undefined) {
      tabs.delete(data.gone);
      for (const [key, notice] of handed) if (notice.to === data.gone) takeBack(key);
      for (const notice of kept.values()) if (notice.to === data.gone) notice.to = null;
    } else if (data.raise !== undefined) {
      if (data.to !== id) return;
      // Answered once shown, so a tab that closes before then leaves the notice to the tab that handed it.
      const shown = Promise.resolve(raise(data.raise, data.take !== undefined));
      if (data.key !== undefined) void shown.then(() => rowsChannel.postMessage({ raised: data.key }));
      if (data.take !== undefined) void shown.then((channel) => rowsChannel.postMessage({ taken: data.take, shown: channel !== null }));
    } else if (data.taken !== undefined) {
      const notice = kept.get(data.taken);
      kept.delete(data.taken);
      if (data.shown === false) notice?.close();
    } else if (data.raised !== undefined) {
      clearTimeout(handed.get(data.raised)?.timer);
      handed.delete(data.raised);
    } else if (data === "read") {
      if (following) void readRows();
    } else if (data.health !== undefined) health(data.health);
    else showRows(data.rows, data.now);
  });
  let events = null;
  let opened = false;
  const hand = (change) => {
    rowsChannel?.postMessage({ health: change });
    health(change);
  };
  function followEvents() {
    if (events !== null || (!sharing && document.visibilityState !== "visible")) return;
    // Each connection reads the list, so it needs none of the events before it.
    events = new EventSource(callOf(streamRoutes.events, { query: { since: "latest", kinds: rowEvents, follow: true } }).path);
    // A check's change has no state to read again, so a stream that opens again hands on each change it missed.
    events.onopen = () => {
      void readRows();
      if (opened) caughtUp(hand);
      opened = true;
    };
    events.onmessage = ({ data }) => {
      const event = data?.includes('"health.changed"') ? JSON.parse(data) : null;
      if (event?.kind !== "health.changed") return void readRows();
      hand(event.payload);
    };
    events.onerror = () => {
      events.close();
      events = null;
      setTimeout(() => { void readRows(); followEvents(); }, 3000);
    };
  }
  function followRows() {
    following = true;
    tell();
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
  if (sharing) {
    for (const kind of ["focus", "blur"]) window.addEventListener(kind, () => tell());
    document.addEventListener("visibilitychange", () => tell());
    // A tab the browser freezes, discards or keeps in its back-forward cache hears no rows, so it raises nothing.
    window.addEventListener("pagehide", gone);
    document.addEventListener("freeze", gone);
    window.addEventListener("pageshow", ({ persisted }) => { if (persisted) back(); });
    document.addEventListener("resume", back);
    tell(true);
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
      await request(threadRoutes.seen, { thread: id, body }, AbortSignal.timeout(10_000));
      marked = body.lastReplyAt;
    } catch { /* The page's refresh reports connection failures. */ }
    finally { marking = false; }
  }
  return { readRows, markSeen, askRows, raises, elsewhere, keep };
}
