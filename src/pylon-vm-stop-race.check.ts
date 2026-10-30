/**
 * Node validation that a pause never leaves a guest exec hanging, run by hand on a home-lab node:
 *   node src/pylon-vm-stop-race.check.ts <image directory> <state root> [rounds, default 10] [readers, default 8]
 *
 * It boots one fresh pylon, then pauses and wakes it `rounds` times. Through each pause, `readers` loops run the
 * probe's listening read, a guest exec of `cat /proc/net/tcp` with a 3 s limit, as a probe snapshot does while a
 * pause stops the VM under it. Each round first pins two execs of a 600 s sleep and starts the readers only once
 * both commands run, so the controller has let both in before the stop begins and they can settle only after it.
 * The stop begins at the time the controller logs for it. Every pinned exec must settle within 8 s of that, and
 * every read within 8 s of when it or the stop began, whichever was later. Each round reports the time the pause
 * spent before the controller began to stop apart, and whether the controller's bounded wait ran out and closed the
 * VM under an action. Readers may be 0, which times the pause with only the pinned execs. It deletes the pylon, also
 * after a failure.
 * The state root must be at most 39 bytes. It prints PYLON_VM_STOP_RACE_CHECK_PASS last.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BootInputs } from "./spawn.ts";
import type { CheckpointId, PylonId } from "./ids.ts";
import { checkBackend, checkBoot, emptyLive } from "./pylon-vm-check-kit.ts";

const [imageArg, stateArg, roundsArg, readersArg] = process.argv.slice(2);
if (imageArg === undefined || stateArg === undefined) throw new Error("usage: node src/pylon-vm-stop-race.check.ts <image directory> <state root> [rounds] [readers]");
const imageDir = resolve(imageArg);
const stateRoot = resolve(stateArg);
const rounds = Number(roundsArg ?? 10);
const readers = Number(readersArg ?? 8);
assert.ok(Number.isInteger(rounds) && rounds > 0 && Number.isInteger(readers) && readers >= 0, "rounds is a positive whole number, readers a whole number");
/** The controller's 5 s wait for guest actions, plus each request's own round trip. */
const settleLimitMs = 8_000;

const pylonId = `pylon-race-${Date.now().toString(36)}` as PylonId;
const signal = () => AbortSignal.timeout(20 * 60_000);
const { backend, image } = checkBackend(imageDir, stateRoot);
const boot = (source: BootInputs["source"]) => checkBoot(pylonId, image, source, { memoryGiB: 4 });
const step = (name: string, value = "ok") => console.log(`${name}: ${value}`);
const seconds = (ms: number) => (ms / 1000).toFixed(1);

type Read = { startedAt: number; settledAt: number; outcome: string };
async function exec(argv: string[], timeoutMs: number): Promise<Read> {
  const startedAt = Date.now();
  const outcome = await backend.guest(pylonId).exec(argv, { cwd: "/", timeoutMs })
    .then((r) => `exit ${r.exitCode}`, (err: Error) => err.message.split("\n")[0]!);
  return { startedAt, settledAt: Date.now(), outcome };
}
/** Reads until `done` is set, each one after the last settles, as the probe's snapshots do. */
async function reader(done: () => boolean, reads: Read[]): Promise<void> {
  while (!done()) {
    reads.push(await exec(["cat", "/proc/net/tcp"], 3_000));
    await delay(20);
  }
}
/** The controller's line as it begins to stop, with its own clock's time, which is the check's too. */
const began = /^Sandbox is stopping since (\S+), so it settles the guest actions in flight/;
const closedUnder = "Closing the VM under guest actions";
/** The controller's log lines that match `line`. The controller appends to its log across boots. */
async function logged(line: string | RegExp): Promise<string[]> {
  const log = await readFile(join(stateRoot, "instances", pylonId, "controller.log"), "utf8");
  return log.split("\n").filter((l) => (typeof line === "string" ? l.startsWith(line) : line.test(l)));
}
/** Resolves once the pinned command has started, so the exec carrying it is in the controller. */
async function running(marker: string, pin: Promise<Read>): Promise<void> {
  let ended: Read | undefined;
  void pin.then((r) => (ended = r));
  const until = performance.now() + 120_000;
  let last: string;
  while ((last = (await exec(["test", "-e", marker], 3_000)).outcome) !== "exit 0") {
    assert.equal(ended, undefined, `the pinned exec behind ${marker} ended before its command started: ${ended?.outcome}`);
    assert.ok(performance.now() < until, `the pinned command behind ${marker} did not start within 120 s, and the last look for it got ${last}`);
    await delay(100);
  }
}

