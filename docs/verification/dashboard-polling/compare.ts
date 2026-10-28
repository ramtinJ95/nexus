// Prints the work measure.ts counted on main and on the branch, and what their tabs showed, and exits 1 if the tabs
// showed different notifications, toasts or titles.
//   node docs/verification/dashboard-polling/compare.ts <main-dir> <branch-dir>
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Counts = Record<"setup" | "idle" | "attention", { sqlReads: number; sqlWrites: number; calls: Record<string, number>; requests: Record<string, number> }>;
type Notice = { tab: string; channel: string; text: string; round: number; afterMs: number; trigger: string | null; triggerAfterMs: number | null };
type Observed = {
  rounds: { kind: string; thread: string; open: string[]; titlesAfter5s: Record<string, string> }[];
  notices: Notice[];
  newReplySeenAfterMs: number[];
  unseenElsewhere: { seenAgainAfterMs: number | null; attentionAtEnd: string | null };
};
const read = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8"));
const [mainDir, branchDir] = process.argv.slice(2) as [string, string];
const counts = { main: read<Counts>(mainDir, "counts.json"), branch: read<Counts>(branchDir, "counts.json") };
const seen = { main: read<Observed>(mainDir, "observed.json"), branch: read<Observed>(branchDir, "observed.json") };

const requests = (c: Counts["idle"], match: (key: string) => boolean) => Object.entries(c.requests).filter(([k]) => match(k)).reduce((n, [, v]) => n + v, 0);
const hidden = (key: string) => key.startsWith("hidden ");
const work: [string, (c: Counts["idle"]) => number][] = [
  ["`GET /v1/threads`, all four tabs", (c) => requests(c, (k) => k.endsWith("GET /v1/threads"))],
  ["Requests from the two hidden tabs", (c) => requests(c, hidden)],
  ["Thread rows built, `row()`", (c) => c.calls.row ?? 0],
  ["Thread details built, `detail()`", (c) => c.calls.detail ?? 0],
  ["Session reads per thread, `withSessions()`", (c) => c.calls.withSessions ?? 0],
  ["SQL statements read", (c) => c.sqlReads],
  ["`POST /v1/threads/<id>/seen`", (c) => requests(c, (k) => k.endsWith("/seen"))],
  ["`markSeen()` write transactions", (c) => c.calls.markSeen ?? 0],
  ["SQL statements written", (c) => c.sqlWrites],
  ["Event batches read, `eventBatch()`", (c) => c.calls.eventBatch ?? 0],
  ["Page renders, `sidebar()`", (c) => c.calls.sidebar ?? 0],
];
const change = (a: number, b: number) => a === b ? "0%" : a === 0 ? "new" : `${Math.round((b - a) / a * 100)}%`;
const lines: string[] = [];
for (const phase of ["idle", "attention"] as const) {
  lines.push(`Work in the ${phase === "idle" ? "idle minute" : "sixteen attention rounds"}:`, "", "| Work | main | branch | change |", "|---|---:|---:|---:|");
  for (const [name, of] of work) {
    const a = of(counts.main[phase]);
    const b = of(counts.branch[phase]);
    lines.push(`| ${name} | ${a} | ${b} | ${change(a, b)} |`);
  }
  lines.push("");
}
const streams = (c: Counts) => Object.entries({ ...c.setup.requests }).filter(([k]) => k.includes("?follow")).map(([k, v]) => `${k} x${v}`).join(", ") || "none";
lines.push(`Event streams opened over the whole run: main ${streams(counts.main)}; branch ${streams(counts.branch)}.`, "");

const key = (n: Notice) => `${n.round} ${n.tab} ${n.channel} ${n.text}`;
const keys = { main: seen.main.notices.map(key), branch: seen.branch.notices.map(key) };
const sameNotices = JSON.stringify(keys.main) === JSON.stringify(keys.branch);
const titles = (o: Observed) => JSON.stringify(o.rounds.map((r) => r.titlesAfter5s));
const sameTitles = titles(seen.main) === titles(seen.branch);
lines.push("Notifications, ms after the registry recorded the change (a reply is held back 2000 ms first):", "",
  "| Round | Change | Tab | Channel | main | branch |", "|---:|---|---|---|---:|---:|");
