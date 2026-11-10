import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Writable } from "node:stream";
import { createServer } from "node:http";
import { pollUntil, request, restartMs, ridingRestarts, type Api, type Result } from "./kit.ts";
import { call, CliError } from "./transport.ts";
import { createServer as createTcpServer } from "node:net";
import { freePort } from "../test-support/kit.ts";
import { commands } from "./commands/index.ts";
import type { Preview } from "../contract/threads.ts";
import { apiIdleMs, apiPingMs, pylonWaitMs } from "../contract/route.ts";
import { pylonRoutes } from "../contract/pylon.ts";
import { threadRoutes } from "../contract/threads.ts";


/** A stderr that claims a terminal, and the chunks written to it. */
function terminal() {
  const written: string[] = [];
  const stderr = Object.assign(new Writable({ decodeStrings: false, write(chunk: string, _encoding, done) { written.push(chunk); done(); } }), { isTTY: true });
  return { written, stderr };
}
test("a call takes its route's idle timeout, and a route with none takes the transport's default", async () => {
  const asked: { path: string; idleMs: number | undefined }[] = [];
  const api: Api = async (_method, path, _body, idleMs) => {
    asked.push({ path, idleMs });
    return null;
  };
  await request(api, pylonRoutes.files, { thread: "th-1", query: { path: "" } });
  await request(api, pylonRoutes.changes, { thread: "th-1", query: { base: "start" } });
  await request(api, pylonRoutes.diff, { thread: "th-1", query: { base: "head" } });
  await request(api, pylonRoutes.openSession, { thread: "th-1", body: {} });
  await request(api, threadRoutes.message, { thread: "th-1", body: { text: "hi", requestId: "msg:1" } });
  await request(api, threadRoutes.show, { thread: "th-1" });
  assert.deepEqual(asked.map((a) => a.idleMs), [pylonWaitMs, pylonWaitMs, pylonWaitMs, pylonWaitMs, pylonWaitMs, undefined], JSON.stringify(asked));
});

test("the server pings a quiet stream or terminal before a client's idle timeout gives up on it", () => {
  assert.ok(apiPingMs < apiIdleMs);
  assert.ok(apiIdleMs < pylonWaitMs);
});

/** The control plane on a port nothing listens on yet, as during the restart a deploy causes, through the real transport. */
async function restarting(t: import("node:test").TestContext, scheme = "http", port?: number) {
  port ??= await freePort();
  const notes: string[] = [];
  let noted!: () => void;
  const first = new Promise<void>((resolve) => { noted = resolve; });
  const endpoint = { url: new URL(`${scheme}://127.0.0.1:${port}`), socks: null };
  const api = ridingRestarts((method, path, body, idleMs) => call(endpoint, method, path, body, idleMs), (line) => { notes.push(line); noted(); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  return { port, notes, first, api };
}

test("a GET that meets a refused connection says so once and succeeds once the control plane listens again", async (t) => {
  const { port, notes, first, api } = await restarting(t);
  const reading = api("GET", "/v1/projects");
  await first;
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("[]")).listen(port, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  t.mock.timers.tick(1_000);
  assert.deepEqual(await reading, []);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes, [`nothing is listening on 127.0.0.1:${port}. Trying again for up to 15 s, as the control plane restarts on each deploy`]);
});

test("a GET gives up on a refused connection after the restart window, and any other request fails at once", async (t) => {
  const { port, notes, first, api } = await restarting(t);
  const reading = api("GET", "/v1/projects");
  await first;
  t.mock.timers.tick(restartMs);
  const lookAt = "The control plane is down or restarting, or the URL is not its own: `nexus connect <host>` finds it again, and `systemctl status nexus-control` on its machine shows whether it runs";
  await assert.rejects(reading, (err: CliError) => err.kind === "unreachable" && err.message === `nothing is listening on 127.0.0.1:${port}. ${lookAt}`);
  await assert.rejects(api("POST", "/v1/threads", {}), (err: CliError) => err.kind === "unreachable" && err.message === `nothing is listening on 127.0.0.1:${port}. ${lookAt}`);
  assert.equal(notes.length, 1, "the POST tried once and said nothing");
});

test("a wait on a terminal says the state it knows before its first poll answers", async () => {
  const { written, stderr } = terminal();
  let answer!: (done: string) => void;
  const waiting = pollUntil({ deadlineMs: 60_000, everyMs: 1_000, timedOut: () => new CliError("failed", "timed out"), shown: { to: stderr, state: () => "installing", stopped: () => "stopped" } },
    () => new Promise<string>((resolve) => { answer = resolve; }));
  assert.deepEqual(written, ["installing\n"], "said while the first poll is out");
  answer("healthy");
  assert.equal(await waiting, "healthy");
});

test("a GET over TLS whose handshake the control plane drops tries again, as one whose connection it refuses does", async (t) => {
  const dropping = createTcpServer((socket) => socket.destroy()).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => dropping.close(resolve)));
  await once(dropping, "listening");
  const { notes, first, api } = await restarting(t, "https", (dropping.address() as { port: number }).port);
  const reading = api("GET", "/v1/projects");
  await first;
  assert.match(notes[0]!, /^the TLS handshake with 127\.0\.0\.1 failed: .+\. Trying again for up to 15 s/);
  t.mock.timers.tick(restartMs);
  await assert.rejects(reading, (err: CliError) => err.kind === "unreachable" && err.restarting);
});

test("preview --wait on a terminal says the preview it published before its first poll answers", async () => {
  const { written, stderr } = terminal();
  const published: Preview = { pylon: "pylon-th-1", service: "port-3000", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" } as Preview;
  let answer!: (detail: unknown) => void;
  const api: Api = async (method) => method === "POST" ? published : new Promise((resolve) => { answer = resolve; });
  const waiting = commands.preview!.run(api, ["th-1", "3000"], { wait: true }, null as never, { connect: null as never, io: { ...process, stderr } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof answer, "function", "the first poll is out");
  assert.deepEqual(written, [`${published.url} is published, and not served yet\n`], "said while the first poll is out");
  answer({ ports: [{ port: 3000, service: "port-3000", preview: { ...published, ready: true } }] });
  assert.equal((await waiting as Result).text, published.url);
});
