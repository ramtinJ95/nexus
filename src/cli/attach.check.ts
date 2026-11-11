/**
 * Real-node validation of `nexus attach` through the control plane, run by hand on a Mac from a checkout:
 *   node src/cli/attach.check.ts --project P [--keep] [--skip-idle-pause] [--evidence DIR] [--url URL] [--socks HOST:PORT|none]
 *
 * It drives the real CLI, `node src/cli/nexus.ts`, which finds the control plane and the proxy as it always does,
 * from the flags given here, its environment or its config file. Each attach runs on a real pty on this Mac, which
 * openTerminal makes with the same relay the control plane runs in a pylon, so the CLI sees a terminal of a known
 * size that the check can resize and type into. It starts one thread in project P and touches no other thread.
 *
 * The thread has no Claude worker, so `nexus attach` attaches to the session Nexus opened in the pylon, its only live
 * terminal (guest-contract.ts attachScript). Steps: start the thread and open a shell session titled attach-check;
 * attach at 100x30 and see the shell answer from the session's terminal; resize to
 * 140x40 and see that shell's size grow; stay attached past a probe snapshot and see the thread's human activity
 * advance, which only the attached terminal can do; detach with Core's Ctrl+\ and see the CLI exit 0 and the
 * terminal's modes restored; archive the thread and see attach exit 5; unarchive it; unless --skip-idle-pause, wait
 * up to 30 minutes for the pylon to pause for idleness, and see attach wait for its wake and then land in the kept
 * shell, back at its address; delete the thread unless --keep. A failed step keeps the thread and prints its ID.
 *
 * Assumed, not seen in spikes/herdr-core, which saw `herdr-core attach <t>` exit 0 on Ctrl+\: the shell sees the size
 * of the one terminal attached to it, and a kept shell's terminal comes back at its address after a VM restore as
 * after the spike's core stop and start, with HC_TERMINAL_ID set to it. Core's picker, which the attach opens only
 * when no terminal is live, is not exercised: its Enter starts a new shell, and Ctrl+\ does nothing in it.
 *
 * Every CLI call's output and every terminal's transcript goes to the evidence directory, a new temporary one by
 * default. It prints ATTACH_CHECK_PASS last.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Thread, ThreadDetail } from "../contract/threads.ts";
import type { OpenedSession } from "../contract/pylon.ts";
import { openTerminal, terminalSize, type Terminal, type TerminalSize } from "../guest-terminal.ts";
import { processStream } from "../process-stream.ts";
import { shellQuote } from "../shell.ts";

/** Threads people work in. The check refuses any command that names one. */
const untouchable: readonly string[] = ["th-884e6960c34f", "th-9d91e1aa1625"];

const { values: flags } = parseArgs({
  options: {
    project: { type: "string" },
    keep: { type: "boolean", default: false },
    "skip-idle-pause": { type: "boolean", default: false },
    evidence: { type: "string" },
    url: { type: "string" },
    socks: { type: "string" },
  },
  strict: true,
});
if (flags.project === undefined) throw new Error("name the project to start the check's thread in with --project");
/** Core's detach key, Ctrl+\, as the byte a terminal sends for it. */
const detachKey = "\x1c";
const evidence = flags.evidence ?? await mkdtemp(join(tmpdir(), "nexus-attach-check-"));
await mkdir(evidence, { recursive: true });
console.log(`evidence: ${evidence}`);
const cli = fileURLToPath(new URL("./nexus.ts", import.meta.url));
const endpoint = [...flags.url === undefined ? [] : ["--url", flags.url], ...flags.socks === undefined ? [] : ["--socks", flags.socks]];

function refuseUntouchable(words: readonly string[]): void {
  const named = untouchable.filter((id) => words.some((word) => word.includes(id)));
  if (named.length > 0) throw new Error(`refusing to touch ${named.join(" and ")}, which people work in`);
}

/** Runs the CLI without a terminal, and records the call and its output as `<name>.txt`. */
async function nexus(name: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  refuseUntouchable(args);
  const child = spawn(process.execPath, [cli, ...args, ...endpoint], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const code = await new Promise<number>((resolve) => child.on("close", (exit) => resolve(exit ?? -1)));
  await writeFile(join(evidence, `${name}.txt`), `$ nexus ${args.join(" ")}\nexit ${code}\n--- stdout\n${stdout}--- stderr\n${stderr}`);
  return { code, stdout, stderr };
}

/** The CLI's JSON reply to a call that must succeed. */
async function json<T>(name: string, args: readonly string[]): Promise<T> {
  const { code, stdout, stderr } = await nexus(name, [...args, "--json"]);
  assert.equal(code, 0, `nexus ${args.join(" ")} succeeds: ${stderr}`);
  return JSON.parse(stdout) as T;
}

const show = (name: string) => json<ThreadDetail>(name, ["show", thread]);

/** Polls the thread until its pylon is in `state`, and fails at once on a failed pylon. */
async function pylonIs(name: string, state: "running" | "paused", withinMs: number, everyMs = 3_000): Promise<ThreadDetail> {
  for (const deadline = Date.now() + withinMs; ;) {
    const detail = await show(name);
    assert.notEqual(detail.pylon.actualState, "failed", `the pylon of ${thread} failed: ${detail.pylon.failed}`);
    if (detail.pylon.actualState === state) return detail;
    assert.ok(Date.now() < deadline, `the pylon of ${thread} is ${state} within ${withinMs / 60_000} min. It is ${detail.pylon.actualState}`);
    await sleep(everyMs);
  }
}

/** What a terminal printed, without its control sequences, which split none of the words the check looks for. */
const plain = (bytes: string) => bytes.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]/g, "");

