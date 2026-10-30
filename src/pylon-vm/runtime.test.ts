import { test } from "node:test";
import assert from "node:assert/strict";
import { bootSchema, type Action, type BootSpec, type SandboxRecord } from "./contracts.ts";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeVm, type WritePhase } from "./fake-vm.ts";
import { execute } from "./guest.ts";
import { networkOptions } from "./network.ts";
import { loadKvm, readIntent, reportResume, SandboxRuntime, setupMarkerOf, setupOnDisk } from "./runtime.ts";

type Status = Awaited<ReturnType<Parameters<typeof reportResume>[0]["status"]>>;

/** A process supervisor whose status calls return `steps` in order, and the log lines reportResume wrote. */
function resume(steps: readonly (Status | Error)[]) {
	const lines: string[] = [];
	let settle!: () => void;
	const settled = new Promise<void>((accept) => (settle = accept));
	const processes = {
		async status(): Promise<Status> {
			const step = steps[0]!;
			steps = steps.slice(1);
			if (step instanceof Error) throw step;
			return step;
		},
	};
	const log = (line: string) => {
		lines.push(line);
		if (/^resume: (exited|no outcome)/.test(line)) settle();
	};
	return { run: () => reportResume(processes, "p1", 10, log), lines, settled };
}
const running = (output: string): Status => ({ pid: "p1", running: true, output });
const exited = (exitCode: number, output = ""): Status => ({ pid: "p1", running: false, output, exitCode, truncated: false });

test("a resume that ends within the wait logs its output and exit code", async () => {
	const { run, lines } = resume([exited(3, "npm ERR! missing script\n")]);
	assert.equal(await run(), false);
	assert.deepEqual(lines, ["npm ERR! missing script\n", "resume: exited 3"]);
});

test("a resume that outlives the wait is followed to its end, killed by a signal here", async () => {
	const { run, lines, settled } = resume([running("starting\n"), running(""), exited(137, "done\n")]);
	assert.equal(await run(), true, "the boot goes on");
	await settled;
	assert.deepEqual(lines, ["starting\n", "resume: continues in the background as p1", "done\n", "resume: exited 137 (signal 9)"]);
});

test("a resume whose outcome is lost says so", async () => {
	const { run, lines, settled } = resume([running(""), new Error("Sandbox is not running")]);
	assert.equal(await run(), true);
	await settled;
	assert.deepEqual(lines, ["resume: continues in the background as p1", "resume: no outcome, because Sandbox is not running"]);
});

test("setup reruns unless the disk holds this instance's own finished setup", () => {
	const record = { name: "pylon-a", createdAt: "2027-01-01T00:00:00.000Z" } as SandboxRecord;
	const build = { name: "tpl-0123456789ab", createdAt: "2026-12-31T00:00:00.000Z" } as SandboxRecord;
	// A controller killed after its first checkpoint and before anything else: the disk alone says setup ran.
	assert.deepEqual(setupOnDisk(setupMarkerOf(record, undefined), record), {});
	assert.deepEqual(setupOnDisk(setupMarkerOf(record, "Setup exited 3"), record), { setupError: "Setup exited 3" });
	// Killed before it: the disk is the one setup ran on, a template's or none.
	assert.equal(setupOnDisk(setupMarkerOf(build, undefined), record), null, "a template's disk carries its build's setup, not the pylon's");
	assert.equal(setupOnDisk(null, record), null);
	assert.equal(setupOnDisk(setupMarkerOf({ ...record, createdAt: "2027-02-01T00:00:00.000Z" }, undefined), record), null, "an instance of the same name created again");
});

test("an intent reads back as the client wrote it, and any other shape is refused", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nexus-intent-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const intentOf = async (intent: object) => {
		await writeFile(join(dir, "intent.json"), JSON.stringify(intent));
		return readIntent(dir);
	};
	assert.deepEqual(await intentOf({ prepare: false }), { prepare: false });
	assert.deepEqual(await intentOf({ prepare: true }), { prepare: true });
	await assert.rejects(intentOf({}));
	await assert.rejects(intentOf({ prepare: "yes" }));
	await assert.rejects(intentOf({ prepare: false, templates: true }));
});

test("an intent written before setup was recorded on the disk is refused", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nexus-intent-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const intent of [{ prepare: false, fresh: false }, { prepare: false, fresh: false, setupError: "Setup exited 1" }, { prepare: false, fresh: true }]) {
		await writeFile(join(dir, "intent.json"), JSON.stringify(intent));
		await assert.rejects(readIntent(dir), /Unrecognized key/);
	}
});

