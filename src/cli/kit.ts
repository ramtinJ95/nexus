import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ParseArgsOptionsConfig } from "node:util";
import type { z } from "zod";
import type { Project } from "../contract/projects.ts";
import { brokenRule, startFields } from "../contract/threads-parse.ts";
import type { itemSchema } from "../contract/projects-parse.ts";
import type { WebSocket } from "ws";
import { CliError, UsageError, type ErrorKind } from "./transport.ts";
import { callOf, type ApiRoute, type CallArgs, type FileBytes, type ReplyOf } from "../contract/route.ts";
import { threadRoutes } from "../contract/threads.ts";

export type Values = Record<string, string | boolean | string[] | undefined>;
/** With `as` set to `bytes`, a success answers the body's bytes as a Buffer, for a route that serves a file. */
export type Api = (method: string, path: string, body?: unknown, idleMs?: number, as?: "bytes") => Promise<unknown>;
export type Follow = (path: string, onEvent: (data: unknown) => void | Promise<void>, signal: AbortSignal, onCursor?: (id: string) => void) => Promise<void>;
export async function request<R extends ApiRoute>(api: Api, route: R, args: CallArgs<R>): Promise<ReplyOf<R>> {
  const { path, body } = callOf(route, args);
  return await api(route.method, path, body, route.idleMs) as ReplyOf<R>;
}
/** The bytes a route that answers a file serves. */
export async function fileOf<R extends ApiRoute<"GET", string, FileBytes>>(api: Api, route: R, args: CallArgs<R>): Promise<Buffer> {
  const { path, body } = callOf(route, args);
  return await api(route.method, path, body, route.idleMs, "bytes") as Buffer;
}
/** With `exit`, the command prints its result and then exits as that kind of failure. */
export interface Result { json: unknown; text: string; exit?: ErrorKind }
/** The process's streams and environment, or a test's, which runs the CLI in its own process. */
export interface Io {
  readonly stdin: Readable & { readonly isTTY?: boolean };
  readonly stdout: Writable & { readonly isTTY?: boolean };
  readonly stderr: Writable & { readonly isTTY?: boolean };
  readonly env: Readonly<Record<string, string | undefined>>;
}
/** This CLI's version, and the one its control plane's health reports, null when it reports none. */
export interface Versions { cli: string; control: string | null }
interface Local {
  connect(path: string): Promise<WebSocket>;
  /** The versions the health read before the command's first request found. */
  versions(): Promise<Versions>;
  io: Io;
}
export interface Command {
  /** Commands that share an entry share the array. */
  help: readonly string[];
  args: readonly [min: number, max: number];
  /** Its first argument names a thread, which a prefix of the ID or `@last` may give. */
  thread?: true;
  /**
   * It runs against a control plane older than `minControlVersion`, with a warning, since it is how a person
   * upgrades or diagnoses one.
   */
  anyVersion?: true;
  options?: ParseArgsOptionsConfig;
  /** What an unknown flag's error adds, for a command whose text is its arguments and may start with a dash. */
  dashHint?: string;
  /** Nothing when the command printed its own output, as watch does, or the exit code it ends with then. */
  run(api: Api, args: readonly string[], values: Values, follow: Follow, local: Local): Promise<Result | number | void>;
}

export const str = (v: Values, key: string) => v[key] as string | undefined;
export const strs = (v: Values, key: string) => (v[key] as string[] | undefined) ?? [];

