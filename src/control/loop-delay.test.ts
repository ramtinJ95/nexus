import assert from "node:assert/strict";
import { setImmediate as turn, setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { loopFigures, loopWatch } from "./loop-delay.ts";

test("a stretch's figures are how late the loop ran past the sampling interval, and one with no sample ran nothing late", () => {
  const histogram = (count: number, p99Ns: number, maxNs: number) => ({ count, max: maxNs, percentile: (p: number) => { assert.equal(p, 99); return p99Ns; } });
  assert.deepEqual(loopFigures(histogram(3000, 22_069_247, 1_820_154_879), 60_000.4, 0.0714), { overMs: 60_000, p99Ms: 2, maxMs: 1800, busy: 0.07 });
  assert.deepEqual(loopFigures(histogram(40, 5_820_000_000, 5_820_000_000), 60_000, 1), { overMs: 60_000, p99Ms: 5800, maxMs: 5800, busy: 1 });
  assert.deepEqual(loopFigures(histogram(10, 19_900_000, 20_100_000), 60_000, 0), { overMs: 60_000, p99Ms: 0, maxMs: 0, busy: 0 }, "a sample that came early is not late");
  assert.deepEqual(loopFigures(histogram(0, 0, 0), 12_345, 0.5), { overMs: 12_345, p99Ms: 0, maxMs: 0, busy: 0.5 });
});

test("the watch reports the time since its start, then the slowest of the minutes it keeps, and a loop that is held shows in it", async (t) => {
  const watch = loopWatch({ minuteMs: 400, kept: 2 });
  t.after(() => watch.close());
  assert.equal(watch.late().minutes, 0, "before its first minute is over it reports the time since the start");
  // Work that holds the thread 150 ms at a time, with a turn of the loop between, so each sample comes that late.
  const until = Date.now() + 1300;
  while (Date.now() < until) {
    const held = Date.now() + 150;
    while (Date.now() < held);
    await turn();
  }
  const { slowest, minutes } = watch.late();
  assert.ok(minutes >= 1 && minutes <= 2, `it keeps 2 minutes at most, and has ${minutes}`);
  assert.ok(slowest.p99Ms >= 100 && slowest.maxMs >= slowest.p99Ms, `the held loop ran ${slowest.p99Ms} ms late, ${slowest.maxMs} at worst`);
  assert.ok(slowest.busy >= 0.5, `and was busy ${slowest.busy} of the time`);
  await sleep(1000);
  assert.equal(watch.late().minutes, 2);
});
