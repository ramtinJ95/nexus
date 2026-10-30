import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { VM } from "@earendil-works/gondolin";
import { fakeVm, fileNotFound } from "./fake-vm.ts";
import { GuestProcesses } from "./processes.ts";

/** The work's error, or "answered". The deadline only ends a hang: a loaded suite can take seconds over what takes milliseconds alone. */
const outcome = (work: Promise<unknown>) =>
	Promise.race([work.then(() => "answered", (err: unknown) => err), delay(60_000, "still waiting", { ref: false })]);

test("a status wait on a running command ends as soon as the controller stops, so the stop can settle it", async () => {
	const stopping = new AbortController();
	const fake = fakeVm();
	const processes = new GuestProcesses(fake.vm, stopping.signal);
	const pid = await processes.launch("sleep 600", "/");
	const waiting = processes.status(pid, 60_000);
	while (!fake.reads.some((path) => path.endsWith("/done"))) await delay(10);
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
		if (path.endsWith("/pid")) return Buffer.from("42");
		if (path.endsWith("/done")) throw fileNotFound(path);
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

/**
 * A guest whose command files are `files`, keyed by name, and missing otherwise. `onRead` runs on each read of a file
 * before it answers. It counts the guest commands it runs and the writes of the worker.
 */
function guest(files: Map<string, string>, onRead: (name: string) => void = () => {}) {
	const { vm } = fakeVm();
	const counts = { execs: 0, workerWrites: 0 };
	vm.exec = (async () => {
		counts.execs++;
		return { exitCode: 0, stdout: "", stderr: "" };
	}) as unknown as VM["exec"];
	vm.fs.readFile = (async (path: string) => {
		const name = path.slice(path.lastIndexOf("/") + 1);
		onRead(name);
		const content = files.get(name);
		if (content === undefined) throw fileNotFound(path);
		return Buffer.from(content);
	}) as unknown as VM["fs"]["readFile"];
	vm.fs.writeFile = (async (path: string) => {
		if (path.endsWith("/worker.py")) counts.workerWrites++;
	}) as unknown as VM["fs"]["writeFile"];
	return Object.assign(vm, { counts });
}
const exited = (exitCode: number) => JSON.stringify({ exitCode, truncated: false });

test("a launch and a status of the finished command run one guest command, the launcher, and the worker is written once for two launches", async () => {
	const files = new Map([["pid", "42"], ["output", "hello\n"], ["done", exited(0)]]);
	const vm = guest(files);
	const processes = new GuestProcesses(vm, new AbortController().signal);
	const status = await processes.status(await processes.launch("echo hello", "/"), 0);
	assert.deepEqual(status, { pid: status.pid, running: false, output: "hello\n", exitCode: 0, truncated: false });
	assert.equal(vm.counts.execs, 1, "only the launcher started a guest process");
	await processes.launch("echo again", "/");
	assert.equal(vm.counts.workerWrites, 1);
	assert.equal(vm.counts.execs, 2);
});

test("a command without its done file is still running, with the output so far", async () => {
	const files = new Map([["pid", "42"], ["output", "partial"]]);
	const processes = new GuestProcesses(guest(files), new AbortController().signal);
	const pid = await processes.launch("sleep 600", "/");
	assert.deepEqual(await processes.status(pid, 0), { pid, running: true, output: "partial", truncated: false });
});

test("a read of a command's file that fails for another reason than a missing file fails the status", async () => {
	const files = new Map([["pid", "42"]]);
	const vm = guest(files, (name) => {
		if (name === "output") throw new Error("failed to read guest file: file_read_failed: AccessDenied");
	});
	const processes = new GuestProcesses(vm, new AbortController().signal);
	const pid = await processes.launch("sleep 600", "/");
	await assert.rejects(processes.status(pid, 0), /AccessDenied/);
});

test("a worker whose write failed is written again by the next launch", async () => {
	const vm = guest(new Map([["pid", "42"]]));
	let fail = true;
	vm.fs.writeFile = (async () => {
		vm.counts.workerWrites++;
		if (fail) throw new Error("operation aborted");
	}) as unknown as VM["fs"]["writeFile"];
	const processes = new GuestProcesses(vm, new AbortController().signal);
	await assert.rejects(processes.launch("true", "/"), /operation aborted/);
	fail = false;
	await processes.launch("true", "/");
	assert.equal(vm.counts.workerWrites, 2);
});

test("a command that finishes silently between the launcher's checks for its pid and its end launches and reports its exit", async () => {
	const files = new Map<string, string>();
	const vm = guest(files, (name) => {
		if (name !== "pid" || files.size) return;
		files.set("pid", "42").set("output", "").set("done", exited(0));
	});
	const processes = new GuestProcesses(vm, new AbortController().signal);
	const pid = await processes.launch("herdr pane run", "/");
	const status = await processes.status(pid, 0);
	assert.equal(status.running, false);
	assert.equal(status.exitCode, 0);
});

test("a command the guest could not spawn fails its launch with the exit code and the reason", async () => {
	const files = new Map([
		["done", exited(127)],
		["output", "No such file or directory: 'x'"],
	]);
	const processes = new GuestProcesses(guest(files), new AbortController().signal);
	await assert.rejects(processes.launch("x", "/missing"), /could not start.*127.*No such file or directory: 'x'/s);
});
