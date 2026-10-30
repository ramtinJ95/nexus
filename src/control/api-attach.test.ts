/** The attach route, which carries a terminal over a WebSocket. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { maxStreams } from "./api/sse.ts";
import type { AttachTiming } from "./attach.ts";
import type { Thread } from "./thread-store.ts";
import { processStream } from "../process-stream.ts";
import { attachScript } from "../sessions.ts";
import { encodeMessage } from "../attach-wire.ts";
import { terminalSize } from "../guest-terminal.ts";
import { until } from "../test-kit.ts";
import type { TailnetNodeId } from "../ids.ts";
import type { ByteStream, StreamEnd } from "../protocol/streams.ts";
import { node, laptop, claudeSession, withThread, observeRunning, attachTo, attachPathOf } from "./api-test-kit.ts";

const fastAttach: AttachTiming = { pingMs: 60_000, waitMs: 5_000, pollMs: 20, hangUpMs: 5_000 };

/** A pipe to the relay in the guest, which records its stdin. Ending its stdin hangs up, and Herdr's client exits 0. */
function fakePipe() {
  const output = new PassThrough();
  const end = Promise.withResolvers<StreamEnd>();
  const stdin: Buffer[] = [];
  const exit = (code: number) => {
    output.end();
    end.resolve({ kind: "exited", code });
  };
  const stream: ByteStream = {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    async write(chunk) { stdin.push(Buffer.from(chunk)); },
    async close() { setTimeout(() => exit(0), 10); },
    abort() {
      output.end();
      end.resolve({ kind: "lost" });
    },
    done: end.promise,
  };
  return { stream, stdin: () => Buffer.concat(stdin), print: (text: string) => output.write(text), exit };
}

test("the attach route refuses before the 101 with the API's JSON errors, and a page from any other origin is refused", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const path = attachPathOf(s.thread.id);
  s.probePipes(async () => { throw Object.assign(new Error("rj-firebat: not running"), { code: "not-running" }); });
  const refused = async (status: number, error: RegExp, attempt: Promise<Awaited<ReturnType<typeof attachTo>>>) => {
    const res = await attempt;
    assert.ok("status" in res, "refused before the 101");
    assert.equal(res.status, status);
    assert.match(res.body.error, error);
  };

  s.callAs("nSTRANGER" as TailnetNodeId);
  await refused(403, /caller is not a tailnet node/, attachTo(s.port, path));
  s.callAs(laptop);
  await refused(403, /does not answer to host evil\.example/, attachTo(s.port, path, { host: "evil.example" }));
  for (const origin of [`http://127.0.0.1:8443`, `https://127.0.0.1:${s.port}`, "null", "http://evil.example"]) {
    await refused(403, /does not answer pages from/, attachTo(s.port, path, { origin }));
  }
  await refused(400, /cols must be a whole number from 1 to 9999, got 0/, attachTo(s.port, attachPathOf(s.thread.id, "cols=0&rows=30")));
  await refused(400, /rows must be a whole number/, attachTo(s.port, attachPathOf(s.thread.id, "cols=80")));
  await refused(400, /term must be a terminal type/, attachTo(s.port, attachPathOf(s.thread.id, "cols=80&rows=24&term=x%20y")));
  for (const pane of ["", "p1", "w1:p1%3Breboot", "%24(id)"]) {
    await refused(400, /^pane must be a Herdr pane ID such as w1:p1, got /, attachTo(s.port, attachPathOf(s.thread.id, `cols=80&rows=24&pane=${pane}`)));
  }
  await refused(404, /^no thread th-missing$/, attachTo(s.port, attachPathOf("th-missing")));
  assert.equal(s.streams.length, 0, "no refusal reached the probe");

  for (const headers of [{}, { origin: `http://127.0.0.1:${s.port}` }]) {
    const a = await attachTo(s.port, path, headers);
    assert.ok("ws" in a, `admitted with ${JSON.stringify(headers)}`);
    a.ws.close();
    await a.closed;
  }

  assert.equal((await s.call("POST", `/v1/threads/${s.thread.id}/archive`)).status, 200);
  await refused(409, new RegExp(`^thread ${s.thread.id} is archived, so its pylon stays paused$`), attachTo(s.port, path));
});

