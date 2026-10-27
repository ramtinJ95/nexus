import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

// Own both ends of upgraded connections. Destroying these tunnels before VM
// checkpoint keeps Gondolin's ingress close from waiting on browser WebSockets.
export async function openPortal(
	upstream: URL,
	prefix: string,
	port = 0,
): Promise<{ url: string; close(): Promise<void> }> {
	const sockets = new Set<Duplex>();
	const server = http.createServer((incoming, response) => {
		const request = http.request(
			{
				hostname: upstream.hostname,
				port: upstream.port,
				method: incoming.method,
				path: `${prefix}${incoming.url ?? "/"}`,
				headers: incoming.headers,
			},
			(result) => {
				response.writeHead(result.statusCode ?? 502, result.headers);
				result.pipe(response);
			},
		);
		request.on("error", () => {
			if (!response.headersSent) response.writeHead(502);
			response.end("Service unavailable");
		});
		incoming.on("aborted", () => request.destroy());
		response.on("close", () => request.destroy());
		incoming.pipe(request);
	});
	server.on("connection", (socket) => track(sockets, socket));
	server.on("upgrade", (request, socket, head) => {
		const backend = net.connect(Number(upstream.port), upstream.hostname);
		backend.on("connect", () => {
			backend.write(
				`${request.method ?? "GET"} ${prefix}${request.url ?? "/"} HTTP/1.1\r\n${Object.entries(
					request.headers,
				)
					.map(
						([key, value]) =>
							`${key}: ${Array.isArray(value) ? value.join(", ") : (value ?? "")}`,
					)
					.join("\r\n")}\r\n\r\n`,
			);
			if (head.length) backend.write(head);
			socket.pipe(backend).pipe(socket);
		});
		tunnel(sockets, socket, backend);
	});
	const listening = await listen(server, port, sockets, "Preview failed to bind localhost");
	return { url: `http://127.0.0.1:${listening.port}`, close: listening.close };
}

export async function openTerminal(
	upstreamPort: number,
): Promise<{ port: number; close(): Promise<void> }> {
	const sockets = new Set<Duplex>();
	const server = net.createServer((socket) => {
		const backend = net.connect(upstreamPort, "127.0.0.1");
		socket.pipe(backend).pipe(socket);
		tunnel(sockets, socket, backend);
	});
	return listen(server, 0, sockets, "Guest terminal failed to bind localhost");
}

function track(sockets: Set<Duplex>, socket: Duplex) {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
}

/** Tracks both ends, and an error or close on either destroys the other. */
function tunnel(sockets: Set<Duplex>, client: Duplex, backend: Duplex) {
	track(sockets, client);
	track(sockets, backend);
	client.on("error", () => backend.destroy());
	backend.on("error", () => client.destroy());
	client.on("close", () => backend.destroy());
	backend.on("close", () => client.destroy());
}

/** Listens on 127.0.0.1. close() destroys every tracked socket first, so it never waits on an open connection. */
async function listen(
	server: net.Server,
	port: number,
	sockets: Set<Duplex>,
	unbound: string,
): Promise<{ port: number; close(): Promise<void> }> {
	await new Promise<void>((accept, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", accept);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error(unbound);
	let closing: Promise<void> | undefined;
	return {
		port: address.port,
		close() {
			if (closing) return closing;
			for (const socket of sockets) socket.destroy();
			closing = new Promise<void>((accept, reject) =>
				server.close((error) => (error ? reject(error) : accept())),
			);
			return closing;
		},
	};
}
