/** What the commands share: their types, the flag readers, the table, and the waits on a thread's pylon. */
import { setTimeout as sleep } from "node:timers/promises";
import type { ParseArgsOptionsConfig } from "node:util";
import type { z } from "zod";
import type { Project } from "../control/project.ts";
import { brokenRule, startFields } from "../contract/threads-parse.ts";
import type { itemSchema } from "../contract/projects-parse.ts";
import type { WebSocket } from "ws";
import { CliError, type ErrorKind } from "./transport.ts";
import { callOf, type ApiRoute, type CallArgs, type ReplyOf } from "../contract/route.ts";
import { threadRoutes } from "../contract/threads.ts";

export type Values = Record<string, string | boolean | string[] | undefined>;
/** `idleMs` is how long the reply may take, the route's. */
export type Api = (method: string, path: string, body?: unknown, idleMs?: number) => Promise<unknown>;
/** Follows one of the API's event streams until it ends or `signal` aborts it. */
export type Follow = (path: string, onEvent: (data: unknown) => void | Promise<void>, signal: AbortSignal, onCursor?: (id: string) => void) => Promise<void>;
/** Calls one of the contract's routes and answers its reply. */
export async function request<R extends ApiRoute>(api: Api, route: R, args: CallArgs<R>): Promise<ReplyOf<R>> {
  const { path, body } = callOf(route, args);
  return await api(route.method, path, body, route.idleMs) as ReplyOf<R>;
}
/** What a command prints: its JSON for --json, its text otherwise. With `exit`, it prints that and then exits as that kind of failure. */
export interface Result { json: unknown; text: string; exit?: ErrorKind }
/** What attach needs beyond the API. */
interface Local {
  /** A WebSocket to the API, over the same connection as every call. */
  connect(path: string): Promise<WebSocket>;
}
export interface Command {
  /** Its lines of `nexus --help`, which its own --help prints. Commands that share an entry share the array. */
  help: readonly string[];
  args: readonly [min: number, max: number];
  options?: ParseArgsOptionsConfig;
  /** Nothing when the command printed its own output, as watch does. */
  run(api: Api, args: readonly string[], values: Values, follow: Follow, local: Local): Promise<Result | void>;
}

export const str = (v: Values, key: string) => v[key] as string | undefined;
/** A flag given any number of times. */
export const strs = (v: Values, key: string) => (v[key] as string[] | undefined) ?? [];

export function int(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new CliError("invalid", `${flag} takes a whole number, got ${value}`);
  return n;
}

