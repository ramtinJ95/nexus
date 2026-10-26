import { readFileSync } from "node:fs";
import { parseRecord } from "../../../src/claude-transcript.ts";
for (const line of readFileSync(process.argv[2]!, "utf8").split("\n").filter((l) => l !== "")) {
  const r = JSON.parse(line);
  console.log(`${r.type} v${r.version ?? "-"} ->`, JSON.stringify(parseRecord(line).map((e) => ({ ...e, at: undefined }))));
}
