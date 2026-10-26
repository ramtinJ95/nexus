/** A refusal the API answers with `status` and `message`, from the API or the control-plane code it calls. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
