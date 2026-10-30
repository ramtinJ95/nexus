/**
 * A terminal in a pylon, such as `nexus attach`'s. Neither backend can give a stream a pty that resizes, because the
 * probe has no terminal of its own, so guest-terminal.py makes the pty in the guest, over an ordinary raw pipe, as
 * checkout-files.py reads the checkout. Any probe serves it, because to the probe it is only `python3 -c`.
 *
 * The relay's source goes in on stdin, ahead of the frames, because the probe takes a stream's argv in its request's
 * URL, whose length is limited. The argv carries only a bootstrap that reads exactly that many bytes and runs them.
 */
import { readFileSync } from "node:fs";
import { frame, type ByteStream, type StreamEnd } from "./protocol.ts";

const relay = readFileSync(new URL("./guest-terminal.py", import.meta.url));
/** os.read, never sys.stdin.buffer, which would read ahead into the frames. */
const bootstrap = [
  "import os, sys",
  "n = int(sys.argv[1])",
  "src = b''",
  "while len(src) < n:",
  "    chunk = os.read(0, n - len(src))",
  "    if not chunk: sys.exit('guest-terminal: stdin ended inside the relay source')",
  "    src += chunk",
  "exec(compile(src, 'guest-terminal.py', 'exec'))",
].join("\n");

const frameType = { keys: 0, resize: 1 } as const;
const maxSide = 9999;

declare const checked: unique symbol;
/** Whole cols and rows from 1 to 9999. Only terminalSize makes one, so a zero size, which Herdr refuses, cannot reach a guest. */
export type TerminalSize = { readonly cols: number; readonly rows: number; readonly [checked]: true };

/** Throws a message naming the bad side. */
export function terminalSize(cols: number, rows: number): TerminalSize {
  for (const [side, n] of [["cols", cols], ["rows", rows]] as const) {
    if (!Number.isInteger(n) || n < 1 || n > maxSide) throw new Error(`${side} must be a whole number from 1 to ${maxSide}, got ${n}`);
  }
  return { cols, rows } as TerminalSize;
}

/** A program on a pty in the guest. Dropping it hangs up, as closing an ssh session does, so Herdr's client detaches and its session stays. */
export interface Terminal extends AsyncIterable<Uint8Array> {
  write(keys: Uint8Array): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  /** Ends the relay's stdin, which hangs up the terminal. Output keeps arriving until the program exits. Safe to repeat. */
  hangUp(): Promise<void>;
  /** Drops the pipe without waiting for the relay, as for a node that stopped answering. The relay hangs up when its stdin ends. */
  abort(): void;
  readonly done: Promise<StreamEnd>;
}

/**
 * `open` opens one raw pipe running argv in the guest, such as `(argv) => probe.stream(pylonId, argv)`. The program's
 * exit code is `done`'s, or 128 plus the signal that ended it. One that cannot start exits 127, and says why on the
 * terminal.
 */
export async function openTerminal(open: (argv: readonly string[]) => Promise<ByteStream>, size: TerminalSize, term: string, program: readonly string[]): Promise<Terminal> {
  const stream = await open(["python3", "-c", bootstrap, String(relay.length), String(size.cols), String(size.rows), term, ...program]);
  // A relay that is already gone fails this write, and `done` says how it ended.
  await stream.write(relay).catch(() => undefined);
  let hungUp: Promise<void> | null = null;
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    write: (keys) => stream.write(frame(frameType.keys, keys)),
    resize(next) {
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(next.cols, 0);
      payload.writeUInt16BE(next.rows, 2);
      return stream.write(frame(frameType.resize, payload));
    },
    hangUp: () => hungUp ??= stream.close(),
    abort: () => stream.abort(),
    done: stream.done,
  };
}
