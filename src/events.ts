import type { PylonId } from "./protocol.ts";
import { z } from "zod";

export const sessionActivityTtlMs = 30 * 60_000;
export const maxActiveSessions = 16;

export const sessionKinds = ["session.turn-started", "session.heartbeat", "session.turn-ended", "session.waiting", "session.ended"] as const;
export const eventKinds = [...sessionKinds, "thread.turn-ended", "thread.failed", "thread.parked", "attention.changed", "pull-request.feedback", "release.changed"] as const;
export type EventKind = typeof eventKinds[number];

export const pylonEventSchema = z.strictObject({
  kind: z.enum(sessionKinds),
  at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  session: z.string().min(1).max(200).optional(),
  message: z.string().max(2048).optional(),
});
export type PylonEvent = z.infer<typeof pylonEventSchema>;
export interface ReportedEvent { sequence: number; pylon: PylonId; event: PylonEvent; time: number }
export const reportedEventSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pylon: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  event: pylonEventSchema,
  time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export interface NexusEvent {
  id: string;
  time: number;
  thread: string | null;
  project: string | null;
  kind: EventKind;
  payload: Record<string, unknown>;
}
export interface EventFilter { thread?: string; project?: string; kinds?: readonly string[] }
export function matchesEvent(event: NexusEvent, filter: EventFilter): boolean {
  return (filter.thread === undefined || event.thread === filter.thread)
    && (filter.project === undefined || event.project === filter.project)
    && (!filter.kinds?.length || filter.kinds.includes(event.kind));
}
export function eventCursor(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("invalid event cursor");
  return Number(value);
}
