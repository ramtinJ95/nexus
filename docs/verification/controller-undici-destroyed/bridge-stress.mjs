import http from "node:http";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(`${process.cwd()}/`);
const { QemuNetworkBackend } = await import(new URL("qemu/net.js", pathToFileURL(require.resolve("@earendil-works/gondolin"))));
const undici = require("undici/package.json").version;
const rounds = Number(process.argv[2] ?? 150);
const rnd = (n) => Math.floor(Math.random() * n);

const unhandled = {};
if (!process.argv.includes("--crash")) process.on("unhandledRejection", (e) => {
	const kind = `${e?.name} ${e?.code}`;
	if (!unhandled[kind]) console.error(kind, e.stack.split("\n").slice(0, 2).join(" "));
	unhandled[kind] = (unhandled[kind] ?? 0) + 1;
});

const upstream = http.createServer((req, res) => {
	if (rnd(6) === 0) return setTimeout(() => req.socket.destroy(), rnd(30));
	res.writeHead(200);
	let chunks = 0;
	const t = setInterval(() => { res.write("x"); if (++chunks > rnd(5)) { clearInterval(t); res.end(); } }, rnd(10) + 1);
	res.on("close", () => clearInterval(t));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;

const statuses = {};
let flow = 0;
for (let round = 0; round < rounds; round++) {
	const backend = new QemuNetworkBackend({ socketPath: "/nonexistent", httpHooks: { isIpAllowed: () => rnd(4) !== 0 } });
	backend.on("error", () => {});
	const replies = new Map();
	backend.stack = {
		handleTcpData: ({ key, data }) => { replies.get(key).text += data.toString("latin1"); },
		handleTcpEnd: ({ key }) => replies.get(key)?.end(),
		handleTcpError: ({ key }) => replies.get(key)?.end(),
	};
	await Promise.all(Array.from({ length: 1 + rnd(30) }, async () => {
		await sleep(rnd(20));
		const key = `flow-${++flow}`;
		const ended = new Promise((end) => replies.set(key, { text: "", end }));
		backend.tcpSessions.set(key, { srcIP: "192.168.127.3", srcPort: 40000, dstIP: "10.0.0.1", dstPort: port, protocol: "http", pendingWrites: [], pendingWriteBytes: 0, flowControlPaused: false });
		backend.handleTcpSend({ key, data: Buffer.from(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`) });
		if (rnd(3) === 0) setTimeout(() => { backend.handleTcpClose({ key }); replies.get(key).end(); }, rnd(30));
		await Promise.race([ended, sleep(1000)]);
		const status = replies.get(key).text.slice(9, 12) || "guest closed";
		statuses[status] = (statuses[status] ?? 0) + 1;
	}));
	await sleep(30);
}
upstream.closeAllConnections();
upstream.close();
console.log(JSON.stringify({ undici, rounds, statuses, unhandled }));
