/**
 * The CLI's entry: its help, its exit codes, where it finds the control plane, and its transport, against the control
 * plane's real API with a fake harness behind it. src/test-support/cli-kit.ts says when a test runs the CLI in its own
 * process and when as a child.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Thread } from "../control/thread-store.ts";
import { titleOf } from "../thread-title.ts";
import type { TailnetNodeId } from "../ids.ts";
import { testCertificate } from "../test-certificate.ts";
import { freePort, tempDir } from "../test-support/kit.ts";
import { call, CliError, follow } from "./transport.ts";
import { whenRunning, type Api } from "./kit.ts";
import { commandGroups, commands } from "./commands/index.ts";
import { version } from "../version.ts";
import { cli, node, apiName, project, withHealth, listening, socksProxy, setup, versioned, bare } from "../test-support/cli-kit.ts";

/**
 * A control plane whose pylon runs from the second read of its checkout, which `files` waits for without riding
 * through a lost connection. `close` says what it does to a kept connection: hang up on it while idle, or on its
 * next request without an answer. Answers the requests each connection carried.
 */
async function closingApi(t: TestContext, close: "idle" | "request") {
  const carried: string[][] = [];
  let reads = 0;
  const of = new WeakMap<Socket, string[]>();
  const idle = new WeakMap<Socket, NodeJS.Timeout>();
  const answer = withHealth((req, res) => {
    // Without Node's keep-alive hint, which would tell the client when the server closes a connection.
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", connection: "keep-alive" }).end(JSON.stringify(body));
    if (!req.url!.includes("/files")) return reply(200, { thread: { status: "active" } });
    if (++reads === 1) return reply(409, { error: "pylon pylon-x is not running yet", code: "not-running", retryable: true });
    reply(200, { path: "", entries: [], truncated: false });
  });
  const server = createHttpServer((req, res) => {
    const requests = of.get(req.socket)!;
    if (close === "request" && requests.length > 0) return void req.socket.destroy();
    requests.push(req.url!.split("?")[0]!);
    clearTimeout(idle.get(req.socket));
    if (close === "idle") res.on("finish", () => idle.set(req.socket, setTimeout(() => req.socket.destroy(), 200)));
    answer(req, res);
  });
  server.on("connection", (socket) => {
    const requests: string[] = [];
    of.set(socket, requests);
    carried.push(requests);
  });
  return { port: await listening(t, server), carried };
}