test("only a boot that asks for nested virtualization runs the image's KVM step, and a guest it leaves without /dev/kvm fails the boot", async () => {
	const step = "/usr/local/libexec/nexus/nexus-kvm";
	const ordinary = fakeVm();
	await loadKvm(ordinary.vm, { cpus: 2, memoryGiB: 4 });
	assert.deepEqual(ordinary.commands, [], "an ordinary pylon keeps the guest without KVM modules");

	const verify = fakeVm();
	await loadKvm(verify.vm, { cpus: 2, memoryGiB: 4, nestedVirtualization: true });
	assert.deepEqual(verify.commands, [step]);

	const without = fakeVm(undefined, (cmd) => cmd === step);
	await assert.rejects(loadKvm(without.vm, { cpus: 2, memoryGiB: 4, nestedVirtualization: true }), /^Error: This pylon asked for nested virtualization, and its guest has no \/dev\/kvm\. Guest command exited 1/);

	const spec = { allowedHosts: [], secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null };
	assert.equal(bootSchema.parse({ ...spec, resources: { cpus: 2, memoryGiB: 4, nestedVirtualization: true } }).resources.nestedVirtualization, true);
	assert.equal(bootSchema.parse({ ...spec, resources: { cpus: 2, memoryGiB: 4 } }).resources.nestedVirtualization, undefined);
	assert.throws(() => bootSchema.parse({ ...spec, resources: { cpus: 2, memoryGiB: 4, nestedVirtualization: false } }), "a pylon asks by setting it, so there is one way not to");
});

/** A running instance on a fake VM whose file writes to paths `holds` names hold in `phase`. */
async function runningOnAFakeVm(t: { after(fn: () => Promise<void>): void }, holds: RegExp, phase: WritePhase, fails?: (cmd: string) => boolean, hangs?: (cmd: string) => boolean) {
	const dir = await mkdtemp(join(tmpdir(), "runtime-stop-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const fake = fakeVm((path) => (holds.test(path) ? phase : undefined), fails, hangs);
	const record = { name: "pylon-a", createdAt: "2027-01-01T00:00:00.000Z", config: { diskGiB: 8, workspace: "/workspace" } } as SandboxRecord;
	const spec = { resources: { cpus: 2, memoryGiB: 4 } } as BootSpec;
	return { dir, fake, runtime: new SandboxRuntime(dir, record, spec, { vm: fake.vm, settleMs: 300 }) };
}
const staged = /^\/var\/lib\/pi-sandbox\/staging\//;
const file = { path: "/home/user/notes.md", owner: "user", mode: 0o644, content: "notes\n" };
const writeFiles = { action: "write-files", name: "pylon-a", files: [file] } as Action;
const settles = (work: Promise<unknown>, ms: number) =>
	Promise.race([work.then(() => "settled", () => "settled"), delay(ms, "still waiting")]);

test("a stop refuses a file write still waiting for its turn, and then checkpoints", async (t) => {
	const { dir, fake, runtime } = await runningOnAFakeVm(t, staged, "queued");
	const writing = runtime.handle(writeFiles);
	void writing.catch(() => {});
	await fake.holding("/0");
	assert.equal(((await runtime.stop()) as { state: string }).state, "stopped");
	await assert.rejects(writing, /operation aborted/, "the write-files was refused, so none of its files were installed");
	assert.equal(fake.checkpoints.length, 1);
	await access(join(dir, "disk.qcow2"));
});

test("a stop turns the guest's disk cache back on and syncs it right before its checkpoint", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, /^$/, "queued");
	assert.equal(((await runtime.stop()) as { state: string }).state, "stopped");
	assert.equal(fake.checkpoints.length, 1);
	assert.deepEqual(fake.commands.slice(-2), ["echo 'write back' > /sys/block/vda/queue/write_cache", "sync"], "the sync reaches the node's disk, not only the guest's");
});

test("a stop that cannot turn the guest's disk cache back on never checkpoints, since its sync would not reach the node's disk", async (t) => {
	const { dir, fake, runtime } = await runningOnAFakeVm(t, /^$/, "queued", (cmd) => cmd.includes("write_cache"));
	await assert.rejects(runtime.stop(), /Stop failed before its checkpoint completed/);
	assert.equal(fake.checkpoints.length, 0);
	assert.equal(fake.commands.at(-1), "echo 'write back' > /sys/block/vda/queue/write_cache");
	await assert.rejects(access(join(dir, "disk.qcow2")));
});

test("a stop refuses a file write still sending its data, and then checkpoints", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, staged, "sending");
	const writing = runtime.handle(writeFiles);
	void writing.catch(() => {});
	await fake.holding("/0");
	assert.equal(((await runtime.stop()) as { state: string }).state, "stopped");
	await assert.rejects(writing, /operation aborted/);
	assert.equal(fake.checkpoints.length, 1);
});

