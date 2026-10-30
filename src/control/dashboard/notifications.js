import { attentions, needsPerson } from "../attention.ts";

export const noticeText = (row) => attentions[row.attention].label;
/** A notice opens the inbox's card for what the thread waits on. A reply waits on no one, so it opens the thread. */
export const noticeUrl = (row) => row.attention === "reply" ? `/threads/${row.id}` : `/#needs-you:${row.id}:${row.attention}`;
/** The cards a notice's hash names, best first: the thread's card for that attention, then any of the thread's. */
export function needSelectors(hash) {
  const m = /^#needs-you:([\w-]+):(\w+)$/.exec(hash);
  return m === null ? null : [`.need[data-thread="${m[1]}"][data-attention="${m[2]}"]`, `.need[data-thread="${m[1]}"]`];
}
export function notificationChannel(focused, current, id, secure, permission) {
  if (focused) return current === id ? null : "toast";
  return secure && permission === "granted" ? "system" : null;
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
