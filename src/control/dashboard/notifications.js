import { needsPerson } from "../attention.ts";
import { attentionLabels } from "../plain-wording.ts";
import { noticeHash, noticeOf } from "./contract.ts";

export const noticeText = (row) => attentionLabels[row.attention];
/** A notice opens the inbox's card for what the thread waits on. A reply waits on no one, so it opens the thread. */
export const noticeUrl = (row) => row.attention === "reply" ? `/threads/${row.id}` : `/${noticeHash(row.id, row.attention)}`;
/** The cards a notice's hash names, best first: the thread's card for that attention, then any of the thread's. */
export function needSelectors(hash) {
  const notice = noticeOf(hash);
  return notice === null ? null : [`.need[data-thread="${notice.thread}"][data-attention="${notice.attention}"]`, `.need[data-thread="${notice.thread}"]`];
}
/** `raises` says whether this tab is the one of the browser's tabs that raises the background notice. */
export function notificationChannel(focused, current, id, secure, permission, raises = true) {
  if (focused) return current === id ? null : "toast";
  return raises && secure && permission === "granted" ? "system" : null;
}

/**
 * Which of the browser's open tabs raises a thread's system notification, by ID, or null for none. A focused tab shows
 * the notice itself, so none raises one. Otherwise a tab on the thread does, so a click shows it with no page left,
 * or else the tab that follows the events, which is open as long as any is.
 */
export function raiser(tabs, thread) {
  if (tabs.some((tab) => tab.focused)) return null;
  const first = (list) => list.map((tab) => tab.id).sort()[0];
  return first(tabs.filter((tab) => tab.thread === thread)) ?? first(tabs.filter((tab) => tab.leading)) ?? first(tabs) ?? null;
}

/** Returns a function that takes the latest rows and returns when a reply it holds back comes due, or null. */
export function coordinator(notify) {
  let previous = null;
  const pending = new Map();
  return (rows, now) => {
    const next = new Map(rows.map((row) => [row.id, row]));
    for (const [id] of pending) {
      const row = next.get(id);
      if (!row || row.attention !== "reply" || row.working) pending.delete(id);
    }
    if (previous !== null) {
      for (const row of rows) {
        const before = previous.get(row.id);
        const changed = before?.attention !== row.attention;
        if (changed && needsPerson(row.attention) && row.attention !== "reply") notify(row);
        else if (row.attention === "reply" && !row.working
          && (changed || before?.lastReplyAt !== row.lastReplyAt || before?.working)) pending.set(row.id, now + 2000);
      }
    }
    for (const [id, due] of pending) if (now >= due) {
      pending.delete(id);
      notify(next.get(id));
    }
    previous = next;
    return pending.size === 0 ? null : Math.min(...pending.values());
  };
}


export function seenBody(conversation) {
  const at = conversation?.dataset.renderedReplyAt;
  return { lastReplyAt: at === undefined || at === "" ? null : Number(at) };
}

/**
 * The seen mark a page owes for the reply it shows, or null when it marked that reply already or shows none. A
 * reply marked unseen elsewhere stays unseen until the page shows a newer one.
 */
export function owedSeen(conversation, marked) {
  const body = seenBody(conversation);
  return body.lastReplyAt === null || body.lastReplyAt === marked ? null : body;
}
