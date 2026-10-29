import { test } from "node:test";
import assert from "node:assert/strict";
import { attachUrl, joinTerminal } from "./terminal.js";

/** A terminal as xterm.js exposes it: what it was written, and the keys and resizes it hands out. */
function fakeTerm() {
  const listeners = { data: [], binary: [], resize: [] };
  const on = (kind) => (listener) => {
    listeners[kind].push(listener);
    return { dispose: () => { listeners[kind] = listeners[kind].filter((l) => l !== listener); } };
  };
  const term = { written: [], focused: 0, write(bytes) { term.written.push(Buffer.from(bytes).toString()); }, focus() { term.focused++; }, onData: on("data"), onBinary: on("binary"), onResize: on("resize") };
  return { term, type: (text) => listeners.data.forEach((l) => l(text)), resize: (cols, rows) => listeners.resize.forEach((l) => l({ cols, rows })) };
}

/** A browser WebSocket: what the page sent, and the server's messages and close as events. */
function fakeSocket() {
  const socket = new EventTarget();
  Object.assign(socket, { readyState: 1, sent: [], closed: false, send(data) { socket.sent.push(typeof data === "string" ? data : Buffer.from(data).toString()); }, close() { socket.closed = true; } });
  const message = (data) => socket.dispatchEvent(Object.assign(new Event("message"), { data }));
  return { socket, text: (value) => message(JSON.stringify(value)), bytes: (text) => message(new TextEncoder().encode(text).buffer), close: () => socket.dispatchEvent(new Event("close")) };
}

test("the attach route is on the page's own host, over wss behind HTTPS, with the terminal's size", () => {
  assert.equal(attachUrl({ protocol: "https:", host: "nexus.example.ts.net" }, "th-0123456789ab", { cols: 120, rows: 40 }), "wss://nexus.example.ts.net/v1/threads/th-0123456789ab/attach?cols=120&rows=40&term=xterm-256color");
  assert.equal(attachUrl({ protocol: "http:", host: "127.0.0.1:7470" }, "th-x", { cols: 80, rows: 24 }), "ws://127.0.0.1:7470/v1/threads/th-x/attach?cols=80&rows=24&term=xterm-256color");
});

test("a joined terminal waits for the pylon, takes focus once attached, and carries keys, resizes and output", () => {
  const t = fakeTerm();
  const s = fakeSocket();
  const statuses = [];
  joinTerminal(t.term, s.socket, (status) => statuses.push(status));
  s.text({ type: "waiting", pylon: "paused" });
  assert.deepEqual(statuses, [{ text: "Waiting for the pylon, which is paused. Attaching wakes it.", over: false }]);
  assert.equal(t.term.focused, 0);
  s.text({ type: "attached" });
  assert.deepEqual(statuses.at(-1), { text: null, over: false });
  assert.equal(t.term.focused, 1, "attached, it is ready to type into");
  s.text({ type: "a type this end does not know" });
  assert.equal(statuses.length, 2);
  s.bytes("Claude Code\r\n❯ ");
  assert.deepEqual(t.term.written, ["Claude Code\r\n❯ "]);
  t.type("hello\r");
  t.resize(100, 30);
  assert.deepEqual(s.socket.sent, ["hello\r", JSON.stringify({ type: "resize", cols: 100, rows: 30 })]);
  s.text({ type: "exit", code: 0 });
  s.close();
  assert.deepEqual(statuses.slice(2), [{ text: "Detached from Herdr. Its sessions keep running.", over: true }], "the close after an exit says nothing more");
  t.type("late");
  assert.equal(s.socket.sent.length, 2, "an ended terminal sends no keys");
});

test("a close before any message is a refusal, one after is a dropped link, and an error ends the terminal with its reason", () => {
  const ends = (drive) => {
    const s = fakeSocket();
    const statuses = [];
    joinTerminal(fakeTerm().term, s.socket, (status) => statuses.push(status));
    drive(s);
    return statuses.filter((status) => status.over).map((status) => status.text);
  };
  assert.deepEqual(ends((s) => s.close()), ["The terminal could not attach. The thread may be archived, or the control plane unreachable."]);
  assert.deepEqual(ends((s) => { s.text({ type: "attached" }); s.close(); }), ["The connection dropped. Herdr keeps the session, so attach again."]);
  assert.deepEqual(ends((s) => { s.text({ type: "error", kind: "conflict", message: "thread th-x is archived, so its pylon stays paused" }); s.close(); }), ["thread th-x is archived, so its pylon stays paused"]);
});

test("detaching closes the socket, says Herdr keeps its sessions, and stops sending keys", () => {
  const t = fakeTerm();
  const s = fakeSocket();
  const statuses = [];
  const detach = joinTerminal(t.term, s.socket, (status) => statuses.push(status));
  s.text({ type: "attached" });
  detach();
  s.close();
  t.type("x");
  assert.ok(s.socket.closed);
  assert.deepEqual(s.socket.sent, []);
  assert.deepEqual(statuses.at(-1), { text: "Detached. Herdr keeps its sessions running.", over: true });
  assert.equal(statuses.filter((status) => status.over).length, 1);
});
