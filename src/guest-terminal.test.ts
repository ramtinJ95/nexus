import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { openTerminal, terminalSize, type Terminal } from "./guest-terminal.ts";
import { processStream } from "./process-stream.ts";
import { attachScript } from "./sessions.ts";

/** Each terminal runs the relay on this machine, as a pylon would over its raw pipe. */
function local(argvs: (readonly string[])[] = [], stderr: string[] = []) {
  return async (argv: readonly string[]) => {
    argvs.push(argv);
    return processStream(argv[0]!, argv.slice(1), (text) => { stderr.push(text); });
  };
}

/** Everything the terminal printed so far, read as it arrives. */
function screen(terminal: Terminal) {
  let bytes = Buffer.alloc(0);
  const read = (async () => {
    for await (const chunk of terminal) bytes = Buffer.concat([bytes, chunk]);
  })();
  return {
    get bytes() { return bytes; },
    get text() { return bytes.toString("latin1"); },
    read,
    async until(pattern: RegExp, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!pattern.test(bytes.toString("latin1"))) {
        if (Date.now() > deadline) assert.fail(`the terminal never printed ${pattern}. It printed ${JSON.stringify(bytes.toString("latin1"))}`);
        await sleep(20);
      }
    },
  };
}

const size = terminalSize(100, 30);

test("a size outside 1 to 9999 on either side, or not whole, is refused", () => {
  for (const [cols, rows] of [[0, 30], [100, 0], [10000, 30], [1.5, 30], [Number.NaN, 30]] as const) {
    assert.throws(() => terminalSize(cols, rows), /must be a whole number from 1 to 9999/);
  }
  assert.deepEqual(terminalSize(9999, 1), { cols: 9999, rows: 1 });
});

test("the program starts at the opening size, with TERM set, and its exit code passes through", async () => {
  const terminal = await openTerminal(local(), size, "xterm-test", ["sh", "-c", 'stty size; echo "term=$TERM"; exit 3']);
  const out = screen(terminal);
  await out.read;
  assert.equal(out.text, "30 100\r\nterm=xterm-test\r\n");
  assert.deepEqual(await terminal.done, { kind: "exited", code: 3 });
});

test("a resize reaches the program as SIGWINCH with the new size", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["sh", "-c", 'trap "stty size; exit 0" WINCH; echo ready; while :; do sleep 0.05; done']);
  const out = screen(terminal);
  await out.until(/ready/);
  await terminal.resize(terminalSize(140, 40));
  await out.read;
  assert.match(out.text, /ready\r\n40 140\r\n$/);
  assert.deepEqual(await terminal.done, { kind: "exited", code: 0 });
});

test("keys and output pass byte for byte through a terminal in raw mode", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["sh", "-c", "stty raw -echo; printf 'ready\\000\\377'; head -c 6 | od -An -tx1; exit 0"]);
  const out = screen(terminal);
  await out.until(/ready/);
  await terminal.write(Buffer.from([0x00, 0xff, 0x03, 0x1b, 0x0d, 0x0a]));
  await out.read;
  assert.deepEqual(out.bytes.subarray(0, 7), Buffer.from("ready\x00\xff", "latin1"));
  assert.equal(out.text.slice(7).replace(/\s+/g, " ").trim(), "00 ff 03 1b 0d 0a");
  assert.deepEqual(await terminal.done, { kind: "exited", code: 0 });
});

test("a hang-up sends the program SIGHUP, and is safe to repeat", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["sh", "-c", 'trap "exit 42" HUP; echo ready; while :; do sleep 0.05; done']);
  const out = screen(terminal);
  await out.until(/ready/);
  await terminal.hangUp();
  await terminal.hangUp();
  assert.deepEqual(await terminal.done, { kind: "exited", code: 42 }, "the trap ran");
});

test("a program that stops reading its keys still hangs up when stdin ends", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["sh", "-c", 'trap "exit 42" HUP; echo ready; while :; do sleep 0.05; done']);
  const out = screen(terminal);
  await out.until(/ready/);
  await terminal.write(Buffer.alloc(2 << 20, "k"));
  await terminal.hangUp();
  const ended = await Promise.race([terminal.done, sleep(5000, "pending")]);
  assert.deepEqual(ended, { kind: "exited", code: 42 }, "the relay saw stdin end behind 2 MiB of unread keys");
});

test("a program that ignores the hang-up is killed, which reads as 128 plus SIGKILL", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["sh", "-c", 'trap "" HUP; echo ready; while :; do sleep 0.05; done']);
  const out = screen(terminal);
  await out.until(/ready/);
  const hungUp = Date.now();
  await terminal.hangUp();
  assert.deepEqual(await terminal.done, { kind: "exited", code: 137 });
  assert.ok(Date.now() - hungUp < 5000, "within the grace period and a little");
});

test("output written right before the program exits is not lost", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["sh", "-c", 'printf "%0200000d" 0; exit 5']);
  const out = screen(terminal);
  await out.read;
  assert.equal(out.bytes.length, 200_000);
  assert.deepEqual(await terminal.done, { kind: "exited", code: 5 });
});

test("a background process that still holds the terminal does not keep it open once the program exits", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["sh", "-c", "sleep 30 & echo bye; exit 4"]);
  const out = screen(terminal);
  const ended = await Promise.race([terminal.done, sleep(3000, "pending")]);
  assert.deepEqual(ended, { kind: "exited", code: 4 });
  await out.read;
  assert.equal(out.text, "bye\r\n");
});

test("a program that cannot start exits 127 and says why on the terminal", async () => {
  const terminal = await openTerminal(local(), size, "xterm", ["nexus-no-such-program"]);
  const out = screen(terminal);
  await out.read;
  assert.match(out.text, /guest-terminal: cannot run nexus-no-such-program: .*No such file/);
  assert.deepEqual(await terminal.done, { kind: "exited", code: 127 });
});

test("the relay goes in on stdin, so Herdr's attach fits the probe's request URL with room to spare", async () => {
  const argvs: (readonly string[])[] = [];
  const terminal = await openTerminal(local(argvs), size, "xterm-256color", ["sh", "-c", "exit 0"]);
  assert.deepEqual(await terminal.done, { kind: "exited", code: 0 });
  const attach = [...argvs[0]!.slice(0, -3), "sh", "-c", attachScript];
  // As protocol.ts's streamPath encodes a stream request.
  const encoded = encodeURIComponent(JSON.stringify({ pty: null, argv: attach })).length;
  assert.ok(encoded < 2048, `the attach request is ${encoded} bytes`);
});
