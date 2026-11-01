import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { attachPath, defaultTerm } from "../../attach-route.ts";
import { attachUrl, clipboardOf, hiddenDetachMs, joinTerminal, keepAttached, keyFor, landing, steadyMs } from "./terminal.js";
import { styleAdopter } from "./term-styles.js";

/** A terminal as xterm.js exposes it: what it was written, how often it was reset, and the keys and resizes it hands out. */
function fakeTerm() {
  const listeners = { data: [], binary: [], resize: [], parsed: [] };
  const on = (kind) => (listener) => {
    listeners[kind].push(listener);
    return { dispose: () => { listeners[kind] = listeners[kind].filter((l) => l !== listener); } };
  };
  const term = { cols: 80, rows: 24, written: [], focused: 0, resets: 0, write(bytes) { term.written.push(Buffer.from(bytes).toString()); listeners.parsed.forEach((l) => l()); }, focus() { term.focused++; }, reset() { term.resets++; }, onData: on("data"), onBinary: on("binary"), onResize: on("resize"), onWriteParsed: on("parsed") };
  return { term, type: (text) => listeners.data.forEach((l) => l(text)), resize: (cols, rows) => listeners.resize.forEach((l) => l({ cols, rows })) };
}

/** A browser WebSocket: what the page sent, and the server's messages and close as events. */
function fakeSocket() {
  const socket = new EventTarget();
  Object.assign(socket, { readyState: 1, sent: [], closed: false, send(data) { socket.sent.push(typeof data === "string" ? data : Buffer.from(data).toString()); }, close() { socket.closed = true; } });
  const message = (data) => socket.dispatchEvent(Object.assign(new Event("message"), { data }));
  return { socket, open: () => socket.dispatchEvent(new Event("open")), text: (value) => message(JSON.stringify(value)), bytes: (text) => message(new TextEncoder().encode(text).buffer), close: () => socket.dispatchEvent(new Event("close")) };
}

test("the attach route is on the page's own host, over wss behind HTTPS, with the terminal's size and the pane it lands in", () => {
  assert.equal(attachUrl({ protocol: "https:", host: "nexus.example.ts.net" }, "th-0123456789ab", { cols: 120, rows: 40 }), "wss://nexus.example.ts.net/v1/threads/th-0123456789ab/attach?cols=120&rows=40&term=xterm-256color");
  assert.equal(attachUrl({ protocol: "http:", host: "127.0.0.1:7470" }, "th-x", { cols: 80, rows: 24 }), "ws://127.0.0.1:7470/v1/threads/th-x/attach?cols=80&rows=24&term=xterm-256color");
  assert.equal(attachUrl({ protocol: "http:", host: "127.0.0.1:7470" }, "th-x", { cols: 80, rows: 24 }, "w2:p1"), "ws://127.0.0.1:7470/v1/threads/th-x/attach?cols=80&rows=24&term=xterm-256color&pane=w2%3Ap1", "a session's Show in terminal lands in its pane");
});

test("the attach URL's path is the route's attachPath for the same size and pane", () => {
  const size = { cols: 100, rows: 30 };
  for (const pane of [null, "w1:p2"]) {
    const url = new URL(attachUrl({ protocol: "https:", host: "nexus.example.ts.net" }, "th-0123456789ab", size, pane));
    assert.equal(url.pathname + url.search, attachPath("th-0123456789ab", { size, term: defaultTerm, ...(pane === null ? {} : { pane }) }), `pane ${pane}`);
  }
});

test("a joined terminal waits for the pylon, takes focus once attached, and carries keys, resizes and output", () => {
  const t = fakeTerm();
  const s = fakeSocket();
  const statuses = [];
  joinTerminal(t.term, s.socket, (status) => statuses.push(status));
  t.term.cols = 132;
  s.open();
  assert.deepEqual(s.socket.sent, [JSON.stringify({ type: "resize", cols: 132, rows: 24 })], "a resize while it connected replaces the size it opens with");
  s.socket.sent.length = 0;
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
  assert.deepEqual(statuses.slice(2), [{ text: "Detached from Herdr. Its sessions keep running.", over: true, why: "exit" }], "the close after an exit says nothing more");
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
  assert.deepEqual(statuses.at(-1), { text: "Detached. Herdr keeps its sessions running.", over: true, why: "detached" });
  assert.equal(statuses.filter((status) => status.over).length, 1);
});

