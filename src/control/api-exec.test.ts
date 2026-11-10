/** The exec route, a raw pipe to a shell line in a running pylon, which `nexus exec` and Herdr Core's `--via` use. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { processStream } from "../process-stream.ts";
import { withThread, observeRunning, attachTo, streamsAs, laptop } from "../test-support/api-kit.ts";

const execPath = (thread: string, line: string) => `/v1/threads/${thread}/exec?line=${encodeURIComponent(line)}`;

test("exec pipes bytes both ways untouched, ends stdin on eof, and reports the line's exit code", async (t) => {
  const s = await withThread(t);
  observeRunning(s, {});
  const ran: (readonly string[])[] = [];
  s.probePipes(async (argv) => {
    ran.push(argv);
    return processStream(argv[0]!, argv.slice(1), () => {});
  });
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}${execPath(s.thread.id, "cat; exit 7")}`, { perMessageDeflate: false });
  await once(ws, "open");
  const out: Buffer[] = [];
  const texts: unknown[] = [];
  ws.on("message", (data, binary) => { if (binary) out.push(Buffer.from(data as Buffer)); else texts.push(JSON.parse(data.toString())); });
  const bytes = Buffer.from([0, 1, 2, 13, 10, 0x1b, 0xff, 0x80, 0x0a]);
  ws.send(bytes, { binary: true });
  ws.send('{"type":"eof"}');
  const [code] = await once(ws, "close");
  assert.deepEqual(ran, [["sh", "-c", "cat; exit 7"]]);
  assert.deepEqual(Buffer.concat(out), bytes, "bytes come back as sent");
  assert.deepEqual(texts, [{ type: "exit", code: 7 }]);
  assert.equal(code, 1000);
});

test("exec refuses a pylon that does not run, and never wakes it", async (t) => {
  const s = await withThread(t);
  s.probePipes(async () => assert.fail("no stream opens"));
  const refused = await attachTo(s.port, execPath(s.thread.id, "true"));
  assert.ok("status" in refused);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /exec does not wake it/);
  const missing = await attachTo(s.port, `/v1/threads/${s.thread.id}/exec`);
  assert.ok("status" in missing);
  assert.equal(missing.status, 400);
});

test("an exec takes none of the streams' places, so a caller whose share of them is full still opens one", async (t) => {
  const s = await withThread(t);
  observeRunning(s, {});
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1), () => {}));
  const mine = await streamsAs(s, [laptop], `/v1/threads/${s.thread.id}/events`);
  t.after(() => { for (const stream of mine) stream.close(); });
  const opened = await attachTo(s.port, execPath(s.thread.id, "cat"));
  assert.ok("ws" in opened, JSON.stringify(opened));
  opened.ws.close();
  await opened.closed;
});