test("the CLI runs a thread's life through the SOCKS proxy, and --json prints the API's replies", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.json(["projects"]), [project]);
  assert.deepEqual((await s.json(["nodes"])).map((n: { name: string }) => n.name), [node]);

  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "\n  Fix the build  \nand run the tests"]);
  assert.equal(thread.title, "Fix the build", "a thread started with a message is titled by its first line");
  // The first message is human activity, so only the time of the last one moved since the start replied.
  const stable = ({ lastHumanActivityAt: _, ...rest }: Thread) => rest;
  assert.deepEqual(stable(s.registry.threads.thread(thread.id)!), stable(thread));
  assert.deepEqual(s.fake.calls.at(-1), ["send", thread.id, "\n  Fix the build  \nand run the tests", `brief:${thread.id}`, "followUp"]);
  assert.deepEqual((await s.json(["threads"])).map(stable), [{ ...stable(thread), attention: null, desired: "running", pylon: { node, actualState: "unknown", failed: null } }],
    "a row carries what the planner wants of the pylon and what its node last reported");
  assert.deepEqual(await s.json(["threads", "--project", "other"]), []);

  assert.deepEqual(await s.json(["send", thread.id, "now", "the", "lint"]), { submission: 7 });
  const [, , text, requestId, mode] = s.fake.calls.at(-1)!;
  assert.deepEqual([text, mode], ["now the lint", "followUp"]);
  assert.match(requestId as string, /^msg:[0-9a-f-]{36}$/);
  await s.json(["send", thread.id, "stop that", "--steer", "--request-id", "msg:fixed"]);
  assert.deepEqual(s.fake.calls.at(-1), ["send", thread.id, "stop that", "msg:fixed", "steer"]);

  const shown = await s.json(["show", thread.id]);
  assert.equal(shown.thread.id, thread.id);
  assert.equal(shown.desired, "running", "a thread with fresh human activity wants its pylon running");
  assert.deepEqual(shown.pylon, { grantsOutdated: false, id: thread.pylonId, node, actualState: "unknown", failed: null, observedAt: null, retryRefused: null, resources: project.resources });
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^attach: nexus attach ${thread.id}$`, "m"), "the line that attaches a terminal, ready to copy");
  assert.deepEqual((await s.json(["conversation", thread.id])).entries.map((e: { id: number }) => e.id), [1, 2, 3]);
  const human = await s.nexus(["conversation", thread.id]);
  assert.equal(human.stdout, "> \n>   Fix the build  \n> and run the tests\n\n> now the lint\n\n> stop that\n");

  assert.equal((await s.json(["archive", thread.id])).status, "archived");
  assert.deepEqual((await s.json(["threads"])).map((r: Thread) => r.status), ["archived"], "threads lists archived threads");
  assert.deepEqual(await s.json(["threads", "--open"]), [], "--open leaves them out");
  assert.equal((await s.nexus(["send", thread.id, "x"])).code, 5, "an archived thread takes no messages");
  assert.doesNotMatch((await s.nexus(["show", thread.id])).stdout, /^attach:/m, "nor an attach, since its pylon stays paused");
  assert.equal((await s.json(["unarchive", thread.id])).status, "active");
  assert.equal(await s.json(["abort", thread.id]), null, "a route that answers 204 prints null");
  assert.equal(await s.json(["retry", thread.id]), null);
  assert.equal(await s.json(["wake", thread.id]), null);
  assert.deepEqual(s.fake.calls.slice(-2).map((c) => c[0]), ["abort", "retry"]);

  assert.equal((await s.json(["delete", thread.id])).status, "deleted");
  assert.deepEqual(await s.json(["threads"]), [], "deleted threads are hidden");
  assert.equal((await s.json(["threads", "--all"]))[0].status, "deleted");
  assert.ok(s.proxy.connects.length > 0 && s.proxy.connects.every((c) => c === `${apiName}:${s.api.port}`), "the proxy resolved the API's name");
});

test("each command's help names every flag it takes", () => {
  // project show's entry says how project add and project edit set the standing rules.
  const elsewhere: Record<string, readonly string[]> = { "project edit": ["rules-file", "clear-rules"] };
  for (const [name, command] of Object.entries(commands)) {
    const unnamed = Object.keys(command.options ?? {}).filter((flag) => !command.help.join("\n").includes(`--${flag}`) && !elsewhere[name]?.includes(flag));
    assert.deepEqual(unnamed, [], name);
  }
});

test("every command whose help takes a <thread> resolves its first argument as one", () => {
  const unresolved = Object.entries(commands).filter(([, command]) => command.help.join("\n").includes("<thread>") !== (command.thread === true)).map(([name]) => name);
  assert.deepEqual(unresolved, []);
});

test("nexus --help and nexus alone name the config file in the HOME the CLI runs with", async (t) => {
  const s = await setup(t);
  const config = `then NEXUS_URL and NEXUS_SOCKS, then ${join(s.home, ".config", "nexus", "cli.json")}, which`;
  assert.ok((await s.nexus(["--help"])).stdout.includes(config));
  const bare = await s.nexus([]);
  assert.equal(bare.code, 64);
  assert.ok(bare.stderr.includes(config), "a run without a command prints the same usage");
});

test("--help or -h after a command prints its lines of nexus --help and exits 0 without a request", async (t) => {
  const s = await setup(t);
  const all = new Set((await s.nexus(["--help"])).stdout.split("\n"));
  const names = Object.keys(commands);
  assert.equal(names.length, commandGroups.reduce((n, group) => n + Object.keys(group).length, 0), "no two command groups share a name");
  for (const name of names) {
    for (const flag of ["--help", "-h"]) {
      const res = await s.nexus([...name.split(" "), flag]);
      assert.equal(res.code, 0, `${name} ${flag}: ${res.stderr}`);
      assert.equal(res.stderr, "");
      const lines = res.stdout.trimEnd().split("\n");
      assert.ok(lines[0]!.startsWith("  nexus ") && lines[0]!.includes(name.split(" ").at(-1)!), `${name} ${flag} prints its own entry first: ${lines[0]}`);
      assert.ok(lines.every((line) => all.has(line)), `${name} ${flag} prints only lines of nexus --help`);
    }
  }
  assert.equal((await s.nexus(["project", "edit", "--help"])).stdout,
    "  nexus project edit <id> [--node N|auto] [--branch B] [--cpus n] [--memory GiB] [--disk GiB]\n"
    + "    [--allow-host HOST]... [--login claude|chatgpt]... [--secret NAME:HOST[,HOST]...]...\n"
    + "    [--clear-hosts] [--clear-logins] [--clear-secrets] [--git-name NAME --git-email EMAIL | --clear-git-identity]\n"
    + "    [--template-input PATH]... [--clear-template-inputs]   repository files, such as package-lock.json, that key the project's templates with .nexus/setup\n"
    + "    [--auto-review off|review|land|yolo]   review each builder's PR on its own, land it too, and with yolo waive the holds you may; land and yolo need a deployer\n"
    + "    [--pipeline off|approve|start]    turn pipeline items into threads, once the person approves each or on their own\n"
    + "    [--second-reviewer off|on|always|reserved,lines=N]   a second reviewer on another model for the PRs the rule names\n");
  assert.equal((await s.nexus(["retry", "-h"])).stdout, "  nexus abort|retry|retry-pylon|wake <thread>\n");
  assert.equal((await s.nexus(["session", "open", "--help"])).stdout, "  nexus session open <thread> [--harness claude-code|pi|shell] [--title T]\n");
  const show = await s.nexus(["show", "--help"]);
  assert.deepEqual([show.code, show.stdout], [0, "  nexus show <thread>                          a thread with its pylon, sessions, previews and outputs\n"], "help needs no thread");
  assert.deepEqual(s.proxy.connects, [], "no help run sent a request");

  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Help"]);
  assert.ok(s.proxy.connects.length > 0, "a command does send its request through the proxy");
  assert.equal((await s.nexus(["send", thread.id, "--", "--help"])).code, 0);
  assert.deepEqual(s.fake.calls.at(-1)?.slice(0, 3), ["send", thread.id, "--help"], "after -- it is text to send");
});

test("each failure has its own exit code, and with --json its error is one JSON line on stderr", async (t) => {
  const s = await setup(t);
  const fails = async (args: readonly string[], code: number, error: Record<string, unknown>, overrides?: Record<string, string>) => {
    const res = await s.spawned([...args, "--json"], overrides);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    const reported = JSON.parse(res.stderr);
    assert.deepEqual(Object.fromEntries(Object.keys(error).map((k) => [k, reported[k]])), error);
    return reported.error as string;
  };

  await fails(["show", "th-missing"], 4, { kind: "not-found", status: 404, error: "no thread th-missing" });
  await fails(["start", "--project", "nope", "--title", "x"], 4, { kind: "not-found", status: 404 });
  const { id } = await s.json(["start", "--project", "acme", "--title", "x"]);
  await fails(["unarchive", id], 5, { kind: "conflict", status: 409 });
  await fails(["retry-pylon", id], 5, { kind: "conflict", status: 409, error: `pylon pylon-${id} has not failed` });
  await fails(["start", "--title", "x"], 64, { kind: "invalid", status: null });
  await fails(["start", "--project", "acme", "--node", "nowhere", "--title", "x"], 64, { kind: "invalid", status: 400, error: "no node nowhere" });
  await fails(["show"], 64, { kind: "invalid", status: null });

  const down = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${await freePort()}` });
  assert.match(down, /nothing is listening on the SOCKS proxy .*ts-home/);
  const refusing = await socksProxy(t, 4);
  const offline = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${refusing.port}` });
  assert.match(offline, /could not reach nexus\.test:\d+: host unreachable\. The node may be offline/);
  const hangingUp = await socksProxy(t, "close");
  const closed = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${hangingUp.port}` });
  assert.match(closed, /closed the connection before answering the CONNECT/);

  s.callAs("nSTRANGER" as TailnetNodeId);
  await fails(["threads"], 3, { kind: "refused", status: 403 });

  const human = await s.spawned(["threads"]);
  assert.deepEqual([human.code, human.stderr], [3, "nexus: caller is not a tailnet node this control plane allows\n"], "without --json the error is plain text");
});