const key = (key, mods = {}) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });

test("Shift+Enter and Option+Enter send ESC CR, a newline in Claude Code, and other keys stay xterm.js's", () => {
  assert.equal(keyFor(key("Enter", { shiftKey: true })), "\x1b\r");
  assert.equal(keyFor(key("Enter", { altKey: true })), "\x1b\r");
  assert.equal(keyFor(key("Enter")), undefined, "Enter sends its own CR");
  assert.equal(keyFor(key("Enter", { ctrlKey: true, shiftKey: true })), undefined);
  assert.equal(keyFor(key("Enter", { metaKey: true })), undefined);
  assert.equal(keyFor(key("@", { altKey: true })), undefined, "Option+2 makes @ on a Swedish layout");
  assert.equal(keyFor(key("Enter", { shiftKey: true, isComposing: true })), undefined, "an input method's Enter confirms its composition");
  assert.equal(keyFor(key("Enter", { shiftKey: true, keyCode: 229 })), undefined, "a keydown during composition has keyCode 229");
});

test("OSC 52 writes the clipboard but X11's primary, and a query reads nothing from it", async () => {
  const written = [];
  let reads = 0;
  const provider = clipboardOf({ writeText: async (text) => { written.push(text); }, readText: async () => { reads++; return "a password"; } });
  await provider.writeText("c", "copied");
  await provider.writeText("", "default selection");
  await provider.writeText("p", "primary");
  assert.deepEqual(written, ["copied", "default selection"]);
  assert.equal(await provider.readText("c"), "");
  assert.equal(reads, 0, "the pylon never reads the person's clipboard");
  await clipboardOf({ writeText: () => Promise.reject(new DOMException("Document is not focused.", "NotAllowedError")) }).writeText("c", "x");
  await clipboardOf(undefined).writeText("c", "x");
});

/** A page whose visibility a test sets, as `document` reports it. */
function fakePage() {
  const page = new EventTarget();
  page.visibilityState = "visible";
  return { page, show: (state) => { page.visibilityState = state; page.dispatchEvent(new Event("visibilitychange")); } };
}

/** A terminal kept attached over fake sockets, which `sockets` lists in the order it opened them. */
function kept(t) {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { term, type } = fakeTerm();
  const sockets = [];
  const statuses = [];
  const lands = landing(term);
  const { page, show } = fakePage();
  const close = keepAttached(term, () => {
    const s = fakeSocket();
    sockets.push(s);
    return s.socket;
  }, (status) => {
    lands.heard(status);
    statuses.push(status);
  }, page);
  return { term, type, sockets, statuses, lands, show, close, tick: (ms) => mock.timers.tick(ms) };
}

test("a dropped link attaches again after 1 s, then 2 s while each try is refused, and anew once one attaches", (t) => {
  const k = kept(t);
  k.sockets[0].text({ type: "attached" });
  k.sockets[0].close();
  assert.deepEqual(k.statuses.at(-1), { text: "The connection dropped. Attaching again in 1 s.", over: false });
  k.tick(999);
  assert.equal(k.sockets.length, 1);
  k.tick(1);
  assert.equal(k.sockets.length, 2);
  k.sockets[1].close();
  assert.deepEqual(k.statuses.at(-1), { text: "The connection dropped. Attaching again in 2 s.", over: false }, "a control plane restarting refuses the retry");
  k.tick(1999);
  assert.equal(k.sockets.length, 2);
  k.tick(1);
  assert.equal(k.sockets.length, 3);
  k.sockets[2].text({ type: "waiting", pylon: "starting" });
  const resets = k.term.resets;
  k.sockets[2].text({ type: "attached" });
  assert.equal(k.term.resets, resets + 1, "a reattach starts from a clean terminal");
  assert.deepEqual(k.statuses.slice(-2), [{ text: "Waiting for the pylon, which is starting. Attaching wakes it.", over: false }, { text: null, over: false }]);
  k.tick(steadyMs);
  k.sockets[2].close();
  assert.deepEqual(k.statuses.at(-1), { text: "The connection dropped. Attaching again in 1 s.", over: false }, "attached for long enough, the backoff starts over");
  assert.equal(k.statuses.filter((s) => s.over).length, 0);
});