test("an attach wakes the pylon, waits for it, and carries keys, resizes and output until Herdr exits", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const pipe = fakePipe();
  let running = false;
  s.probePipes(async () => {
    if (!running) throw Object.assign(new Error("rj-firebat: not running"), { code: "not-running" });
    return pipe.stream;
  });
  const before = Date.now();
  const a = await attachTo(s.port, attachPathOf(s.thread.id, "cols=100&rows=30&term=xterm-ghostty"));
  assert.ok("ws" in a);
  await until("a waiting message", () => a.received.length === 1);
  assert.deepEqual(a.received, [{ type: "waiting", pylon: "unknown" }]);
  assert.ok(s.registry.thread(s.thread.id)!.lastHumanActivityAt >= before, "attaching is human activity");
  assert.ok(s.woken.includes(node), "and wakes the node");
  observeRunning(s, {});
  running = true;
  await until("the attached message", () => a.received.length === 2);
  assert.deepEqual(a.received[1], { type: "attached" });

  const [pylonId, argv] = s.streams.at(-1)!;
  assert.equal(pylonId, s.thread.pylonId);
  assert.deepEqual([argv[0], argv[1], argv[3], ...argv.slice(5)], ["python3", "-c", "guest-terminal.py", "100", "30", "xterm-ghostty", "sh", "-c", attachScript, "attach", ""]);
  const relayBytes = Number(argv[4]);
  await until("the relay's source", () => pipe.stdin().length >= relayBytes);
  assert.match(pipe.stdin().subarray(0, relayBytes).toString(), /^# A program on a pty in a pylon/);

  a.ws.send(Buffer.from("ls\r"));
  a.ws.send(encodeMessage({ type: "resize", size: terminalSize(140, 40) }));
  const frames = Buffer.from([0, 0, 0, 0, 3, ...Buffer.from("ls\r"), 1, 0, 0, 0, 4, 0, 140, 0, 40]);
  await until("the key and resize frames", () => pipe.stdin().length >= relayBytes + frames.length);
  assert.deepEqual(pipe.stdin().subarray(relayBytes), frames);

  pipe.print("herdr screen");
  await until("the output", () => a.received.length === 3);
  pipe.exit(0);
  assert.equal(await a.closed, 1000);
  assert.deepEqual(a.received.slice(2), ["herdr screen", { type: "exit", code: 0 }]);
});

test("a Claude worker's attach lands in the pane of its Claude session, one that names a pane lands there, and a Nexus agent thread's where Herdr was", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const started = await s.call("POST", "/v1/threads", { project: "acme", title: "Claude worker", claude: "fix it" });
  const claude = { ...s, thread: started.body as Thread };
  s.registry.setClaudeWorker(claude.thread.id, "/poteto-mode fix it", "started", undefined, claudeSession);
  const session = (herdrPane: string, harness: "shell" | "claude-code", harnessSessionId: string | null) => ({ id: herdrPane, state: "running" as const, herdrPane, harness, harnessSessionId, status: "idle" as const, title: "x", message: null });
  observeRunning(claude, {});
  s.registry.apply({ record: "sessions", pylonId: claude.thread.pylonId, sessions: [session("w1:p1", "shell", null), session("w2:p1", "claude-code", "another-session"), session("w3:p1", "claude-code", claudeSession)] });
  s.probePipes(async (argv) => argv[0] === "python3" ? fakePipe().stream : processStream("true", [], () => {}));
  const landsIn = async (thread: string, query?: string) => {
    const a = await attachTo(s.port, attachPathOf(thread, query));
    assert.ok("ws" in a);
    await until("attached", () => a.received.length === 1);
    a.ws.close();
    await a.closed;
    return s.streams.findLast(([, argv]) => argv[0] === "python3")![1].slice(8);
  };
  assert.deepEqual(await landsIn(claude.thread.id), ["sh", "-c", attachScript, "attach", "w3:p1"]);
  assert.deepEqual(await landsIn(claude.thread.id, "cols=100&rows=30&pane=w1:p1"), ["sh", "-c", attachScript, "attach", "w1:p1"], "an argument, never the script's text");
  observeRunning(s, {});
  assert.deepEqual(await landsIn(s.thread.id), ["sh", "-c", attachScript, "attach", ""]);
});