test("the URL and the proxy come from the flags, then the environment, then the config file", async (t) => {
  const s = await setup(t);
  const unset = { NEXUS_URL: "", NEXUS_SOCKS: "" };
  const dead = `http://127.0.0.1:${await freePort()}`;
  const config = join(s.home, ".config", "nexus", "cli.json");
  const none = await s.nexus(["projects"], unset);
  assert.deepEqual([none.code, none.stderr], [64, "nexus: no control plane is set. Run nexus connect <host> with its tailnet name, or give --url or NEXUS_URL. Run nexus --help for usage\n"], "no URL is built in");
  assert.deepEqual(await s.json(["projects"], { ...unset, NEXUS_URL: s.localUrl }), [project], "without a proxy the CLI connects directly");
  await mkdir(join(s.home, ".config", "nexus"), { recursive: true });

  await writeFile(config, JSON.stringify({ url: s.localUrl, socks: "none" }));
  assert.deepEqual(await s.json(["projects"], unset), [project], "the config file connects directly");
  assert.equal((await s.nexus(["projects"], { ...unset, NEXUS_URL: dead })).code, 2, "the environment overrides the file");
  assert.deepEqual(await s.json(["projects", "--url", s.localUrl], { ...unset, NEXUS_URL: dead }), [project], "a flag overrides the environment");
  assert.deepEqual(await s.json(["projects", "--socks", "none", "--url", s.localUrl]), [project], "--socks none overrides the environment's proxy");

  await writeFile(config, JSON.stringify({ url: s.localUrl, proxy: "x" }));
  const bad = await s.nexus(["projects"], unset);
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /cli\.json is not a CLI config/);
});

