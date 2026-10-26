export const needsAttention = (row) => ["failed", "decision", "parked", "reply"].includes(row.attention);
export const badgeCount = (rows) => rows.filter(needsAttention).length;
export const badgeText = (count) => count > 9 ? "9+" : String(count);
export function notificationChannel(focused, current, id, secure, permission) {
  if (focused) return current === id ? null : "toast";
  return secure && permission === "granted" ? "system" : null;
}

export function coordinator(notify) {
  let previous = null;
  const pending = new Map();
  return (rows, now) => {
    const next = new Map(rows.map((row) => [row.id, row]));
    for (const [id] of pending) {
      const row = next.get(id);
      if (!row || row.attention !== "reply" || row.agentTurnRunning) pending.delete(id);
    }
    if (previous !== null) {
      for (const row of rows) {
        const before = previous.get(row.id);
        const changed = before?.attention !== row.attention;
        if (changed && (row.attention === "failed" || row.attention === "decision" || row.attention === "parked")) notify(row);
        else if (row.attention === "reply" && !row.agentTurnRunning
          && (changed || before?.lastReplyAt !== row.lastReplyAt || before?.agentTurnRunning)) pending.set(row.id, now + 2000);
      }
    }
    for (const [id, due] of pending) if (now >= due) {
      pending.delete(id);
      notify(next.get(id));
    }
    previous = next;
  };
}


export function seenBody(conversation) {
  const at = conversation?.dataset.renderedReplyAt;
  return { lastReplyAt: at === undefined || at === "" ? null : Number(at) };
}