/** The --cpus, --memory and --disk given, or undefined for none, as a project, a start and an item send them. */
export function resourcesOf(v: Values): Partial<Project["resources"]> | undefined {
  const resources: Partial<Project["resources"]> = {};
  for (const [flag, field] of [["cpus", "cpus"], ["memory", "memoryGiB"], ["disk", "diskGiB"]] as const) {
    if (v[flag] !== undefined) resources[field] = int(str(v, flag), `--${flag}`, 0);
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}

export const resourceOptions = { cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" } } as const;

/**
 * The start fields that a flag of the same name gives as text. The rest have flags of their own: --cpus, --memory
 * and --disk give `resources`, --after a list, and start's --request-id and --plan `requestId` and `planning`.
 */
const textFields = Object.keys(startFields.shape).filter((field) => !["resources", "after", "requestId", "planning"].includes(field));
/** The flags of a start's or an item's brief. */
export const briefOptions = { ...Object.fromEntries(textFields.map((field) => [field, { type: "string" }])), ...resourceOptions, after: { type: "string" } } as const satisfies ParseArgsOptionsConfig;
const flagOf = (field: string) => `--${field === "planning" ? "plan" : field}`;

/** The body that `start` and `item add` send, held to the API's `rules` with the fields named as flags. */
export function briefOf(v: Values, verb: string, rules: Parameters<typeof brokenRule>[0]): z.input<typeof itemSchema> & { requestId?: string; planning?: true } {
  if (v.project === undefined) throw new CliError("invalid", `${verb} needs --project`);
  const after = str(v, "after")?.split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (after?.length === 0) throw new CliError("invalid", "--after needs a thread");
  const resources = resourcesOf(v);
  const requestId = str(v, "request-id");
  const body = {
    ...Object.fromEntries(textFields.flatMap((field) => v[field] === undefined ? [] : [[field, v[field]]])) as { project: string },
    ...resources === undefined ? {} : { resources }, ...after === undefined ? {} : { after },
    ...requestId === undefined ? {} : { requestId }, ...v.plan === true ? { planning: true as const } : {},
  };
  const broken = brokenRule(rules, body, flagOf);
  if (broken !== undefined) throw new CliError("invalid", broken);
  return body;
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

/** Pads every column but the last. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => i === r.length - 1 ? cell : cell.padEnd(widths[i]!)).join("  ")).join("\n");
}

export const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}...`;

export const waitMs = 120_000;
export const waitPollMs = 1_000;

/**
 * Runs `step` every `everyMs` until it answers something other than undefined, and fails with `timedOut` once the
 * deadline passes. A wait rides through an unreachable control plane, since every deploy restarts it and a step that
 * reads finishes on the next try. A step that sends what it waits on passes `tolerateUnreachable: false`, because an
 * unreachable answer may hide a request that ran.
 */
export async function pollUntil<T>(o: { deadlineMs: number; everyMs: number; tolerateUnreachable?: boolean; timedOut: () => CliError }, step: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + o.deadlineMs;
  for (;;) {
    let lost: CliError | null = null;
    try {
      const done = await step();
      if (done !== undefined) return done;
    } catch (err) {
      if (o.tolerateUnreachable === false || !(err instanceof CliError) || err.kind !== "unreachable") throw err;
      lost = err;
    }
    if (Date.now() >= deadline) {
      const timedOut = o.timedOut();
      throw lost === null ? timedOut : new CliError(timedOut.kind, `${timedOut.message}\nThe last poll failed: ${lost.message}`);
    }
    await sleep(o.everyMs);
  }
}

/**
 * Sends a request that needs the pylon running, such as an unlink or a session open. Each try is human activity, so
 * the first wakes a paused pylon, and a retryable refusal is tried again once a second until the pylon runs, unless
 * the thread is archived or deleted. Any other refusal, such as Claude waiting at a prompt, fails at once.
 * `undone` says what the failure after the wait leaves undone.
 */
export async function whenRunning<T>(api: Api, id: string, send: () => Promise<T>, undone: string): Promise<T> {
  let refused: CliError;
  return pollUntil({
    deadlineMs: waitMs, everyMs: waitPollMs, tolerateUnreachable: false,
    timedOut: () => new CliError("failed", `the pylon of ${id} did not run within ${waitMs / 1000} s, so ${undone}. ${refused.message}`),
  }, async () => {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof CliError) || !err.retryable) throw err;
      const { status } = (await request(api, threadRoutes.show, { thread: id })).thread;
      if (status === "archived" || status === "deleted") throw err;
      refused = err;
      return undefined;
    }
  });
}

/** How long a dropped stream or link waits before it opens again, after `failed` drops in a row: 1 s, doubling, at most `maxMs`. */
export const reconnectMs = (failed: number, maxMs = 30_000) => Math.min(maxMs, 1000 * 2 ** failed);

/**
 * Calls `onEnd` once the consumer of a stream is gone: on SIGINT, SIGTERM or SIGHUP, when it closes the pipe, or when
 * the process that started this one exits. A consumer killed outright never closes the pipe, and a quiet stream
 * writes nothing that would find it closed, so the parent is checked every second. Answers what stops the parent
 * check and the signal handlers. The pipe's stays, since a closed pipe fails the last write after the stream ends.
 */
export function untilConsumerGone(onEnd: () => void): () => void {
  const parent = process.ppid;
  const orphan = setInterval(() => { if (process.ppid !== parent) onEnd(); }, 1000);
  const outputError = (err: NodeJS.ErrnoException) => { if (err.code === "EPIPE") onEnd(); else throw err; };
  process.stdout.on("error", outputError);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, onEnd);
  return () => {
    clearInterval(orphan);
    for (const signal of signals) process.removeListener(signal, onEnd);
  };
}
