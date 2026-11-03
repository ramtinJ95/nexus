import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { stampLines, unstamped } from "./controller-log.ts";

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
