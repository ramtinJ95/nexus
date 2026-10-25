/**
 * A ByteStream over a local child process, for backends that reach the guest through a CLI: `docker exec -i`
 * for the Docker test double, and `ssh` for pylon VMs. stdin and stdout are the stream, stderr goes to `log`,
 * and a child killed by a signal ends the stream as lost.
 */
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import type { ByteStream, StreamEnd } from "./protocol.ts";

export function processStream(file: string, args: readonly string[], log: (text: string) => void): ByteStream {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.setEncoding("utf8").on("data", log);
  // A write after the child exited fails through its callback, and an unhandled stream error would crash the probe.
  child.stdin.on("error", () => undefined);
  const done = new Promise<StreamEnd>((resolve) => {
    child.on("error", (err) => {
      log(`${file}: ${err.message}`);
      resolve({ kind: "lost" });
    });
    child.on("close", (code) => resolve(code === null ? { kind: "lost" } : { kind: "exited", code }));
  });
  return {
    [Symbol.asyncIterator]: () => child.stdout[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>,
    write: (chunk) => new Promise((resolve, reject) => { child.stdin.write(chunk, (err) => err ? reject(err) : resolve()); }),
    async close() {
      // end()'s own callback never runs on a stdin that a write after exit already destroyed.
      child.stdin.end();
      await finished(child.stdin).catch(() => undefined);
    },
    done,
  };
}
