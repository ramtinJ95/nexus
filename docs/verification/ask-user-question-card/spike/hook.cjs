const fs = require("fs");
const dir = process.env.SPIKE;
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const p = JSON.parse(input);
  fs.appendFileSync(`${dir}/hooks.jsonl`, JSON.stringify({ t: Date.now(), hook: p.hook_event_name, tool: p.tool_name, id: p.tool_use_id, input: p.tool_input, response: p.tool_response }) + "\n");
  if (p.hook_event_name !== process.env.SPIKE_ANSWERS_ON || p.tool_name !== "AskUserQuestion") return;
  fs.writeFileSync(`${dir}/pending.json`, JSON.stringify(p));
  const answer = `${dir}/answer.json`;
  for (let i = 0; i < 1200; i++) {
    if (fs.existsSync(answer)) {
      const out = fs.readFileSync(answer, "utf8");
      fs.renameSync(answer, `${dir}/answer-used-${Date.now()}.json`);
      fs.rmSync(`${dir}/pending.json`, { force: true });
      process.stdout.write(out);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});
