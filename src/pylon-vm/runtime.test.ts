import { test } from "node:test";
import assert from "node:assert/strict";
import type { SandboxRecord } from "./contracts.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIntent, reportResume, setupMarkerOf, setupOnDisk, setupState } from "./runtime.ts";

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

test("an instance whose intent predates the disk marker boots as its intent said, and its disk is marked", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nexus-intent-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const intentOf = async (intent: object) => {
		await writeFile(join(dir, "intent.json"), JSON.stringify(intent));
		return readIntent(dir);
	};
	const record = { name: "pylon-old", createdAt: "2026-10-01T00:00:00.000Z" } as SandboxRecord;
	// A pylon main created and checkpointed after its setup: before the marker, this boot would rerun setup over its checkout.
	const ran = await intentOf({ prepare: false, fresh: false });
	assert.deepEqual(ran, { prepare: false, setupRan: {} });
	assert.deepEqual(setupState(true, null, record, ran.setupRan), { done: {}, mark: true });
	const failed = await intentOf({ prepare: false, fresh: false, setupError: "Setup exited 1" });
	assert.deepEqual(setupState(true, null, record, failed.setupRan), { done: { setupError: "Setup exited 1" }, mark: true });
	// Setup had not run, or a boot from no disk, which ran setup then too.
	assert.deepEqual(setupState(true, null, record, (await intentOf({ prepare: false, fresh: true })).setupRan), { done: null, mark: false });
	assert.deepEqual(setupState(false, null, record, ran.setupRan), { done: null, mark: false });
	// Once a checkpoint holds the marker, the disk answers.
	assert.deepEqual(setupState(true, setupMarkerOf(record, undefined), record, ran.setupRan), { done: {}, mark: false });
	assert.deepEqual(await intentOf({ prepare: true }), { prepare: true });
	await assert.rejects(intentOf({ prepare: false, fresh: "yes" }));
});
