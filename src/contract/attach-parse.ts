/** These parsers need zod, so they stay out of attach.ts, which the dashboard bundles. */
import { z } from "zod";
import { defaultTerm, type AttachRequest, type ClientMessage, type ServerMessage } from "./attach.ts";
import { terminalSize } from "../guest-terminal.ts";
import type { ActualState } from "../control/reconcile.ts";
import { herdrPanePattern } from "../guest-contract.ts";

const termPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export const attachRoute = /^\/v1\/threads\/([^/]+)\/attach$/;

/** Throws a message for a 400. */
export function parseAttachQuery(query: URLSearchParams): AttachRequest {
  const side = (name: string) => {
    const value = query.get(name);
    if (value === null || !/^\d+$/.test(value)) throw new Error(`${name} must be a whole number from 1 to 9999, got ${value ?? "none"}`);
    return Number(value);
  };
  const size = terminalSize(side("cols"), side("rows"));
  const term = query.get("term") ?? defaultTerm;
  if (!termPattern.test(term)) throw new Error(`term must be a terminal type such as ${defaultTerm}, got ${JSON.stringify(term.slice(0, 80))}`);
  const pane = query.get("pane");
  if (pane !== null && !herdrPanePattern.test(pane)) throw new Error(`pane must be a Herdr pane ID such as w1:p1, got ${JSON.stringify(pane.slice(0, 80))}`);
  return { size, term, ...(pane === null ? {} : { pane }) };
}

export function termOf(env: string | undefined): string {
  return env !== undefined && termPattern.test(env) ? env : defaultTerm;
}

const typed = z.object({ type: z.string() });
const resizeSchema = z.object({ cols: z.number(), rows: z.number() });
const serverSchemas = {
  waiting: z.object({ type: z.literal("waiting"), pylon: z.string().transform((pylon) => pylon as ActualState) }),
  attached: z.object({ type: z.literal("attached") }),
  exit: z.object({ type: z.literal("exit"), code: z.int() }),
  error: z.object({ type: z.literal("error"), kind: z.enum(["conflict", "failed", "unreachable"]), message: z.string() }),
};

export function parseClientMessage(text: string): ClientMessage | null {
  const value: unknown = JSON.parse(text);
  if (typed.parse(value).type !== "resize") return null;
  const { cols, rows } = resizeSchema.parse(value);
  return { type: "resize", size: terminalSize(cols, rows) };
}

export function parseServerMessage(text: string): ServerMessage | null {
  const value: unknown = JSON.parse(text);
  const { type } = typed.parse(value);
  return Object.hasOwn(serverSchemas, type) ? serverSchemas[type as keyof typeof serverSchemas].parse(value) : null;
}
