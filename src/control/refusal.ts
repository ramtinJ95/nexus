/** What a refusal says of the request it refuses. The API answers each kind with one HTTP status, as http-error.ts maps them. */
export type RefusalKind = "invalid" | "forbidden" | "missing" | "method" | "conflict" | "too-large" | "unsupported" | "unprocessable" | "upstream" | "unavailable" | "timeout";

/**
 * What a client may branch on in a refusal, beside its message, which is for a person to read, and whether the
 * refusal ends by itself, so the same request asked again later can succeed. A Claude waiting at a prompt waits for
 * a person, so `blocked` does not, and a queued thread starts only once the threads it waits on end, which can take
 * hours, so `queued` does not either.
 */
const retryableCodes = {
  "not-running": true, "not-ready": true, moved: true, draining: true,
  blocked: false, queued: false, "no-route": false, "no-branch": false, "too-long": false, "probe-unreachable": false, "probe-forbidden": false,
} as const satisfies Record<string, boolean>;
export type RefusalCode = keyof typeof retryableCodes;

export class Refusal extends Error {
  readonly kind: RefusalKind;
  readonly code: RefusalCode | null;
  readonly retryable: boolean;
  constructor(kind: RefusalKind, message: string, code: RefusalCode | null = null) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.retryable = code !== null && retryableCodes[code];
  }
}