test("a stop whose file write is answered within the wait checkpoints with the write installed", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, staged, "answering");
	const writing = runtime.handle(writeFiles);
	void writing.catch(() => {});
	await fake.holding("/0");
	const stop = runtime.stop();
	fake.answer();
	assert.equal(((await stop) as { state: string }).state, "stopped");
	assert.deepEqual(await writing, { paths: ["/home/user/notes.md"] });
	assert.equal(fake.checkpoints.length, 1);
});

test("a stop never checkpoints under a file write that still awaits the guest's answer, and closes the VM", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, staged, "answering");
	const writing = runtime.handle(writeFiles);
	void writing.catch(() => {});
	await fake.holding("/0");
	await assert.rejects(runtime.stop(), /Stop failed before its checkpoint completed/);
	assert.deepEqual(fake.checkpoints, [], "a checkpoint would keep a half-installed write");
	assert.deepEqual(fake.closed, ["vm"]);
	await assert.rejects(writing, /sandbox closed/, "the close ended the write, so its request does not hang");
});

test("a stop under a command's kill write that holds the file slot closes the VM at its deadline, not behind the write", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, /\/kill$/, "answering");
	const { pid } = (await runtime.handle({ action: "exec", name: "pylon-a", cmd: "sleep 600", timeoutMs: 0 } as Action)) as { pid: string };
	const killing = runtime.handle({ action: "exec-kill", name: "pylon-a", pid } as Action);
	void killing.catch(() => {});
	await fake.holding("/kill");
	const stop = runtime.stop();
	void stop.catch(() => {});
	assert.equal(await settles(stop, 2_000), "settled", "the stop's guest commands queued behind the write, for up to 40 s each");
	await assert.rejects(stop, /Stop failed before its checkpoint completed/);
	assert.deepEqual(fake.checkpoints, []);
	await assert.rejects(killing, /sandbox closed/);
});

/** `count` guest commands that each read a file, as a probe's reads do. */
const reading = (vm: Parameters<typeof execute>[0], count: number, timeoutMs = 10000) =>
	Array.from({ length: count }, (_, i) => execute(vm, `head -c 65537 /tmp/${i}`, "/", timeoutMs));

test("reads queued behind a file write take at most 48 of the guest's 64 command slots, and the rest wait for one", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, staged, "answering");
	const writing = runtime.handle(writeFiles);
	await fake.holding("/0");
	const reads = reading(fake.vm, 65);
	assert.ok((await Promise.all(reads.map((read) => settles(read, 200)))).every((outcome) => outcome === "still waiting"), `no read failed behind the write, but the guest refused ${fake.refused.length} as full`);
	fake.answer();
	await writing;
	assert.equal((await Promise.allSettled(reads)).filter((read) => read.status === "fulfilled").length, 65);
	assert.deepEqual(fake.refused, []);
	assert.equal(fake.peak, 48);
});

test("reads against a guest that stopped answering take at most 48 of its 64 command slots, and the rest wait for one", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, /^$/, "queued", undefined, (cmd) => cmd.startsWith("head -c"));
	const reads = reading(fake.vm, 70);
	assert.ok((await Promise.all(reads.map((read) => settles(read, 200)))).every((outcome) => outcome === "still waiting"), `no read failed while the guest held them, but the guest refused ${fake.refused.length} as full`);
	assert.equal(fake.peak, 48);
	fake.answer();
	await delay(50);
	fake.answer();
	assert.equal((await Promise.allSettled(reads)).filter((read) => read.status === "fulfilled").length, 70, "each waiting read ran once a slot freed");
	assert.deepEqual(fake.refused, [], "the guest never refused a command as full");
	assert.equal(fake.peak, 48);
	assert.equal(((await runtime.stop()) as { state: string }).state, "stopped");
});

test("a stop refuses the reads still waiting for a command slot, so they never take the slots its own commands need", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, /^$/, "queued", undefined, (cmd) => cmd.startsWith("head -c"));
	const reads = reading(fake.vm, 70);
	for (const read of reads) void read.catch(() => {});
	await delay(50);
	const stop = runtime.stop();
	fake.answer();
	assert.equal(((await stop) as { state: string }).state, "stopped");
	const outcomes = await Promise.allSettled(reads);
	assert.equal(outcomes.filter((read) => read.status === "fulfilled").length, 48, "the reads the guest ran were answered within the stop's wait");
	for (const read of outcomes.slice(48)) assert.match(String((read as PromiseRejectedResult).reason), /the VM stopped running while it waited for a command slot/);
	assert.deepEqual(fake.refused, []);
	assert.equal(fake.peak, 48);
	assert.equal(fake.checkpoints.length, 1);
});