/** A shell command line that runs the CLI with the check's endpoint flags. */
const nexusLine = (args: readonly string[]) => [process.execPath, cli, ...args, ...endpoint].map(shellQuote).join(" ");

/** A real pty on this Mac, running `script` with sh at `size`, and everything it printed so far. */
async function inTerminal(name: string, size: TerminalSize, script: string) {
  refuseUntouchable([script]);
  const terminal: Terminal = await openTerminal(async (argv) => processStream(argv[0]!, argv.slice(1), (text) => process.stderr.write(`${name} relay: ${text}`)),
    size, "xterm-256color", ["sh", "-c", script]);
  const chunks: Buffer[] = [];
  const reading = (async () => { for await (const chunk of terminal) chunks.push(Buffer.from(chunk)); })();
  const printed = (from = 0) => Buffer.concat(chunks.slice(from)).toString();
  return {
    terminal,
    printed,
    /** Where the output so far ends, for `printed` to read only what comes after. */
    mark: () => chunks.length,
    async until(what: string, test: (printed: string) => boolean, withinMs: number, from = 0) {
      for (const deadline = Date.now() + withinMs; !test(printed(from));) {
        assert.ok(Date.now() < deadline, `${name}: ${what} within ${withinMs / 1000} s. The terminal shows:\n${plain(printed(from)).slice(-2000)}`);
        await sleep(200);
      }
    },
    /** Waits for the shell to exit, and writes the transcript as `<name>.typescript`. */
    async end(withinMs: number) {
      const end = await Promise.race([terminal.done, sleep(withinMs, null)]);
      if (end === null) await terminal.hangUp();
      await reading;
      await writeFile(join(evidence, `${name}.typescript`), Buffer.concat(chunks));
      assert.ok(end !== null, `${name}: the shell exits within ${withinMs / 1000} s`);
      return end;
    },
  };
}

type Attached = Awaited<ReturnType<typeof inTerminal>>;

/** Prints the lines of a transcript that match, as the terminal showed them. */
function echo(name: string, printed: string, line: RegExp): void {
  for (const text of plain(printed).split(/\r?\n/)) if (line.test(text)) console.log(`${name}: ${text.trim()}`);
}

/** Attaches inside a shell that reports the CLI's exit code and then the terminal's modes. */
const attachScript = () => `${nexusLine(["attach", thread])}; echo "attach-exit=$?"; stty -a`;

/**
 * Types `line` into the attached shell and returns the first match of `answer` in what follows, which the typed line
 * itself must not match, since the terminal echoes it.
 */
async function ask(t: Attached, what: string, line: string, answer: RegExp, withinMs = 20_000): Promise<RegExpExecArray> {
  const from = t.mark();
  await t.terminal.write(Buffer.from(`${line}\r`));
  await t.until(what, (printed) => answer.test(plain(printed)), withinMs, from);
  return answer.exec(plain(t.printed(from)))!;
}

/**
 * Checks the attach lands in the session's terminal, by the address Core gives its programs. The shell answers only
 * once the attach is up, which a wake delays, so it asks again until then.
 */
async function landsInSession(t: Attached, terminal: string, withinMs: number): Promise<void> {
  let landed: string | undefined;
  for (const deadline = Date.now() + withinMs; landed === undefined;) {
    try {
      [, landed] = await ask(t, "the attached shell says where it runs", 'echo "attached-to=$HC_TERMINAL_ID"', /attached-to=(t[0-9a-z]+)/, 5_000);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
    }
  }
  assert.equal(landed, terminal, `the attach lands in the session's terminal ${terminal}`);
}

/** The attached shell's size, as `stty size` gives it. */
async function shellSize(t: Attached): Promise<{ rows: number; cols: number }> {
  const [, rows, cols] = await ask(t, "the shell gives its size", 'echo "size=$(stty size | tr " " x)"', /size=(\d+)x(\d+)/);
  return { rows: Number(rows), cols: Number(cols) };
}