test("a reattach sends none of the keys typed while it waited, and an unreachable error says why it attaches again", (t) => {
  const k = kept(t);
  const typed = k.type;
  k.sockets[0].text({ type: "attached" });
  typed("before");
  k.sockets[0].close();
  typed("in the gap");
  k.tick(1000);
  k.sockets[1].open();
  typed("while it attaches");
  k.sockets[1].text({ type: "attached" });
  typed("after");
  assert.deepEqual(k.sockets[0].socket.sent, ["before"]);
  assert.deepEqual(k.sockets[1].socket.sent, [JSON.stringify({ type: "resize", cols: 80, rows: 24 }), "after"]);
  k.sockets[1].text({ type: "error", kind: "unreachable", message: "infra-testbench: pylon pylon-x is not answering: it did not start a process within 10 s. It may be out of memory or busy" });
  k.sockets[1].close();
  assert.deepEqual(k.statuses.at(-1), { text: "Infra-testbench: pylon pylon-x is not answering: it did not start a process within 10 s. It may be out of memory or busy. Attaching again in 2 s.", over: false });
  k.tick(2000);
  assert.equal(k.sockets.length, 3, "same as a drop, it attaches again");
});

test("a join that attaches and drops at once counts as a failed try, so a pylon that keeps dropping it is not tried for good", (t) => {
  const k = kept(t);
  for (let i = 0; i <= 8; i++) {
    k.sockets[i].text({ type: "attached" });
    k.tick(steadyMs - 1);
    k.sockets[i].close();
    k.tick(30_000);
  }
  assert.equal(k.sockets.length, 9, "the first join and 8 tries");
  assert.equal(k.statuses.at(-1).over, true);
  assert.match(k.statuses.at(-1).text, /failed 8 times/);
});

test("a session shown while the link reattaches waits for the reattach to draw, so the reattach's own focus cannot undo it", async (t) => {
  const k = kept(t);
  const now = (promise) => Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve("waiting")))]);
  k.sockets[0].text({ type: "attached" });
  assert.equal(await now(k.lands.landed()), "waiting", "attached, but Herdr's client has not drawn");
  k.sockets[0].bytes("herdr");
  assert.equal(await now(k.lands.landed()), true);
  k.sockets[0].close();
  const during = k.lands.landed();
  assert.equal(await now(during), "waiting", "a dropped link has not landed");
  k.tick(1000);
  k.sockets[1].text({ type: "attached" });
  assert.equal(await now(during), "waiting");
  k.sockets[1].bytes("herdr again");
  assert.equal(await now(during), true, "lands once the reattach draws");
  k.close();
  assert.equal(await now(k.lands.landed()), false, "a detached terminal never lands");
});

test("an exit, a conflict and a first refusal end the terminal without a second socket", (t) => {
  const ends = [
    (s) => { s.text({ type: "attached" }); s.text({ type: "exit", code: 0 }); s.close(); },
    (s) => { s.text({ type: "error", kind: "conflict", message: "thread th-x is archived, so its pylon stays paused" }); s.close(); },
    (s) => s.close(),
  ];
  for (const drive of ends) {
    const k = kept(t);
    drive(k.sockets[0]);
    k.tick(60_000);
    assert.equal(k.sockets.length, 1);
    assert.equal(k.statuses.at(-1).over, true);
    mock.timers.reset();
  }
});

test("a link that drops while the page is hidden attaches again when it shows, at once", (t) => {
  const k = kept(t);
  k.sockets[0].text({ type: "attached" });
  k.show("hidden");
  k.sockets[0].close();
  assert.deepEqual(k.statuses.at(-1), { text: "The connection dropped. It attaches again when the page shows.", over: false });
  k.tick(60 * 60_000);
  assert.equal(k.sockets.length, 1);
  k.show("visible");
  assert.equal(k.sockets.length, 2);
});

test("a page hidden for 10 minutes detaches so the pylon can pause, and attaches again when it shows", (t) => {
  const k = kept(t);
  k.sockets[0].text({ type: "attached" });
  k.show("hidden");
  k.tick(9 * 60_000);
  k.show("visible");
  k.show("hidden");
  k.tick(9 * 60_000);
  assert.equal(k.sockets[0].socket.closed, false, "showing again before 10 minutes keeps the terminal");
  k.tick(60_000);
  assert.ok(k.sockets[0].socket.closed);
  assert.deepEqual(k.statuses.at(-1), { text: "Detached while the page was hidden, so the pylon can pause. It attaches again when the page shows.", over: false });
  assert.equal(hiddenDetachMs, 10 * 60_000);
  k.show("visible");
  assert.equal(k.sockets.length, 2);
});

