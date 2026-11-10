/**
 * One `nexus exec` on the control plane, after the exec route's 101: a raw pipe to `sh -c <line>` in a running pylon,
 * as `ssh host <line>` gives, so Herdr Core can reach the pylon's core with `hc machine add --via 'nexus exec <thread>'`.
 *
 * Binary messages carry bytes both ways untouched. The client's text `{"type":"eof"}` ends the process's stdin. The
 * server ends with one text `{"type":"exit","code":n}` and a close with 1000, or a close with 1011 when the link to
 * the pylon was lost. An exec never wakes a pylon and is not human activity, so a held connection does not keep the
 * pylon from pausing: the route refuses before the 101 unless the pylon runs.
 *
 * The server pings as the attach route does, which keeps a quiet line's link inside the CLI's idle timeout, and drops a
 * client that did not answer the last ping. Input waits in order for the process to take it. Past maxQueuedKeys bytes
 * the socket stops being read until it drains, so a process that reads nothing holds a bounded amount here.
 */
import type { WebSocket } from "ws";
import type { ByteStream } from "../protocol/streams.ts";
import { maxQueuedKeys, type Ending } from "./attach.ts";

export async function serveExec(ws: WebSocket, stream: ByteStream, signal: AbortSignal, pingMs: number): Promise<void> {
  ws.on("error", () => undefined);
  const left = new AbortController();
  ws.on("close", () => left.abort());
  const ended = AbortSignal.any([signal, left.signal]);
  ended.addEventListener("abort", () => stream.abort(), { once: true });
  let answered = true;
  ws.on("pong", () => { answered = true; });
  const ping = setInterval(() => {
    if (!answered) return void ws.terminate();
    answered = false;
    ws.ping();
  }, pingMs);
  let input = Promise.resolve();
  let queued = 0;
  const enqueue = (bytes: number, write: () => Promise<void>) => {
    queued += bytes;
    if (queued > maxQueuedKeys) ws.pause();
    input = input.then(write).catch(() => undefined).finally(() => {
      queued -= bytes;
      if (queued <= maxQueuedKeys && ws.isPaused) ws.resume();
    });
  };
  ws.on("message", (data, binary) => {
    if (binary) {
      const bytes = data as Buffer;
      enqueue(bytes.length, () => stream.write(bytes));
    } else if (data.toString() === '{"type":"eof"}') {
      enqueue(0, () => stream.close());
    } else {
      ws.close(1008, "not an exec message");
    }
  });
  try {
    for await (const chunk of stream) {
      if (ws.readyState === ws.OPEN) await new Promise<void>((resolve) => { ws.send(chunk, { binary: true }, () => resolve()); });
    }
    const end = await stream.done;
    if (ws.readyState !== ws.OPEN) return;
    if (end.kind === "lost") return ws.close(1011, signal.aborted ? (signal.reason as Ending) : "the link to the pylon was lost");
    await new Promise<void>((resolve) => { ws.send(JSON.stringify({ type: "exit", code: end.code }), () => resolve()); });
    ws.close(1000);
  } finally {
    clearInterval(ping);
    // A paused socket would not read the client's answer to the close.
    ws.resume();
  }
}
