/**
 * Runs `run` one at a time. A call while a run is in flight either joins it, or asks for one more run after it, which
 * every later call joins until that run starts. Once `stopped` holds, no run starts.
 */
export function singleFlight(run: () => Promise<void>, stopped: () => boolean = () => false) {
  let flight: Promise<void> | null = null;
  let again = false;
  function rerun(): Promise<void> {
    if (stopped()) return Promise.resolve();
    again = true;
    flight ??= (async () => {
      try {
        while (again && !stopped()) {
          again = false;
          await run();
        }
      } finally {
        flight = null;
      }
    })();
    return flight;
  }
  return {
    /** Starts a run, or joins the one in flight. */
    join: (): Promise<void> => flight ?? rerun(),
    /** Starts a run, or asks for one more after the one in flight. Settles after the last run. */
    rerun,
    /** Whether a run is in flight. */
    busy: (): boolean => flight !== null,
    /** Settles once no run is in flight. */
    async settled(): Promise<void> { await flight; },
  };
}

export type SingleFlight = ReturnType<typeof singleFlight>;
