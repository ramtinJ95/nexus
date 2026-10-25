/**
 * The attach route's WebSocket protocol, one definition for both ends: the control plane serves it, the CLI speaks
 * it, and a browser terminal on the dashboard can follow docs/cli.md, which describes the same thing.
 *
 * GET /v1/threads/<thread>/attach?cols=C&rows=R&term=T upgrades to a plain RFC 6455 WebSocket, with no subprotocol
 * and no extensions. After the 101, binary messages carry terminal bytes both ways, and text messages carry one JSON
 * object each, whose `type` says what it is. Either end ignores a type it does not know.
 */
import { z } from "zod";
import { terminalSize, type TerminalSize } from "./guest-terminal.ts";
import type { ActualState } from "./reconcile.ts";

export const defaultTerm = "xterm-256color";
const termPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** The opening size and TERM of the terminal. Both go in the URL, because Herdr needs a size before it starts. */
export interface AttachRequest { size: TerminalSize; term: string }

export const attachRoute = /^\/v1\/threads\/([^/]+)\/attach$/;

export function attachPath(thread: string, { size, term }: AttachRequest): string {
  return `/v1/threads/${encodeURIComponent(thread)}/attach?cols=${size.cols}&rows=${size.rows}&term=${encodeURIComponent(term)}`;
}

/** The server's side of the query. Throws a message for a 400. */
export function parseAttachQuery(query: URLSearchParams): AttachRequest {
  const side = (name: string) => {
    const value = query.get(name);
    if (value === null || !/^\d+$/.test(value)) throw new Error(`${name} must be a whole number from 1 to 9999, got ${value ?? "none"}`);
    return Number(value);
  };
  const size = terminalSize(side("cols"), side("rows"));
  const term = query.get("term") ?? defaultTerm;
  if (!termPattern.test(term)) throw new Error(`term must be a terminal type such as ${defaultTerm}, got ${JSON.stringify(term.slice(0, 80))}`);
  return { size, term };
}

/** $TERM when the guest can take it, which a terminal type name always can, and xterm-256color otherwise. */
export function termOf(env: string | undefined): string {
  return env !== undefined && termPattern.test(env) ? env : defaultTerm;
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

const typed = z.object({ type: z.string() });
const resizeSchema = z.object({ cols: z.number(), rows: z.number() });
const serverSchemas = {
  waiting: z.object({ type: z.literal("waiting"), pylon: z.string().transform((pylon) => pylon as ActualState) }),
  attached: z.object({ type: z.literal("attached") }),
  exit: z.object({ type: z.literal("exit"), code: z.int() }),
  error: z.object({ type: z.literal("error"), kind: z.enum(["conflict", "failed", "unreachable"]), message: z.string() }),
};

/** Null for a type this end does not know. Throws for anything else that is not a message. */
export function parseClientMessage(text: string): ClientMessage | null {
  const value: unknown = JSON.parse(text);
  if (typed.parse(value).type !== "resize") return null;
  const { cols, rows } = resizeSchema.parse(value);
  return { type: "resize", size: terminalSize(cols, rows) };
}

/** Null for a type this end does not know. Throws for anything else that is not a message. */
export function parseServerMessage(text: string): ServerMessage | null {
  const value: unknown = JSON.parse(text);
  const { type } = typed.parse(value);
  return Object.hasOwn(serverSchemas, type) ? serverSchemas[type as keyof typeof serverSchemas].parse(value) : null;
}
