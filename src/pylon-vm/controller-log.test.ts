import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { stampLines, unstamped } from "./controller-log.ts";
import { controllerLog } from "./pylon-guest.ts";

test("a stamped stream starts each line with its time, and keeps the bytes and encodings written to it", async () => {
	const chunks: Buffer[] = [];
	const stream = new Writable({ write: (chunk: Buffer, _encoding, done) => void (chunks.push(chunk), done()) }) as unknown as NodeJS.WriteStream;
	stampLines(stream);
	stream.write("first line\nsecond ");
	stream.write(Buffer.from([0xe2]));
	stream.write(Buffer.from([0x82, 0xac, 0x0a]));
	stream.write("616263", "hex");
	await new Promise<void>((done) => stream.write("\n", () => done()));
	const lines = Buffer.concat(chunks).toString("utf8").split("\n");
	assert.equal(lines.pop(), "");
	for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
	assert.deepEqual(lines.map(unstamped), ["first line", "second €", "abc"]);
});

test("a line the probe appends to the controller log has the time on each of its lines, as a session failure's output may span several", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "controller-log-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await controllerLog(dir)("sessions: relaunch of pane w1:p1 failed: herdr exited 1\nerror: no server\n  at start");
	const lines = (await readFile(join(dir, "controller.log"), "utf8")).split("\n");
	assert.equal(lines.pop(), "");
	for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
	assert.deepEqual(lines.map(unstamped), ["sessions: relaunch of pane w1:p1 failed: herdr exited 1", "error: no server", "  at start"]);
});
