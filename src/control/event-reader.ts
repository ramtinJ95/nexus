/**
 * Test support: one client of a control-plane event stream, over plain HTTP to loopback. Each event's data is
 * parsed as JSON and queued, so a test takes the events in order as they arrive.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";

export interface EventReader {
  /** The response, once its headers are in. */
  response: Promise<IncomingMessage>;
  /** The next event's data, waiting up to 5 s for it. */
  next(): Promise<any>;
  /**
   * Settles with "end" when the server ends the stream, or "dropped" when the connection closes before its end. A
   * paused reader notices neither until it resumes.
   */
  ended: Promise<"end" | "dropped">;
  /** Stops reading without closing, so the server's writes back up. */
  pause(): void;
  resume(): void;
  close(): void;
}

export function readEvents(port: number, path: string): EventReader {
  const queued: unknown[] = [];
  let wake = () => {};
  const ended = Promise.withResolvers<"end" | "dropped">();
  let res: IncomingMessage | undefined;
  const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, accept: "text/event-stream" } });
  req.on("error", () => {});
  req.on("close", () => ended.resolve("dropped"));
  req.end();
  const response = once(req, "response").then(([r]) => {
    res = r as IncomingMessage;
    res.setEncoding("utf8");
    // A long event's chunks are joined once it is whole: rescanning all that is held on every chunk is quadratic, and
    // under a loaded suite a 16 MiB view then outlasts next()'s wait.
    let held: string[] = [];
    res.on("data", (chunk: string) => {
      const whole = ((held.at(-1) ?? "").slice(-1) + chunk).includes("\n\n");
      held.push(chunk);
      if (!whole) return;
      const blocks = held.join("").split("\n\n");
      held = [blocks.pop()!];
      for (const block of blocks) {
        const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
        if (data.length > 0) queued.push(JSON.parse(data.join("\n")));
      }
      wake();
    });
    res.on("error", () => {});
    res.on("end", () => ended.resolve("end"));
    res.on("close", () => ended.resolve("dropped"));
    return res;
  });
  return {
    response,
    async next() {
      const deadline = Date.now() + 5_000;
      while (queued.length === 0) {
        assert.ok(Date.now() < deadline, `no event on ${path}`);
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
      return queued.shift();
    },
    ended: ended.promise,
    pause() { res?.pause(); },
    resume() { res?.resume(); },
    close() { req.destroy(); },
  };
}
