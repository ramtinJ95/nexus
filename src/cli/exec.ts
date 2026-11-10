/**
 * `nexus exec <thread> <line>`: runs a shell line in a running pylon with this process's stdin and stdout piped to it
 * untouched, as `ssh host <line>` does, so `hc machine add --via 'nexus exec <thread>' --name <thread>` reaches the
 * pylon's Herdr Core. control/exec.ts is the protocol. Exits with the line's exit code.
 */
import type { WebSocket } from "ws";
import { CliError } from "./transport.ts";

export async function execLine(connect: (path: string) => Promise<WebSocket>, thread: string, line: string): Promise<number> {
  const ws = await connect(`/v1/threads/${encodeURIComponent(thread)}/exec?line=${encodeURIComponent(line)}`);
  return await new Promise<number>((resolve, reject) => {
    let code: number | null = null;
    ws.on("message", (data, binary) => {
      if (binary) {
        if (!process.stdout.write(data as Buffer)) {
          ws.pause();
          process.stdout.once("drain", () => ws.resume());
        }
        return;
      }
      const message = JSON.parse(data.toString()) as { type: string; code?: number };
      if (message.type === "exit") code = message.code!;
    });
    ws.on("error", (err) => reject(err));
    ws.on("close", (status, reason) => {
      process.stdin.pause();
      if (code !== null) resolve(code);
      else reject(new CliError("unreachable", `the exec on ${thread} ended without an exit code (${status}${reason.length > 0 ? `: ${reason.toString()}` : ""})`));
    });
    process.stdin.on("data", (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    });
    process.stdin.on("end", () => {
      if (ws.readyState === ws.OPEN) ws.send('{"type":"eof"}');
    });
    ws.resume();
  });
}
