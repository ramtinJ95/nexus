import { DatabaseSync } from "node:sqlite";
import type { PylonEvent, ReportedEvent } from "../events.ts";
import type { PylonId } from "../ids.ts";


export function eventJournal(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)");
  let closed = false;
  return {
    append(pylon: PylonId, event: PylonEvent): ReportedEvent {
      const record = { pylon, event, time: Date.now() };
      db.exec("BEGIN IMMEDIATE");
      try {
        const sequence = Number(db.prepare("INSERT INTO events (record) VALUES (?)").run(JSON.stringify(record)).lastInsertRowid);
        db.prepare("DELETE FROM events WHERE id <= ?").run(sequence - 100);
        db.exec("COMMIT");
        return { sequence, ...record };
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    },
    recent(): ReportedEvent[] {
      return db.prepare("SELECT id, record FROM events ORDER BY id").all().map((r) => ({ sequence: Number(r.id), ...JSON.parse(r.record as string) }));
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
