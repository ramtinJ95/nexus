import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { duplexPair, PassThrough, Writable } from "node:stream";
import { WebSocket, WebSocketServer, type ClientOptions } from "ws";
import { encodeMessage, parseClientMessage, type ServerMessage } from "../attach-wire.ts";
import { attachTerminal, type Tty } from "./attach.ts";
import { CliError } from "./transport.ts";

/** A terminal that records its raw mode, what was written to it and its status lines, and whose size the test sets. */
function fakeTty(options: { isTTY?: boolean; writes?: () => boolean } = {}) {
  const modes: boolean[] = [];
  const written: string[] = [];
  const status: string[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: options.isTTY ?? true, setRawMode: (raw: boolean) => modes.push(raw) });
  const output = Object.assign(new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  }), { isTTY: options.isTTY ?? true, columns: 100, rows: 30 });
  if (options.writes !== undefined) output.write = options.writes as never;
  const tty: Tty = { input, output, term: "xterm-ghostty", status: (line) => status.push(line) };
  return { tty, input, output, modes, written, status };
}

/**
 * A control plane in-process that runs `serve` on each attach, and a `connect` that reaches it as transport.upgrade
 * would. `paths` records each path asked for.
 */
function controlPlane(serve: (ws: WebSocket) => void) {
  const paths: string[] = [];
  const clients: WebSocket[] = [];
  const links: { destroy(err?: Error): void }[] = [];
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = createServer({ shouldUpgradeCallback: () => true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, serve));
  async function connect(path: string): Promise<WebSocket> {
    paths.push(path);
    const [near, far] = duplexPair();
    links.push(far);
    server.emit("connection", near);
    // An in-process link answers a close frame before ws marks its own as sent, which leaves ws's close timer running.
    const options: ClientOptions & { closeTimeout: number } = { createConnection: () => far as never, perMessageDeflate: false, closeTimeout: 100 };
    const ws = new WebSocket(`ws://nexus${path}`, options);
    clients.push(ws);
    await new Promise((resolve) => ws.once("open", () => resolve(ws.pause())));
    return ws;
  }
  return { connect, paths, clients, links };
}

const send = (ws: WebSocket, message: ServerMessage) => ws.send(encodeMessage(message));
/** The final message and the close, as the control plane ends an attach. */
const endWith = (ws: WebSocket, message: ServerMessage) => {
  send(ws, message);
  ws.close(1000);
};
const kindOf = (kind: string, message: RegExp) => (err: unknown) => err instanceof CliError && err.kind === kind && message.test(err.message);

test("attach says each state the pylon waits in, then gives it the terminal raw, with keys, resizes and output, until Herdr detaches", async () => {
  const t = fakeTty();
  const received: unknown[] = [];
  const cp = controlPlane((ws) => {
    ws.on("message", (data, binary) => {
      received.push(binary ? data.toString() : parseClientMessage(data.toString()));
      if (binary && data.toString() === "q") endWith(ws, { type: "exit", code: 0 });
    });
    send(ws, { type: "waiting", pylon: "paused" });
    send(ws, { type: "waiting", pylon: "spawning" });
    send(ws, { type: "attached" });
    ws.send(Buffer.from("herdr screen"), { binary: true });
  });
  const attaching = attachTerminal(cp.connect, "th-0123456789ab", t.tty);
  while (t.written.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(t.modes, [true], "raw once attached");
  t.output.columns = 140;
  t.output.rows = 40;
  t.output.emit("resize");
  t.input.write("q");
  await attaching;
  assert.deepEqual(cp.paths, ["/v1/threads/th-0123456789ab/attach?cols=100&rows=30&term=xterm-ghostty"]);
  assert.deepEqual(t.status, ["waiting for the pylon of th-0123456789ab, which is paused", "waiting for the pylon of th-0123456789ab, which is spawning"]);
  assert.deepEqual(t.written, ["herdr screen"]);
  assert.deepEqual(received, [{ type: "resize", size: { cols: 140, rows: 40 } }, "q"]);
  assert.deepEqual(t.modes, [true, false], "the terminal is back as it was");
  assert.equal(t.input.isPaused(), true, "stdin stops being read, so the process can exit");
});

test("every other end is a CliError of its own kind, and puts the terminal back", async () => {
  const ends: [ServerMessage | "drop" | "garbage", (err: unknown) => boolean][] = [
    [{ type: "exit", code: 3 }, kindOf("failed", /^Herdr in the pylon of th-0123456789ab exited 3$/)],
    [{ type: "error", kind: "conflict", message: "thread th-0123456789ab is deleted" }, kindOf("conflict", /^thread th-0123456789ab is deleted$/)],
    [{ type: "error", kind: "unreachable", message: "the control plane is stopping" }, kindOf("unreachable", /stopping/)],
    ["drop", kindOf("unreachable", /^the connection to the control plane dropped.*Herdr keeps the session, so `nexus attach th-0123456789ab` again$/)],
    ["garbage", kindOf("failed", /a message attach does not understand/)],
  ];
  for (const [end, expected] of ends) {
    const t = fakeTty();
    const cp = controlPlane((ws) => {
      send(ws, { type: "attached" });
      if (end === "garbage") ws.send("{not json");
      else if (end !== "drop") endWith(ws, end);
    });
    const attaching = attachTerminal(cp.connect, "th-0123456789ab", t.tty);
    if (end === "drop") {
      while (t.modes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      cp.links[0]!.destroy(new Error("reset"));
    }
    await assert.rejects(attaching, expected, JSON.stringify(end));
    assert.deepEqual(t.modes, [true, false], `restored after ${JSON.stringify(end)}`);
  }
});

test("an error before attached leaves the terminal as it was", async () => {
  const t = fakeTty();
  const cp = controlPlane((ws) => {
    send(ws, { type: "waiting", pylon: "paused" });
    endWith(ws, { type: "error", kind: "failed", message: "the pylon of th-0123456789ab failed: setup failed" });
  });
  await assert.rejects(attachTerminal(cp.connect, "th-0123456789ab", t.tty), kindOf("failed", /setup failed/));
  assert.deepEqual(t.modes, []);
});

test("attach needs a terminal, and asks the control plane for nothing without one", async () => {
  const t = fakeTty({ isTTY: false });
  const cp = controlPlane(() => assert.fail("connected"));
  await assert.rejects(attachTerminal(cp.connect, "th-0123456789ab", t.tty), kindOf("invalid", /attach needs a terminal/));
  assert.deepEqual(cp.paths, []);
});

test("output the terminal cannot take yet pauses the socket until it drains", async () => {
  let accepting = false;
  const t = fakeTty({ writes: () => accepting });
  const cp = controlPlane((ws) => {
    send(ws, { type: "attached" });
    ws.send(Buffer.from("a lot"), { binary: true });
  });
  const attaching = attachTerminal(cp.connect, "th-0123456789ab", t.tty);
  while (cp.clients[0]?.isPaused !== true) await new Promise((resolve) => setTimeout(resolve, 5));
  accepting = true;
  t.output.emit("drain");
  assert.equal(cp.clients[0]!.isPaused, false);
  cp.clients[0]!.close();
  await assert.rejects(attaching, kindOf("unreachable", /dropped/));
});
