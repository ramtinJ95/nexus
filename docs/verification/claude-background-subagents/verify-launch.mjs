// node verify-launch.mjs <herdr session> <scratch dir> [bash startup seconds]
// Runs the patched openSession against a real Herdr server and Claude, with the guest's HOME and checkout moved
// under the scratch dir, and a first prompt over 5 KB holding newlines, a tab, quotes, backticks, dollar signs and `!!`.
// The workspace starts with HOME set, so the pane's bash runs <scratch dir>/home/.bashrc, which sources the real one
// and the token placeholder, and sleeps the given seconds first. Nothing else is typed into the pane.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { openSession } from "../../../src/sessions.ts";

const [session, scratch, startupSeconds = "0"] = process.argv.slice(2);
const home = `${scratch}/home`;
const repo = `${scratch}/repo`;
const hooks = `${scratch}/hooks.jsonl`;
mkdirSync(`${home}/.claude`, { recursive: true });
mkdirSync(repo, { recursive: true });
writeFileSync(`${home}/.bashrc`, `${startupSeconds === "0" ? "" : `sleep ${startupSeconds}\n`}. /home/user/.bashrc\n. /etc/profile.d/nexus-secrets.sh\n`);
writeFileSync(`${scratch}/log-hook.cjs`, `let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => require("node:fs").appendFileSync(${JSON.stringify(hooks)}, JSON.stringify({ hook: "UserPromptSubmit", payload: JSON.parse(d) }) + "\\n"));\n`);
writeFileSync(`${home}/.claude/settings.json`, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${scratch}/log-hook.cjs` }] }] } }));
const lines = ['Reply with the single word "received" and nothing else.'];
for (let i = 1; lines.join("\n").length < 5200; i++) {
  lines.push(`Line ${i} has "double quotes", 'single quotes', \`backticks\`, $HOME, $(echo no), \${PATH}, !!, a backslash \\n and a tab:\there.`);
  if (i % 10 === 0) lines.push("");
}
lines.push("Last line.");
const prompt = lines.join("\n");
const guest = {
  async exec(argv, options) {
    argv = argv.map((a) => a.replaceAll("/home/user/workspace/repo", repo).replaceAll("/home/user", home));
    if (argv[0] === "herdr") argv[2] = session;
    if (argv[3] === "workspace" && argv[4] === "create") argv.push("--env", `HOME=${home}`);
    if (argv[3] === "pane" && argv[4] === "run") console.log(`typed ${argv[6].length} bytes at`, new Date().toISOString());
    if (argv[3] === "shell-ready") console.log("waiting for the shell's prompt from", new Date().toISOString());
    return new Promise((resolve, reject) => execFile(argv[0], argv.slice(1), { cwd: repo, env: { ...process.env, HOME: argv[0] === "herdr" ? process.env.HOME : home }, timeout: options.timeoutMs }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") reject(err); else resolve({ exitCode: err?.code ?? 0, output: stdout + stderr });
    }));
  },
};
console.log(`first prompt: ${prompt.length} bytes, ${lines.length} lines; bash startup sleeps ${startupSeconds} s`);
console.log("started at", new Date().toISOString());
const pane = await openSession(guest, { harness: "claude-code", title: "multi-line-launch", cwd: repo, prompt, model: "claude-sonnet-5-5" });
console.log("openSession returned", pane, new Date().toISOString());
for (let i = 0; i < 100 && !existsSync(hooks); i++) await new Promise((r) => setTimeout(r, 100));
const submitted = readFileSync(hooks, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.hook === "UserPromptSubmit");
console.log("UserPromptSubmit prompt is the exact first prompt:", submitted?.payload.prompt === prompt);
await new Promise((r) => setTimeout(r, 8000));
const read = await guest.exec(["herdr", "--session", session, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "12"], { timeoutMs: 10_000 });
console.log(read.output.trimEnd());