export function int(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} takes a whole number, got ${value}`);
  return n;
}

export function resourcesOf(v: Values): Partial<Project["resources"]> | undefined {
  const resources: Partial<Project["resources"]> = {};
  for (const [flag, field] of [["cpus", "cpus"], ["memory", "memoryGiB"], ["disk", "diskGiB"]] as const) {
    if (v[flag] !== undefined) resources[field] = int(str(v, flag), `--${flag}`, 0);
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}

/**
 * Text that no shell argument has to carry, read from the file at `path`, or from stdin when it is `-`. A file's last
 * line break is how files end, not part of the text.
 */
export async function textFrom(path: string, flag: string, stdin: Readable): Promise<string> {
  const from = path === "-" ? "stdin" : path;
  let read: string;
  try {
    // Decoded as readFile decodes, which keeps a leading byte order mark that text() would drop.
    read = (path === "-" ? await buffer(stdin) : await readFile(path)).toString("utf8");
  } catch (err) {
    throw new CliError("invalid", `${flag} could not read ${from}: ${(err as Error).message}`);
  }
  const body = read.replace(/\r?\n$/, "");
  if (body === "") throw new UsageError(`${flag} read nothing from ${from}`);
  return body;
}

export const resourceOptions = { cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" } } as const;

/**
 * The fields left out have flags of their own: --cpus, --memory and --disk give `resources`, --after a list, and
 * start's --request-id and --plan `requestId` and `planning`.
 */
const textFields = Object.keys(startFields.shape).filter((field) => !["resources", "after", "requestId", "planning"].includes(field));
/** A brief's message or Claude prompt may come from a file or stdin, as --message-file and --claude-file. */
const fileFields = ["message", "claude"] as const;
export const briefOptions = {
  ...Object.fromEntries(textFields.map((field) => [field, { type: "string" }])), ...Object.fromEntries(fileFields.map((field) => [`${field}-file`, { type: "string" }])),
  ...resourceOptions, after: { type: "string" },
} as const satisfies ParseArgsOptionsConfig;
const flagOf = (field: string) => `--${field === "planning" ? "plan" : field}`;

/** `project` is --project, or what `projectOf` made of this checkout. */
export async function briefOf(v: Values, project: string, rules: Parameters<typeof brokenRule>[0], stdin: Readable): Promise<z.input<typeof itemSchema> & { requestId?: string; planning?: true }> {
  const files = fileFields.flatMap((field) => {
    const path = str(v, `${field}-file`);
    if (path !== undefined && v[field] !== undefined) throw new UsageError(`--${field} and --${field}-file cannot be used together`);
    return path === undefined ? [] : [{ field, path }];
  });
  // The rules see a file's text as given before any is read, so a refused brief never waits on stdin.
  v = { ...v, ...Object.fromEntries(files.map(({ field }) => [field, "-"])) };
  const after = str(v, "after")?.split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (after?.length === 0) throw new UsageError("--after needs a thread");
  const resources = resourcesOf(v);
  const requestId = str(v, "request-id");
  const body = {
    ...Object.fromEntries(textFields.flatMap((field) => v[field] === undefined ? [] : [[field, v[field]]])), project,
    ...resources === undefined ? {} : { resources }, ...after === undefined ? {} : { after },
    ...requestId === undefined ? {} : { requestId }, ...v.plan === true ? { planning: true as const } : {},
  };
  const broken = brokenRule(rules, body, (field) => files.some((file) => file.field === field) ? `--${field}-file` : flagOf(field));
  if (broken !== undefined) throw new UsageError(broken);
  for (const { field, path } of files) (body as Record<string, unknown>)[field] = await textFrom(path, `--${field}-file`, stdin);
  return body;
}

const two = (n: number) => String(n).padStart(2, "0");
/** The local date and clock time, such as `2026-11-07 09:12`. */
export const localTime = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** A time as how long ago, or how soon, then its local time: `3h ago (2026-11-10 14:05)`, `in 20m (2026-11-10 17:30)`. */
export function when(at: number, now = Date.now()): string {
  const s = Math.floor(Math.abs(now - at) / 1000);
  const span = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return `${at > now && s > 0 ? `in ${span}` : `${span} ago`} (${localTime(at)})`;
}

/** A row's colour, shown only on a terminal without NO_COLOR. */
export type Tone = "failed" | "attention";
const tones: Record<Tone, string> = { failed: "\x1b[31m", attention: "\x1b[33m" };

/** Whether the text may be coloured: stdout is a terminal and NO_COLOR is unset or empty, as no-color.org says. */
export const colourOf = (io: Io) => io.stdout.isTTY === true && (io.env.NO_COLOR ?? "") === "";

/** Columns padded to their widest cell under a header. A row with a tone is coloured whole, after its padding. */
export function table(head: readonly string[], rows: readonly (readonly string[])[], toneOf: (i: number) => Tone | null = () => null): string {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return all.map((r, n) => {
    const line = r.map((cell, i) => i === r.length - 1 ? cell : cell.padEnd(widths[i]!)).join("  ");
    const tone = n === 0 ? null : toneOf(n - 1);
    return tone === null ? line : `${tones[tone]}${line}\x1b[0m`;
  }).join("\n");
}

export const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}...`;

export const waitMs = 120_000;
export const waitPollMs = 1_000;

/**
 * A line for the person at a wait. Only a terminal gets it, since the client extensions read stdout and may take
 * output on stderr for a failure.
 */
export type Note = (line: string) => void;
export const noteTo = (stderr: Io["stderr"]): Note => (line) => { if (stderr.isTTY === true) stderr.write(`${line}\n`); };

/**
 * What a wait says on the run's stderr `to` while it waits: its state, each time that changes, and on Ctrl-C what
 * carries on without it.
 */
export interface Shown { to: Io["stderr"]; state: () => string | undefined; stopped: () => string }

/**
 * A wait rides through an unreachable control plane, since every deploy restarts it and a step that reads finishes
 * on the next try. A step that sends what it waits on passes `tolerateUnreachable: false`, because an
 * unreachable answer may hide a request that ran. With `shown`, a terminal sees the wait's state, and Ctrl-C ends
 * the wait with exit code 130 once it said what carries on.
 */
export async function pollUntil<T>(o: { deadlineMs: number; everyMs: number; tolerateUnreachable?: boolean; timedOut: () => CliError; shown?: Shown }, step: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + o.deadlineMs;
  const shown = o.shown?.to.isTTY === true ? o.shown : undefined;
  const note = shown === undefined ? () => {} : noteTo(shown.to);
  let said: string | undefined;
  const show = () => {
    const state = shown?.state();
    if (state !== undefined && state !== said) note(said = state);
  };
  const stop = () => {
    note(shown!.stopped());
    process.exit(130);
  };
  if (shown !== undefined) process.once("SIGINT", stop);
  try {
    show();
    for (;;) {
      let lost: CliError | null = null;
      try {
        const done = await step();
        if (done !== undefined) return done;
      } catch (err) {
        if (o.tolerateUnreachable === false || !(err instanceof CliError) || err.kind !== "unreachable") throw err;
        lost = err;
      }
      show();
      if (Date.now() >= deadline) {
        const timedOut = o.timedOut();
        throw lost === null ? timedOut : new CliError(timedOut.kind, `${timedOut.message}\nThe last poll failed: ${lost.message}`);
      }
      await sleep(o.everyMs);
    }
  } finally {
    process.off("SIGINT", stop);
  }
}

/** Each try is human activity, so the first wakes a paused pylon. */
export async function whenRunning<T>(api: Api, io: Io, id: string, send: () => Promise<T>, undone: string): Promise<T> {
  let refused: CliError | undefined;
  let sending = false;
  return pollUntil({
    deadlineMs: waitMs, everyMs: waitPollMs, tolerateUnreachable: false,
    timedOut: () => new CliError("failed", `the pylon of ${id} did not run within ${waitMs / 1000} s, so ${undone}. ${refused!.message}`),
    shown: {
      to: io.stderr,
      state: () => refused && `Waiting up to ${waitMs / 1000} s for the pylon of ${id} to run: ${refused.message}`,
      stopped: () => sending ? `Stopped waiting while a try was out, so it may have gone through. The pylon of ${id} keeps waking` : `Stopped waiting, so ${undone}. The pylon of ${id} keeps waking`,
    },
  }, async () => {
    try {
      sending = true;
      return await send();
    } catch (err) {
      if (!(err instanceof CliError) || !err.retryable) throw err;
      sending = false;
      const { status } = (await request(api, threadRoutes.show, { thread: id })).thread;
      if (status === "archived" || status === "deleted") throw err;
      refused = err;
      return undefined;
    }
  });
}

/** How long a read tries again after the control plane refused or dropped its connection, as a deploy's restart does. */
export const restartMs = 15_000;

/**
 * A GET may run twice, so one that meets a restarting control plane tries again each second for `restartMs`, and
 * the process says so once, however many polls a wait makes. Any other request fails at once, since it may have gone
 * through. Either failure then names where to look, which `connect`, trying its candidates, does not need.
 */
export function ridingRestarts(api: Api, said: Note): Api {
  let noted = false;
  const lookAt = (err: CliError) => new CliError(err.kind, `${err.message}. The control plane is down or restarting, or the URL is not its own: \`nexus connect <host>\` finds it again, and \`systemctl status nexus-control\` on its machine shows whether it runs`, err.status, err.code, err.retryable, err.restarting);
  return async (method, path, body, idleMs, as) => {
    const deadline = Date.now() + restartMs;
    for (;;) {
      try {
        return await api(method, path, body, idleMs, as);
      } catch (err) {
        if (!(err instanceof CliError) || !err.restarting) throw err;
        if (method !== "GET" || Date.now() >= deadline) throw lookAt(err);
        if (!noted) said(`${err.message}. Trying again for up to ${restartMs / 1000} s, as the control plane restarts on each deploy`);
        noted = true;
      }
      await sleep(1_000);
    }
  };
}

export const reconnectMs = (failed: number, maxMs = 30_000) => Math.min(maxMs, 1000 * 2 ** failed);

/**
 * A consumer killed outright never closes the pipe, and a quiet stream writes nothing that would find it closed, so
 * the parent is checked every second. A consumer that closes the pipe ends the CLI at its entry, nexus.ts.
 */
export function untilConsumerGone(onEnd: () => void): () => void {
  const parent = process.ppid;
  const orphan = setInterval(() => { if (process.ppid !== parent) onEnd(); }, 1000);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, onEnd);
  return () => {
    clearInterval(orphan);
    for (const signal of signals) process.removeListener(signal, onEnd);
  };
}

/** Where the person confirms what a command does for them: its stdin, and the stderr it asks on. */
export interface Terminal { input: Readable & { readonly isTTY?: boolean }; output: Writable & { readonly isTTY?: boolean } }

/**
 * An agent on the person's Mac calls as the same tailnet node, so the terminal is what tells the person apart: with
 * no terminal the command refuses, with `refusal`.
 */
export function needsTerminal(terminal: Terminal, refusal: string): void {
  if (terminal.input.isTTY !== true || terminal.output.isTTY !== true) throw new CliError("invalid", refusal);
}

/** Whether the person typed yes after `prompt`. A closed stdin is a no. */
export async function typedYes(terminal: Terminal, prompt: string): Promise<boolean> {
  terminal.output.write(prompt);
  const lines = createInterface({ input: terminal.input, terminal: false });
  const answer = await new Promise<string | null>((resolve) => {
    lines.once("line", resolve);
    lines.once("close", () => resolve(null));
  });
  lines.close();
  return answer?.trim() === "yes";
}
