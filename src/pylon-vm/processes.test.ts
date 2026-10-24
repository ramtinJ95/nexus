import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { VM } from "@earendil-works/gondolin";
import { fakeVm } from "./fake-vm.ts";
import { GuestProcesses } from "./processes.ts";

const outcome = (work: Promise<unknown>, ms = 1_000) =>
	Promise.race([work.then(() => "answered", (err: unknown) => err), delay(ms, "still waiting")]);

test("a status wait on a running command ends as soon as the controller stops, so the stop can settle it", async () => {
	const stopping = new AbortController();
	const processes = new GuestProcesses(fakeVm().vm, stopping.signal);
	const pid = await processes.launch("sleep 600", "/");
	const waiting = processes.status(pid, 60_000);
	await delay(200);
	const reason = new Error("the controller is stopping");
	stopping.abort(reason);
	assert.equal(await outcome(waiting), reason, "the wait went on after the stop, so the stop would close the VM under it or wait out its 60 s");
});

test("a file read that the closing VM never answers ends as soon as the controller stops", async () => {
	const stopping = new AbortController();
	const { vm } = fakeVm();
	let reading = false;
	// Gondolin's file read ends when its signal aborts, and one that reaches a VM as it closes is never answered.
	vm.fs.readFile = (async (path: string, options?: { signal?: AbortSignal }) => {
		if (path.endsWith("/pid")) return "42";
		reading = true;
		const signal = options?.signal;
		return await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
	}) as VM["fs"]["readFile"];
	const processes = new GuestProcesses(vm, stopping.signal);
	const pid = await processes.launch("sleep 600", "/");
	// A status that does not wait goes straight to reading the command's output.
	const waiting = processes.status(pid, 0);
	while (!reading) await delay(10);
	const reason = new Error("the controller is stopping");
	stopping.abort(reason);
	assert.equal(await outcome(waiting), reason, "the read went on after the stop, so the stop would close the VM under it");
});

test("a file write waiting for its turn ends as soon as the controller stops, so it never reaches a closing VM", async () => {
	const stopping = new AbortController();
	const fake = fakeVm((path) => (path.endsWith("/kill") ? "queued" : undefined));
	const processes = new GuestProcesses(fake.vm, stopping.signal);
	const killing = processes.kill(await processes.launch("sleep 600", "/"));
	await fake.holding("/kill");
	stopping.abort(new Error("the controller is stopping"));
	const settled = await outcome(killing);
	assert.ok(settled instanceof Error && settled.message === "operation aborted", `the write went on waiting: ${String(settled)}`);
});
