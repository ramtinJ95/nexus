/**
 * `nexus attach`: this terminal on a pylon's Herdr session, through the control plane's attach route, which wakes the
 * pylon and waits for it. The CLI only owns the terminal: raw mode while attached, its size, and putting it back the
 * way it was on every way out. contract/attach.ts is the protocol.
 */
import type { Readable, Writable } from "node:stream";
import type { WebSocket } from "ws";
import { attachPath, encodeMessage, type ServerMessage } from "../contract/attach.ts";
import { parseServerMessage, termOf } from "../contract/attach-parse.ts";
import { terminalSize, type TerminalSize } from "../guest-terminal.ts";
import { CliError } from "./transport.ts";
import { reconnectMs } from "./kit.ts";

export interface Tty {
  readonly input: Readable & { readonly isTTY?: boolean; setRawMode(raw: boolean): unknown; unref?(): unknown };
  readonly output: Writable & { readonly isTTY?: boolean; readonly columns: number; readonly rows: number };
  readonly term: string | undefined;
  status(line: string): void;
  exit(code: number): never;
}

export function processTty(): Tty {
  return {
    input: process.stdin as Tty["input"],
    output: process.stdout,
    term: process.env.TERM,
    status: (line) => process.stderr.write(`nexus: ${line}\n`),
    exit: (code) => process.exit(code),
  };
}

/**
 * Leaves the alternate screen and turns the cursor back on, and mouse reports, focus reports, bracketed paste and
 * the kitty keyboard protocol off. Herdr does this when it detaches, but not when the link drops under it, and
 * without it the shell after attach would read mouse moves and keys as escape sequences.
 */
const screenReset = "\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u";

/** Signals that end an attach from outside, such as a closed terminal window. */
const signals = { SIGHUP: 1, SIGTERM: 15 } as const;

export interface Retry {
  readonly tries: number;
  delayMs(retry: number): number;
  /**
   * `attached` comes before Herdr's client runs, so a pylon whose sshd takes the link and drops it at once would
   * otherwise be tried again every second for good.
   */
  readonly steadyMs: number;
}

/** 8 times, about two minutes. */
const retry: Retry = { tries: 8, delayMs: reconnectMs, steadyMs: 10_000 };

type LinkEnd = { kind: "over"; message: Extract<ServerMessage, { type: "exit" | "error" }> } | { kind: "lost"; why: string };

interface Link { readonly ws: WebSocket; attached: boolean }

/**
 * Resolves when Herdr exits 0, which is its own detach, and throws a CliError on every other end. A link that drops,
 * or ends with an unreachable error, such as the control plane stopping for a deploy, links again while the terminal
 * stays raw, dropping the keys typed in between. Raw mode starts at the first `attached`, so Ctrl-C still quits while
 * the pylon wakes. `connect` gives a paused WebSocket to the API, as transport.upgrade does.
 */
