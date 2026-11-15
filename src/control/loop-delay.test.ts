import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { loopFigures, loopMinutes, loopWatch } from "./loop-delay.ts";

test("a stretch's figures are how late the loop ran past the sampling interval, and one with no sample ran nothing late", () => {
  const histogram = (count: number, p99Ns: number, maxNs: number) => ({ count, max: maxNs, percentile: (p: number) => { assert.equal(p, 99); return p99Ns; } });
  assert.deepEqual(loopFigures(histogram(3000, 22_069_247, 1_820_154_879), 60_000.4, 0.0714), { overMs: 60_000, p99Ms: 2, maxMs: 1800, busy: 0.07 });
  assert.deepEqual(loopFigures(histogram(40, 5_820_000_000, 5_820_000_000), 60_000, 1), { overMs: 60_000, p99Ms: 5800, maxMs: 5800, busy: 1 });
  assert.deepEqual(loopFigures(histogram(10, 19_900_000, 20_100_000), 60_000, 0), { overMs: 60_000, p99Ms: 0, maxMs: 0, busy: 0 }, "a sample that came early is not late");
  assert.deepEqual(loopFigures(histogram(0, 0, 0), 12_345, 0.5), { overMs: 12_345, p99Ms: 0, maxMs: 0, busy: 0.5 });
});

/** Samples every 20 ms from `from` up to `to`, with the loop at work `busy` of the time, and answers the work done. */
function run(minutes: ReturnType<typeof loopMinutes>, from: number, to: number, active: number, busy = 0) {
  for (let at = from + 20; at <= to; at += 20) minutes.sample(at, active += 20 * busy);
  return active;
}

test("before its first minute ends the loop's figures are of the time since its start", () => {
  const minutes = loopMinutes(1000, 50);
  const active = run(minutes, 1000, 13_000, 50, 0.25);
  assert.deepEqual(minutes.late(13_400, active), { slowest: { overMs: 12_400, p99Ms: 0, maxMs: 0, busy: 0.24 }, minutes: 0 });
  assert.deepEqual(minutes.latest(13_400, active), { overMs: 12_400, p99Ms: 0, maxMs: 0, busy: 0.24 });
});

test("a pause under way when a minute would end is counted in the minute it ends in, with the work that caused it", () => {
  const minutes = loopMinutes(0, 0);
  let active = run(minutes, 0, 59_000, 0);
  // The loop is held from 59.0 s to 61.5 s, across the minute's end.
  minutes.sample(61_500, active += 2_500);
  assert.deepEqual(minutes.latest(61_500, active), { overMs: 61_500, p99Ms: 0, maxMs: 2480, busy: 0.04 });
  active = run(minutes, 61_500, 121_500, active);
  assert.deepEqual(minutes.latest(121_500, active), { overMs: 60_000, p99Ms: 0, maxMs: 0, busy: 0 }, "and the next minute starts after it, with its own work alone");
});

test("the check's figure is the slowest of the minutes kept and health's the latest, and a minute older than those kept is gone", () => {
  const minutes = loopMinutes(0, 0, { kept: 3 });
  let at = 0;
  let active = 0;
  const idle = () => { active = run(minutes, at, at + 60_000, active); at += 60_000; };
  idle();
  // A minute of work that holds the loop 600 ms at a time.
  for (const end = at + 60_000; at < end;) minutes.sample(at += 620, active += 600);
  const slow = { overMs: 60_140, p99Ms: 600, maxMs: 600, busy: 0.97 };
  assert.deepEqual(minutes.late(at, active), { slowest: slow, minutes: 2 });
  assert.deepEqual(minutes.latest(at, active), slow);
  idle();
  assert.deepEqual(minutes.late(at, active), { slowest: slow, minutes: 3 }, "the slow minute is still the check's");
  assert.deepEqual(minutes.latest(at, active), { overMs: 60_000, p99Ms: 0, maxMs: 0, busy: 0 }, "and no longer health's");
  idle();
  assert.deepEqual(minutes.late(at, active).slowest, slow);
  idle();
  assert.deepEqual(minutes.late(at, active), { slowest: { overMs: 60_000, p99Ms: 0, maxMs: 0, busy: 0 }, minutes: 3 }, "three minutes after it, it is no longer kept");
});

test("one pause in a minute moves only the worst figure unless it takes nearly the whole minute", () => {
  const minutes = loopMinutes(0, 0);
  let active = run(minutes, 0, 30_000, 0);
  minutes.sample(40_000, active);
  active = run(minutes, 40_000, 60_000, active);
  assert.deepEqual(minutes.latest(60_000, active), { overMs: 60_000, p99Ms: 0, maxMs: 9980, busy: 0 });
  // A process stopped from outside for all but a second of the minute leaves 41 samples, so the pause is the 99th percentile too, at work none of the time.
  active = run(minutes, 60_000, 60_400, active);
  minutes.sample(119_600, active);
  active = run(minutes, 119_600, 120_000, active);
  assert.deepEqual(minutes.latest(120_000, active), { overMs: 60_000, p99Ms: 59_180, maxMs: 59_180, busy: 0 });
});

test("the watch samples the running loop, and work that holds it shows in its figures", async (t) => {
  const watch = loopWatch({ minuteMs: 300, kept: 2 });
  t.after(() => watch.close());
  // Work that holds the thread 150 ms at a time, with a turn of the loop's timers between, so each sample comes that late.
  const until = Date.now() + 1000;
  while (Date.now() < until) {
    const held = Date.now() + 150;
    while (Date.now() < held);
    await sleep(1);
  }
  const { slowest, minutes } = watch.late();
  assert.ok(minutes >= 1 && minutes <= 2, `it keeps 2 minutes at most, and has ${minutes}`);
  assert.ok(slowest.maxMs >= 100 && slowest.maxMs >= slowest.p99Ms, `the held loop ran ${slowest.p99Ms} ms late, ${slowest.maxMs} at worst`);
  assert.ok(slowest.busy >= 0.5, `and was at work ${slowest.busy} of the time`);
  assert.ok(watch.latest().overMs >= 300);
});
