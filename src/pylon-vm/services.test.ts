import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VM } from "@earendil-works/gondolin";
import { execFile } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema, type BootSpec, type SandboxRecord } from "./contracts.ts";
import { lifecycleQueue, SandboxRuntime } from "./runtime.ts";
import { answersScript, GuestServices } from "./services.ts";

/**
 * A VM whose ingress is never dialled here, the prefixes of the routes set on it and the port each points at, and the
 * relay maps written to its guest. Its guest has the services
 * file `file` holds, none while undefined, and runs a service from its launch until its stop, unless `exits` holds,
 * as for a service whose cwd is missing. Every port listens while `listening` holds, every new port asked for is the
 * next from 41000, and every other command succeeds.
 */
function fakeVm() {
	const routes: string[][] = [];
	const targets: Record<string, number>[] = [];
	const relayMaps: Record<string, number>[] = [];
	const running = new Set<string>();
	const launches: string[] = [];
	const scripts = new Map<string, string>();
	const guest = { file: undefined as string | undefined, listening: true, exits: false };
	let nextPort = 41000;
	const service = (command: string) => /services\/([a-z0-9-]+)\.pid/.exec(command)![1]!;
	const vm = {
		async enableIngress() {
			return { url: "http://127.0.0.1:9/" };
		},
		setIngressRoutes(set: { prefix: string; port: number }[]) {
			routes.push(set.map((route) => route.prefix));
			targets.push(Object.fromEntries(set.map((route) => [route.prefix, route.port])));
		},
		async exec(argv: string[], options: { stdout: Writable }) {
			const command = argv[3]!;
			let exitCode = 0;
			const relayMap = /relays\.json\.new' && mv /.test(command) ? /printf '%s' '([^']*)'/.exec(command) : null;
			if (relayMap) relayMaps.push(JSON.parse(relayMap[1]!));
			if (command.startsWith("test -e")) exitCode = guest.file === undefined ? 1 : 0;
			else if (command.includes("connect_ex")) options.stdout.write(guest.listening ? "True\n" : "False\n");
			else if (command.includes("getsockname")) options.stdout.write(`${nextPort++}\n`);
			else if (command.startsWith("test -f")) exitCode = running.has(service(command)) ? 0 : 1;
			else if (command.startsWith("if test -f")) running.delete(service(command));
			else if (command.startsWith("setsid")) {
				if (!guest.exits) running.add(service(command));
				launches.push(service(command));
			}
			return { exitCode: 0, stderr: JSON.stringify({ state: "exited", exitCode }) };
		},
		fs: {
			async stat() {
				return { size: Buffer.byteLength(guest.file!) };
			},
			async readFile() {
				return guest.file!;
			},
			async writeFile(path: string, content: string) {
				scripts.set(/([a-z0-9-]+)\.sh$/.exec(path)![1]!, content);
			},
		},
	};
	return { vm: vm as unknown as VM, routes, targets, relayMaps, running, launches, scripts, guest };
}

test("every route points at a relay port of Nexus's own, which the relay map carries to the routed port, a port keeps its relay port while it stays routed, and a freed one waits its turn", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const fake = fakeVm();
	const services = new GuestServices(fake.vm, dir, "/workspace/repo/.nexus/services.yaml", "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.attach(3000);
	await services.attach(3001);
	assert.deepEqual(fake.targets.at(-1), { "/port-3000/": 700, "/port-3001/": 701 });
	assert.deepEqual(fake.relayMaps.at(-1), { 700: 3000, 701: 3001 });
	await services.detach(3000);
	assert.deepEqual(fake.targets.at(-1), { "/port-3001/": 701 }, "3001 keeps its relay port");
	assert.deepEqual(fake.relayMaps.at(-1), { 701: 3001 });
	const written = fake.relayMaps.length;
	await services.attach(3001);
	assert.equal(fake.relayMaps.length, written, "an unchanged map is not written again");
	await services.attach(3002);
	assert.deepEqual(fake.relayMaps.at(-1), { 701: 3001, 702: 3002 }, "700 is not taken again while another is free, because the relay may still forward it to 3000");
	await assert.rejects(services.attach(700), { message: /^Port 700 is Nexus's own/ }, "a relay port is never previewed itself");
});

test("a declaration that fixes one of Nexus's ports is refused, and a service without a preview takes no route", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const fake = fakeVm();
	fake.guest.file = declared("  web:\n    command: serve\n    port: 700\n    preview: true\n");
	const services = new GuestServices(fake.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.initialize();
	await assert.rejects(services.operate("ensure"), /is Nexus's own: sshd's 22, or the preview relay's 700 to 799/);
	assert.deepEqual(fake.launches, []);
	assert.throws(() => configSchema.parse({ services: { api: { command: "serve", port: 22 } } }), /is Nexus's own/, "nor can an ad hoc service, whose start the same schema parses");
	fake.guest.file = declared("  web:\n    command: serve\n    port: 3000\n    preview: true\n  worker:\n    command: work\n    port: 3001\n");
	await services.operate("ensure");
	assert.deepEqual(fake.targets.at(-1), { "/web/": 700 }, "worker has no preview, so it needs no relay port");
});

test("a wake drops restored ports that are Nexus's own and routes the rest, rather than failing", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const logged = t.mock.method(console, "log", () => {});
	await writeFile(join(root, "linked.json"), JSON.stringify([700, 3000]));
	await writeFile(join(root, "adhoc.json"), JSON.stringify({ api: { command: "serve", port: 22 }, jobs: { command: "work" } }));
	await writeFile(join(root, "services.json"), JSON.stringify({ old: { port: 750 } }));
	const fake = fakeVm();
	const services = new GuestServices(fake.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.initialize();
	assert.deepEqual(fake.targets.at(-1), { "/port-3000/": 700 });
	assert.deepEqual(logged.mock.calls.map((call) => call.arguments[0]), [
		"services: old's saved port 750 is Nexus's own: sshd's 22, or the preview relay's 700 to 799, so it gets another",
		"services: ad hoc service api is not restored: services.api.port is Nexus's own: sshd's 22, or the preview relay's 700 to 799",
		"services: linked port 700 is Nexus's own: sshd's 22, or the preview relay's 700 to 799, so it is not routed",
	]);
});

test("a port past the relay's 100 is refused before anything is saved, and a wake that restores more than 100 routes 100 and still runs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const logged = t.mock.method(console, "log", () => {});
	const fake = fakeVm();
	const services = new GuestServices(fake.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	for (let port = 3000; port < 3100; port++) await services.attach(port);
	const full = /because every relay port from 700 to 799 serves another preview\. Unpublish one first/;
	await assert.rejects(services.attach(3100), { message: new RegExp(`^Port 3100 cannot be previewed, ${full.source}`) });
	assert.equal(JSON.parse(await readFile(join(root, "linked.json"), "utf8")).length, 100, "3100 was not saved");
	assert.equal(Object.keys(fake.targets.at(-1)!).length, 100);
	fake.guest.file = declared("  web:\n    command: serve\n    port: 3200\n    preview: true\n");
	await assert.rejects(services.operate("ensure"), { message: new RegExp(`^Port 3200 cannot be previewed, ${full.source}`) });
	assert.equal(JSON.parse(await readFile(join(root, "services.json"), "utf8")).web, undefined, "web was not saved");
	await services.close();

	await writeFile(join(root, "linked.json"), JSON.stringify(Array.from({ length: 101 }, (_, i) => 3000 + i)));
	const woken = fakeVm();
	const again = new GuestServices(woken.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => again.close());
	await again.initialize();
	assert.equal(Object.keys(woken.targets.at(-1)!).length, 100);
	assert.equal(woken.targets.at(-1)!["/port-3100/"], undefined);
	assert.ok(logged.mock.calls.some((call) => call.arguments[0] === "services: port 3100 is not routed, because every relay port from 700 to 799 serves another preview"));
});

test("a reserved port is refused, and a linked port is saved before it is acknowledged, so a retry after a failed save saves it, and a fresh boot routes it again", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "instance");
	const services = (vm: VM) => new GuestServices(vm, dir, "/workspace/repo/.nexus/services.yaml", "/workspace/repo", "agent", {});
	const first = services(fakeVm().vm);
	await assert.rejects(first.attach(22), /Port 22 is Nexus's own/, "the in-pylon preview refuses it too");
	await assert.rejects(first.attach(3000), { code: "ENOENT" }, "the state directory is missing, so the save fails");
	await mkdir(dir);
	assert.equal(await first.attach(3000), "port-3000");
	assert.deepEqual(JSON.parse(await readFile(join(dir, "linked.json"), "utf8")), [3000]);
	await first.close();

	const woken = fakeVm();
	const second = services(woken.vm);
	await second.initialize();
	assert.deepEqual(woken.routes.at(-1), ["/port-3000/"]);
	await second.close();
});

test("an unlinked port is saved before it stops counting as linked, unlinking again changes nothing, and a fresh boot leaves it out", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "instance");
	await mkdir(dir);
	const services = (vm: VM) => new GuestServices(vm, dir, "/workspace/repo/.nexus/services.yaml", "/workspace/repo", "agent", {});
	const first = fakeVm();
	const running = services(first.vm);
	await running.attach(3000);
	await running.attach(4000);
	await rm(dir, { recursive: true });
	await assert.rejects(running.detach(3000), { code: "ENOENT" }, "the state directory is missing, so the save fails");
	assert.deepEqual(Object.keys(running.urls()), ["port-3000", "port-4000"], "a failed save leaves the port linked");
	await mkdir(dir);
	await running.detach(3000);
	assert.deepEqual(JSON.parse(await readFile(join(dir, "linked.json"), "utf8")), [4000]);
	assert.deepEqual(first.routes.at(-1), ["/port-4000/"]);
	assert.deepEqual(Object.keys(running.urls()), ["port-4000"]);
	assert.deepEqual((await running.operate("status")).map((f) => f.name), ["port-4000"]);
	await running.detach(3000);
	await running.detach(5000);
	assert.deepEqual(JSON.parse(await readFile(join(dir, "linked.json"), "utf8")), [4000], "a port that is not linked is left as it is");
	await running.close();

	const woken = fakeVm();
	const second = services(woken.vm);
	await second.initialize();
	assert.deepEqual(woken.routes.at(-1), ["/port-4000/"]);
	await second.attach(3000);
	assert.deepEqual(woken.routes.at(-1), ["/port-4000/", "/port-3000/"], "the port can be linked again");
	await second.close();
});

test("a port a service's preview owns is refused, naming the service, and stays previewed", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { vm, routes } = fakeVm();
	const services = new GuestServices(vm, root, "/workspace/repo/.nexus/services.yaml", "/workspace/repo", "agent", {});
	t.after(() => services.close());
	const { web, worker } = configSchema.parse({
		services: { web: { command: "serve", port: 3000, preview: true }, worker: { command: "work", port: 3001 } },
	}).services;
	await services.adHoc("web", web!);
	await services.adHoc("worker", worker!);
	assert.equal(await services.detach(3000), "Port 3000 is the preview of service web, not a linked port. An ad hoc service keeps its preview");
	assert.deepEqual(Object.keys(services.urls()), ["web"]);
	assert.equal(await services.detach(3001), null);
	assert.deepEqual(routes.at(-1), ["/web/"], "a service's port without a preview has nothing to unlink, nor a route");
});

test("a port whose linked name a service holds is refused, so its caller leaves that service's preview alone", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { vm, routes } = fakeVm();
	const services = new GuestServices(vm, root, "/workspace/repo/.nexus/services.yaml", "/workspace/repo", "agent", {});
	t.after(() => services.close());
	const { "port-6006": named } = configSchema.parse({ services: { "port-6006": { command: "serve", port: 3000, preview: true } } }).services;
	await services.adHoc("port-6006", named!);
	assert.equal(await services.detach(6006), "Service port-6006 is not a linked port, so port 6006 has no linked preview to unpublish. Rename the service");
	assert.deepEqual([Object.keys(services.urls()), routes.at(-1)], [["port-6006"], ["/port-6006/"]]);
});

const configPath = "/workspace/repo/.nexus/services.yaml";
const declared = (services: string) => `services:\n${services}`;
/** Waits for the service's reported state, as the probe's reads would see it change. */
async function until(services: GuestServices, name: string, state: string) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const fact = (await services.operate("status", name))[0];
		if (fact?.state === state) return;
		if (Date.now() > deadline) assert.fail(`${name} is ${fact?.state}, not ${state}`);
		await delay(50);
	}
}

