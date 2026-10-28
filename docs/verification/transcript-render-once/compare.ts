// Prints the main-vs-branch table of what measure.ts counted, and whether the two clients saw the same thing.
// Exits non-zero if they did not.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [mainDir, branchDir] = process.argv.slice(2) as [string, string];
const load = async (dir: string) => ({
  counts: JSON.parse(await readFile(join(dir, "counts.json"), "utf8")),
  observed: JSON.parse(await readFile(join(dir, "observed.json"), "utf8")),
  shown: await readFile(join(dir, "shown.html"), "utf8"),
});
const main = await load(mainDir);
const branch = await load(branchDir);

const rows: [string, (c: any) => number][] = [
  ["Entries parsed for the stream's views", (c) => c.entriesParsed.stream],
  ["Entries parsed for the page polls' views", (c) => c.entriesParsed.poll],
  ["Whole-conversation renders for the stream", (c) => c.convoRenders.stream],
  ["Whole-conversation renders for the page polls", (c) => c.convoRenders.poll],
  ["Blocks rendered to HTML, stream", (c) => c.blocksRendered.stream],
  ["Blocks rendered to HTML, page polls", (c) => c.blocksRendered.poll],
  ["Stream frames sent", (c) => c.frames],
  ["Stream frames that changed only an age", (c) => c.ageOnlyFrames],
  ["Stream frames that only name the view shown", (c) => c.namingFrames],
  ["Stream bytes sent", (c) => c.streamBytes],
  ["Page poll bytes sent", (c) => c.pollBytes],
  ["Bare pings", (c) => c.pings],
  ["Transcript reads from the pylon", (c) => c.transcriptReads],
  ["Usage-limit check entries (not this path)", (c) => c.usageLimitEntries],
];
const change = (a: number, b: number) => {
  if (a === b) return "0%";
  if (a === 0) return "new";
  const percent = (b - a) / a * 100;
  return `${Math.abs(percent) > 99 && b !== 0 ? percent.toFixed(1) : Math.round(percent)}%`;
};
const width = Math.max(...rows.map(([name]) => name.length));
console.log(`${main.counts.polls} page polls over 120 simulated seconds of a watched Claude turn of about 630 entries.\n`);
console.log(`| ${"Work".padEnd(width)} | main | branch | change |`);
console.log(`|${"-".repeat(width + 2)}|-----:|-------:|-------:|`);
for (const [name, of] of rows) console.log(`| ${name.padEnd(width)} | ${of(main.counts)} | ${of(branch.counts)} | ${change(of(main.counts), of(branch.counts))} |`);

const same = (what: string, a: unknown, b: unknown) => {
  const equal = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${what}: ${equal ? "identical" : "DIFFERENT"}.`);
  return equal;
};
const certified = (o: any) => o.polls.map((p: any) => [p.at, p.certifies]);
const unseen = (o: any) => o.polls.filter((p: any) => p.unseen).map((p: any) => `${p.at} s (${p.certifies})`);
// The polls where either client certified a reply it had not shown, which the last check counts on its own.
const unseenAt = new Set([...main.observed.polls, ...branch.observed.polls].filter((p: any) => p.unseen).map((p: any) => p.at));
const certifiedSeen = (o: any) => certified(o).filter(([at]: [number]) => !unseenAt.has(at));
const results = [
  same(`Conversation states the client showed, in order (${main.observed.shownContents} on main)`, main.shown, branch.shown),
  same("The conversation the client showed last", main.observed.final, branch.observed.final),
  same("Each poll's page outside the conversation", main.observed.polls.map((p: any) => p.page), branch.observed.polls.map((p: any) => p.page)),
  same("The watermark each other poll let the client certify", certifiedSeen(main.observed), certifiedSeen(branch.observed)),
];
console.log(`Polls that let the client certify a reply it had not shown: main ${unseen(main.observed).join(", ") || "none"}, branch ${unseen(branch.observed).join(", ") || "none"}.`);
results.push(unseen(branch.observed).length === 0);
console.log(`\nPolls that rendered the conversation: main ${main.observed.polls.filter((p: any) => p.renderedConvo).length}, branch ${branch.observed.polls.filter((p: any) => p.renderedConvo).length}.`);
console.log(`Polls that certified a reply's watermark: ${certified(branch.observed).filter(([, w]: [number, string | null]) => w !== null && w !== "").map(([at, w]: [number, string]) => `${at} s (${w})`).join(", ")} on the branch, ${certified(main.observed).filter(([, w]: [number, string | null]) => w !== null && w !== "").map(([at, w]: [number, string]) => `${at} s (${w})`).join(", ")} on main.`);
process.exit(results.every(Boolean) ? 0 : 1);
