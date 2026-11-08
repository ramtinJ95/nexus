/**
 * The control plane's services. A periodic one polls when it starts and every `everyMs` after. Each closes once, at
 * shutdown, the last started first, so a service closes before what it was built from.
 */
export type Service = { readonly everyMs: number; poll(): unknown; close?(): unknown } | { readonly everyMs?: never; close(): unknown };

export interface Services {
  /** Starts the service and answers it. Null is a feature not configured, which has nothing to poll or close. */
  start<S extends Service | null>(service: S): S;
  /** Stops every poll, then closes each service even when one before it fails, and rejects with the first failure. */
  close(): Promise<void>;
}

export function services(): Services {
  const timers: NodeJS.Timeout[] = [];
  const started: Service[] = [];
  return {
    start(service) {
      if (service === null) return service;
      started.push(service);
      if (service.everyMs !== undefined) {
        void service.poll();
        // The API's server keeps the process alive, so no timer does.
        timers.push(setInterval(() => { void service.poll(); }, service.everyMs).unref());
      }
      return service;
    },
    async close() {
      for (const timer of timers.splice(0)) clearInterval(timer);
      const failures: unknown[] = [];
      for (const service of started.splice(0).reverse()) {
        try {
          await service.close?.();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}
