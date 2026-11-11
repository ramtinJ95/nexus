import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as contract from "./guest-contract.ts";
import { coreHome, tempDir, unixSockets } from "./test-support/kit.ts";

test("each name and limit equals the literal it replaced", () => {
  const { asUser, onClaudeTranscript, coreRunning, coreHeld, startCore, ensureCore, terminalPattern, attachScript, ...values } = contract;
  assert.deepEqual(values, {
    servicesActions: ["ensure", "list", "restart", "stop"],
    maxServiceLogLines: 500,
    execOutputMaxBytes: 65_536,
    callTimeoutMs: 10_000,
    coreAttach: "hc",
    coreViewer: "([^ ]*/)?(herdr-core|hc)( attach( .*)?)?",
    coreStartMs: 5_000,
  });
  assert.equal(startCore, "setsid -f tini -s -- herdr-core serve </dev/null >/dev/null 2>&1");
  assert.equal(ensureCore, `{ up() ${coreRunning}; up || { ${startCore}; i=50; while [ $((i-=1)) -gt 0 ] && ! up; do sleep 0.1; done; up; }; }`);
  assert.equal(terminalPattern.source, "^t[0-9a-z]{1,12}$");
  assert.equal(terminalPattern.flags, "");
  assert.deepEqual(asUser("id"), ["runuser", "-l", "user", "-c", "id"]);
  assert.equal(onClaudeTranscript("cat \"$f\"", 3), 'for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] || continue; cat "$f"; exit 0; done; exit 3');
});

test("a viewer is Core's picker or an attach, not the core, a held terminal, or an app's connect and events", () => {
  // pgrep -x matches the whole command line, as these anchors do. Each is one check.sh's viewer-cmdline saw.
  const viewer = new RegExp(`^${contract.coreViewer}$`);
  const counted = ["herdr-core attach target", "herdr-core", "/usr/local/bin/herdr-core attach t7", "hc", "hc attach t2"];
  const not = ["/home/user/.local/bin/herdr-core serve", "herdr-core hold --socket /run/user/1000/herdr-core/default.holder.f460535f.sock",
    "herdr-core events --json", "herdr-core connect", "tini -s -- herdr-core serve", "sh -c herdr-core attach t1", "herdr --session nexus"];
  assert.deepEqual(counted.filter((line) => !viewer.test(line)), []);
  assert.deepEqual(not.filter((line) => viewer.test(line)), []);
});

interface Listed { address: string; state?: string; labels?: Record<string, string>; parent?: string }

/**
 * Runs attachScript as a user whose core listens, against a fake herdr-core on PATH whose `connect` answers a
 * `terminal.list` of the live ones of `terminals`, as Core lists them, or a reply as given. Returns what herdr-core was exec'd with last and where, or null
 * when it was not, with the script's exit code and stderr.
 */
async function attach(t: { after: (fn: () => Promise<void>) => void }, pane: string, terminals: readonly Listed[] | string, core: "listening" | "down" = "listening") {
  const user = await coreHome(t);
  if (core === "listening") await user.listen("core");
  const bin = await tempDir("nexus-attach-", t);
  const log = join(bin, "argv");
  const list = typeof terminals === "string" ? terminals
    : JSON.stringify({ id: 1, jsonrpc: "2.0", result: { terminals: terminals.filter((x) => x.state !== "finished").map((x) => ({ state: "live", labels: {}, parent: null, ...x })) } });
  await writeFile(join(bin, "reply"), `a warning first\n${list}\n`);
  await writeFile(join(bin, "herdr-core"), `#!/bin/sh\nif [ "$1" = connect ]; then cat >/dev/null; exec cat ${join(bin, "reply")}; fi\necho "$PWD: $*" > ${log}\n`, { mode: 0o755 });
  await writeFile(join(bin, "setsid"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const run = spawnSync("sh", ["-c", contract.attachScript, "attach", pane], { cwd: "/", env: { ...user.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: "utf8" });
  return { exec: existsSync(log) ? readFileSync(log, "utf8").trim().replace(user.home, "~") : null, exitCode: run.status, stderr: run.stderr };
}

const worker = { address: "t3", labels: { "nexus.harness": "claude-code" } };
const handOpened = { address: "t1" };
const reviewer = { address: "t2", parent: "t3", labels: { "nexus.harness": "claude-code" } };
const shell = { address: "t4", labels: { "nexus.harness": "shell" } };

test("the attach attaches to the live terminal it names, else to a session Nexus opened, else to any live one", { skip: unixSockets !== true && unixSockets }, async (t) => {
  assert.equal((await attach(t, "t3", [handOpened, reviewer, worker, shell])).exec, "/: attach t3");
  assert.equal((await attach(t, "t3", [handOpened, reviewer, { ...worker, state: "finished" }, shell])).exec, "/: attach t4", "a finished terminal, as a wake leaves its session's old one");
  assert.equal((await attach(t, "t9", [handOpened, reviewer, shell])).exec, "/: attach t4", "a terminal the core does not know");
  assert.equal((await attach(t, "", [handOpened, reviewer, shell])).exec, "/: attach t4", "no terminal named, and a reviewer belongs to its builder");
  assert.equal((await attach(t, "", [{ address: "laptop/t1", labels: { "nexus.harness": "shell" } }, handOpened])).exec, "/: attach t1", "a terminal of another machine is not the pylon's");
});

test("the attach opens Core's picker in the home folder only when no terminal is live, or when the list cannot be read, which it says", { skip: unixSockets !== true && unixSockets }, async (t) => {
  assert.deepEqual(await attach(t, "t3", [{ ...worker, state: "finished" }]), { exec: "~:", exitCode: 0, stderr: "" });
  const unread = await attach(t, "t3", "not json");
  assert.equal(unread.exec, "~:");
  assert.match(unread.stderr, /nexus attach: no terminal list, so the picker opens/);
});

test("an attach whose core does not start fails, saying so, and runs no Core command that would start one", { skip: unixSockets !== true && unixSockets }, async (t) => {
  assert.deepEqual(await attach(t, "t3", [worker], "down"), { exec: null, exitCode: 1, stderr: "nexus attach: Herdr Core did not start\n" });
});

test("a core runs while it listens at the socket its lock names, for the session Core's commands reach, and its holder outlives a crash", { skip: unixSockets !== true && unixSockets }, async (t) => {
  const user = await coreHome(t);
  const holds = (script: string, env: NodeJS.ProcessEnv = {}) => spawnSync("sh", ["-c", script], { env: { ...user.env, ...env } }).status === 0;
  const seen = () => [holds(contract.coreRunning), holds(contract.coreHeld)];
  assert.deepEqual(seen(), [false, false]);
  await user.listen("core");
  await user.listen("holder");
  assert.deepEqual(seen(), [true, true]);
  assert.equal(holds(contract.coreRunning, { HC_SESSION: "other" }), false, "a core of another session is not the one connect reaches");
  await user.close("core");
  assert.deepEqual(seen(), [false, true], "the core crashed, and its programs run on");
  await user.close("holder");
  assert.deepEqual(seen(), [false, false]);
});
