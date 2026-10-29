// Prints the main-vs-branch table of follow()'s work and the pylons it holds, and whether the two state dumps match.
//   node compare.ts <main-dir> <branch-dir>
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

const [mainDir, branchDir] = process.argv.slice(2) as [string, string];
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const main = JSON.parse(read(mainDir, "counts.json"));
const branch = JSON.parse(read(branchDir, "counts.json"));

const events = (c: typeof main) => `${Object.entries(c.events).map(([k, v]) => `${v} ${k}`).join(", ")}, over ${c.connections} observe connections`;
if (events(main) !== events(branch)) throw new Error("the two runs were fed different streams");
console.log(`Stream: ${events(main)}.\n`);

const rows: [string, (c: typeof main) => number][] = [
  ["pylon ID reads, one per `known` built", (c) => (c.calls.pylonIdsOn ?? 0) + (c.calls.pylonIdsToTick ?? 0)],
  ["`known` entries ingest read, over all events", (c) => c.knownEntries],
  ["sessions writes", (c) => c.sessionsWrites],
  ["most pylons in `listed`", (c) => c.listedMax],
  ["pylons in `listed` at the end", (c) => c.listedLast],
  ["BEGIN IMMEDIATE transactions", (c) => c.transactions],
  ["SQL statements run", (c) => c.statements],
];
const width = Math.max(...rows.map(([name]) => name.length));
console.log(`| ${"follow() work".padEnd(width)} | main | branch | change |`);
console.log(`|${"-".repeat(width + 2)}|-----:|-------:|-------:|`);
for (const [name, value] of rows) {
  const before = value(main);
  const after = value(branch);
  const change = before === 0 ? "new" : `${Math.round(((after - before) / before) * 100)}%`;
  console.log(`| ${name.padEnd(width)} | ${before} | ${after} | ${change} |`);
}

const same = isDeepStrictEqual(JSON.parse(read(mainDir, "state.json")), JSON.parse(read(branchDir, "state.json")));
const logs = read(mainDir, "loop.log") === read(branchDir, "loop.log");
console.log(`\nRegistry state after the stream: ${same ? "identical" : "DIFFERENT"}. Loop log: ${logs ? "identical" : "DIFFERENT"}.`);
if (!same || !logs) process.exitCode = 1;
