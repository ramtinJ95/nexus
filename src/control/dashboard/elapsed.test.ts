import { test } from "node:test";
import assert from "node:assert/strict";
import { localTime } from "./elapsed.ts";

test("a moment reads in the reader's own zone as the day, the date, the month and the time, with seconds when asked", () => {
  const at = new Date(2026, 10, 1, 14, 5, 20).getTime();
  assert.equal(localTime(at), "Sun 1 Nov 14:05");
  assert.equal(localTime(at, true), "Sun 1 Nov 14:05:20");
  assert.equal(localTime(new Date(2026, 0, 9, 3, 7, 4).getTime(), true), "Fri 9 Jan 03:07:04");
});
