/**
 * Times three ways to read the newest 16 Claude entries of 300 threads that hold 1000 entries each, every seventh only
 * nine: one LIMIT query per thread as main does, a row_number() window, and the bounded join the branch uses, and
 * checks the join reads the same entries per thread as main. Run with `node --no-warnings docs/verification/registry-reads/entries.ts`.
 */
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE claude_entries (thread TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (thread, seq)) STRICT;");
const ins = db.prepare("INSERT INTO claude_entries VALUES (?, ?, ?)");
const ids: string[] = [];
db.exec("BEGIN");
for (let t = 0; t < 300; t++) { const id = `th-${t}`; ids.push(id); for (let s = 0; s < (t % 7 === 0 ? 9 : 1000); s++) ins.run(id, s, JSON.stringify({ kind: "reply", at: s, text: id + "x".repeat(200) })); }
db.exec("COMMIT");
const of = JSON.stringify(ids);
const time = (name: string, run: () => unknown[]) => { run(); const t0 = performance.now(); let n = 0; for (let i = 0; i < 5; i++) n = run().length; console.log(name, ((performance.now() - t0) / 5).toFixed(1), "ms", n, "rows"); };
const perThread = db.prepare("SELECT entry FROM claude_entries WHERE thread = ? ORDER BY seq DESC LIMIT 16");
time("per thread LIMIT 16 (main)", () => ids.flatMap((id) => perThread.all(id)));
const windowed = db.prepare(`SELECT thread, entry FROM (SELECT thread, seq, entry, row_number() OVER (PARTITION BY thread ORDER BY seq DESC) AS n
  FROM claude_entries WHERE thread IN (SELECT value FROM json_each(?))) WHERE n <= 16 ORDER BY thread, seq`);
time("window", () => windowed.all(of));
const bounded = db.prepare(`SELECT j.value AS thread, e.entry FROM json_each(?) j JOIN claude_entries e ON e.thread = j.value
  AND e.seq > coalesce((SELECT seq FROM claude_entries WHERE thread = j.value ORDER BY seq DESC LIMIT 1 OFFSET 16), -1) ORDER BY j.value, e.seq`);
time("bounded join", () => bounded.all(of));
for (const r of db.prepare(`EXPLAIN QUERY PLAN SELECT j.value AS thread, e.entry FROM json_each(?) j JOIN claude_entries e ON e.thread = j.value
  AND e.seq > coalesce((SELECT seq FROM claude_entries WHERE thread = j.value ORDER BY seq DESC LIMIT 1 OFFSET 16), -1) ORDER BY j.value, e.seq`).all(of)) console.log(r.detail);
const a = JSON.stringify(Object.fromEntries(ids.map((id) => [id, perThread.all(id).reverse().map((r) => r.entry)])));
const grouped: Record<string, unknown[]> = Object.fromEntries(ids.map((id) => [id, []]));
for (const r of bounded.all(of)) grouped[r.thread as string]!.push(r.entry);
const b = JSON.stringify(grouped);
console.log("same entries as main, in order per thread:", a === b);
