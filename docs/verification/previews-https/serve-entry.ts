// Plain HTTP on the port gets the answer Go's net/http TLS server gives it, which is what tailscale serve runs.
import { createServer as createTcp, connect, type Socket } from "node:net";
import { createServer as createTls, type TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";

export function startServeEntry(publicPort: number, target: number, dir: string) {
  const tls = createTls({ key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) }, (s: TLSSocket) => {
    const up = connect(target, "127.0.0.1");
    s.pipe(up).pipe(s);
    up.on("error", () => s.destroy());
    s.on("error", () => up.destroy());
  });
  const server = createTcp((raw: Socket) => {
    raw.on("error", () => {});
    raw.once("data", (first: Buffer) => {
      if (first[0] !== 0x16) return raw.end("HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n");
      raw.pause();
      raw.unshift(first);
      tls.emit("connection", raw);
    });
  });
  return new Promise<typeof server>((resolve) => server.listen(publicPort, "127.0.0.1", () => resolve(server)));
}
