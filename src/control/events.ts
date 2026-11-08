import { sessionKinds } from "../guest-contract.ts";

export const sessionActivityTtlMs = 30 * 60_000;
export const maxActiveSessions = 16;

export const eventKinds = [...sessionKinds, "thread.turn-ended", "thread.failed", "thread.parked", "attention.changed", "pull-request.feedback", "pull-request.linked", "pull-request.error", "pull-request.error-cleared", "release.changed", "health.changed", "review.changed", "review.waived", "review.approval-carried", "review.waiver-carried", "usage-limit.continued", "thread.resumed"] as const;
export type EventKind = typeof eventKinds[number];

export interface NexusEvent {
  id: string;
  time: number;
  thread: string | null;
  project: string | null;
  kind: EventKind;
  payload: Record<string, unknown>;
}
export interface EventFilter { thread?: string; project?: string; kinds?: readonly string[] }
export function eventCursor(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("invalid event cursor");
  return Number(value);
}
