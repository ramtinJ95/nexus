import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkOptions } from "../../../src/pylon-vm/network.ts";
const { QemuNetworkBackend } = await import(new URL("qemu/net.js", import.meta.resolve("@earendil-works/gondolin")).href);
const undici = (await import("undici/package.json", { with: { type: "json" } })).default.version;
const spec = { resources: { cpus: 2, memoryGiB: 4 }, allowedHosts: ["api.github.com", "127.0.0.1"], secrets: { ECHO_TOKEN: { hosts: ["127.0.0.1"], value: "real-value" } }, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null } as any;
const { httpHooks, placeholders } = networkOptions(spec, "pylon-verify");
const placeholder = placeholders.ECHO_TOKEN!;
const echo = http.createServer(async (req, res) => { let n = 0; for await (const c of req) n += c.length; res.end(`${req.method} ${req.url} got ${n} bytes, auth=${req.headers.authorization ?? "none"}`); });
await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
const port = (echo.address() as AddressInfo).port;
async function send(isIpAllowed: (info: any) => boolean, raw: string, chunks: string[] = []) {
	const backend = new QemuNetworkBackend({ socketPath: "/nonexistent", httpHooks: { ...httpHooks, isIpAllowed } });
	backend.on("error", (e: Error) => console.log("  bridge error:", e.message));
	let text = ""; let end!: () => void; const ended = new Promise<void>((r) => { end = r; });
	backend.stack = { handleTcpData: ({ data }: any) => { text += data.toString("latin1"); }, handleTcpEnd: () => end(), handleTcpError: () => end() };
	backend.tcpSessions.set("k", { srcIP: "192.168.127.3", srcPort: 40000, dstIP: "10.0.0.1", dstPort: 80, protocol: "http", pendingWrites: [], pendingWriteBytes: 0, flowControlPaused: false });
	backend.handleTcpSend({ key: "k", data: Buffer.from(raw) });
	for (const c of chunks) { await new Promise((r) => setTimeout(r, 20)); backend.handleTcpSend({ key: "k", data: Buffer.from(c) }); }
	await ended;
	const split = text.indexOf("\r\n\r\n");
	const head = text.slice(0, split).split("\r\n");
	let body = text.slice(split + 4);
	const chunked = head.some((l) => /^transfer-encoding: chunked$/i.test(l));
	if (chunked) body = body.split("\r\n").filter((_, i) => i % 2 === 1).join("");
	return `${head[0]}, ${chunked ? "chunked" : head.find((l) => /^content-length/i.test(l))} | ${body.trim().slice(0, 90)}`;
}
console.log(`undici ${undici}`);
console.log("GET http://api.github.com/zen (301 to https, real TLS, real DNS, Nexus hooks):\n ", await send(httpHooks!.isIpAllowed!, "GET /zen HTTP/1.1\r\nHost: api.github.com\r\nUser-Agent: nexus-verify\r\n\r\n"));
console.log("POST to a local echo with the secret's placeholder and a body sent in two chunks:\n ", await send(() => true, `POST /upload HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${placeholder}\r\nContent-Length: 10\r\n\r\n`, ["hello", "world"]));
console.log("GET a host outside the allowlist:\n ", await send(httpHooks!.isIpAllowed!, "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"));
echo.close();
