import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema, type BootSpec, type SandboxRecord } from "./contracts.ts";
import { lifecycleQueue, SandboxRuntime } from "./runtime.ts";
import { GuestServices } from "./services.ts";

/**
 * A VM whose ingress is never dialled here, and the prefixes of the routes last set on it. Its guest has the services
 * file `file` holds, none while undefined, and runs a service from its launch until its stop. Every port listens
 * while `listening` holds, every new port asked for is the next from 41000, and every other command succeeds.
 */
function fakeVm() {
	const routes: string[][] = [];
	const running = new Set<string>();
	const launches: string[] = [];
	const scripts = new Map<string, string>();
	const guest = { file: undefined as string | undefined, listening: true };
	let nextPort = 41000;
	const service = (command: string) => /services\/([a-z0-9-]+)\.pid/.exec(command)![1]!;
	const vm = {
		async enableIngress() {
			return { url: "http://127.0.0.1:9/" };
		},
		setIngressRoutes(set: { prefix: string }[]) {
			routes.push(set.map((route) => route.prefix));
		},
		async exec(argv: string[], options: { stdout: Writable }) {
			const command = argv[3]!;
			let exitCode = 0;
			if (command.startsWith("test -e")) exitCode = guest.file === undefined ? 1 : 0;
			else if (command.includes("connect_ex")) options.stdout.write(guest.listening ? "True\n" : "False\n");
			else if (command.includes("getsockname")) options.stdout.write(`${nextPort++}\n`);
			else if (command.startsWith("test -f")) exitCode = running.has(service(command)) ? 0 : 1;
			else if (command.startsWith("if test -f")) running.delete(service(command));
			else if (command.startsWith("setsid")) {
				running.add(service(command));
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
	return { vm: vm as unknown as VM, routes, running, launches, scripts, guest };
}

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
	assert.deepEqual(routes.at(-1), ["/web/", "/worker/"], "a service's port without a preview has nothing to unlink");
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
