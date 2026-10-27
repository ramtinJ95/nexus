// Prints the main-vs-branch table of follow()'s work and whether the two state dumps match.
//   node compare.ts <main-dir> <branch-dir>
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

const [mainDir, branchDir] = process.argv.slice(2) as [string, string];
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const main = JSON.parse(read(mainDir, "counts.json"));
const branch = JSON.parse(read(branchDir, "counts.json"));

const events = (c: typeof main) => Object.entries(c.events).map(([k, v]) => `${v} ${k}`).join(", ");
if (events(main) !== events(branch)) throw new Error("the two runs were fed different streams");
console.log(`Stream: ${events(main)}.\n`);

const rows: [string, (c: typeof main) => number][] = [
  ["registry.node reads", (c) => c.calls.node ?? 0],
  ["pylonIdsOn reads, one per `known` built", (c) => c.calls.pylonIdsOn ?? 0],
  ["reportSession calls, each a zod parse and a pylon lookup", (c) => c.calls.reportSession ?? 0],
  ["eventReceipt reads", (c) => c.calls.eventReceipt ?? 0],
  ["ingested calls", (c) => c.calls.ingested ?? 0],
  ["BEGIN IMMEDIATE transactions", (c) => c.transactions],
  ["node observation UPDATEs", (c) => c.observationWrites],
  ["observation JSON written, bytes", (c) => c.observationBytes],
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
