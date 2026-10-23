import http from "node:http";
import { join } from "node:path";
import type { HttpHooks } from "@earendil-works/gondolin";

/** The host the guest's NEXUS_API names. It never leaves the node, so no allowlist entry or DNS name is needed. */
export const bridgeHost = "nexus.pylon";

/** Set by the controller, never taken from the guest: the instance whose VM the request came through. */
export const bridgePylonHeader = "x-nexus-pylon";

/** Where the probe listens for the controllers' forwarded requests. Under the private state root, so only the probe's user reaches it. */
export const hostBridgeSocket = (stateRoot: string): string => join(stateRoot, "host-bridge.sock");

/**
 * Answers every request to the bridge host by forwarding it to the probe's socket with the instance name
 * attached, so the guest holds no token. Gondolin runs this hook before its allowlist and IP checks, and a
 * returned Response short-circuits both. Only the method, path, body and content type are forwarded: a guest
 * header can never pose as the controller's. Other hosts fall through to the allowlist and secret substitution.
 */
export function hostBridgeHook(socket: string, instance: string): NonNullable<HttpHooks["onRequest"]> {
	return async (request) => {
		const url = new URL(request.url);
		if (url.hostname !== bridgeHost) return undefined;
		const body = Buffer.from(await request.arrayBuffer());
		const headers: http.OutgoingHttpHeaders = {
			[bridgePylonHeader]: instance,
			"content-length": body.length,
		};
		const type = request.headers.get("content-type");
		if (type !== null) headers["content-type"] = type;
		try {
			const reply = await forward(socket, {
				method: request.method,
				path: url.pathname + url.search,
				headers,
				body,
			});
			return new Response(reply.body, {
				status: reply.status,
				headers: { "content-type": reply.contentType },
			});
		} catch (error) {
			return new Response(
				`the probe on this node is not answering ${bridgeHost}: ${error instanceof Error ? error.message : String(error)}\n`,
				{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
			);
		}
	};
}

function forward(
	socketPath: string,
	request: { method: string; path: string; headers: http.OutgoingHttpHeaders; body: Buffer },
): Promise<{ status: number; contentType: string; body: Buffer }> {
	return new Promise((accept, reject) => {
		const req = http.request(
			{ socketPath, method: request.method, path: request.path, headers: request.headers },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					accept({
						status: res.statusCode!,
						contentType: res.headers["content-type"] ?? "application/octet-stream",
						body: Buffer.concat(chunks),
					}),
				);
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end(request.body);
	});
}
