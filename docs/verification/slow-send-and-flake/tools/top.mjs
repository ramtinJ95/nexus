// top.mjs <file.cpuprofile>: self time per function, largest first.
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = p.timeDeltas; let i = 0;
for (const s of p.samples) { const n = byId.get(s); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + (dt[i++] ?? 0)); }
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log("total ms", Math.round(total / 1000));
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(Math.round(v / 1000).toString().padStart(6), k);
