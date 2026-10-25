import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { duplexPair, PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer, type ClientOptions } from "ws";
import { encodeMessage, type AttachRequest } from "../attach-wire.ts";
import { terminalSize, type Terminal } from "../guest-terminal.ts";
import type { StreamEnd } from "../protocol.ts";
import { serveAttach, type AttachTiming, type Ending, type Look, type PylonDoor } from "./attach.ts";

const fast: AttachTiming = { pingMs: 60_000, waitMs: 5_000, pollMs: 10 };
const opening: AttachRequest = { size: terminalSize(100, 30), term: "xterm-256color" };

/** A program on a pty, scripted by the test. A hang-up ends it with `onHangUp`'s code, as Herdr detaching exits 0. */
function fakeTerminal(onHangUp: StreamEnd | null = { kind: "exited", code: 0 }) {
  const output = new PassThrough();
  const end = Promise.withResolvers<StreamEnd>();
  const calls: unknown[][] = [];
  const finish = (how: StreamEnd) => {
    output.end();
    end.resolve(how);
  };
  const terminal: Terminal = {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    async write(keys) { calls.push(["keys", Buffer.from(keys).toString()]); },
    async resize(size) { calls.push(["resize", size.cols, size.rows]); },
    async hangUp() {
      calls.push(["hangUp"]);
      if (onHangUp !== null) setTimeout(() => finish(onHangUp), 20);
    },
    done: end.promise,
  };
  return { terminal, calls, print: (text: string) => output.write(text), exit: (code: number) => finish({ kind: "exited", code }), lose: () => finish({ kind: "lost" }) };
}

/** A thread whose pylon the test moves, and whose node opens `opens` in turn: a terminal, or a ProbeError code. */
function fakeDoor(opens: (ReturnType<typeof fakeTerminal> | "not-running" | "unreachable")[], look: Look = { kind: "pylon", state: "running" }) {
  const asked: AttachRequest[] = [];
  const state = { look };
  const door: PylonDoor = {
    thread: "th-0123456789ab",
    look: () => state.look,
    async open(request) {
      asked.push(request);
      const next = opens.length > 1 ? opens.shift()! : opens[0];
      if (next === undefined) throw new Error("the test opened no more terminals");
      if (typeof next === "string") throw Object.assign(new Error(`rj-firebat: ${next}`), { code: next });
      return next.terminal;
    },
  };
  return { door, asked, state };
}

/** serveAttach on one end of an in-process WebSocket, and the client on the other, as the API would link them. */
async function attach(door: PylonDoor, options: { timing?: AttachTiming; request?: AttachRequest; autoPong?: boolean } = {}) {
  const stop = new AbortController();
  const served = Promise.withResolvers<void>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = createServer({ shouldUpgradeCallback: () => true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    serveAttach(ws, door, options.request ?? opening, stop.signal, options.timing ?? fast).then(served.resolve, served.reject);
  }));
  const [near, far] = duplexPair();
  server.emit("connection", near);
  const clientOptions: ClientOptions & { closeTimeout: number } = {
    createConnection: () => far as never, perMessageDeflate: false, autoPong: options.autoPong ?? true,
    // An in-process link answers a close frame before ws marks its own as sent, which leaves ws's close timer running.
    // @types/ws lacks the option.
    closeTimeout: 100,
  };
  const client = new WebSocket("ws://nexus/v1/threads/th-0123456789ab/attach", clientOptions);
  const received: unknown[] = [];
  const arrived = new EventTarget();
  client.on("message", (data, binary) => {
    received.push(binary ? Buffer.from(data as Buffer).toString() : JSON.parse(data.toString()));
    arrived.dispatchEvent(new Event("message"));
  });
  const closed = once(client, "close").then(([code]) => code as number);
  await once(client, "open");
  return {
    client, received, closed, served: served.promise,
    end: (why: Ending) => stop.abort(why),
    /** Waits until `count` messages have arrived. */
    async messages(count: number) {
      while (received.length < count) {
        await once(arrived, "message", { signal: AbortSignal.timeout(5000) }).catch(() => assert.fail(`only ${JSON.stringify(received)} arrived`));
      }
      return received.slice(0, count);
    },
  };
}

test("an attach waits for a paused pylon, saying each state it passes, then attaches and ends with Herdr's exit", async () => {
  const program = fakeTerminal();
  const { door, asked, state } = fakeDoor(["not-running", "not-running", "not-running", program], { kind: "pylon", state: "paused" });
  const a = await attach(door);
  assert.deepEqual(await a.messages(1), [{ type: "waiting", pylon: "paused" }]);
  state.look = { kind: "pylon", state: "spawning" };
  await a.messages(2);
  state.look = { kind: "pylon", state: "running" };
  await a.messages(3);
  program.print("herdr screen");
  await a.messages(4);
  program.exit(0);
  assert.equal(await a.closed, 1000);
  await a.served;
  assert.deepEqual(a.received, [
    { type: "waiting", pylon: "paused" }, { type: "waiting", pylon: "spawning" }, { type: "attached" }, "herdr screen", { type: "exit", code: 0 },
  ]);
  assert.ok(asked.length >= 4, "each try opens, which records human activity and wakes the node");
});

