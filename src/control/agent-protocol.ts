/**
 * How Nexus speaks for itself to the agents it runs: who starts the threads it starts, which part of it sent an
 * automated message and the prefix that says so, the role a thread's caller gives it, and the tokens and fenced
 * blocks an agent answers a request in.
 */
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { tailnetNodeIdSchema } from "../protocol/fields.ts";

/** Who starts a reviewer thread, as its `startedBy`. */
export const reviewerCaller = "nexus-review";
/** Who starts a check thread, as its `startedBy`. */
export const checkCaller = "nexus-check";
/** Who starts a verify pylon's thread, as its `startedBy`. */
export const verifyCaller = "nexus-verify";

const automated = (name: string) => `[${name} — automated, not a message from the person]`;
const sender = (name: string) => ({ name, prefix: automated(name) });
/** Who sends automated input entries: the name an entry's kind, `nexus.<sender>`, and its data give, and the prefix its text starts with. */
export const senders = {
  "pr-watch": sender("Nexus PR watch"), review: sender("Nexus review"), "usage-limit": sender("Nexus usage limit"), nudge: sender("Nexus nudge"), resume: sender("Nexus resume"),
};
export type Sender = keyof typeof senders;
export const judgmentPrefix = automated("Nexus judgment");
export const planningPrefix = "[Nexus planning: automated, not a message from the person]";

/**
 * What a thread is to the work. A builder's work becomes a pull request. The rest serve one: a review's reviewer, a
 * check or verify thread a review started, and a planning thread.
 */
export type Role = "builder" | "planning" | "reviewer" | "check" | "verify";

type CallerRole = "builder" | "reviewer" | "check" | "verify" | "other";

const nexusCallers: ReadonlyMap<string, CallerRole> = new Map([[reviewerCaller, "reviewer"], [checkCaller, "check"], [verifyCaller, "verify"]]);

/** A reviewer, check or verify thread is one the review loop started, and a builder one a person started from a tailnet node. */
export const roleOf = (startedBy: string): CallerRole =>
  nexusCallers.get(startedBy) ?? (tailnetNodeIdSchema.safeParse(startedBy).success ? "builder" : "other");

/** A token of `id` and random hex, which only the recipient of the request it is in is told. */
export const mint = (id: string) => `${id}:${randomBytes(6).toString("hex")}`;

/**
 * The text of each block fenced as `fence` in the replies, oldest first. The closing fence starts a line, which no
 * JSON string can, so a brief or a finding that quotes fenced code stays in its block.
 */
const fencedBlocks = (replies: readonly string[], fence: string): string[] =>
  replies.flatMap((text) => [...text.matchAll(new RegExp("```" + fence + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```", "g"))].map((m) => m[1]!));

/** Every fenced `fence` block in the replies whose JSON matches `schema` and echoes `token`, oldest first. */
export const tokenBlocks = <T extends { token: string }>(replies: readonly string[], fence: string, schema: z.ZodType<T>, token: string): T[] =>
  fencedBlocks(replies, fence).flatMap((block) => {
    let value: unknown;
    try { value = JSON.parse(block); } catch { return []; }
    const parsed = schema.safeParse(value);
    return parsed.success && parsed.data.token === token ? [parsed.data] : [];
  });

/**
 * The fenced `fence` block that ends `reply`, with nothing but whitespace after it, if its JSON matches `schema` and
 * echoes `token`, or null. Text after the block, such as a correction, takes it back.
 */
export function endingBlock<T extends { token: string }>(reply: string, fence: string, schema: z.ZodType<T>, token: string): T | null {
  const last = reply.slice(reply.lastIndexOf("```" + fence));
  return new RegExp("^```" + fence + "[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n[ \\t]*```\\s*$").test(last) ? latest([last], fence, schema, token) : null;
}

/** The newest fenced `fence` block in the replies whose JSON matches `schema` and echoes `token`, or null when none does. */
export const latest = <T extends { token: string }>(replies: readonly string[], fence: string, schema: z.ZodType<T>, token: string): T | null =>
  tokenBlocks(replies, fence, schema, token).at(-1) ?? null;
