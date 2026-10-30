import { test } from "node:test";
import assert from "node:assert/strict";
import { openPython, pipeOutput, type OpenPipe } from "./pipe.ts";
import { processStream } from "./process-stream.ts";
import type { ByteStream } from "./protocol.ts";

/** Runs argv on this machine, and refuses one the probe's request URL could not carry, as protocol.ts's streamPath encodes it. */
const local: OpenPipe = async (argv) => {
  const encoded = encodeURIComponent(JSON.stringify({ argv })).length;
  if (encoded > 16 << 10) throw new Error(`a request URL of ${encoded} bytes`);
  return processStream(argv[0]!, argv.slice(1), () => undefined);
};
const sh = (script: string) => local(["sh", "-c", script]);
const read = { deadlineMs: 10_000, maxBytes: 1 << 20, what: "the test's output" };

test("a helper larger than a request URL runs from stdin, with its own name and arguments, and reads the payload after it", async () => {
  const source = Buffer.from(`# ${"padding ".repeat(3000)}\nimport json, sys\nprint(json.dumps({"argv": sys.argv, "name": __name__, "payload": json.load(sys.stdin)}))\n`);
  assert.ok(source.length > 16 << 10);
  const stream = await openPython(local, source, ["one", "two words"], "helper.py");
  const { code, out } = await pipeOutput(stream, { ...read, input: Buffer.from(JSON.stringify({ n: 1 })) });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.toString("utf8")), { argv: ["helper.py", "one", "two words"], name: "__main__", payload: { n: 1 } });
});

test("a helper's exit code passes through, and one that fails names its file in the traceback", async () => {
  const stderr: string[] = [];
  const open: OpenPipe = async (argv) => processStream(argv[0]!, argv.slice(1), (text) => { stderr.push(text); });
  await assert.rejects(pipeOutput(await openPython(open, Buffer.from("raise SystemExit(4)\n"), [], "four.py"), read), /reading the test's output exited 4/);
  await assert.rejects(pipeOutput(await openPython(open, Buffer.from("1 / 0\n"), [], "broken.py"), read), /exited 1/);
  assert.match(stderr.join(""), /File "broken\.py", line 1/);
});

test("a pipe's output is answered with its exit code, which must be one of okCodes", async () => {
  assert.deepEqual(await pipeOutput(await sh("printf hi"), read), { code: 0, out: Buffer.from("hi") });
  assert.deepEqual(await pipeOutput(await sh("exit 3"), { ...read, okCodes: [0, 3] }), { code: 3, out: Buffer.alloc(0) });
  await assert.rejects(pipeOutput(await sh("exit 3"), read), /^Error: reading the test's output exited 3$/);
});

test("a lost pipe fails", async () => {
  const lost: ByteStream = {
    async *[Symbol.asyncIterator]() {},
    write: async () => undefined,
    close: async () => undefined,
    abort: () => undefined,
    done: Promise.resolve({ kind: "lost" }),
  };
  await assert.rejects(pipeOutput(lost, read), /the pipe to the pylon was lost before it read the test's output/);
});

test("a pipe that prints past the cap, or passes the deadline, fails and is dropped", async () => {
  const loud = await sh("head -c 5000 /dev/zero; exec sleep 30");
  await assert.rejects(pipeOutput(loud, { ...read, maxBytes: 1000 }), /reading the test's output printed over 1000 bytes/);
  assert.deepEqual(await loud.done, { kind: "lost" });
  const slow = await sh("exec sleep 30");
  await assert.rejects(pipeOutput(slow, { ...read, deadlineMs: 50 }), /the pylon did not read the test's output within 0.05 s/);
  assert.deepEqual(await slow.done, { kind: "lost" });
});