/** Detaches with Core's Ctrl+\, and checks the CLI exits 0 and leaves the terminal's modes as they were. */
async function detach(name: string, t: Attached): Promise<void> {
  await t.terminal.write(Buffer.from(detachKey));
  const end = await t.end(60_000);
  const printed = t.printed();
  echo(name, printed, /attach-exit=|lflags:/);
  assert.match(plain(printed), /attach-exit=0\b/, `${name}: Core's detach ends nexus attach with exit code 0`);
  const modes = plain(printed.slice(printed.lastIndexOf("attach-exit=")));
  assert.match(modes, /(^|\s)icanon(\s|$)/m, `${name}: stty -a after the attach shows icanon, so the terminal is no longer raw`);
  assert.match(modes, /(^|\s)echo(\s|$)/m, `${name}: stty -a after the attach shows echo`);
  assert.deepEqual(end, { kind: "exited", code: 0 }, `${name}: the shell around the attach exits 0`);
}

const started = await json<Thread>("start", ["start", "--project", flags.project, "--title", "attach check"]);
const thread = started.id;
refuseUntouchable([thread]);
console.log(`thread: ${thread}`);
let passed = false;
try {
  await pylonIs("running", "running", 10 * 60_000);
  const opened = await json<OpenedSession>("session-open", ["session", "open", thread, "--harness", "shell", "--title", "attach-check"]);
  console.log(`session-open: ${JSON.stringify(opened)}`);

  const attached = await inTerminal("attach", terminalSize(100, 30), attachScript());
  await landsInSession(attached, opened.herdrPane, 60_000);
  echo("attach", attached.printed(), /attached-to=/);

  const before = await shellSize(attached);
  assert.ok(before.rows <= 30 && before.cols <= 100, `the shell sees at most 100x30 before the resize, and sees ${before.cols}x${before.rows}`);
  await attached.terminal.resize(terminalSize(140, 40));
  let after = before;
  for (const deadline = Date.now() + 20_000; after.rows <= 30 || after.cols <= 100;) {
    assert.ok(Date.now() < deadline, `the shell sees more than 100x30 within 20 s of the resize to 140x40, and sees ${after.cols}x${after.rows}`);
    await sleep(1_000);
    after = await shellSize(attached);
  }
  console.log(`resize: the shell saw ${before.cols}x${before.rows}, then ${after.cols}x${after.rows} after the resize to 140x40`);

  // Only GETs reach the control plane from here until the detach, and a GET records no activity. The probe counts
  // attached Core viewers in its snapshot every 60 s, so 75 s spans one.
  const humanBefore = (await show("presence-before")).thread.lastHumanActivityAt;
  await sleep(75_000);
  const humanAfter = (await show("presence-after")).thread.lastHumanActivityAt;
  console.log(`presence: lastHumanActivityAt ${new Date(humanBefore).toISOString()} then ${new Date(humanAfter).toISOString()}`);
  assert.ok(humanAfter > humanBefore, "an attached terminal counts as human presence: lastHumanActivityAt advanced while only GETs reached the API");

  await detach("attach", attached);

  // Detached, the same wait must not move it, which shows the advance above came from the terminal. An observation
  // read just before the detach can still land, so it settles first.
  await sleep(10_000);
  const idleBefore = (await show("detached-before")).thread.lastHumanActivityAt;
  await sleep(75_000);
  const idleAfter = (await show("detached-after")).thread.lastHumanActivityAt;
  assert.equal(idleAfter, idleBefore, "without a terminal, neither GETs nor the probe's snapshots record human activity");

  await json<unknown>("archive", ["archive", thread]);
  const archived = await inTerminal("attach-archived", terminalSize(100, 30), `${nexusLine(["attach", thread])}; echo "attach-exit=$?"`);
  await archived.end(60_000);
  echo("attach-archived", archived.printed(), /nexus:|attach-exit=/);
  assert.match(plain(archived.printed()), /attach-exit=5\b/, "attach to an archived thread exits 5");
  assert.match(plain(archived.printed()), /archived/, "and says the thread is archived");
  await json<unknown>("unarchive", ["unarchive", thread]);
  await pylonIs("unarchived", "running", 10 * 60_000);

  if (flags["skip-idle-pause"]) {
    console.log("idle-pause: skipped");
  } else {
    // A pylon pauses after 5 minutes without agent activity and 20 without a human, and the unarchive was human.
    await pylonIs("idle-paused", "paused", 30 * 60_000, 30_000);
    const woken = await inTerminal("attach-woken", terminalSize(100, 30), attachScript());
    await woken.until("attach waits for the paused pylon", (printed) => plain(printed).includes(`waiting for the pylon of ${thread}, which is paused`), 60_000);
    // The shell is kept, so the woken core brings it back at its address, where the relaunch finds it.
    await landsInSession(woken, opened.herdrPane, 3 * 60_000);
    echo("attach-woken", woken.printed(), /nexus: waiting|attached-to=/);
    await detach("attach-woken", woken);
  }

  if (!flags.keep) await json<unknown>("delete", ["delete", thread]);
  passed = true;
} finally {
  if (!passed) console.log(`the check kept ${thread} to look at. Delete it with: nexus delete ${thread}`);
  else if (flags.keep) console.log(`kept ${thread}, as --keep asks`);
}
console.log("ATTACH_CHECK_PASS");
