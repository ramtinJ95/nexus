import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controllerLogLimit, rotateLog } from "./log-rotation.ts";

test("controller.log rotates at 10 MiB, keeps two old files, and an open writer goes on in the current file", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nexus-log-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const log = join(dir, "controller.log");
	assert.deepEqual(controllerLogLimit, { maxBytes: 10 * 2 ** 20, kept: 2 });
	assert.equal(await rotateLog(log, controllerLogLimit), false, "no log yet");
	// As the client opens it for the controller's stdout and stderr.
	const fd = openSync(log, "a", 0o600);
	t.after(() => closeSync(fd));
	const fill = (mark: string) => writeSync(fd, `${mark}\n`.padEnd(controllerLogLimit.maxBytes, "."));
	fill("first");
	assert.equal(await rotateLog(log, { ...controllerLogLimit, maxBytes: controllerLogLimit.maxBytes + 1 }), false, "under the limit");
	assert.equal(await rotateLog(log, controllerLogLimit), true);
	assert.equal((await stat(log)).size, 0);
	assert.equal((await stat(`${log}.1`)).mode & 0o777, 0o600, "the copy is as private as the log");
	writeSync(fd, "after\n");
	assert.equal(await readFile(log, "utf8"), "after\n", "the writer's next line starts the emptied file");

	fill("second");
	await rotateLog(log, controllerLogLimit);
	fill("third");
	await rotateLog(log, controllerLogLimit);
	assert.deepEqual((await readdir(dir)).toSorted(), ["controller.log", "controller.log.1", "controller.log.2"]);
	assert.match(await readFile(`${log}.1`, "utf8"), /^third\n/);
	assert.match(await readFile(`${log}.2`, "utf8"), /^after\nsecond\n/, "the oldest, first's, is gone");
});
