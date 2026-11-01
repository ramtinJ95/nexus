/**
 * Probe contract, byte streams to a process in a pylon's guest.
 *
 * The wire encoding (frames on an upgraded connection) is private to this module. Callers see the domain types below.
 * The probe serves through `parseStreamRequest`, `streamUpgradeResponse` and `serveByteStream`, and the control plane
 * opens through `streamPath`, `streamProtocol` and `clientByteStream`.
 */
import { once } from "node:events";
import { PassThrough, type Duplex } from "node:stream";
import { z } from "zod";
import { parseJson } from "../parse.ts";
import type { PylonId } from "../ids.ts";

/**
 * A stream is a raw pipe to a process in the guest, such as the pi-env daemon. It carries the process's stdout
 * only, and its stderr goes to the probe's log under the pylon's ID, so a diagnostic can never corrupt a framed
 * protocol on stdout. A terminal is a program on a pipe too: guest-terminal.ts makes its pty in the guest.
 *
 * A pipe runs at most once. If the connection drops, the probe ends the guest process's stdin and `done`
 * resolves to `lost`. The pi-env daemon then kills every command it started. A tool call whose pipe was lost
 * fails with pi-env's "connection lost" error, which the model sees as an ordinary error result. pi-durable's
 * `interrupted` result appears only when the harness process itself died mid-call. A terminal's relay hangs up
 * when its stdin ends, so Herdr's client detaches and the session stays.
 */
export type StreamEnd = { kind: "exited"; code: number } | { kind: "lost" };
export interface ByteStream extends AsyncIterable<Uint8Array> {
  write(chunk: Uint8Array): Promise<void>;
  /** Ends the process's stdin. Its output keeps arriving until it exits. */
  close(): Promise<void>;
  /** Drops the stream at once, without waiting for the process, as for a node that stopped answering. `done` follows. */
  abort(): void;
  readonly done: Promise<StreamEnd>;
}

/**
 * GET /v1/pylons/{id}/stream?request={"argv": [...]} upgrades the connection to `nexus-stream`, a sequence of
 * frames: a type byte, a 4-byte big-endian length, then the payload. The control plane sends stdin and end of
 * stdin. The probe sends output, then the exit code as its last frame. A connection that closes without an exit
 * frame is a lost stream. The probe answers 409 instead of upgrading when the pylon is not running, and 504 when its
 * guest does not start the process in time.
 */
export const streamProtocol = "nexus-stream";
// 2 was a resize, which nothing sends since streams lost their pty, so the other numbers stay as older peers know them.
const frameType = { data: 0, eof: 1, exit: 3 } as const;
const maxFrameBytes = 16 << 20;

export function streamPath(pylonId: PylonId, argv: readonly string[]): string {
  return `/v1/pylons/${encodeURIComponent(pylonId)}/stream?request=${encodeURIComponent(JSON.stringify({ argv }))}`;
}

const streamRequestSchema = z.object({
  argv: z.array(z.string()).min(1),
  pty: z.null({ error: "streams are raw pipes only, so a stream request has no pty. A terminal's pty is made in the guest, as guest-terminal.ts does" }).optional(),
});

/** The probe's side of the stream route: `null` unless the request asks to upgrade to `nexus-stream`. Throws with a message for a 400. */
export function parseStreamRequest(upgrade: string | undefined, url: URL): { pylonId: PylonId; argv: readonly string[] } | null {
  const match = /^\/v1\/pylons\/([^/]+)\/stream$/.exec(url.pathname);
  if (match === null || upgrade?.toLowerCase() !== streamProtocol) return null;
  const { argv } = parseJson(streamRequestSchema, url.searchParams.get("request") ?? "null", "request");
  return { pylonId: decodeURIComponent(match[1]!) as PylonId, argv };
}

/** The probe's 504 for a stream whose guest did not start the process within `ms`, and what the person can do about it. */
export function notAnswering(pylonId: PylonId, ms: number): string {
  return `pylon ${pylonId} is not answering: it did not start a process within ${ms / 1000} s. It may be out of memory or busy. Pausing and waking it, as archiving and unarchiving its thread does, gives it a fresh VM`;
}

export const streamUpgradeResponse = `HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: ${streamProtocol}\r\n\r\n`;

/**
 * The probe's side of an upgraded stream: frames from the socket go into `stream`, and its output and exit code
 * go back. When the socket drops first, the process's stdin ends. Resolves once both directions are done.
 */
export async function serveByteStream(socket: Duplex, head: Buffer, stream: ByteStream): Promise<void> {
  const output = (async () => {
    let linked = true;
    // Output keeps being read after the link drops, so a process writing to a full pipe can still see its stdin end.
    for await (const chunk of stream) if (linked) await send(socket, frame(frameType.data, chunk)).catch(() => { linked = false; });
    const end = await stream.done;
    if (end.kind === "exited" && linked) {
      const code = Buffer.alloc(4);
      code.writeInt32BE(end.code);
      await send(socket, frame(frameType.exit, code)).catch(() => undefined);
      socket.end();
    } else {
      socket.destroy();
    }
  })();
  // A process can close its stdin and keep writing output, so a failed write drops input and keeps the socket:
  // leaving the loop would destroy it, and the output and exit code with it.
  let stdin = true;
  try {
    for await (const f of frames(socket, head)) {
      if (f.type === frameType.data) {
        if (stdin) await stream.write(f.payload).catch(() => { stdin = false; });
      } else if (f.type === frameType.eof) {
        await stream.close();
      } else {
        throw new Error(`unexpected stream frame type ${f.type}`);
      }
    }
  } catch {
    // The link broke or broke the protocol, so the input side is over.
  }
  await stream.close();
  await output;
}

export function clientByteStream(socket: Duplex, head: Buffer): ByteStream {
  const output = new PassThrough();
  const done = (async (): Promise<StreamEnd> => {
    let code: number | null = null;
    try {
      for await (const f of frames(socket, head)) {
        if (f.type === frameType.data) {
          if (!output.write(f.payload)) await once(output, "drain");
        } else if (f.type === frameType.exit && f.payload.length === 4) {
          code = f.payload.readInt32BE(0);
        } else {
          throw new Error(`unexpected stream frame type ${f.type}`);
        }
      }
    } catch {
      // The link broke. Without an exit frame that is a lost stream.
    } finally {
      socket.destroy();
      output.end();
    }
    return code === null ? { kind: "lost" } : { kind: "exited", code };
  })();
  return {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>,
    write: (chunk) => send(socket, frame(frameType.data, chunk)),
    close: () => send(socket, frame(frameType.eof, Buffer.alloc(0))),
    abort: () => socket.destroy(),
    done,
  };
}

export function frame(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function* frames(source: AsyncIterable<Buffer>, head: Buffer): AsyncGenerator<{ type: number; payload: Buffer }> {
  let buffered = head;
  function* complete() {
    while (buffered.length >= 5) {
      const length = buffered.readUInt32BE(1);
      if (length > maxFrameBytes) throw new Error(`stream frame of ${length} bytes is over ${maxFrameBytes}`);
      if (buffered.length < 5 + length) return;
      yield { type: buffered[0]!, payload: buffered.subarray(5, 5 + length) };
      buffered = buffered.subarray(5 + length);
    }
  }
  yield* complete();
  for await (const chunk of source) {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    yield* complete();
  }
  if (buffered.length > 0) throw new Error("the stream ended inside a frame");
}

/** Resolves once the bytes are handed to the kernel, which is the stream's backpressure. */
function send(socket: Duplex, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => { socket.write(bytes, (err) => err ? reject(err) : resolve()); });
}