test("a service declared with a preview while the pylon runs is reported with its port, route and portal, and starts once its URL is assigned, unless stopped", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const guest = fakeVm();
	const services = new GuestServices(guest.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.initialize();
	guest.guest.file = declared("  web:\n    command: serve\n    preview: true\n  finder:\n    command: open .\n    preview: true\n    platforms: [darwin]\n");
	const web = { name: "web", state: "stopped", port: 41000, declared: true, wantsPreview: true };
	assert.deepEqual(await services.operate("status"), [web], "a service the Linux guest excludes is not reported");
	assert.deepEqual([guest.routes.at(-1), Object.keys(services.urls())], [["/web/"], ["web"]]);
	assert.deepEqual(await services.operate("status"), [web], "the port sticks");
	assert.deepEqual(JSON.parse(await readFile(join(root, "services.json"), "utf8")).web.port, 41000);
	assert.deepEqual(guest.launches, [], "it waits for its preview's URL");

	await services.setPublicUrls({ web: "https://node.example:10100" });
	assert.deepEqual(guest.launches, ["web"]);
	assert.match(guest.scripts.get("web")!, /^export PUBLIC_URL='https:\/\/node\.example:10100'$/m);
	await until(services, "web", "ready");

	await services.operate("stop", "web");
	await services.setPublicUrls({ web: "https://node.example:10101" });
	assert.deepEqual(guest.launches, ["web"], "a service stopped on purpose stays stopped");
	assert.deepEqual(await services.operate("status"), [web]);
	await services.operate("ensure");
	assert.deepEqual(guest.launches, ["web", "web"], "ensure starts it again");
});

