/** The contract between a backend's host bridge, which carries a pylon's NEXUS_API calls out of its VM or container, and the probe that answers them. */
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { BodyTooLarge, readBody } from "./request-body.ts";
import type { PylonId } from "./ids.ts";

/** One NEXUS_API call, from the pylon the bridge named. A 200 body is JSON, any other is plain text. */
export type HostBridgeAnswer = (pylonId: PylonId, body: string) => Promise<{ status: number; body: string }>;

/** A backend's end of NEXUS_API. The probe starts it once and closes it when it closes. */
export type HostBridge = (answer: HostBridgeAnswer) => Promise<{ close(): Promise<void> }>;

/**
 * An HTTP listener for NEXUS_API calls. `identify` names the calling pylon from what the bridge attached to the
 * request, or returns null for a request no bridge sent, which gets a 404.
 */
export function listenHostBridge(
  at: { path: string } | { host: string; port: number },
  identify: (req: IncomingMessage) => Promise<PylonId | null>,
): HostBridge {
  return async (answer) => {
    const server = createServer((req, res) => {
      const reply = async (): Promise<{ status: number; body: string }> => {
        const pylonId = await identify(req);
        if (pylonId === null) return { status: 404, body: `no route ${req.method} ${req.url}` };
        if (req.method !== "POST") return { status: 405, body: "NEXUS_API takes POST only" };
        return answer(pylonId, await readBody(req));
      };
      reply().then(
        ({ status, body }) => res.writeHead(status, { "content-type": status === 200 ? "application/json" : "text/plain; charset=utf-8" }).end(body),
        (err: unknown) => res.writeHead(err instanceof BodyTooLarge ? 413 : 500, { "content-type": "text/plain; charset=utf-8" }).end((err as Error).message),
      );
    });
    if ("path" in at) server.listen(at.path);
    else server.listen(at.port, at.host);
    await once(server, "listening");
    return {
      close: () => new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    };
  };
}