for (const n of seen.main.notices) {
  const b = seen.branch.notices.find((m) => key(m) === key(n));
  lines.push(`| ${n.round} | ${seen.main.rounds[n.round]!.kind} | ${n.tab} | ${n.channel} | ${n.afterMs} | ${b?.afterMs ?? "missing"} |`);
}
for (const n of seen.branch.notices.filter((m) => !keys.main.includes(key(m)))) lines.push(`| ${n.round} | ${seen.branch.rounds[n.round]!.kind} | ${n.tab} | ${n.channel} | missing | ${n.afterMs} |`);
const mean = (xs: number[]) => xs.length === 0 ? NaN : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
const delays = (o: Observed, kind: string, tabs: (tab: string) => boolean) => o.notices.filter((n) => o.rounds[n.round]!.kind === kind && tabs(n.tab)).map((n) => n.afterMs);
lines.push("", "| Delay, ms | main mean | branch mean | main max | branch max |", "|---|---:|---:|---:|---:|");
for (const kind of ["new reply", "waiting for input"]) {
  for (const [name, tabs] of [["hidden tabs", hidden], ["all tabs", () => true]] as const) {
    const [a, b] = [delays(seen.main, kind, tabs), delays(seen.branch, kind, tabs)];
    lines.push(`| ${kind}, ${name} | ${mean(a)} | ${mean(b)} | ${Math.max(...a)} | ${Math.max(...b)} |`);
  }
}
const waits = (o: Observed) => o.notices.filter((n) => o.rounds[n.round]!.kind === "waiting for input" && n.triggerAfterMs !== null);
const triggers = (o: Observed) => [...new Set(waits(o).map((n) => n.trigger))].join(", ");
lines.push("", "A waiting session's notifications, split at what ended the tab's wait (main: its read of the list; branch: the stream's message):", "",
  "| Mean, ms | main | branch |", "|---|---:|---:|",
  `| Change to the trigger | ${mean(waits(seen.main).map((n) => n.triggerAfterMs!))} | ${mean(waits(seen.branch).map((n) => n.triggerAfterMs!))} |`,
  `| Trigger to the notification | ${mean(waits(seen.main).map((n) => n.afterMs - n.triggerAfterMs!))} | ${mean(waits(seen.branch).map((n) => n.afterMs - n.triggerAfterMs!))} |`,
  `| Triggers | ${triggers(seen.main)} | ${triggers(seen.branch)} |`);
lines.push("", `Same notifications and toasts, on the same tabs, for the same rounds: ${sameNotices ? "yes" : "NO"} (${keys.main.length} on main, ${keys.branch.length} on the branch).`);
lines.push(`Same tab titles 5 s into every round: ${sameTitles ? "yes" : "NO"} (${[...new Set(seen.main.rounds.flatMap((r) => Object.values(r.titlesAfter5s)))].join(", ")}).`);
lines.push(`A new reply on the focused page was marked seen after, in ms: main ${seen.main.newReplySeenAfterMs.join(", ")}; branch ${seen.branch.newReplySeenAfterMs.join(", ")}.`);
const unseen = (o: Observed) => o.unseenElsewhere.seenAgainAfterMs === null ? `stayed unseen for 8 s, attention ${o.unseenElsewhere.attentionAtEnd}` : `marked seen again after ${o.unseenElsewhere.seenAgainAfterMs} ms, attention ${o.unseenElsewhere.attentionAtEnd}`;
lines.push(`A reply another client marked unseen while the page shows it: main ${unseen(seen.main)}; branch ${unseen(seen.branch)}.`);
console.log(lines.join("\n"));
process.exit(sameNotices && sameTitles && seen.branch.unseenElsewhere.seenAgainAfterMs === null ? 0 : 1);