test("a stop checkpoints although reads whose waits ran out still hold command slots the guest never answered", async (t) => {
	const { dir, fake, runtime } = await runningOnAFakeVm(t, /^$/, "queued", undefined, (cmd) => cmd.startsWith("head -c"));
	// Each read's wait ends 10 s after its 0 s timeout.
	const reads = await Promise.allSettled(reading(fake.vm, 64, 0));
	assert.ok(reads.every((read) => read.status === "rejected"), "the guest answered none of them");
	assert.equal(((await runtime.stop()) as { state: string }).state, "stopped");
	assert.deepEqual(fake.refused, [], "the stop's own commands found room");
	assert.equal(fake.checkpoints.length, 1);
	await access(join(dir, "disk.qcow2"));
});

/** Opens the guest terminal, a real listener on the host, and closes it after the test even when the code under test does not. */
async function openTerminal(runtime: SandboxRuntime, t: { after(fn: () => Promise<void>): void }) {
	await runtime.handle({ action: "shell", name: "pylon-a", user: "user" } as Action);
	t.after(async () => void (await runtime.handle({ action: "destroy", name: "pylon-a", confirm: "pylon-a" } as Action)));
}

test("a stop that closes the VM at its deadline first closes the guest terminal, which the VM's close would wait on", async (t) => {
	const { fake, runtime } = await runningOnAFakeVm(t, staged, "answering");
	await openTerminal(runtime, t);
	const writing = runtime.handle(writeFiles);
	void writing.catch(() => {});
	await fake.holding("/0");
	await assert.rejects(runtime.stop(), /Stop failed before its checkpoint completed/);
	assert.deepEqual(fake.closed, ["ssh", "vm"]);
});

test("a stop whose status cannot be saved still closes the guest terminal before the VM", async (t) => {
	const { dir, fake, runtime } = await runningOnAFakeVm(t, staged, "answering");
	await openTerminal(runtime, t);
	// Renaming the saved status onto a directory fails, as a full disk would.
	await mkdir(join(dir, "status.json"));
	await assert.rejects(runtime.stop(), /Stop failed before its checkpoint completed/);
	assert.deepEqual(fake.closed, ["ssh", "vm"]);
});

test("a failed controller whose status cannot be saved still closes the guest terminal and the VM", async (t) => {
	const { dir, fake, runtime } = await runningOnAFakeVm(t, staged, "answering");
	await openTerminal(runtime, t);
	await mkdir(join(dir, "status.json"));
	await assert.rejects(runtime.fail(new Error("the guest stopped answering")));
	assert.deepEqual(fake.closed, ["ssh", "vm"]);
});

test("update-secret swaps a granted secret's new value into the running VM's requests, still only toward its own hosts", async () => {
	const spec = {
		resources: { cpus: 2, memoryGiB: 4 },
		allowedHosts: ["api.openai.com", "github.com"],
		secrets: { NEXUS_CHATGPT_TOKEN: { hosts: ["api.openai.com"], value: "first-token" } },
		ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null,
	} satisfies BootSpec;
	const record = { name: "pylon-a", createdAt: "2027-01-01T00:00:00.000Z", config: { diskGiB: 8, workspace: "/workspace" } } as SandboxRecord;
	const network = networkOptions(spec, record.name);
	const runtime = new SandboxRuntime("/nonexistent", record, spec, { vm: fakeVm().vm, settleMs: 300, network });
	const placeholder = network.placeholders.NEXUS_CHATGPT_TOKEN!;
	const sent = async (host: string) => {
		const request = await network.httpHooks!.onRequest!(new Request(`https://${host}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${placeholder}` } }));
		assert.ok(request instanceof Request);
		return request.headers.get("authorization");
	};
	const update = (secret: string, value: string) => runtime.handle({ action: "update-secret", name: "pylon-a", secret, value });

	assert.equal(await sent("api.openai.com"), "Bearer first-token");
	assert.deepEqual(await update("NEXUS_CHATGPT_TOKEN", "second-token"), { held: true });
	assert.equal(await sent("api.openai.com"), "Bearer second-token");
	await assert.rejects(sent("github.com"), { status: 403 }, "another host gets neither value");

	assert.deepEqual(await update("STRIPE_KEY", "sk_live_new"), { held: false }, "a secret the boot did not grant is not held, and not an error");
	assert.equal(await sent("api.openai.com"), "Bearer second-token");
});
