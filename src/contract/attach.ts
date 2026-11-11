/**
 * docs/cli.md describes the same protocol. It imports nothing at run time, so a browser can bundle it.
 *
 * GET /v1/threads/<thread>/attach?cols=C&rows=R&term=T[&terminal=A] upgrades to a plain RFC 6455 WebSocket, with no subprotocol
 * and no extensions. After the 101, binary messages carry terminal bytes both ways, and text messages carry one JSON
 * object each, whose `type` says what it is. Either end ignores a type it does not know.
 */
import type { TerminalSize } from "../guest-terminal.ts";
import type { ActualState } from "../control/reconcile.ts";

export const defaultTerm = "xterm-256color";

/**
 * The opening size and TERM of the terminal. Both go in the URL, because Herdr Core's client needs a size before it
 * starts. `terminal` is the address of the Core terminal it shows, in place of the Claude worker's.
 */
export interface AttachRequest { size: TerminalSize; term: string; terminal?: string }

export function attachPath(thread: string, { size, term, terminal }: AttachRequest): string {
  return `/v1/threads/${encodeURIComponent(thread)}/attach?cols=${size.cols}&rows=${size.rows}&term=${encodeURIComponent(term)}${terminal === undefined ? "" : `&terminal=${encodeURIComponent(terminal)}`}`;
}

/** Before `attached`, a resize replaces the size the terminal opens with. */
export type ClientMessage = { type: "resize"; size: TerminalSize };

export type AttachErrorKind = "conflict" | "failed" | "unreachable";
/**
 * `waiting` comes on each change of the pylon's state while it does not run, `attached` once, and then exactly one
 * of `exit` or `error`, and a close with 1000. A close without one of them is a dropped link.
 */
export type ServerMessage =
  | { type: "waiting"; pylon: ActualState }
  | { type: "attached" }
  /** 0 is Core's own detach. */
  | { type: "exit"; code: number }
  | { type: "error"; kind: AttachErrorKind; message: string };

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message.type === "resize" ? { type: "resize", cols: message.size.cols, rows: message.size.rows } : message);
}
