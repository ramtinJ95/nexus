/**
 * The API's server-sent event streams: a thread's conversation, and the event log's followers.
 */
import type { ServerResponse } from "node:http";
import type { Frames, Watch } from "../conversation-view.ts";
import type { Registry } from "../registry.ts";
import type { Thread } from "../thread-store.ts";
import type { ThreadId } from "../../ids.ts";
import { HttpError } from "../http-error.ts";

type EventBatch = ReturnType<Registry["eventBatch"]>;

/** Streams open at once, across threads and callers. Each holds a watch, and the streams of one thread page share its renders. */
export const maxStreams = 16;
/**
 * Under the CLI's 30 s idle timeout, so a quiet thread's stream stays open. Each ping renders the latest view again
 * first, so what a frame shows of the time, such as how long ago the thread started, stays true.
 */
const pingMs = 15_000;

export function eventStreams(streamStallMs: number) {
  /**
   * Each open stream's and terminal's thread and how to end it, so a delete ends its thread's streams. The event log's
   * followers belong to no thread.
   */
  const open = new Set<{ thread: ThreadId | null; end(): void }>();

  /**
   * Takes one of the streams' places for a server-sent event stream, or refuses with `full`. A client that leaves
   * bytes unread for `streamStallMs` is dropped, and one that still listens connects again. `end` runs once, whichever
   * comes first: the client leaves, `thread` is deleted, or the source ends. The source's `onEnd`, the timer and the
   * place go at once, and the response ends once the client reads what it holds, or is dropped after the stall limit.
   */
  function eventStream(res: ServerResponse, thread: ThreadId | null, full: string, onEnd: () => void = () => {}) {
    if (open.size >= maxStreams) throw new HttpError(503, full);
    let timer: NodeJS.Timeout | undefined;
    let stalled: NodeJS.Timeout | undefined;
    let ended = false;
    const stall = () => { stalled ??= setTimeout(() => res.destroy(), streamStallMs); };
    const end = () => {
      if (ended) return;
      ended = true;
      open.delete(handle);
      clearInterval(timer);
      onEnd();
      res.end();
      if (!res.closed) stall();
    };
    const handle = { thread, end };
    open.add(handle);
    res.on("close", () => {
      clearTimeout(stalled);
      end();
    });
    return {
      get ended() { return ended; },
      end,
      /** For a source that failed to open. Its error reply ends the response. */
      abandon() {
        ended = true;
        open.delete(handle);
      },
      send(text: string) { if (!res.write(text)) stall(); },
      /** Sends the headers, then calls `tick` every `everyMs`, and `drained` each time a client that fell behind catches up. */
      begin(everyMs: number, tick: () => void, drained: () => void) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.on("drain", () => {
          clearTimeout(stalled);
          stalled = undefined;
          drained();
        });
        timer = setInterval(tick, everyMs);
      },
    };
  }

  /**
   * Sends `frames` of each commit to the thread's conversation. A client that reads slowly leaves bytes in the socket:
   * until it drains, commits only replace the view to send, and the next event carries everything since the last one.
   * So the harness's listener never waits on a client.
   */
  async function stream<V>(res: ServerResponse, t: Thread, follow: () => Promise<Watch<V>>, frames: Frames<V>, leave = () => {}) {
    let watch: Watch<V> | null = null;
    const sse = eventStream(res, t.id, `${maxStreams} streams are open, the most this control plane serves at once`, () => {
      void watch?.stop();
      leave();
    });
    try {
      watch = await follow();
    } catch (err) {
      sse.abandon();
      throw err;
    }
    if (sse.ended) return void watch.stop();
    let latest = watch.value;
    let framed: V | undefined;
    /**
     * Whether bytes are on their way, so the stream needs no ping. A view already framed has nothing to send. A view
     * that cannot be rendered ends the stream.
     */
    const flush = () => {
      if (sse.ended || res.writableNeedDrain) return true;
      if (latest === framed) return false;
      framed = latest;
      let frame: unknown;
      try {
        frame = frames(latest);
      } catch (err) {
        res.destroy(err as Error);
        return true;
      }
      if (frame !== null) sse.send(`data: ${JSON.stringify(frame)}\n\n`);
      return frame !== null;
    };
    sse.begin(pingMs, () => { if (!flush()) sse.send(": ping\n\n"); }, flush);
    flush();
    watch.start(async (view) => {
      latest = view;
      flush();
    });
    void watch.closed.then(sse.end);
  }

  /**
   * Sends each event of `first`, then of each later read, as its ID and its data, then the ID of the newest event read
   * as a ping, every second. A client that reads slowly gets the rest of a batch on the first tick after it caught up,
   * from the last event it was sent.
   */
  function followEvents(res: ServerResponse, first: EventBatch, read: (since: string) => EventBatch) {
    const sse = eventStream(res, null, "too many streams");
    let since: string;
    const flush = (batch = read(since)) => {
      for (const event of batch.events) {
        sse.send(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        since = event.id;
        if (res.writableNeedDrain) return;
      }
      since = batch.watermark;
      sse.send(`id: ${since}\n: ping\n\n`);
    };
    sse.begin(1000, () => {
      if (res.writableNeedDrain) return;
      try { flush(); }
      catch { res.destroy(); }
    }, () => {});
    flush(first);
  }

  return { open, stream, followEvents };
}
export type EventStreams = ReturnType<typeof eventStreams>;