test("a thread's default title is its brief's first line that is not blank, cut to 80 characters", () => {
  assert.equal(titleOf("\n  \n  Fix the login page  \nthen test it"), "Fix the login page");
  assert.equal(titleOf("a".repeat(80)), "a".repeat(80));
  assert.equal(titleOf("a".repeat(81)), `${"a".repeat(80)}...`);
});

test("a stream refused with a reply cut off mid-body fails as unreachable rather than hanging", { timeout: 60_000 }, async (t) => {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"err');
      setTimeout(() => socket.destroy(), 20);
    });
  });
  const port = await listening(t, server);
  await assert.rejects(follow({ url: new URL(`http://127.0.0.1:${port}`), socks: null }, "/v1/threads/th-x/events", () => {}, new AbortController().signal),
    (err) => err instanceof CliError && err.kind === "unreachable");
});

test("an API that stays silent behind a working proxy is named as the culprit, not the proxy", { timeout: 60_000 }, async (t) => {
  const held = new Set<Socket>();
  const silent = createServer((socket) => {
    socket.on("error", () => {});
    held.add(socket);
  });
  const port = await listening(t, silent);
  const proxy = await socksProxy(t);
  try {
    await assert.rejects(call({ url: new URL(`http://${apiName}:${port}`), socks: { host: "127.0.0.1", port: proxy.port } }, "DELETE", "/v1/threads/th-x/previews/8003", undefined, 200),
      (err) => err instanceof CliError && err.kind === "unreachable" && err.message === `the control plane at ${apiName}:${port} sent nothing for 0.2s after DELETE /v1/threads/th-x/previews/8003 went out, so the request may have gone through. Check with nexus show <thread>, or nexus threads for a start, before you try again`);
  } finally {
    // The proxy keeps its leg to the silent server open after the CLI gives up, which would hold the server's close.
    for (const socket of held) socket.destroy();
  }
});

