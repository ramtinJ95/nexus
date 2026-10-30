// Types a message into a Claude pane exactly as src/sessions.ts's sendToClaude does: 64-code-point chunks, then Enter.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { typeable } from "../../../src/control/inbox.ts";
const [pane, name, out] = process.argv.slice(2) as [string, string, string];
const texts: Record<string, string> = {
  review: `[Nexus review — automated, not a message from the person]
Round 1 of review rv-live. Here are the reviewer's findings, "quoted" and 'single', with \`ticks\` and $HOME and $(echo no) and a \\ backslash.\r\n\tA tabbed line, and an indented one:
    - F1 (P2) src/control/inbox.ts: the hash covers the text as typed — not as shown.
${Array.from({ length: 30 }, (_, i) => `    filler line ${i} with "quotes", \`ticks\`, $VAR and ünïcödé ✓`).join("\n")}
Do not change anything. Reply with just OK.`,
  busy: "Run each of these as its own separate Bash tool call, one after another: `seq 1 2000000 | tail -1`, `ls /usr/bin | wc -l`, `date`, `uname -a`, `df -h /`. Then reply with just DONE.",
  nudge: `[Nexus nudge — automated, not a message from the person]
Typed mid-turn, so Claude queues it. "q" 's' \`b\` $X
${Array.from({ length: 12 }, (_, i) => `  queued filler ${i} — with an em dash`).join("\n")}
Reply with just QUEUED.`,
};
const text = typeable(texts[name]!);
writeFileSync(out, text);
const points = Array.from(text);
for (let i = 0; i < points.length; i += 64) execFileSync("herdr", ["pane", "send-text", pane, points.slice(i, i + 64).join("")]);
execFileSync("sleep", ["0.5"]);
execFileSync("herdr", ["pane", "send-keys", pane, "Enter"]);
console.log(`typed ${name}: ${points.length} code points in ${Math.ceil(points.length / 64)} chunks`);