test("a service declared without a preview while the pylon runs starts when a status first reports it, and only then", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const guest = fakeVm();
	const services = new GuestServices(guest.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.initialize();
	await services.operate("ensure");
	guest.guest.file = declared("  worker:\n    command: work\n    health: process\n");
	await services.operate("status");
	assert.deepEqual(guest.launches, ["worker"]);
	await until(services, "worker", "ready");
	await services.operate("stop", "worker");
	await services.operate("status");
	await services.setPublicUrls({});
	assert.deepEqual(guest.launches, ["worker"], "a status or new URLs do not start it again once stopped");
});

test("a start does not wait for health: ensure and new URLs return at once, the service is starting, and it fails after its timeout", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const logged = t.mock.method(console, "log", () => {});
	const guest = fakeVm();
	guest.guest.listening = false;
	guest.guest.file = declared("  web:\n    command: sleep infinity\n    port: 3000\n    preview: true\n    timeoutMs: 1000\n");
	const services = new GuestServices(guest.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.initialize();
	const began = Date.now();
	assert.deepEqual((await services.operate("ensure")).map((f) => f.state), ["starting"]);
	await services.setPublicUrls({ web: "https://node.example:10100" });
	assert.deepEqual(guest.launches, ["web", "web"], "the new URL restarted it");
	assert.equal(
		await services.detach(3000),
		"Port 3000 is the preview of service web, not a linked port. Remove the preview from /workspace/repo/.nexus/services.yaml to unpublish it",
	);
	assert.ok(Date.now() - began < 1000, "nothing waited for the service's timeout");
	assert.equal((await services.operate("status"))[0]!.state, "starting");
	await until(services, "web", "failed");
	assert.ok(Date.now() - began >= 1000);
	assert.deepEqual(logged.mock.calls.map((call) => call.arguments[0]), [
		"services: web failed: Service web started but is not responding. Read logs, then restart or stop it",
	], "the restart's start replaced the first's watch, so it fails once");
});

