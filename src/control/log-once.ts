/**
 * How a service reports a failure that repeats on every pass: the first time, and again only once it fails another way
 * or after it succeeded, so a node or thread that stays broken fills no log.
 */
export type Log = (message: string) => void;

export interface LogOnce {
  /** Logs `message` unless it is what `key` logged last. */
  failed(key: string, message: string): void;
  /** `key` succeeded, so its next failure is logged. */
  ok(key: string): void;
}

export function logOnce(log: Log): LogOnce {
  const last = new Map<string, string>();
  return {
    failed(key, message) {
      if (last.get(key) !== message) log(message);
      last.set(key, message);
    },
    ok(key) { last.delete(key); },
  };
}
