/**
 * The guest-side outbox that carries Claude hook events to the probe (images/pylon/nexus-outbox.ts), through the
 * real hook and sender processes against a local server standing in for the host bridge.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drain, enqueue, maxAgeMs, maxEntries, type OutboxEvent, type Outcome } from "../images/pylon/nexus-outbox.ts";

const sender = fileURLToPath(new URL("../images/pylon/nexus-outbox.ts", import.meta.url));
const hook = fileURLToPath(new URL("../images/pylon/nexus-claude-hook", import.meta.url));

function home(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-outbox-"));
  // Removing the spool also stops any sender a failed test left behind.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, outbox: join(dir, ".nexus", "outbox") };
}

/** A bridge whose answer to each event the test decides; it records every request and the events it accepted. */
async function bridge(t: TestContext, answer: (event: OutboxEvent, res: ServerResponse) => void) {
  const requests: OutboxEvent[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { op, ...event } = JSON.parse(body);
    assert.equal(op, "event");
    requests.push(event);
    answer(event, res);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runSender(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [sender], { env: { ...process.env, ...env }, stdio: "ignore" });
  return once(child, "exit").then(([code]) => code as number | null);
}

test("events written while the probe is down reach it in order and once when it comes back", async (t) => {
  const { dir, outbox } = home(t);
  let up = false;
  const accepted: OutboxEvent[] = [];
  const { requests, url } = await bridge(t, (event, res) => {
    if (!up) return void res.writeHead(503).end();
    if (event.kind === "bogus") return void res.writeHead(400).end();
    accepted.push(event);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true }));
  });
  const env = { HOME: dir, NEXUS_API: url };
  const now = Date.now();
  await enqueue({ kind: "session.turn-started", at: now - 1, session: "c1" }, outbox);
  const exited = runSender(env);
  await until(() => requests.length > 0);

  const started = Date.now();
  const child = execFile(hook, ["session.turn-ended"], { env: { ...process.env, ...env } });
  child.stdin!.end(JSON.stringify({ session_id: "c1" }));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 1500, "the hook returns while the probe is down");
  await enqueue({ kind: "bogus", at: Date.now() + 1 }, outbox);
  await enqueue({ kind: "session.waiting", at: Date.now() + 2, session: "c1", message: "approve?" }, outbox);

  up = true;
  assert.equal(await exited, 0);
  assert.deepEqual(accepted.map((e) => [e.kind, e.session, e.message]), [
    ["session.turn-started", "c1", undefined],
    ["session.turn-ended", "c1", undefined],
    ["session.waiting", "c1", "approve?"],
  ]);
  assert.ok(requests.some((e) => e.kind === "bogus"), "the rejected event was sent");
  assert.deepEqual(readdirSync(outbox), []);
});

test("a second sender leaves the spool to the one that holds it", async (t) => {
  const { dir, outbox } = home(t);
  const held: ServerResponse[] = [];
  const { requests, url } = await bridge(t, (_event, res) => { held.push(res); });
  const env = { HOME: dir, NEXUS_API: url };
  await enqueue({ kind: "session.turn-started", at: Date.now(), session: "c1" }, outbox);
  await enqueue({ kind: "session.turn-ended", at: Date.now() + 1, session: "c1" }, outbox);
  const first = runSender(env);
  await until(() => requests.length === 1);

  assert.equal(await runSender(env), 0);
  assert.equal(requests.length, 1, "the second sender sent nothing");

  const release = setInterval(() => { for (const res of held.splice(0)) res.writeHead(200).end("{}"); }, 10);
  t.after(() => clearInterval(release));
  assert.equal(await first, 0);
  assert.deepEqual(requests.map((e) => e.kind), ["session.turn-started", "session.turn-ended"]);
  assert.deepEqual(readdirSync(outbox), []);
});

test("a full spool drops its oldest events", async (t) => {
  const { outbox } = home(t);
  const now = Date.now();
  mkdirSync(outbox, { recursive: true });
  for (let i = 0; i < maxEntries + 4; i++) writeFileSync(join(outbox, `${String(now + i).padStart(16, "0")}-1-0000000${i % 10}.json`), JSON.stringify({ kind: "session.heartbeat", at: now + i }));
  await enqueue({ kind: "session.heartbeat", at: now + maxEntries + 4 }, outbox);
  const sent: number[] = [];
  await drain(outbox, async (e) => { sent.push(e.at - now); return "delivered"; });
  assert.equal(sent.length, maxEntries);
  assert.equal(sent[0], 5);
  assert.equal(sent.at(-1), maxEntries + 4);
});

test("drain drops stale, unreadable and rejected events and backs off on retry", async (t) => {
  const { outbox } = home(t);
  const now = Date.now();
  await enqueue({ kind: "session.turn-ended", at: now - maxAgeMs - 1, session: "old" }, outbox);
  await enqueue({ kind: "session.turn-ended", at: now, session: "rejected" }, outbox);
  await enqueue({ kind: "session.turn-ended", at: now + 1, session: "flaky" }, outbox);
  writeFileSync(join(outbox, `${String(now + 2).padStart(16, "0")}-1-garbage.json`), "{");
  await enqueue({ kind: "session.turn-ended", at: now + 3, session: "last" }, outbox);
  const answers: Record<string, Outcome[]> = { rejected: ["rejected"], flaky: ["retry", "retry", "retry", "delivered"], last: ["retry", "delivered"] };
  const sent: string[] = [];
  const slept: number[] = [];
  await drain(outbox, async (e) => { sent.push(e.session!); return answers[e.session!]!.shift()!; }, async (ms) => { slept.push(ms); });
  assert.deepEqual(sent, ["rejected", "flaky", "flaky", "flaky", "flaky", "last", "last"]);
  assert.deepEqual(slept, [500, 1000, 2000, 500], "a delivery resets the backoff");
  assert.deepEqual(readdirSync(outbox), []);
});
