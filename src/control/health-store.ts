/** The table keeps the name `doctor_reports` from when it held daily reports. */
import { json, type Db, type Holding } from "./db.ts";
import type { AppendEvent } from "./thread-store.ts";
import { checkKey, statuses, type HealthChange, type Status } from "./doctor-model.ts";

export type NewHealthChange = Omit<HealthChange, "id" | "seenAt">;

const isStatus = (value: unknown): value is Status => (statuses as readonly unknown[]).includes(value);
const iso = (ms: unknown) => new Date(ms as number).toISOString();

/** Why the row's record is not a change, or the change. */
function changeRow(r: Record<string, unknown>): HealthChange | string {
  try {
    const { node, name, status, from, text, seenAt = null } = json<Record<string, unknown>>(r.record) ?? {};
    if (!(node === null || typeof node === "string") || typeof name !== "string" || !isStatus(status) || !isStatus(from) || typeof text !== "string" || !(seenAt === null || typeof seenAt === "string")) return "its fields are not a change's";
    return { id: r.id as number, at: iso(r.at), node, name, status, from, text, seenAt } as HealthChange;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Each check's latest change, in the order of those changes. */
const latest = (changes: readonly HealthChange[]) => [...new Map(changes.map((c) => [checkKey(c), c])).values()].sort((a, b) => a.id - b.id);

export const holding = { tables: { doctor_reports: {} } } as const satisfies Holding;

export function healthStore(db: Db, appendEvent: AppendEvent, log: (message: string) => void) {
  db.hold(holding);
  const { sql } = db;
  /** Every reader passes over a row that is not a change rather than fail on it, and the log says so once per row. */
  const logged = new Set<number>();
  const changes = () => sql("SELECT id, at, record FROM doctor_reports ORDER BY id").all().flatMap((r) => {
    const change = changeRow(r);
    if (typeof change !== "string") return [change];
    if (!logged.has(r.id as number)) log(`health history passes over change ${r.id as number}, whose record does not read: ${change}`);
    logged.add(r.id as number);
    return [];
  });
  return {
    /** Each check's latest change, oldest first, which is its confirmed status. A check with none is ok. */
    healthStates: (): HealthChange[] => latest(changes()),
    /** Newest first. */
    healthChanges: (): HealthChange[] => changes().reverse(),
    /**
     * Records each change, with the event the dashboard alerts on, and drops every change from before `keepSince`, in
     * ms, but one that set a problem still open and the newest. A problem that only got better keeps its seen mark, so
     * only a new or worse problem counts as unseen.
     */
    recordHealthChanges(next: readonly NewHealthChange[], keepSince: number): HealthChange[] {
      return db.transaction(() => {
        const before = new Map(latest(changes()).map((c) => [checkKey(c), c]));
        const recorded = next.map((change): HealthChange => {
          const better = change.status !== "ok" && statuses.indexOf(change.status) < statuses.indexOf(change.from);
          const seenAt = better ? before.get(checkKey(change))?.seenAt ?? null : null;
          const { at, ...record } = change;
          const { id } = sql("INSERT INTO doctor_reports (at, record) VALUES (?, ?) RETURNING id").get(Date.parse(at), JSON.stringify({ ...record, seenAt }))!;
          const saved = { ...change, id: id as number, seenAt } as HealthChange;
          appendEvent("health.changed", null, { ...saved });
          return saved;
        });
        const open = new Set(latest(changes()).filter((c) => c.status !== "ok").map((c) => c.id));
        // The newest row stays too, as SQLite gives the next row the highest ID left plus one, and the Health page's
        // seen mark relies on IDs that never repeat.
        const { newest } = sql("SELECT max(id) AS newest FROM doctor_reports").get()!;
        for (const { id } of sql("SELECT id FROM doctor_reports WHERE at < ? AND id < ?").all(keepSince, newest as number | null)) if (!open.has(id as number)) sql("DELETE FROM doctor_reports WHERE id = ?").run(id as number);
        return recorded;
      });
    },
    /** Marks each open problem not yet seen whose change is `through` or older as seen at `at`, in ms. Returns how many. */
    markHealthSeen(through: number, at: number): number {
      return db.transaction(() => {
        const unseen = latest(changes()).filter((c) => c.status !== "ok" && c.seenAt === null && c.id <= through);
        for (const c of unseen) sql("UPDATE doctor_reports SET record = json_set(record, '$.seenAt', ?) WHERE id = ?").run(iso(at), c.id);
        return unseen.length;
      });
    },
  };
}
