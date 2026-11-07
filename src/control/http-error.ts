import { Refusal, type RefusalCode, type RefusalKind } from "./refusal.ts";

/** The HTTP status the API answers each kind of refusal with. */
export const refusalStatus = {
  invalid: 400, forbidden: 403, missing: 404, method: 405, conflict: 409, "too-large": 413, unsupported: 415,
  unprocessable: 422, upstream: 502, unavailable: 503, timeout: 504,
} as const satisfies Record<RefusalKind, number>;
export type RefusalStatus = (typeof refusalStatus)[RefusalKind];
const kindOf = Object.fromEntries(Object.entries(refusalStatus).map(([kind, status]) => [status, kind])) as Record<RefusalStatus, RefusalKind>;

/** A refusal named by the HTTP status of its kind, as control-plane code not yet moved to refusal kinds throws it. */
export class HttpError extends Refusal {
  readonly status: RefusalStatus;
  constructor(status: RefusalStatus, message: string, code?: RefusalCode) {
    super(kindOf[status], message, code);
    this.status = status;
  }
}