test("a start whose process exits at once is starting until its timeout fails it, not stopped", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	t.mock.method(console, "log", () => {});
	const guest = fakeVm();
	guest.guest.listening = false;
	guest.guest.exits = true;
	guest.guest.file = declared("  web:\n    command: serve\n    cwd: missing\n    port: 3000\n    timeoutMs: 500\n");
	const services = new GuestServices(guest.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.initialize();
	assert.deepEqual((await services.operate("ensure")).map((f) => f.state), ["starting"]);
	await until(services, "web", "failed");
	await services.operate("stop", "web");
	assert.equal((await services.operate("status"))[0]!.state, "stopped");
});

test("an unpreview sent to the controller during an ensure of a service that never answers is answered at once", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "nexus-services-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	t.mock.method(console, "log", () => {});
	const guest = fakeVm();
	guest.guest.listening = false;
	guest.guest.file = declared("  web:\n    command: sleep infinity\n    port: 3000\n    preview: true\n");
	const services = new GuestServices(guest.vm, root, configPath, "/workspace/repo", "agent", {});
	t.after(() => services.close());
	await services.initialize();
	const record = { name: "pylon-q", createdAt: "2027-01-01T00:00:00.000Z", labels: {}, config: { diskGiB: 8, workspace: "/workspace" } } as unknown as SandboxRecord;
	const spec = { resources: { cpus: 1, memoryGiB: 1 } } as BootSpec;
	const runtime = new SandboxRuntime(root, record, spec, { vm: guest.vm, settleMs: 0, services });
	const queue = lifecycleQueue();
	const began = Date.now();
	const ensure = queue.run(() => runtime.handle({ action: "services", name: "pylon-q", op: "ensure" }));
	const unpreview = queue.run(() => runtime.handle({ action: "unpreview", name: "pylon-q", port: 3000 }));
	assert.deepEqual(((await ensure) as { state: string }[]).map((f) => f.state), ["starting"]);
	assert.deepEqual(await unpreview, { refused: "Port 3000 is the preview of service web, not a linked port. Remove the preview from /workspace/repo/.nexus/services.yaml to unpublish it" });
	assert.ok(Date.now() - began < 5000, "neither waited for the service's 30 s timeout");
});

