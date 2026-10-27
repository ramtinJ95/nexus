import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { VM } from "@earendil-works/gondolin";
import { fakeVm } from "./fake-vm.ts";
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
	while (!fake.commands.some((command) => command.endsWith("/done'"))) await delay(10);
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

/** A guest whose command files are `files`, keyed by name. `onCheck` runs on each `test -e` of a file before it answers. */
function guest(files: Map<string, string>, onCheck: (name: string) => void = () => {}) {
	const { vm } = fakeVm();
	vm.exec = (async (argv: string[]) => {
		const path = /^test -e '(.*)'$/.exec(argv[3]!)?.[1];
		const name = path?.slice(path.lastIndexOf("/") + 1);
		const exitCode = name === undefined || files.has(name) ? 0 : 1;
		if (name !== undefined) onCheck(name);
		return { exitCode: 0, stdout: "", stderr: JSON.stringify({ state: "exited", exitCode }) };
	}) as unknown as VM["exec"];
	vm.fs.readFile = (async (path: string) => files.get(path.slice(path.lastIndexOf("/") + 1)) ?? "") as unknown as VM["fs"]["readFile"];
	return vm;
}

test("a command that finishes silently between the launcher's checks for its pid and its end launches and reports its exit", async () => {
	const files = new Map<string, string>();
	const vm = guest(files, (name) => {
		if (name !== "pid" || files.size) return;
		files.set("pid", "42").set("output", "").set("done", JSON.stringify({ exitCode: 0, truncated: false }));
	});
	const processes = new GuestProcesses(vm, new AbortController().signal);
	const pid = await processes.launch("herdr pane run", "/");
	const status = await processes.status(pid, 0);
	assert.equal(status.running, false);
	assert.equal(status.exitCode, 0);
});

test("a command the guest could not spawn fails its launch with the exit code and the reason", async () => {
	const files = new Map([
		["done", JSON.stringify({ exitCode: 127, truncated: false })],
		["output", "No such file or directory: 'x'"],
	]);
	const processes = new GuestProcesses(guest(files), new AbortController().signal);
	await assert.rejects(processes.launch("x", "/missing"), /could not start.*127.*No such file or directory: 'x'/s);
});
