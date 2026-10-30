/**
 * Reading from a pylon over a raw pipe: a process the probe runs in the guest, whose stdin and stdout are a stream. A
 * pylon's output is untrusted, so a read is bounded in time and bytes.
 */
import type { ByteStream } from "./protocol.ts";

/** Opens a raw pipe to a process in the pylon, which runs argv. */
export type OpenPipe = (argv: readonly string[]) => Promise<ByteStream>;

/**
 * Reads `source` from stdin and runs it as `__main__`, with `sys.argv` the helper's name and its own arguments. It
 * uses os.read, never sys.stdin.buffer, which would read ahead into what follows the source.
 */
const bootstrap = [
  "import os, sys",
  "name, n = sys.argv[1], int(sys.argv[2])",
  "src = b''",
  "while len(src) < n:",
  "    chunk = os.read(0, n - len(src))",
  "    if not chunk: sys.exit(name + ': stdin ended inside its source')",
  "    src += chunk",
  "sys.argv = [name] + sys.argv[3:]",
  "exec(compile(src, name, 'exec'), {'__name__': '__main__'})",
].join("\n");

/**
 * Runs a Python helper in the pylon. The probe takes a stream's argv in its request's URL, whose length is limited, so
 * argv carries only a bootstrap, and the source goes first on stdin. The rest of stdin is the helper's.
 */
export async function openPython(open: OpenPipe, source: Uint8Array, args: readonly string[], name: string): Promise<ByteStream> {
  const stream = await open(["python3", "-c", bootstrap, name, String(source.length), ...args]);
  // A helper that is already gone fails this write, and `done` says how it ended.
  await stream.write(source).catch(() => undefined);
  return stream;
}

export interface PipeRead {
  deadlineMs: number;
  maxBytes: number;
  /** What the process prints, as in "the pylon did not read <what> within 20 s". */
  what: string;
  okCodes?: readonly number[];
  /** Written to stdin before it ends, within the deadline, since a pylon that never reads it would hold the write. */
  input?: Uint8Array;
}

/**
 * Writes `input`, ends the stream's stdin and reads its whole output. A pipe that is lost, exits with a code outside
 * `okCodes`, passes the deadline or prints past the cap fails, and one that passes the deadline or the cap is dropped.
 */
export async function pipeOutput(stream: ByteStream, { deadlineMs, maxBytes, what, okCodes = [0], input }: PipeRead): Promise<{ code: number; out: Buffer }> {
  const reply = (async () => {
    if (input !== undefined) await stream.write(input);
    await stream.close();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`reading ${what} printed over ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return { end: await stream.done, out: Buffer.concat(chunks) };
  })();
  // A reply that loses the race fails unwatched.
  reply.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the pylon did not read ${what} within ${deadlineMs / 1000} s`)), deadlineMs);
  });
  let result: Awaited<typeof reply>;
  try {
    result = await Promise.race([reply, late]);
  } catch (err) {
    stream.abort();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const { end, out } = result;
  if (end.kind === "lost") throw new Error(`the pipe to the pylon was lost before it read ${what}`);
  if (!okCodes.includes(end.code)) throw new Error(`reading ${what} exited ${end.code}`);
  return { code: end.code, out };
}
