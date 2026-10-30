/**
 * How Nexus speaks for itself to the agents it runs: who starts the threads it starts, which part of it sent an
 * automated message and the prefix that says so, the role a thread's caller gives it, and the tokens and fenced
 * blocks an agent answers a request in.
 */
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { tailnetNodeIdSchema } from "./protocol.ts";

/** Who starts a reviewer thread, as its `startedBy`. */
export const reviewerCaller = "nexus-review";
/** Who starts a check thread, as its `startedBy`. */
export const checkCaller = "nexus-check";
/** Who starts a verify pylon's thread, as its `startedBy`. */
export const verifyCaller = "nexus-verify";

/** Who sent an automated input entry, which the entry's kind, `nexus.<sender>`, and its data name. */
export type Sender = "pr-watch" | "review" | "usage-limit" | "nudge";
export const senderNames: Readonly<Record<Sender, string>> = { "pr-watch": "Nexus PR watch", review: "Nexus review", "usage-limit": "Nexus usage limit", nudge: "Nexus nudge" };

export const reviewPrefix = "[Nexus review — automated, not a message from the person]";
export const nudgePrefix = "[Nexus nudge — automated, not a message from the person]";
export const prWatchPrefix = "[Nexus PR watch — automated, not a message from the person]";
export const usageLimitPrefix = "[Nexus usage limit — automated, not a message from the person]";
export const planningPrefix = "[Nexus planning: automated, not a message from the person]";
export const judgmentPrefix = "[Nexus judgment — automated, not a message from the person]";
export const senderPrefixes: Readonly<Record<Sender, string>> = { "pr-watch": prWatchPrefix, review: reviewPrefix, nudge: nudgePrefix, "usage-limit": usageLimitPrefix };

export type ThreadRole = "builder" | "reviewer" | "check" | "verify" | "other";

/** A reviewer, check or verify thread is one the review loop started, and a builder one a person started from a tailnet node. */
export function roleOf(startedBy: string): ThreadRole {
  if (startedBy === reviewerCaller) return "reviewer";
  if (startedBy === checkCaller) return "check";
  if (startedBy === verifyCaller) return "verify";
  return tailnetNodeIdSchema.safeParse(startedBy).success ? "builder" : "other";
}

/** Whether the review loop started `t`, including a reviewer a later review of the same builder replaced. */
export const startedByNexus = <Id extends string>(registry: { isReviewer(id: Id): boolean }, t: { id: Id; startedBy: string }): boolean => {
  const role = roleOf(t.startedBy);
  return role === "reviewer" || role === "check" || role === "verify" || registry.isReviewer(t.id);
};

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

/** The newest fenced `fence` block in the replies whose JSON matches `schema` and echoes `token`, or null when none does. */
export const latest = <T extends { token: string }>(replies: readonly string[], fence: string, schema: z.ZodType<T>, token: string): T | null =>
  tokenBlocks(replies, fence, schema, token).at(-1) ?? null;
