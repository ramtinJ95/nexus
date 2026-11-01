import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { duplexPair, PassThrough, Writable } from "node:stream";
import { WebSocket, WebSocketServer, type ClientOptions } from "ws";
import { encodeMessage, parseClientMessage, type ServerMessage } from "../attach-wire.ts";
import { attachTerminal, type Tty } from "./attach.ts";
import { CliError } from "./transport.ts";

/** What the fake terminal's exit throws, as process.exit would not return. */
class Exited extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exited ${code}`);
    this.code = code;
  }
}

/** A terminal that records its raw mode, what was written to it, its status lines and exits, and whose size the test sets. */
function fakeTty(options: { isTTY?: boolean; writes?: () => boolean } = {}) {
  const modes: boolean[] = [];
  const written: string[] = [];
  const status: string[] = [];
  const exits: number[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: options.isTTY ?? true, setRawMode: (raw: boolean) => modes.push(raw) });
  const output = Object.assign(new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  }), { isTTY: options.isTTY ?? true, columns: 100, rows: 30 });
  if (options.writes !== undefined) output.write = options.writes as never;
  const exit = (code: number) => {
    exits.push(code);
    throw new Exited(code);
  };
  const tty: Tty = { input, output, term: "xterm-ghostty", status: (line) => status.push(line), exit };
  return { tty, input, output, modes, written, status, exits };
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
const until = async (done: () => boolean) => {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 5));
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

test("every other end is a CliError of its own kind, and puts the terminal and its screen modes back", async () => {
  const ends: [ServerMessage | "garbage", (err: unknown) => boolean][] = [
    [{ type: "exit", code: 3 }, kindOf("failed", /^Herdr in the pylon of th-0123456789ab exited 3$/)],
    [{ type: "error", kind: "conflict", message: "thread th-0123456789ab is deleted" }, kindOf("conflict", /^thread th-0123456789ab is deleted$/)],
    ["garbage", kindOf("failed", /a message attach does not understand/)],
  ];
  for (const [end, expected] of ends) {
    const t = fakeTty();
    const cp = controlPlane((ws) => {
      send(ws, { type: "attached" });
      if (end === "garbage") ws.send("{not json");
      else endWith(ws, end);
    });
    const attaching = attachTerminal(cp.connect, "th-0123456789ab", t.tty);
    await assert.rejects(attaching, expected, JSON.stringify(end));
    assert.deepEqual(t.modes, [true, false], `restored after ${JSON.stringify(end)}`);
    assert.ok(t.written.at(-1)?.startsWith("\x1b[?1049l"), `the screen modes Herdr set are reset after ${JSON.stringify(end)}, because Herdr did not`);
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
  const attaching = attachTerminal(cp.connect, "th-0123456789ab", t.tty, { tries: 0, delayMs: () => 0, steadyMs: 0 });
  while (cp.clients[0]?.isPaused !== true) await new Promise((resolve) => setTimeout(resolve, 5));
  accepting = true;
  t.output.emit("drain");
  assert.equal(cp.clients[0]!.isPaused, false);
  cp.clients[0]!.close();
  await assert.rejects(attaching, kindOf("unreachable", /dropped/));
});

const path = (cols: number) => `/v1/threads/th-0123456789ab/attach?cols=${cols}&rows=30&term=xterm-ghostty`;

test("a link that drops after attached links again with the terminal's size, staying raw and dropping the keys typed in between", async () => {
  const t = fakeTty();
  const received: string[] = [];
  let links = 0;
  const cp = controlPlane((ws) => {
    const n = ++links;
    send(ws, { type: "attached" });
    ws.send(Buffer.from(`screen ${n}`), { binary: true });
    ws.on("message", (data, binary) => {
      if (!binary) return;
      received.push(`${n}:${data.toString()}`);
      if (data.toString() === "q") endWith(ws, { type: "exit", code: 0 });
    });
  });
  const attaching = attachTerminal(cp.connect, "th-0123456789ab", t.tty, { tries: 8, delayMs: () => 50, steadyMs: 0 });
  await until(() => t.written.includes("screen 1"));
  t.input.write("a");
  await until(() => received.length === 1);
  cp.links[0]!.destroy(new Error("reset"));
  await until(() => t.status.length === 1);
  assert.match(t.status[0]!, /^the connection to the control plane dropped.*\. Attaching again in 0\.05 s, Ctrl-C quits$/);
  assert.ok(t.written.at(-1)!.startsWith("\x1b[?1049l"), "the screen leaves Herdr's modes while it waits");
  t.input.write("typed in the gap");
  t.output.columns = 120;
  await until(() => t.written.includes("screen 2"));
  t.input.write("q");
  await attaching;
  assert.deepEqual(cp.paths, [path(100), path(120)]);
  assert.deepEqual(received, ["1:a", "2:q"], "keys typed while reconnecting reach no session");
  assert.deepEqual(t.modes, [true, false], "raw through the gap, and back once Herdr detaches");
});

test("Ctrl-C while attach links again exits 130 with the terminal put back", async () => {
  const t = fakeTty();
  const cp = controlPlane((ws) => send(ws, { type: "attached" }));
  const attaching = attachTerminal(cp.connect, "th-0123456789ab", t.tty, { tries: 8, delayMs: () => 60_000, steadyMs: 0 });
  await until(() => t.modes.length === 1);
  cp.links[0]!.destroy(new Error("reset"));
  await until(() => t.status.length === 1);
  t.input.write("\x03");
  await assert.rejects(attaching, (err) => err instanceof Exited && err.code === 130);
  assert.deepEqual(t.exits, [130]);
  assert.deepEqual(t.modes, [true, false]);
  assert.equal(cp.paths.length, 1);
});

test("an unreachable error, such as the control plane stopping for a deploy, links again", async () => {
  const t = fakeTty();
  let links = 0;
  const cp = controlPlane((ws) => {
    send(ws, { type: "attached" });
    if (++links === 1) endWith(ws, { type: "error", kind: "unreachable", message: "the control plane is stopping" });
    else endWith(ws, { type: "exit", code: 0 });
  });
  await attachTerminal(cp.connect, "th-0123456789ab", t.tty, { tries: 8, delayMs: () => 0, steadyMs: 0 });
  assert.equal(cp.paths.length, 2);
  assert.deepEqual(t.status, ["the control plane is stopping. Attaching again in 0 s, Ctrl-C quits"]);
  assert.deepEqual(t.modes, [true, false]);
});

test("a refusal of another kind when linking again ends the attach with it", async () => {
  const t = fakeTty();
  const cp = controlPlane((ws) => send(ws, { type: "attached" }));
  let calls = 0;
  const connect = (path: string) => ++calls === 1 ? cp.connect(path) : Promise.reject(new CliError("conflict", "thread th-0123456789ab is archived"));
  const attaching = attachTerminal(connect, "th-0123456789ab", t.tty, { tries: 8, delayMs: () => 0, steadyMs: 0 });
  await until(() => t.modes.length === 1);
  cp.links[0]!.destroy(new Error("reset"));
  await assert.rejects(attaching, kindOf("conflict", /^thread th-0123456789ab is archived$/));
  assert.equal(calls, 2);
  assert.deepEqual(t.modes, [true, false]);
});

test("attach gives up once linking again fails every try, and says Herdr keeps the session", async () => {
  const t = fakeTty();
  const cp = controlPlane((ws) => send(ws, { type: "attached" }));
  let calls = 0;
  const connect = (path: string) => ++calls === 1 ? cp.connect(path) : Promise.reject(new CliError("unreachable", "cannot reach nexus:443: ECONNREFUSED"));
  const attaching = attachTerminal(connect, "th-0123456789ab", t.tty, { tries: 3, delayMs: () => 0, steadyMs: 0 });
  await until(() => t.modes.length === 1);
  cp.links[0]!.destroy(new Error("reset"));
  await assert.rejects(attaching, kindOf("unreachable", /^cannot reach nexus:443: ECONNREFUSED, and attaching again failed 3 times\. Herdr keeps the session, so `nexus attach th-0123456789ab` again$/));
  assert.equal(calls, 4, "the first link and three tries");
  assert.equal(t.status.length, 3, "a line for each try");
  assert.deepEqual(t.modes, [true, false]);
});

test("a link that attaches and drops at once counts as a failed try, so a pylon that keeps dropping it is not tried for good", async () => {
  const t = fakeTty();
  let links = 0;
  const cp = controlPlane((ws) => {
    send(ws, { type: "attached" });
    if (++links > 10) return endWith(ws, { type: "exit", code: 0 });
    endWith(ws, { type: "error", kind: "unreachable", message: "the link to the pylon of th-0123456789ab was lost" });
  });
  await assert.rejects(attachTerminal(cp.connect, "th-0123456789ab", t.tty, { tries: 3, delayMs: () => 0, steadyMs: 60_000 }), kindOf("unreachable", /was lost, and attaching again failed 3 times/));
  assert.equal(links, 4, "the first link and three tries");
});

test("a control plane that cannot be reached on the first link fails at once", async () => {
  const t = fakeTty();
  let calls = 0;
  const connect = () => { calls++; return Promise.reject(new CliError("unreachable", "cannot reach nexus:443: ECONNREFUSED")); };
  await assert.rejects(attachTerminal(connect, "th-0123456789ab", t.tty, { tries: 8, delayMs: () => 0, steadyMs: 0 }), kindOf("unreachable", /^cannot reach nexus:443/));
  assert.equal(calls, 1);
  assert.deepEqual(t.status, []);
});