let failure: unknown = null;
try {
  await backend.ensureRunning(boot({ kind: "fresh", preSetup: null }), emptyLive, signal());
  step("BOOTED");
  let raced = 0;
  for (let round = 1; round <= rounds; round++) {
    const reads: Read[] = [];
    let paused = false;
    const markers = [1, 2].map((n) => `/tmp/pinned-${round}-${n}`);
    const pinAt = performance.now();
    // The sleep outlasts any pause, and the client's limit outlasts the sleep.
    const pinned = markers.map((marker) => exec(["sh", "-c", `touch ${marker}; exec sleep 600`], 900_000));
    await Promise.all(markers.map((marker, i) => running(marker, pinned[i]!)));
    const pinMs = performance.now() - pinAt;
    const loops = Array.from({ length: readers }, () => reader(() => paused, reads));
    // A varying lead-in moves the stop to a different point in the readers' requests each round.
    await delay(500 + Math.random() * 1_000);
    const [beganBefore, closedBefore] = [(await logged(began)).length, (await logged(closedUnder)).length];
    const pauseAt = Date.now();
    await backend.ensurePaused(pylonId, `ckpt-${pylonId}-${round}` as CheckpointId, signal());
    const pausedAt = Date.now();
    paused = true;
    // Before the controller stops, the pause records the guest's sessions through the same guest calls the readers
    // load, so that time is contention, reported apart. Without the line, as before the fix, the pause's start counts.
    const line = (await logged(began))[beganBefore];
    const stopAt = line === undefined ? pauseAt : Date.parse(began.exec(line)![1]!);
    await Promise.all(loops);
    const held = await Promise.all(pinned);
    const closed = (await logged(closedUnder)).slice(closedBefore);
    // Late is how long a request outlived the later of its own start and the controller's stop.
    const late = (r: Read) => r.settledAt - Math.max(r.startedAt, stopAt);
    const crossed = held.filter((r) => r.startedAt < pauseAt && r.settledAt >= stopAt && r.outcome !== "exit 0");
    if (crossed.length === held.length) raced++;
    const slowest = [...held, ...reads].reduce((a, b) => (late(b) > late(a) ? b : a));
    const phases = stopAt === pauseAt ? "the controller did not log its stop" : `${seconds(stopAt - pauseAt)} s before the controller began to stop, ${seconds(pausedAt - stopAt)} s stopping`;
    step(`ROUND_${round}`, `pinned in ${seconds(pinMs)} s, pause ${seconds(pausedAt - pauseAt)} s (${phases}), ${reads.length} reads, pinned execs settled ${held.map((r) => `${seconds(late(r))} s into the stop (${r.outcome})`).join(" and ")}, latest ${seconds(late(slowest))} s after its start or the stop's (${slowest.outcome}), ${closed.length === 0 ? "all settled before the close" : closed.join("; ")}`);
    assert.equal(crossed.length, held.length, `round ${round}: a pinned exec did not cross the stop, so the round proved nothing`);
    assert.ok(late(slowest) < settleLimitMs, `round ${round}: a request in flight through the stop settled ${seconds(late(slowest))} s late (${slowest.outcome})`);
    await backend.ensureRunning(boot({ kind: "resume", checkpoint: `ckpt-${pylonId}-${round}` as CheckpointId }), emptyLive, signal());
  }
  step("ROUNDS_RACED", `${raced} of ${rounds}`);
} catch (err) {
  failure = err;
  console.error(err);
  const log = await readFile(join(stateRoot, "instances", pylonId, "controller.log"), "utf8").catch((e: Error) => e.message);
  console.error(`CONTROLLER_LOG_TAIL:\n${log.split("\n").slice(-80).join("\n")}`);
} finally {
  await backend.ensureDeleted(pylonId, signal());
}
if (failure !== null) process.exit(1);
console.log("PYLON_VM_STOP_RACE_CHECK_PASS");
