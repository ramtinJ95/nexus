/**
 * How late the control plane's event loop runs what is due. Everything it does shares one thread, so work that holds
 * the thread makes every request and every probe's event wait that long. On 2026-11-15 a pass that read each node's
 * whole history held it for seconds at a time from about midnight, and nothing said so until the person found the
 * control plane unreachable six hours later.
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

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

/** How often the histogram samples. It reports the time between two samples, so this much of each is no delay. */
const resolutionMs = 20;
export const loopMinuteMs = 60_000;
/** A health pass runs every 5 minutes and looks back over the minutes since the last. */
export const loopMinutesKept = 5;

/** The figures of a stretch whose samples `histogram` holds, in nanoseconds as Node's does. One with no sample ran nothing late. */
export function loopFigures(histogram: { count: number; max: number; percentile(p: number): number }, overMs: number, busy: number): LoopDelay {
  const late = (ns: number) => histogram.count === 0 ? 0 : Math.max(0, Math.round(ns / 1e6 - resolutionMs));
  return { overMs: Math.round(overMs), p99Ms: late(histogram.percentile(99)), maxMs: late(histogram.max), busy: Math.round(busy * 100) / 100 };
}

/** Watches the loop from now on, a minute at a time. `close` stops it. */
export function loopWatch(options: { minuteMs?: number; kept?: number } = {}) {
  const { minuteMs = loopMinuteMs, kept = loopMinutesKept } = options;
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  let since = performance.now();
  let work = performance.eventLoopUtilization();
  const minutes: LoopDelay[] = [];
  const now = () => loopFigures(histogram, performance.now() - since, performance.eventLoopUtilization(work).utilization);
  const timer = setInterval(() => {
    minutes.push(now());
    if (minutes.length > kept) minutes.shift();
    histogram.reset();
    since = performance.now();
    work = performance.eventLoopUtilization();
  }, minuteMs);
  // The watch keeps no process alive.
  timer.unref();
  return {
    late: (): LoopLate => minutes.length === 0 ? { slowest: now(), minutes: 0 }
      : { slowest: minutes.reduce((a, b) => b.p99Ms > a.p99Ms ? b : a), minutes: minutes.length },
    close() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
