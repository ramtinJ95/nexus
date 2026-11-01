/**
 * The health store: each change of `nexus doctor`'s checks that two passes in a row confirmed, in `doctor_reports`,
 * with when the person saw it in its record.
 */
import { json, type Db } from "./db.ts";
import type { EventKind } from "../events.ts";
import { checkKey, statuses, type HealthChange, type Status } from "./doctor-model.ts";

export type NewHealthChange = Omit<HealthChange, "id" | "seenAt">;

const isStatus = (value: unknown): value is Status => (statuses as readonly unknown[]).includes(value);
const iso = (ms: unknown) => new Date(ms as number).toISOString();

/** Null for a row whose record does not parse, which every reader passes over rather than fail on. */
function changeRow(r: Record<string, unknown>): HealthChange | null {
  try {
    const { node, name, status, from, text, seenAt = null } = json<Record<string, unknown>>(r.record) ?? {};
    if (!(node === null || typeof node === "string") || typeof name !== "string" || !isStatus(status) || !isStatus(from) || typeof text !== "string" || !(seenAt === null || typeof seenAt === "string")) return null;
    return { id: r.id as number, at: iso(r.at), node, name, status, from, text, seenAt } as HealthChange;
  } catch {
    return null;
  }
}

/** Each check's latest change, in the order of those changes. */
const latest = (changes: readonly HealthChange[]) => [...new Map(changes.map((c) => [checkKey(c), c])).values()].sort((a, b) => a.id - b.id);

export function reportStore(db: Db, appendEvent: (kind: EventKind, thread: null, payload: Record<string, unknown>) => unknown) {
  const { sql } = db;
  const changes = () => sql("SELECT id, at, record FROM doctor_reports ORDER BY id").all().flatMap((r) => changeRow(r) ?? []);
  return {
    /** Each check's latest change, oldest first, which is its confirmed status. A check with none is ok. */
    healthStates: (): HealthChange[] => latest(changes()),
    /** Newest first. */
    healthChanges: (): HealthChange[] => changes().reverse(),
    /**
     * Records each change, with the event the dashboard alerts on, and drops every change from before `keepSince`, in
     * ms, but one that set a problem still open. A problem that only got better keeps its seen mark, so only a new or
     * worse problem counts as unseen.
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
        for (const { id } of sql("SELECT id FROM doctor_reports WHERE at < ?").all(keepSince)) if (!open.has(id as number)) sql("DELETE FROM doctor_reports WHERE id = ?").run(id as number);
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
