/**
 * `nexus attach`: this terminal on a pylon's Herdr session, through the control plane's attach route, which wakes the
 * pylon and waits for it. The CLI only owns the terminal: raw mode while attached, its size, and putting it back the
 * way it was on every way out. attach-wire.ts is the protocol.
 */
import type { Readable, Writable } from "node:stream";
import type { WebSocket } from "ws";
import { attachPath, encodeMessage, parseServerMessage, termOf, type ServerMessage } from "../attach-wire.ts";
import { terminalSize, type TerminalSize } from "../guest-terminal.ts";
import { CliError } from "./transport.ts";

/** The terminal attach runs in. processTty() is this process's. Tests pass a fake. */
export interface Tty {
  readonly input: Readable & { readonly isTTY?: boolean; setRawMode(raw: boolean): unknown; unref?(): unknown };
  readonly output: Writable & { readonly isTTY?: boolean; readonly columns: number; readonly rows: number };
  /** $TERM. */
  readonly term: string | undefined;
  /** One line for the person, outside the terminal's own output. */
  status(line: string): void;
}

export function processTty(): Tty {
  return {
    input: process.stdin as Tty["input"],
    output: process.stdout,
    term: process.env.TERM,
    status: (line) => process.stderr.write(`nexus: ${line}\n`),
  };
}

/**
 * Leaves the alternate screen and turns the cursor back on, and mouse reports, focus reports, bracketed paste and
 * the kitty keyboard protocol off. Herdr does this when it detaches, but not when the link drops under it, and
 * without it the shell after attach would read mouse moves and keys as escape sequences.
 */
const screenReset = "\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u";

/** Signals that end an attach from outside, such as a closed terminal window. Each exits 128 plus its number. */
const signals = { SIGHUP: 1, SIGTERM: 15 } as const;

/**
 * Resolves when Herdr exits 0, which is its own detach, and throws a CliError on every other end. Raw mode starts
 * at `attached`, so Ctrl-C still quits while the pylon wakes. `connect` gives a paused WebSocket to the API, as
 * transport.upgrade does.
 */
export async function attachTerminal(connect: (path: string) => Promise<WebSocket>, thread: string, tty: Tty): Promise<void> {
  const { input, output } = tty;
  if (input.isTTY !== true || output.isTTY !== true) throw new CliError("invalid", "attach needs a terminal, and stdin or stdout is not one");
  const size = (): TerminalSize => {
    try {
      return terminalSize(output.columns, output.rows);
    } catch (err) {
      throw new CliError("invalid", `this terminal's size cannot be attached: ${(err as Error).message}`);
    }
  };
  const ws = await connect(attachPath(thread, { size: size(), term: termOf(tty.term) }));

  let raw = false;
  /** Whether Herdr ended the attach itself, and so put back the screen modes it set. */
  let clean = false;
  /** Puts the terminal back as it was. Safe to repeat, and also run when the process exits. */
  const restore = () => {
    if (!raw) return;
    raw = false;
    if (!clean) output.write(screenReset);
    input.setRawMode(false);
  };
  const onResize = () => {
    if (ws.readyState === ws.OPEN) ws.send(encodeMessage({ type: "resize", size: size() }));
  };
  const onKeys = (keys: Buffer) => { ws.send(keys); };
  const onSignal = (signal: keyof typeof signals) => {
    restore();
    ws.close();
    process.exit(128 + signals[signal]);
  };
  process.once("exit", restore);
  for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.once(signal, onSignal);
  output.on("resize", onResize);

  let final: ServerMessage | null = null;
  /** Why the link failed, when it did. */
  let cause: Error | null = null;
  const unwritten = () => {
    // A terminal that takes output slower than Herdr makes it holds the socket, and so Herdr, back.
    ws.pause();
    output.once("drain", () => ws.resume());
  };
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on("error", (err) => { cause ??= err; });
      ws.on("close", () => resolve());
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
          input.setRawMode(true);
          raw = true;
          input.on("data", onKeys);
          input.resume();
          return;
        }
        final = message;
        clean = message.type === "exit" && message.code === 0;
      });
      ws.resume();
    });
  } finally {
    restore();
    output.off("resize", onResize);
    input.off("data", onKeys);
    // So the process can exit once the attach ends.
    input.pause();
    input.unref?.();
    process.off("exit", restore);
    for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.off(signal, onSignal);
  }
  const end = final as ServerMessage | null;
  if (end?.type === "exit") {
    if (end.code === 0) return;
    throw new CliError("failed", `Herdr in the pylon of ${thread} exited ${end.code}`);
  }
  if (end?.type === "error") throw new CliError(end.kind, end.message);
  const why = cause === null ? "" : `: ${(cause as Error).message}`;
  throw new CliError("unreachable", `the connection to the control plane dropped${why}. Herdr keeps the session, so \`nexus attach ${thread}\` again`);
}
