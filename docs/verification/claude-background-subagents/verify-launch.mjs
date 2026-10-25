// node verify-launch.mjs <herdr session> <scratch dir>
// Runs the patched openSession against a real Herdr server and Claude, with the guest's HOME and checkout moved
// under the scratch dir, and a first prompt holding newlines, a tab, quotes, backticks, dollar signs and `!!`.
// <scratch dir>/home/.claude/settings.json should log UserPromptSubmit input to <scratch dir>/hooks.jsonl.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { openSession } from "../../../src/sessions.ts";

const [session, scratch] = process.argv.slice(2);
const home = `${scratch}/home`;
const repo = `${scratch}/repo`;
const prompt = [
  'Reply with the single word "received" and nothing else.',
  "Line two has \"double quotes\", 'single quotes', `backticks`, $HOME, $(echo no), !!, a backslash \\n and a tab:\there.",
  "",
  "Last line, after a blank one.",
].join("\n");
const guest = {
  async exec(argv, options) {
    argv = argv.map((a) => a.replaceAll("/home/user/workspace/repo", repo).replaceAll("/home/user", home));
    if (argv[0] === "herdr") argv[2] = session;
    if (argv[3] === "pane" && argv[4] === "run") console.log("typed:", argv[6]);
    const result = await new Promise((resolve, reject) => execFile(argv[0], argv.slice(1), { cwd: repo, env: { ...process.env, HOME: argv[0] === "herdr" ? process.env.HOME : home }, timeout: options.timeoutMs }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") reject(err); else resolve({ exitCode: err?.code ?? 0, output: stdout + stderr });
    }));
    if (argv[3] === "workspace" && argv[4] === "create") {
      const pane = JSON.parse(result.output).result.root_pane.pane_id;
      await this.exec(["herdr", "--session", "nexus", "pane", "run", pane, `export HOME=${home}; . /etc/profile.d/nexus-secrets.sh`], { timeoutMs: 10_000 });
      await new Promise((r) => setTimeout(r, 500));
    }
    return result;
  },
};
console.log("started at", new Date().toISOString());
const pane = await openSession(guest, { harness: "claude-code", title: "multi-line-launch", cwd: repo, prompt, model: "claude-sonnet-5-5" });
console.log("openSession returned", pane, new Date().toISOString());
for (let i = 0; i < 100 && !existsSync(`${scratch}/hooks.jsonl`); i++) await new Promise((r) => setTimeout(r, 100));
const submitted = readFileSync(`${scratch}/hooks.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.hook === "UserPromptSubmit");
console.log("UserPromptSubmit prompt is the exact first prompt:", submitted?.payload.prompt === prompt);
console.log(JSON.stringify(submitted?.payload.prompt));
await new Promise((r) => setTimeout(r, 8000));
const read = await guest.exec(["herdr", "--session", "nexus", "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "30"], { timeoutMs: 10_000 });
console.log(read.output.trimEnd());
