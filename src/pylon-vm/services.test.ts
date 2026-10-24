import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type { Writable } from "node:stream";
import { configSchema } from "./contracts.ts";
import { GuestServices } from "./services.ts";

/**
 * A VM whose ingress is never dialled here, and the prefixes of the routes last set on it. Its guest has no
 * services file, and every other guest command succeeds, with every port listening and every service running.
 */
function fakeVm() {
	const routes: string[][] = [];
	const vm = {
		async enableIngress() {
			return { url: "http://127.0.0.1:9/" };
		},
		setIngressRoutes(set: { prefix: string }[]) {
			routes.push(set.map((route) => route.prefix));
		},
		async exec(argv: string[], options: { stdout: Writable }) {
			const command = argv[3]!;
			if (command.includes("connect_ex")) options.stdout.write("True\n");
			return { exitCode: 0, stderr: JSON.stringify({ state: "exited", exitCode: command.startsWith("test -e") ? 1 : 0 }) };
		},
	};
	return { vm: vm as unknown as VM, routes };
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
