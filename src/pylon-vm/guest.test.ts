import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeVm } from "./fake-vm.ts";
import { direct } from "./guest.ts";

const sleeping = (cmd: string) => cmd.startsWith("sleep");
const holdAll = (vm: Parameters<typeof direct>[0], timeoutMs: number) =>
	Array.from({ length: 48 }, () => direct(vm, ["sleep", "600"], timeoutMs));

test("a command that waits for a command slot past its budget fails as one that never got a slot, and never reaches the guest", async () => {
	const fake = fakeVm(undefined, undefined, sleeping);
	const held = holdAll(fake.vm, 60000);
	for (const command of held) void command.catch(() => {});
	await assert.rejects(direct(fake.vm, ["true"], 0), (error: Error) => {
		assert.match(error.message, /^Guest command was not started: no command slot freed within 10000 ms/);
		assert.doesNotMatch(error.message, /no answer/);
		return true;
	});
	assert.equal(fake.commands.filter((cmd) => cmd === "true").length, 0);
	fake.answer();
	await Promise.allSettled(held);
});

for (const delayedAnswer of [false, true])
	test(`a command that got no answer has its guest processes killed, so its slot frees and a later command runs${delayedAnswer ? " even when its answer arrives later" : ""}`, async (t) => {
		const lines: string[] = [];
		t.mock.method(console, "error", (line: unknown) => void lines.push(String(line)));
		const fake = fakeVm(undefined, undefined, sleeping);
		const answer = Promise.withResolvers<void>();
		t.after(() => answer.resolve());
		if (delayedAnswer) {
			const exec = fake.vm.exec.bind(fake.vm);
			let first = true;
			t.mock.method(fake.vm, "exec", async (...args: Parameters<typeof exec>) => {
				const delay = first;
				first = false;
				const result = await exec(...args);
				if (delay) await answer.promise;
				return result;
			});
		}
		const stuck = holdAll(fake.vm, 0);
		const later = direct(fake.vm, ["true"], 30000);
		const outcomes = await Promise.allSettled(stuck);
		for (const outcome of outcomes) assert.match(String((outcome as PromiseRejectedResult).reason), /got no answer within 10000 ms/);
		assert.equal((await later).exitCode, 0, "the later command got a slot the killed ones gave back");
		assert.deepEqual(fake.refused, []);
		const named = /\((g\d+) in the controller log\)/.exec(String((outcomes[0] as PromiseRejectedResult).reason))?.[1];
		assert.ok(named !== undefined, "the error names its command's ID");
		assert.ok(lines.some((line) => line.startsWith(`guest command ${named} got no answer within 10000 ms`)), `the log has its timeout:\n${lines.join("\n")}`);
		if (delayedAnswer) {
			assert.ok(!lines.some((line) => line.startsWith(`guest command ${named} answered and released its slot`)));
			setImmediate(() => answer.resolve());
		}
		// A later command needs any free slot, not necessarily this command's slot.
		await t.waitFor(() => {
			assert.ok(lines.some((line) => line.startsWith(`guest command ${named} answered and released its slot`)), `the log has its release:\n${lines.join("\n")}`);
			assert.ok(lines.some((line) => new RegExp(`^guest command g\\d+ killed \\d+ guest processes of .*\\b${named}\\b`).test(line)), `the log has the kill:\n${lines.join("\n")}`);
		}, { timeout: 10000 });
	});

test("a command that gets a slot late has only what is left of its deadline, and its error says it may still have run", async () => {
	const fake = fakeVm(undefined, undefined, sleeping);
	const held = holdAll(fake.vm, 60000);
	for (const command of held) void command.catch(() => {});
	const started = Date.now();
	const late = direct(fake.vm, ["sleep", "1"], 0);
	setTimeout(() => fake.answer(), 5000);
	await assert.rejects(late, /got no answer within 10000 ms .*may still have run or may run later, so check what it does before retrying it/);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 11000, `the wait for a slot and for the answer share one deadline, but it took ${elapsed} ms`);
	await Promise.allSettled(held);
	fake.answer();
});
