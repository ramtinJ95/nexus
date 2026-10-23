import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VM } from "@earendil-works/gondolin";
import { GuestServices } from "./services.ts";

/** A VM whose ingress is never dialled here, and the prefixes of the routes last set on it. */
function fakeVm() {
	const routes: string[][] = [];
	const vm = {
		async enableIngress() {
			return { url: "http://127.0.0.1:9/" };
		},
		setIngressRoutes(set: { prefix: string }[]) {
			routes.push(set.map((route) => route.prefix));
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