/** What the guest's health check prints for the port, and the path if given, and how long it took. */
function answers(port: number, path?: string): Promise<{ answer: string; ms: number }> {
	const began = Date.now();
	return new Promise((accept, reject) =>
		execFile("python3", ["-c", answersScript, String(port), ...(path === undefined ? [] : [path])], (error, stdout) =>
			error ? reject(error) : accept({ answer: stdout.trim(), ms: Date.now() - began })),
	);
}
/** Answers 200, 302 or 503 by path, and 421 to a Host that is not its own address, as Vite's host check would. */
async function healthServer(host: string): Promise<Server & { port: number; hosts: string[] }> {
	const hosts: string[] = [];
	const server = createHttpServer((req, res) => {
		hosts.push(req.headers.host ?? "");
		const own = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
		res.statusCode = req.headers.host !== own ? 421 : req.url === "/ok" ? 200 : req.url === "/moved" ? 302 : 503;
		res.end();
	});
	await new Promise<void>((accept, reject) => server.once("error", reject).listen(0, host, accept));
	const port = (server.address() as { port: number }).port;
	return Object.assign(server, { port, hosts });
}

test("the health check asks the port itself on 127.0.0.1 or else ::1, as its own Host, wants a 2xx or 3xx, and gives up after 2 s in all", async (t) => {
	const v6 = await healthServer("::1");
	const v4 = await healthServer("127.0.0.1");
	// Sends its status line a byte at a time, each well within a socket timeout, and never finishes.
	const trickle = createTcpServer((socket) => {
		const bytes = Buffer.from("HTTP/1.1 200 OK\r\nX-Slow: " + "y".repeat(100));
		let sent = 0;
		const timer = setInterval(() => sent < bytes.length ? socket.write(bytes.subarray(sent, ++sent)) : socket.end(), 300);
		socket.on("close", () => clearInterval(timer)).on("error", () => {});
	});
	await new Promise<void>((accept) => trickle.listen(0, "127.0.0.1", accept));
	t.after(() => {
		v6.close();
		v4.close();
		trickle.close();
	});
	const slow = (trickle.address() as { port: number }).port;

	assert.equal((await answers(v6.port)).answer, "True", "a port on ::1 alone listens");
	assert.equal((await answers(v6.port, "/ok")).answer, "True");
	assert.equal((await answers(v6.port, "/moved")).answer, "True", "a redirect is not followed, and counts as healthy");
	assert.equal((await answers(v6.port, "/down")).answer, "False");
	assert.deepEqual(new Set(v6.hosts), new Set([`[::1]:${v6.port}`]), "it asked ::1 as its own Host");
	assert.equal((await answers(v4.port, "/ok")).answer, "True");
	assert.deepEqual(new Set(v4.hosts), new Set([`127.0.0.1:${v4.port}`]));
	const { answer, ms } = await answers(slow, "/");
	assert.equal(answer, "False", "a response that trickles in is not healthy");
	assert.ok(ms < 3500, `it gave up after 2 s, not each socket read's, but took ${ms} ms`);
	v6.close();
	assert.equal((await answers(v6.port)).answer, "False", "a port nothing listens on does not");
});
