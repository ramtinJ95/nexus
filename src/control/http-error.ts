/** What a client may branch on in an error reply, beside its message, which is for a person to read. */
export type ApiErrorCode = "not-running" | "not-ready" | "blocked" | "moved" | "no-route";

/** A refusal the API answers with `status` and `message`, from the API or the control-plane code it calls. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | undefined;
  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
