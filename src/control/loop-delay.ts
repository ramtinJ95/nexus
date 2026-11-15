/**
 * How late the control plane's event loop runs what is due. Everything it does shares one thread, so work that holds
 * the thread makes every request and every probe's event wait that long. On 2026-11-15 a pass that read each node's
 * whole history held it for seconds at a time from about midnight, and nothing said so until the person found the
 * control plane unreachable six hours later.
 */
import { createHistogram, performance } from "node:perf_hooks";

/** One stretch of the loop's time, a minute once the control plane has run that long. */
export interface LoopDelay {
  /** How long the stretch is, in milliseconds. */
  overMs: number;
  /** How late the loop ran at the 99th percentile of the stretch's samples, in milliseconds. */
  p99Ms: number;
  /** The latest it ran, in milliseconds. */
  maxMs: number;
  /** The share of the stretch the loop was at work rather than waiting, from 0 to 1. */
  busy: number;
}
/** The slowest of the last `minutes` full minutes, or with `minutes` 0 the time since the start. */
export interface LoopLate { slowest: LoopDelay; minutes: number }

/** How often the watch samples. A sample is the time since the one before, so this much of each is no delay. */
const resolutionMs = 20;
export const loopMinuteMs = 60_000;
/** A health pass runs every 5 minutes and looks back over the minutes since the last. */
export const loopMinutesKept = 5;

/** The figures of a stretch whose samples `histogram` holds, in nanoseconds as Node's does. One with no sample ran nothing late. */
export function loopFigures(histogram: { count: number; max: number; percentile(p: number): number }, overMs: number, busy: number): LoopDelay {
  const late = (ns: number) => histogram.count === 0 ? 0 : Math.max(0, Math.round(ns / 1e6 - resolutionMs));
  return { overMs: Math.round(overMs), p99Ms: late(histogram.percentile(99)), maxMs: late(histogram.max), busy: Math.round(busy * 100) / 100 };
}

/**
 * The minutes of a loop that tells `sample` each time its sampling timer runs. `at` is a clock in milliseconds and
 * `active` the milliseconds the loop has been at work, both since any start. A minute ends at the first sample a
 * minute or more after it began, so a pause is counted in the minute it ends in, and a minute's delays and its share
 * at work cover one stretch.
 */
export function loopMinutes(at: number, active: number, options: { minuteMs?: number; kept?: number } = {}) {
  const { minuteMs = loopMinuteMs, kept = loopMinutesKept } = options;
  const histogram = createHistogram();
  let since = at;
  let worked = active;
  let last = at;
  // The histogram keeps three figures of each sample and rounds up, so the worst is kept whole and bounds the percentile.
  let worst = 0;
  const minutes: LoopDelay[] = [];
  const stretch = (at: number, active: number) => loopFigures({ count: histogram.count, max: worst, percentile: (p) => Math.min(worst, histogram.percentile(p)) }, at - since, at > since ? Math.min(1, Math.max(0, (active - worked) / (at - since))) : 0);
  return {
    sample(at: number, active: number) {
      const gap = Math.max(1, Math.round((at - last) * 1e6));
      histogram.record(gap);
      worst = Math.max(worst, gap);
      last = at;
      if (at - since < minuteMs) return;
      minutes.push(stretch(at, active));
      if (minutes.length > kept) minutes.shift();
      histogram.reset();
      worst = 0;
      since = at;
      worked = active;
    },
    /** The slowest of the minutes kept, or the time since the start before the first ends. */
    late: (at: number, active: number): LoopLate => minutes.length === 0 ? { slowest: stretch(at, active), minutes: 0 }
      : { slowest: minutes.reduce((a, b) => b.p99Ms > a.p99Ms ? b : a), minutes: minutes.length },
    /** The last full minute, or the time since the start before the first ends. */
    latest: (at: number, active: number): LoopDelay => minutes.at(-1) ?? stretch(at, active),
  };
}

/** Watches the loop from now on, a minute at a time. `close` stops it. */
export function loopWatch(options: { minuteMs?: number; kept?: number } = {}) {
  const read = () => [performance.now(), performance.eventLoopUtilization().active] as const;
  const minutes = loopMinutes(...read(), options);
  // Node's own monitorEventLoopDelay forgets a pause that is still under way when its histogram is reset, so the
  // watch samples with a timer of its own and ends a minute only in a sample.
  const timer = setInterval(() => minutes.sample(...read()), resolutionMs);
  // The watch keeps no process alive.
  timer.unref();
  return {
    late: (): LoopLate => minutes.late(...read()),
    latest: (): LoopDelay => minutes.latest(...read()),
    close() { clearInterval(timer); },
  };
}