test("a command refuses a control plane that reports no version, or one older than the CLI reads, and sends nothing past health", async (t) => {
  // 0.9.99 is older though it sorts after 0.74.0 as text.
  for (const [health, runs] of [[{ commit: "a".repeat(40), https: {} }, /older than \d+\.\d+\.\d+/], [{ commit: null, version: "0.9.99" }, /0\.9\.99/]] as const) {
    // A watch and a follow retry through a failing control plane, but not through one too old.
    for (const args of [["projects"], ["events", "--follow"], ["watch", "th-0123456789ab"]]) {
      const old = await versioned(t, health);
      const res = await bare(t, args, { NEXUS_URL: old.url });
      assert.equal(res.code, 1, `${args[0]}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`^nexus: the control plane at ${old.url.replaceAll(".", "\\.")} runs Nexus ${runs.source}, and this CLI needs \\d+\\.\\d+\\.\\d+ or later\\. Upgrade it, as deploy/README\\.md describes\n$`), args[0]!);
      assert.deepEqual(old.paths, ["/v1/health"], args[0]!);
    }
  }
  const current = await versioned(t, { commit: null, version });
  assert.deepEqual(await bare(t, ["projects"], { NEXUS_URL: current.url }).then((r) => [r.code, r.stdout]), [0, "No projects.\n"]);
  assert.deepEqual(current.paths, ["/v1/health", "/v1/projects"]);
});

test("threads --open asks for the open threads, and leaves out the others a control plane that ignores status=open answers", async (t) => {
  const rows = ["active", "idle", "archived"].map((status, i) => ({ id: `th-00000000000${i}`, status, project: "acme", title: "t", pylon: { actualState: "paused" }, createdAt: 0 }));
  const old = await versioned(t, { commit: null, version: "0.76.0" }, rows);
  const res = await bare(t, ["threads", "--open", "--json"], { NEXUS_URL: old.url });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).map((r: Thread) => r.status), ["active", "idle"]);
  assert.ok(old.paths.includes("/v1/threads?deleted=false&status=open"), old.paths.join(" "));
});

test("a follow whose first health read fails reads it again, and follows once the control plane answers", { timeout: 30_000 }, async (t) => {
  const paths: string[] = [];
  const followed = Promise.withResolvers<void>();
  let failures = 1;
  const server = createHttpServer((req, res) => {
    paths.push(req.url!.split("?")[0]!);
    if (req.url === "/v1/health" && failures-- > 0) return void res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "starting" }));
    withHealth((_req, stream) => {
      stream.writeHead(200, { "content-type": "text/event-stream" }).write(": connected\n\n");
      followed.resolve();
    })(req, res);
  });
  const port = await listening(t, server);
  t.after(() => server.closeAllConnections());
  const child = spawn(process.execPath, [cli, "events", "--follow", "--url", `http://127.0.0.1:${port}`, "--socks", "none"]);
  t.after(() => { child.kill(); });
  await followed.promise;
  // Before the server's close, which would otherwise wait out the follow's idle timeout.
  child.kill();
  assert.deepEqual(paths, ["/v1/health", "/v1/health", "/v1/events"]);
});

test("a config file that cannot be read fails as invalid, in JSON under --json", async (t) => {
  const s = await setup(t);
  // A directory where the file should be.
  await mkdir(join(s.home, ".config", "nexus", "cli.json"), { recursive: true });
  const res = await s.nexus(["projects", "--json"]);
  assert.equal(res.code, 64);
  const { error, ...rest } = JSON.parse(res.stderr);
  assert.deepEqual(rest, { kind: "invalid", status: null, code: null });
  assert.match(error, /^cannot read .*cli\.json: EISDIR/);
});
test("a thread ID is one path segment", async (t) => {
  const s = await setup(t);
  const res = await s.nexus(["show", `../projects?${randomUUID()}`, "--json"]);
  assert.equal(res.code, 4, res.stderr);
});

test("a GET whose kept connection the server closed, idle or as the GET went out, goes out again on a new one without an error", { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const [health, files, thread] = ["/v1/health", "/v1/threads/th-0123456789ab/files", "/v1/threads/th-0123456789ab"];
  const expected = { idle: [[health, files, thread], [files]], request: [[health], [files], [thread], [files]] };
  for (const close of ["idle", "request"] as const) {
    const api = await closingApi(t, close);
    const res = await s.nexus(["files", "th-0123456789ab"], { NEXUS_URL: `http://127.0.0.1:${api.port}`, NEXUS_SOCKS: "none" });
    assert.deepEqual([res.code, res.stdout, res.stderr], [0, "the checkout is empty.\n", ""], close);
    assert.deepEqual(api.carried.filter((requests) => requests.length > 0), expected[close], `${close}: the connections and what each carried`);
  }
});

test("the CLI exits as soon as its command is done, though the server keeps the connection open", { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const dir = await tempDir("nexus-keep-", t);
  const certificate = await testCertificate(dir, apiName);
  let answered = 0;
  const server = createHttpsServer(certificate, withHealth((_req, res) => {
    res.on("finish", () => { answered = Date.now(); });
    res.writeHead(200, { "content-type": "application/json" }).end("[]");
  }));
  server.keepAliveTimeout = 60_000;
  const open = new Set<Socket>();
  server.on("secureConnection", (socket) => { open.add(socket); socket.on("close", () => open.delete(socket)); });
  const port = await listening(t, server);
  t.after(() => { for (const socket of open) socket.destroy(); });
  const res = await s.spawned(["projects"], { NEXUS_URL: `https://${apiName}:${port}`, NODE_EXTRA_CA_CERTS: join(dir, "cert.pem") });
  assert.deepEqual([res.code, res.stdout], [0, "No projects.\n"], res.stderr);
  // The pool lets go of an idle connection after 4 s, so a socket that held the process would show here.
  assert.ok(Date.now() - answered < 3_000, `the CLI exited ${Date.now() - answered} ms after its answer`);
});

test("a reused connection takes each request's own idle timeout, and a silence on it is not sent again", { timeout: 60_000 }, async (t) => {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((req, res) => {
    seen.push(req.url!);
    sockets.add(req.socket);
    if (req.url === "/slow") return;
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const port = await listening(t, server);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const endpoint = { url: new URL(`http://127.0.0.1:${port}`), socks: null };
  await call(endpoint, "GET", "/fast", undefined, 100);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await call(endpoint, "GET", "/fast", undefined, 60_000), {}, "the first request's 100 ms did not stay on the socket");
  await assert.rejects(call(endpoint, "GET", "/slow", undefined, 200),
    (err) => err instanceof CliError && err.kind === "unreachable" && err.message === `the control plane at 127.0.0.1:${port} sent nothing for 0.2s`);
  assert.deepEqual(seen, ["/fast", "/fast", "/slow"]);
  assert.equal(sockets.size, 1, "the three requests shared one connection");
});

test("whenRunning tries a retryable refusal again and fails at once on any other", async () => {
  const api: Api = async () => ({ thread: { status: "active" } });
  for (const refusal of [
    new CliError("conflict", "pylon-x is stopped, not running", 409, "not-running", true),
    new CliError("conflict", "control plane is draining for deployment", 409, "draining", true),
  ]) {
    let tries = 0;
    const waking = () => {
      if (tries++ === 0) throw refusal;
      return Promise.resolve("sent");
    };
    assert.equal(await whenRunning(api, "th-0123456789ab", waking, "nothing was sent"), "sent", refusal.code!);
    assert.equal(tries, 2, refusal.code!);
  }
  for (const refusal of [
    new CliError("conflict", "the Claude worker waits at a prompt", 409, "blocked"),
    new CliError("conflict", "pylon-x is stopped, not running", 409, "not-running"),
  ]) {
    let refusals = 0;
    await assert.rejects(whenRunning(api, "th-0123456789ab", () => { refusals++; throw refusal; }, "nothing was sent"), refusal);
    assert.equal(refusals, 1, `${refusal.code}: a refusal that is not retryable is not tried again, whatever its code`);
  }
});
