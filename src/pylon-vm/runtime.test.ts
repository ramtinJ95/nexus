import { test } from "node:test";
import assert from "node:assert/strict";
import { reportResume } from "./runtime.ts";

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
