import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseRecord } from "../../../src/claude-transcript.ts";
const [file, dir] = process.argv.slice(2) as [string, string];
const prompts = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  const raw = JSON.parse(line);
  return parseRecord(line).filter((e) => e.kind === "prompt").map((e) => ({ ...e, record: raw.type === "attachment" ? `attachment/${raw.attachment?.type}` : raw.type }));
});
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
for (const name of ["review", "busy", "nudge"]) {
  const typed = readFileSync(`${dir}/${name}.txt`, "utf8");
  const hit = prompts.filter((p) => p.kind === "prompt" && sha(p.text) === sha(typed));
  console.log(`${name}: typed ${typed.length} chars; prompts with the same SHA-256: ${hit.map((p) => `${p.record} from=${(p as { from: string }).from}`).join(", ") || "NONE"}`);
}
for (const p of prompts) console.log(`  prompt ${p.record} from=${(p as { from: string }).from} ${JSON.stringify((p as { text: string }).text.slice(0, 70))}`);