export async function attachTerminal(connect: (path: string) => Promise<WebSocket>, thread: string, tty: Tty, retries = retry): Promise<void> {
  const { input, output } = tty;
  if (input.isTTY !== true || output.isTTY !== true) throw new CliError("invalid", "attach needs a terminal, and stdin or stdout is not one");
  const size = (): TerminalSize => {
    try {
      return terminalSize(output.columns, output.rows);
    } catch (err) {
      throw new CliError("invalid", `this terminal's size cannot be attached: ${(err as Error).message}`);
    }
  };

  let raw = false;
  /** Whether Herdr ended the attach itself, and so put back the screen modes it set. */
  let clean = false;
  let current: Link | null = null;
  let tries = 0;
  let quit!: () => void;
  const quitting = new Promise<{ kind: "quit" }>((resolve) => { quit = () => resolve({ kind: "quit" }); });
  const restore = () => {
    if (!raw) return;
    raw = false;
    if (!clean) output.write(screenReset);
    input.setRawMode(false);
  };
  const onResize = () => {
    if (current !== null && current.ws.readyState === current.ws.OPEN) current.ws.send(encodeMessage({ type: "resize", size: size() }));
  };
  const onKeys = (keys: Buffer) => {
    if (current?.attached === true) return current.ws.send(keys);
    // The terminal is raw, so Ctrl-C is a byte rather than SIGINT.
    if (keys.includes(0x03)) quit();
  };
  const onSignal = (signal: keyof typeof signals) => {
    restore();
    current?.ws.close();
    process.exit(128 + signals[signal]);
  };

  const link = async (): Promise<LinkEnd> => {
    let ws: WebSocket;
    try {
      ws = await connect(attachPath(thread, { size: size(), term: termOf(tty.term) }));
    } catch (err) {
      // A first refusal is the person's to see at once. A later one is the control plane coming back up.
      if (tries > 0 && err instanceof CliError && err.kind === "unreachable") return { kind: "lost", why: err.message };
      throw err;
    }
    const at: Link = { ws, attached: false };
    current = at;
    let final: LinkEnd | null = null;
    let steady: NodeJS.Timeout | undefined;
    let cause: Error | null = null;
    const unwritten = () => {
      // A terminal that takes output slower than Herdr makes it holds the socket, and so Herdr, back.
      ws.pause();
      output.once("drain", () => ws.resume());
    };
    try {
      return await new Promise<LinkEnd>((resolve, reject) => {
        ws.on("error", (err) => { cause ??= err; });
        ws.on("close", () => resolve(final ?? { kind: "lost", why: `the connection to the control plane dropped${cause === null ? "" : `: ${cause.message}`}` }));
        ws.on("message", (data, binary) => {
          if (binary) {
            if (!output.write(data as Buffer)) unwritten();
            return;
          }
          let message: ServerMessage | null;
          try {
            message = parseServerMessage(data.toString());
          } catch (err) {
            ws.terminate();
            return reject(new CliError("failed", `the control plane sent a message attach does not understand: ${(err as Error).message}`));
          }
          if (message === null) return;
          if (message.type === "waiting") return tty.status(`waiting for the pylon of ${thread}, which is ${message.pylon}`);
          if (message.type === "attached") {
            at.attached = true;
            steady = setTimeout(() => { tries = 0; }, retries.steadyMs);
            if (raw) return;
            input.setRawMode(true);
            raw = true;
            input.on("data", onKeys);
            input.resume();
            return;
          }
          final = message.type === "error" && message.kind === "unreachable" ? { kind: "lost", why: message.message } : { kind: "over", message };
          clean = message.type === "exit" && message.code === 0;
        });
        ws.resume();
      });
    } finally {
      clearTimeout(steady);
      if (current === at) current = null;
    }
  };

  process.once("exit", restore);
  for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.once(signal, onSignal);
  output.on("resize", onResize);
  let end: LinkEnd | { kind: "quit" };
  let timer: NodeJS.Timeout | undefined;
  try {
    for (;;) {
      end = await Promise.race([link(), quitting]);
      if (end.kind !== "lost") break;
      if (tries === retries.tries) {
        throw new CliError("unreachable", `${end.why}, and attaching again failed ${tries} times. Herdr keeps the session, so \`nexus attach ${thread}\` again`);
      }
      const delay = retries.delayMs(tries++);
      // Herdr set its screen modes and did not get to put them back, so the line below lands on the shell's screen.
      if (raw && !clean) output.write(screenReset);
      tty.status(`${end.why}. Attaching again in ${delay / 1000} s, Ctrl-C quits`);
      const waited = await Promise.race([new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), delay); }), quitting]);
      if (waited !== null) {
        end = waited;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    // Ctrl-C quits while a link waits for its `attached`.
    (current as Link | null)?.ws.terminate();
    restore();
    output.off("resize", onResize);
    input.off("data", onKeys);
    // So the process can exit once the attach ends.
    input.pause();
    input.unref?.();
    process.off("exit", restore);
    for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.off(signal, onSignal);
  }
  if (end.kind === "quit") tty.exit(130);
  const { message } = end;
  if (message.type === "exit") {
    if (message.code === 0) return;
    throw new CliError("failed", `Herdr in the pylon of ${thread} exited ${message.code}`);
  }
  throw new CliError(message.kind, message.message);
}
