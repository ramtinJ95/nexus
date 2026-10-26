// node summary.cjs <hooks.jsonl> [all]: one line per hook, seconds from the first, without tool hooks unless `all`.
const lines = require("fs").readFileSync(process.argv[2], "utf8").trim().split("\n").map(JSON.parse);
const t0 = lines[0].t;
for (const l of lines) {
  const p = l.payload;
  if (process.argv[3] !== "all" && /ToolUse$/.test(l.hook)) continue;
  console.log(((l.t - t0) / 1000).toFixed(1), l.hook, p.session_id?.slice(0, 8), p.notification_type ?? "", p.message ?? "", p.tool_name ?? "", JSON.stringify(p.background_tasks ?? ""), p.prompt ? String(p.prompt).slice(0, 60).replace(/\n/g, " ") : "");
}
