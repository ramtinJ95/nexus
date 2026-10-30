/**
 * The attach route's WebSocket protocol, one definition for both ends: the control plane serves it, the CLI and the
 * dashboard's terminal speak it, and docs/cli.md describes the same thing. It imports nothing at run time, so a
 * browser can bundle it. attach-wire.ts parses it.
 *
 * GET /v1/threads/<thread>/attach?cols=C&rows=R&term=T[&pane=P] upgrades to a plain RFC 6455 WebSocket, with no subprotocol
 * and no extensions. After the 101, binary messages carry terminal bytes both ways, and text messages carry one JSON
 * object each, whose `type` says what it is. Either end ignores a type it does not know.
 */
import type { TerminalSize } from "./guest-terminal.ts";
import type { ActualState } from "./reconcile.ts";

export const defaultTerm = "xterm-256color";

/**
 * The opening size and TERM of the terminal. Both go in the URL, because Herdr needs a size before it starts. `pane`
 * is the pane it lands in, in place of the Claude worker's.
 */
export interface AttachRequest { size: TerminalSize; term: string; pane?: string }

export function attachPath(thread: string, { size, term, pane }: AttachRequest): string {
  return `/v1/threads/${encodeURIComponent(thread)}/attach?cols=${size.cols}&rows=${size.rows}&term=${encodeURIComponent(term)}${pane === undefined ? "" : `&pane=${encodeURIComponent(pane)}`}`;
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
  /** The program exited. 0 is Herdr's own detach. */
  | { type: "exit"; code: number }
  | { type: "error"; kind: AttachErrorKind; message: string };

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message.type === "resize" ? { type: "resize", cols: message.size.cols, rows: message.size.rows } : message);
}
