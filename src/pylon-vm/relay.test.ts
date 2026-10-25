import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { relayScript } from "./relay.ts";

async function serve(host: string, body: string, port = 0): Promise<Server & { port: number }> {
	const server = createServer((_req, res) => res.end(body));
	await new Promise<void>((accept, reject) => server.once("error", reject).listen(port, host, accept));
	return Object.assign(server, { port: (server.address() as { port: number }).port });
}
const closed = (server: Server) => new Promise<void>((accept) => server.close(() => accept()));

/** A loopback port nothing listens on, for the relay to take. */
async function freePort(): Promise<number> {
	const server = await serve("127.0.0.1", "");
	await closed(server);
	return server.port;
}

/** One GET to 127.0.0.1, as the ingress dials it: the body, or the connection error's code. */
function get(port: number): Promise<string> {
	return new Promise((accept) => {
		const req = request({ host: "127.0.0.1", port, agent: false, timeout: 2_000 }, (res) => {
			let body = "";
			res.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; }).on("end", () => accept(body));
		});
		req.on("error", (err: NodeJS.ErrnoException) => accept(err.code ?? err.message));
		req.end();
	});
}

async function until(what: string, check: () => Promise<boolean>) {
	const deadline = Date.now() + 5_000;
	while (!await check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
		await delay(100);
	}
}

test("the relay carries a route's port to 127.0.0.1 or else ::1, follows its server across addresses without holding its port, lets a relay port go when the map drops it, and caps its log", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nexus-relay-"));
	const map = join(dir, "relays.json");
	const logFile = join(dir, "relay.log");
	await writeFile(logFile, "x".repeat(1048577));
	/** Written aside and renamed in, as writeRelayMap does. */
	const relays = async (entries: Record<number, number>) => {
		await writeFile(`${map}.new`, JSON.stringify(entries));
		await rename(`${map}.new`, map);
	};
	const v6 = await serve("::1", "v6");
	const relayPort = await freePort();
	await relays({ [relayPort]: v6.port });
	const relay = spawn("python3", ["-c", relayScript, map, logFile], { stdio: ["ignore", "inherit", "inherit"] });
	const logged = async (line: string) => (await readFile(logFile, "utf8")).includes(`${line}\n`);
	const servers: Server[] = [v6];
	t.after(async () => {
		relay.kill();
		for (const server of servers) server.close();
		await rm(dir, { recursive: true, force: true });
	});

	await until(`the relay port answers from the server on ::1`, async () => await get(relayPort) === "v6");
	await until("the relay logs the port", () => logged(`relaying 127.0.0.1:${relayPort} to port ${v6.port}`));
	assert.equal((await stat(`${logFile}.previous`)).size, 1048577, "a log past 1 MiB was moved aside");
	assert.ok((await stat(logFile)).size < 1024, "and a new one begun");

	const v4 = await serve("127.0.0.1", "v4", v6.port);
	servers.push(v4);
	assert.equal(await get(relayPort), "v4", "a server on 127.0.0.1 is preferred, as the ingress alone would reach it");
	await closed(v4);
	assert.equal(await get(relayPort), "v6", "and once it stops, the one on ::1 answers again");

	await closed(v6);
	const moved = await serve("0.0.0.0", "moved", v6.port);
	servers.push(moved);
	assert.equal(await get(relayPort), "moved", "the server moved from ::1 to 0.0.0.0 on the same port, which the relay never held");

	await relays({});
	await until("the relay port is let go", async () => await get(relayPort) === "ECONNREFUSED");
	await until("the relay logs that it let the port go", () => logged(`stopped relaying 127.0.0.1:${relayPort} to port ${v6.port}`));
});
