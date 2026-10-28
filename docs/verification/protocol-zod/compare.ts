/**
 * Reads main's and the branch's capture and prints, for each entry point, how many cases kept the same outcome, how
 * many kept their verdict and status with new error text, and every case whose verdict, status or value changed. Then
 * one example of each error text the probe's routes answered on main, beside the branch's text for the same request.
 *
 *   node docs/verification/protocol-zod/compare.ts <main.txt> <branch.txt>
 */
import { readFileSync } from "node:fs";

const read = (path: string) => new Map(readFileSync(path, "utf8").trimEnd().split("\n").map((line) => {
  const at = line.indexOf(" => ");
  return [line.slice(0, at), line.slice(at + 4)] as const;
}));
const main = read(process.argv[2]!);
const branch = read(process.argv[3]!);
if (main.size !== branch.size || [...main.keys()].some((id) => !branch.has(id))) throw new Error("the captures hold different cases");

/** `ok`, `threw`, or the HTTP status, which a changed error text must keep. */
const verdict = (outcome: string) => /^(ok|threw) /.exec(outcome)?.[1] ?? /^"?(?:HTTP\/1\.1 )?(\d{3}) /.exec(outcome)?.[1] ?? outcome;
const entry = (id: string) => id.split(" ").slice(0, id.startsWith("client.") ? 1 : id.match(/^(PUT|POST|GET) /) ? 2 : 1).join(" ");

const counts = new Map<string, { same: number; text: number; changed: number }>();
const changed: string[] = [];
const examples = new Map<string, [string, string, string]>();
for (const [id, before] of main) {
  const after = branch.get(id)!;
  const count = counts.get(entry(id)) ?? { same: 0, text: 0, changed: 0 };
  counts.set(entry(id), count);
  if (before === after) count.same++;
  else if (verdict(before) === verdict(after) && verdict(before) !== "ok" && !before.startsWith("410 ")) {
    count.text++;
    if (/^(PUT|POST|GET) /.test(id) && !examples.has(before)) examples.set(before, [id, before, after]);
  } else {
    count.changed++;
    changed.push(`${id}\n  main:   ${before}\n  branch: ${after}`);
  }
}

console.log(`${main.size} cases\n`);
console.log("entry point | same outcome | same verdict and status, new error text | verdict, status or value changed");
for (const [name, c] of counts) console.log(`${name} | ${c.same} | ${c.text} | ${c.changed}`);
console.log(`\n${changed.length} cases changed verdict, status or value:\n${changed.join("\n")}`);
console.log(`\n${examples.size} distinct error answers from the probe's routes on main, each with the branch's answer to the same request:`);
for (const [id, before, after] of examples.values()) console.log(`\n${id}\n  main:   ${before}\n  branch: ${after}`);
