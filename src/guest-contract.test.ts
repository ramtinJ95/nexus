import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as contract from "./guest-contract.ts";

test("each name and limit equals the literal it replaced", () => {
  const { asUser, onClaudeTranscript, coreRunning, startCore, ensureCore, terminalPattern, attachScript, ...values } = contract;
  assert.deepEqual(values, {
    servicesActions: ["ensure", "list", "restart", "stop"],
    maxServiceLogLines: 500,
    execOutputMaxBytes: 65_536,
    callTimeoutMs: 10_000,
    herdrSession: "nexus",
    coreAttach: "hc",
    coreViewer: "([^ ]*/)?(herdr-core|hc)( attach( .*)?)?",
    coreStartMs: 5_000,
  });
  assert.equal(coreRunning, `pgrep -u "$(id -u)" -x -f '([^ ]*/)?herdr-core serve' >/dev/null`);
  assert.equal(startCore, "setsid -f tini -s -- herdr-core serve </dev/null >/dev/null 2>&1");
  assert.equal(ensureCore, `{ ${coreRunning} || { ${startCore}; i=0; until ${coreRunning}; do i=$((i + 1)); [ $i -lt 50 ] || break; sleep 0.1; done; ${coreRunning}; }; }`);
  assert.equal(terminalPattern.source, "^t[0-9a-z]{1,12}$");
  assert.equal(terminalPattern.flags, "");
  assert.deepEqual(asUser("id"), ["runuser", "-l", "user", "-c", "id"]);
  assert.equal(onClaudeTranscript("cat \"$f\"", 3), 'for f in "$1"/*/"$0".jsonl; do [ -e "$f" ] || continue; cat "$f"; exit 0; done; exit 3');
  assert.equal(attachScript, `${ensureCore}; t=$1; [ -n "$t" ] && herdr-core get "$t" --json 2>/dev/null | grep -q '"state": *"live"' && exec herdr-core attach "$t"; exec herdr-core`);
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

/**
 * Runs attachScript against a fake core on PATH: pgrep finds a running core, and `herdr-core get` prints the JSON
 * `states` holds for a terminal, or fails for one it does not. It answers the argv herdr-core was exec'd with last.
 */
async function attachArgv(t: { after: (fn: () => Promise<void>) => void }, pane: string, states: Record<string, string>): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "nexus-attach-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const log = join(bin, "argv");
  await writeFile(join(bin, "pgrep"), "#!/bin/sh\nexit 0\n");
  const cases = Object.entries(states).map(([address, state]) => `${address}) printf '{"address": "${address}", "state": "${state}"}\\n'; exit 0;;`).join("\n  ");
  await writeFile(join(bin, "herdr-core"), `#!/bin/sh\nif [ "$1" = get ]; then case "$2" in\n  ${cases}\n  *) echo "no terminal $2" >&2; exit 1;;\nesac; fi\necho "$*" > ${log}\n`);
  await chmod(join(bin, "pgrep"), 0o755);
  await chmod(join(bin, "herdr-core"), 0o755);
  await promisify(execFile)("sh", ["-c", contract.attachScript, "attach", pane], { env: { PATH: `${bin}:/usr/bin:/bin` } });
  return (await readFile(log, "utf8")).trim();
}

test("the attach attaches to a live terminal it names, and opens Core's picker for none, a finished one or a gone one", async (t) => {
  const states = { t1: "live", t2: "finished" };
  assert.equal(await attachArgv(t, "t1", states), "attach t1");
  assert.equal(await attachArgv(t, "", states), "");
  assert.equal(await attachArgv(t, "t2", states), "", "a finished terminal, as a wake leaves its session's old one");
  assert.equal(await attachArgv(t, "t9", states), "", "a terminal the core does not know");
});
