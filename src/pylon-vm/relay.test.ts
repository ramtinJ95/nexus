import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * A port free on both 127.0.0.1 and ::1, from below every ephemeral range (Linux's starts at 32768, macOS's at 49152).
 * Other test files' listeners on port 0 can then never take its 127.0.0.1 side, where the relay would reach them first.
 */
async function quietPort(): Promise<number> {
	for (;;) {
		const port = 20_000 + Math.floor(Math.random() * 12_000);
		try {
			for (const host of ["127.0.0.1", "::1"]) await closed(await serve(host, "", port));
			return port;
		} catch {}
	}
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

/** Waits for the check. The deadline only ends a hang: a loaded suite can take seconds over what takes milliseconds alone. */
async function until(what: string, check: () => Promise<boolean>) {
	const deadline = Date.now() + 60_000;
	while (!await check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
		await delay(100);
	}
}

test("the relay carries a route's port to 127.0.0.1 or else ::1, follows its server across addresses without holding its port, reports the relay ports it holds and those it cannot, lets a relay port go when the map drops it, and caps its log as it runs", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nexus-relay-"));
	const map = join(dir, "relays.json");
	const statusFile = join(dir, "relay-status.json");
	const logFile = join(dir, "relay.log");
	await writeFile(logFile, "x".repeat(1048577));
	/** Written aside and renamed in, as writeRelayMap does. */
	const relays = async (generation: number, entries: Record<number, number>) => {
		await writeFile(`${map}.new`, JSON.stringify({ generation, relays: entries }));
		await rename(`${map}.new`, map);
	};
	const status = async () => JSON.parse(await readFile(statusFile, "utf8").catch(() => '{"generation":0}')) as { generation: number; bound: Record<string, number>; failed: Record<string, string> };
	const applied = (generation: number) => until(`the relay applies map ${generation}`, async () => (await status()).generation >= generation);
	const v6 = await serve("::1", "v6", await quietPort());
	const relayPort = await quietPort();
	await relays(1, { [relayPort]: v6.port });
	const relay = spawn("python3", ["-c", relayScript, map, statusFile, logFile], { stdio: ["ignore", "inherit", "inherit"] });
	const logged = async (line: string) => (await readFile(logFile, "utf8")).includes(`${line}\n`);
	const servers: Server[] = [v6];
	t.after(async () => {
		relay.kill();
		for (const server of servers) server.close();
		await rm(dir, { recursive: true, force: true });
	});

	await applied(1);
	assert.deepEqual(await status(), { generation: 1, bound: { [relayPort]: v6.port }, failed: {} });
	assert.equal(await get(relayPort), "v6", "the relay port answers from the server on ::1");
	assert.ok(await logged(`relaying 127.0.0.1:${relayPort} to port ${v6.port}`));
	assert.equal((await stat(`${logFile}.previous`)).size, 1048577, "a log past 1 MiB was moved aside at the start");
	assert.ok((await stat(logFile)).size < 1024, "and a new one begun");

	// Something else holds a relay port, as only root could in the guest, and the log passes 1 MiB while the relay runs.
	const held = await serve("127.0.0.1", "held");
	servers.push(held);
	await appendFile(logFile, "y".repeat(1048577));
	await relays(2, { [relayPort]: v6.port, [held.port]: v6.port });
	await applied(2);
	const second = await status();
	assert.deepEqual(second.bound, { [relayPort]: v6.port }, "a relay port the relay cannot listen on is not reported as held");
	assert.match(second.failed[held.port] ?? "", /in use/i);
	assert.equal(await get(held.port), "held", "its holder still answers it");
	assert.ok(await logged(`cannot relay 127.0.0.1:${held.port}: ${second.failed[held.port]}`));
	assert.ok((await readFile(`${logFile}.previous`, "utf8")).endsWith("y".repeat(1048577)), "the running relay moved the full log aside before its next line");
	assert.ok((await stat(logFile)).size < 1024);

	const v4 = await serve("127.0.0.1", "v4", v6.port);
	servers.push(v4);
	assert.equal(await get(relayPort), "v4", "a server on 127.0.0.1 is preferred, as the ingress alone would reach it");
	await closed(v4);
	assert.equal(await get(relayPort), "v6", "and once it stops, the one on ::1 answers again");

	await closed(v6);
	const moved = await serve("0.0.0.0", "moved", v6.port);
	servers.push(moved);
	assert.equal(await get(relayPort), "moved", "the server moved from ::1 to 0.0.0.0 on the same port, which the relay never held");

	await relays(3, {});
	await applied(3);
	assert.deepEqual(await status(), { generation: 3, bound: {}, failed: {} });
	assert.equal(await get(relayPort), "ECONNREFUSED", "the relay port is let go");
	assert.ok(await logged(`stopped relaying 127.0.0.1:${relayPort} to port ${v6.port}`));
});