test("keys and resizes after attached reach the terminal in order, and a resize before it sets the opening size", async () => {
  const program = fakeTerminal();
  const { door, asked, state } = fakeDoor(["not-running", program], { kind: "pylon", state: "paused" });
  const a = await attach(door);
  await a.messages(1);
  a.client.send(encodeMessage({ type: "resize", size: terminalSize(140, 40) }));
  a.client.send(Buffer.from("typed too early"));
  await sleep(50);
  state.look = { kind: "pylon", state: "running" };
  await a.messages(2);
  assert.deepEqual(asked.at(-1)!.size, { cols: 140, rows: 40 }, "the terminal opened at the latest size");
  a.client.send(Buffer.from("ls\r"));
  a.client.send(encodeMessage({ type: "resize", size: terminalSize(80, 24) }));
  a.client.send(JSON.stringify({ type: "something-new" }));
  a.client.send(Buffer.from("exit\r"));
  await sleep(50);
  program.exit(0);
  await a.served;
  assert.deepEqual(program.calls, [["keys", "ls\r"], ["resize", 80, 24], ["keys", "exit\r"]], "keys before attached are dropped, and an unknown message is ignored");
});

test("a failed pylon fails at once, and an archive during the wait ends it as a conflict", async () => {
  const failed = fakeDoor([], { kind: "over", error: { kind: "failed", message: "the pylon of th-0123456789ab failed: setup failed" } });
  const a = await attach(failed.door);
  assert.equal(await a.closed, 1000);
  assert.deepEqual(a.received, [{ type: "error", kind: "failed", message: "the pylon of th-0123456789ab failed: setup failed" }]);
  assert.equal(failed.asked.length, 0, "nothing was opened");

  const archived = fakeDoor(["not-running"], { kind: "pylon", state: "paused" });
  const b = await attach(archived.door);
  await b.messages(1);
  archived.state.look = { kind: "over", error: { kind: "conflict", message: "thread th-0123456789ab is archived, so its pylon stays paused" } };
  assert.equal(await b.closed, 1000);
  assert.deepEqual(b.received.at(-1), { type: "error", kind: "conflict", message: "thread th-0123456789ab is archived, so its pylon stays paused" });
});

test("an unreachable node ends the wait, and so does the deadline", async () => {
  const unreachable = fakeDoor(["unreachable"]);
  const a = await attach(unreachable.door);
  await a.closed;
  assert.deepEqual(a.received, [{ type: "error", kind: "unreachable", message: "rj-firebat: unreachable" }]);

  const slow = fakeDoor(["not-running"], { kind: "pylon", state: "spawning" });
  const b = await attach(slow.door, { timing: { ...fast, waitMs: 100 } });
  await b.closed;
  assert.deepEqual(b.received.at(-1), { type: "error", kind: "failed", message: "the pylon of th-0123456789ab did not run within 0.1 s. It is spawning" });
});

test("a client that leaves while it waits opens nothing", async () => {
  const { door, asked } = fakeDoor(["not-running"], { kind: "pylon", state: "paused" });
  const a = await attach(door);
  await a.messages(1);
  const tries = asked.length;
  a.client.close();
  await a.served;
  await sleep(50);
  assert.ok(asked.length <= tries + 1, "the wait stopped");
});

test("a client that leaves hangs the terminal up and waits for the program to exit", async () => {
  const program = fakeTerminal();
  const a = await attach(fakeDoor([program]).door);
  await a.messages(1);
  a.client.close();
  await a.served;
  assert.deepEqual(program.calls, [["hangUp"]]);
  assert.deepEqual(await program.terminal.done, { kind: "exited", code: 0 }, "serveAttach resolved only after the program exited");
});

test("a client that stops answering pings is dropped, which hangs up", async () => {
  const program = fakeTerminal();
  const a = await attach(fakeDoor([program]).door, { timing: { ...fast, pingMs: 30 }, autoPong: false });
  await a.messages(1);
  await a.served;
  assert.deepEqual(program.calls, [["hangUp"]]);
});

test("a lost terminal is unreachable, and a conflict when the thread was archived meanwhile", async () => {
  const lost = fakeTerminal();
  const a = await attach(fakeDoor([lost]).door);
  await a.messages(1);
  lost.lose();
  assert.equal(await a.closed, 1000);
  const [, end] = a.received as [unknown, { type: string; kind: string; message: string }];
  assert.equal(end.kind, "unreachable");
  assert.match(end.message, /^the link to the pylon of th-0123456789ab was lost.*Herdr keeps the session/);

  const archived = fakeTerminal();
  const door = fakeDoor([archived]);
  const b = await attach(door.door);
  await b.messages(1);
  door.state.look = { kind: "over", error: { kind: "conflict", message: "thread th-0123456789ab is archived, so its pylon stays paused" } };
  archived.lose();
  await b.closed;
  assert.deepEqual(b.received.at(-1), { type: "error", kind: "conflict", message: "thread th-0123456789ab is archived, so its pylon stays paused" });
});

test("a delete ends the attach as a conflict, and a stopping control plane closes it with 1001", async () => {
  const deleted = fakeTerminal();
  const a = await attach(fakeDoor([deleted]).door);
  await a.messages(1);
  a.end("deleted");
  assert.equal(await a.closed, 1000);
  assert.deepEqual(a.received.at(-1), { type: "error", kind: "conflict", message: "thread th-0123456789ab is deleted" });
  assert.deepEqual(deleted.calls, [["hangUp"]]);

  const stopping = fakeTerminal();
  const b = await attach(fakeDoor([stopping]).door);
  await b.messages(1);
  b.end("stopping");
  assert.equal(await b.closed, 1001);
  assert.equal((b.received.at(-1) as { kind: string }).kind, "unreachable");
  assert.deepEqual(stopping.calls, [["hangUp"]]);
});

test("a message that is not an attach message closes the link with 1008 and hangs up", async () => {
  const program = fakeTerminal();
  const a = await attach(fakeDoor([program]).door);
  await a.messages(1);
  a.client.send("{not json");
  assert.equal(await a.closed, 1008);
  await a.served;
  assert.deepEqual(program.calls, [["hangUp"]]);
});
