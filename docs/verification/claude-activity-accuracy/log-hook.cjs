// node log-hook.cjs <out.jsonl> <hook>, as a Claude hook command: appends the hook input, a few environment variables
// and the process chain up to the Claude running it, with the environment each Claude process started with.
const fs = require("node:fs");
const out = process.argv[2], hook = process.argv[3];
const flags = (env) => Object.fromEntries(["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "HOME"].map((k) => [k, env[k] ?? null]));
const procEnv = (pid) => { try { return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])); } catch { return {}; } };
const chain = [];
for (let pid = process.ppid; pid > 1 && chain.length < 12;) {
  let stat; try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { break; }
  const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
  chain.push({ pid, comm, exec: /claude/.test(comm) ? flags(procEnv(pid)) : undefined });
  pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}
let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => fs.appendFileSync(out, JSON.stringify({ t: Date.now(), hook, payload: JSON.parse(d), env: flags(process.env), chain }) + "\n"));
