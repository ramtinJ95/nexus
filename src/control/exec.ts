/**
 * One `nexus exec` on the control plane, after the exec route's 101: a raw pipe to `sh -c <line>` in a running pylon,
 * as `ssh host <line>` gives, so Herdr Core can reach the pylon's core with `hc machine add --via 'nexus exec <thread>'`.
 *
 * Binary messages carry bytes both ways untouched. The client's text `{"type":"eof"}` ends the process's stdin. The
 * server ends with one text `{"type":"exit","code":n}` and a close with 1000, or a close with 1011 when the link to
 * the pylon was lost. An exec never wakes a pylon and is not human activity, so a held connection does not keep the
 * pylon from pausing: the route refuses before the 101 unless the pylon runs.
 */
import type { WebSocket } from "ws";
import type { ByteStream } from "../protocol/streams.ts";
import type { Ending } from "./attach.ts";

export async function serveExec(ws: WebSocket, stream: ByteStream, signal: AbortSignal): Promise<void> {
  ws.on("error", () => undefined);
  const left = new AbortController();
  ws.on("close", () => left.abort());
  const ended = AbortSignal.any([signal, left.signal]);
  ended.addEventListener("abort", () => stream.abort(), { once: true });
  let input = Promise.resolve();
  ws.on("message", (data, binary) => {
    if (binary) {
      const bytes = data as Buffer;
      input = input.then(() => stream.write(bytes)).catch(() => undefined);
    } else if (data.toString() === '{"type":"eof"}') {
      input = input.then(() => stream.close()).catch(() => undefined);
    } else {
      ws.close(1008, "not an exec message");
    }
  });
  ws.resume();
  for await (const chunk of stream) {
    if (ws.readyState === ws.OPEN) await new Promise<void>((resolve) => { ws.send(chunk, { binary: true }, () => resolve()); });
  }
  const end = await stream.done;
  if (ws.readyState !== ws.OPEN) return;
  if (end.kind === "lost") return ws.close(1011, signal.aborted ? (signal.reason as Ending) : "the link to the pylon was lost");
  await new Promise<void>((resolve) => { ws.send(JSON.stringify({ type: "exit", code: end.code }), () => resolve()); });
  ws.close(1000);
}