test("deleting a thread ends its attach as a conflict, and a closing API ends one with 1001", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  observeRunning(s, {});
  const pipes: ReturnType<typeof fakePipe>[] = [];
  s.probePipes(async () => {
    pipes.push(fakePipe());
    return pipes.at(-1)!.stream;
  });

  const deleted = await attachTo(s.port, attachPathOf(s.thread.id));
  assert.ok("ws" in deleted);
  await until("attached", () => deleted.received.length === 1);
  assert.equal((await s.call("DELETE", `/v1/threads/${s.thread.id}`)).status, 200);
  assert.equal(await deleted.closed, 1000);
  assert.deepEqual(deleted.received.at(-1), { type: "error", kind: "conflict", message: `thread ${s.thread.id} is deleted` });

  const other = await withThread(t, { attachTiming: fastAttach });
  observeRunning(other, {});
  other.probePipes(async () => fakePipe().stream);
  const stopping = await attachTo(other.port, attachPathOf(other.thread.id));
  assert.ok("ws" in stopping);
  await until("attached", () => stopping.received.length === 1);
  await other.close();
  assert.equal(await stopping.closed, 1001);
  assert.equal((stopping.received.at(-1) as { kind: string }).kind, "unreachable");
});

test("a closing API gives up on a terminal whose node stopped answering after its wait, and opens none for an upgrade it was admitting", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach, closeWaitMs: 100 });
  observeRunning(s, {});
  let opened = 0;
  s.probePipes(async () => {
    opened++;
    // Its hang-up never ends, as a node that stopped answering would leave it.
    return { ...fakePipe().stream, async close() {} };
  });
  const stuck = await attachTo(s.port, attachPathOf(s.thread.id));
  assert.ok("ws" in stuck);
  await until("attached", () => stuck.received.length === 1);

  const whois = s.holdWhois();
  const admitting = attachTo(s.port, attachPathOf(s.thread.id));
  await whois.asked;
  const closing = s.close();
  whois.release();
  assert.equal(await Promise.race([closing.then(() => "closed"), sleep(60_000, "still closing", { ref: false })]), "closed");
  assert.equal(await stuck.closed, 1006, "the stuck terminal's socket is dropped");
  const late = await admitting;
  assert.ok("status" in late && late.status === 503, JSON.stringify("status" in late ? late : "attached"));
  assert.equal(opened, 1, "no terminal opened for the upgrade that was still at whois");
});

test("a closing API drops an upgrade whose whois never returns after its wait", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach, closeWaitMs: 100 });
  const whois = s.holdWhois();
  const stalled = attachTo(s.port, attachPathOf(s.thread.id)).then(() => "answered", () => "dropped");
  await whois.asked;
  const closing = await Promise.race([s.close().then(() => "closed"), sleep(60_000, "still closing", { ref: false })]);
  whois.release();
  assert.equal(closing, "closed");
  assert.equal(await stalled, "dropped", "the upgrade's socket was dropped, not answered");
});

test("a terminal takes a place among the streams", async (t) => {
  const s = await withThread(t, { attachTiming: fastAttach });
  const open = Array.from({ length: maxStreams }, () => s.events(`/v1/threads/${s.thread.id}/events`));
  for (const stream of open) await stream.next();
  const extra = await attachTo(s.port, attachPathOf(s.thread.id));
  assert.ok("status" in extra && extra.status === 503, JSON.stringify(extra));
  for (const stream of open) stream.close();
});

test("an upgrade the API serves no WebSocket for is handled as an ordinary request", async (t) => {
  const s = await withThread(t);
  const upgrade = { connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  assert.equal((await s.call("GET", "/v1/projects", undefined, upgrade)).status, 200);
  const other = await s.call("GET", attachPathOf(s.thread.id), undefined, { connection: "upgrade", upgrade: "h2c" });
  assert.deepEqual(other, { status: 404, body: { error: `no route /v1/threads/${s.thread.id}/attach`, code: "no-route" } });
});