test("detaching while a retry waits opens nothing more and says it detached once", (t) => {
  const k = kept(t);
  k.sockets[0].text({ type: "attached" });
  k.sockets[0].close();
  k.close();
  k.close();
  k.tick(60_000);
  assert.equal(k.sockets.length, 1);
  assert.deepEqual(k.statuses.filter((s) => s.over), [{ text: "Detached. Herdr keeps its sessions running.", over: true, why: "detached" }]);
});

test("after 8 failed tries the terminal ends and says to attach again", (t) => {
  const k = kept(t);
  k.sockets[0].text({ type: "attached" });
  k.sockets[0].close();
  for (let i = 1; i <= 8; i++) {
    k.tick(30_000);
    assert.equal(k.sockets.length, i + 1);
    k.sockets[i].text({ type: "error", kind: "unreachable", message: "the control plane is stopping, so attach again once it is back" });
    k.sockets[i].close();
  }
  k.tick(60_000);
  assert.equal(k.sockets.length, 9);
  assert.equal(k.statuses.at(-1).over, true);
  assert.match(k.statuses.at(-1).text, /8 times/);
});

/**
 * adoptStyles from term-styles.js on a screen element shaped as xterm.js 6 builds it: its style elements and its row
 * container as children. `change(node, kind)` is a DOM mutation of that kind on that node, which wakes the observer
 * only as the browser would for the options it observes with.
 */
function styledScreen() {
  const node = (name, parent, extra = {}) => ({ name, parent, ...extra });
  const screen = node("screen", null, { children: [] });
  const style = (text) => { const s = node("style", screen, { textContent: text }); screen.children.push(s); return s; };
  const rows = node("rows", screen);
  screen.children.push(rows);
  const row = node("row", rows);
  screen.querySelectorAll = () => screen.children.filter((c) => c.name === "style");
  const copies = [];
  const watched = [];
  class Sheet { replaceSync(text) { copies.push(text); } }
  class Observer {
    constructor(callback) { this.callback = callback; this.on = true; watched.push(this); this.targets = new Map(); }
    observe(target, options) { this.targets.set(target, options); }
    disconnect() { this.on = false; }
  }
  const change = (target, kind) => {
    for (const observer of watched) {
      if (!observer.on) continue;
      for (let at = target; at !== null; at = at.parent) {
        const options = observer.targets.get(at);
        if (options?.[kind] && (at === target || options.subtree)) { observer.callback([]); break; }
      }
    }
  };
  const document = { adoptedStyleSheets: [] };
  const { adoptStyles } = styleAdopter({ CSSStyleSheet: Sheet, MutationObserver: Observer, document });
  return { screen, style, row, copies, change, document, adoptStyles };
}

test("the terminal copies each xterm.js style once per change of its text, and a row's change copies nothing", () => {
  const t = styledScreen();
  const theme = t.style(".theme { color: red }");
  const stop = t.adoptStyles(t.screen);
  assert.deepEqual(t.copies, [".theme { color: red }"], "the style already there is copied as the terminal opens");
  assert.equal(t.document.adoptedStyleSheets.length, 1);

  t.change(t.row, "childList");
  t.change(t.row, "characterData");
  assert.deepEqual(t.copies, [".theme { color: red }"], "rewriting a row wakes nothing");
  t.change(t.screen, "childList");
  assert.deepEqual(t.copies, [".theme { color: red }"], "a style whose text is unchanged is not copied again");

  t.style(".cells { height: 17px }");
  t.change(t.screen, "childList");
  assert.deepEqual(t.copies, [".theme { color: red }", ".cells { height: 17px }"], "a style xterm.js adds later is copied");
  theme.textContent = ".theme { color: blue }";
  t.change(theme, "childList");
  assert.deepEqual(t.copies.at(-1), ".theme { color: blue }", "a style's new text is copied");
  assert.equal(t.copies.length, 3);

  stop();
  assert.equal(t.document.adoptedStyleSheets.length, 0, "closing the terminal drops its sheets");
});
