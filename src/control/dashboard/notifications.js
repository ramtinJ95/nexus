import { attentions } from "../attention.ts";

const needsPerson = (row) => attentions[row.attention]?.needsPerson === true;
export const badgeCount = (rows) => rows.filter(needsPerson).length;
export const noticeText = (row) => attentions[row.attention].label;
export const badgeText = (count) => count > 9 ? "9+" : String(count);
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
        if (changed && needsPerson(row) && row.attention !== "reply") notify(row);
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
