/**
 * The Mac nexus CLI as a process, against the control plane's real API with a fake harness behind it. Most calls
 * go through a fake SOCKS5 proxy that alone can resolve the API's name, as ts-home's proxy alone knows MagicDNS.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startApi } from "../control/api.ts";
import { fakeHarness } from "../control/fake-harness.ts";
import { openRegistry, type Thread } from "../control/registry.ts";
import type { ImageId, ImageManifest } from "../images.ts";
import type { Project, ProjectId } from "../project.ts";
import type { NodeName, TailnetNodeId } from "../protocol.ts";

const cli = fileURLToPath(new URL("./nexus.ts", import.meta.url));
const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
/** Only the fake proxy resolves this name, so a call that reaches the API went through it. */
const apiName = "nexus.test";
const project: Project = {
  id: "acme" as ProjectId, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image: ImageManifest = {
  id: "img-0123456789ab" as ImageId, gondolinBuildId: "b1", builtOn: node, builtAt: "2027-01-01T00:00:00Z", sha256: "a".repeat(64),
  pins: {
    debianDigest: "d", node: "24.22.1", nodeSha256: "n", claudeCode: "c", pi: "p", herdr: "h", piEnv: "e", piEnvSha256: "s",
    gondolin: "0.13.0", alpineKernel: "k", dotfilesCommon: "f",
  },
};

async function listening(t: TestContext, server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as { port: number }).port;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A SOCKS5 proxy without authentication. A `reply` other than 0 refuses every CONNECT with that code, and "close"
 * hangs up after the greeting instead.
 */
async function socksProxy(t: TestContext, reply: number | "close" = 0) {
  const connects: string[] = [];
  const server = createServer((client) => {
    client.on("error", () => {});
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      if (reply === "close") return void client.end();
      client.once("data", (req: Buffer) => {
        const length = req[4]!;
        const host = req.subarray(5, 5 + length).toString();
        const port = req.readUInt16BE(5 + length);
        connects.push(`${host}:${port}`);
        if (reply !== 0) return void client.end(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
        const upstream = connect(port, host === apiName ? "127.0.0.1" : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(upstream).pipe(client);
        });
        upstream.on("error", () => client.destroy());
      });
    });
  });
  return { port: await listening(t, server), connects };
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
  const registry = openRegistry(join(dir, "registry.db"));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.createProject(project);
  registry.saveImage(image);
  registry.setCurrentImage(image.id);
  let caller: TailnetNodeId = laptop;
  const fake = fakeHarness();
  const api = await startApi({
    registry, host: "127.0.0.1", port: 0, whois: async () => caller, allowed: new Set([laptop]),
    hostnames: new Set([apiName, "127.0.0.1"]), dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
    harness: fake.harness, wake: () => {},
  });
  t.after(async () => {
    await api.close();
    registry.close();
    await rm(dir, { recursive: true });
  });
  const proxy = await socksProxy(t);
  const home = join(dir, "home");
  await mkdir(home);
  /** The environment of a CLI run: a home of its own, and the API through the proxy. */
  const env = (overrides: Record<string, string> = {}) => ({
    PATH: process.env.PATH!, HOME: home, NEXUS_URL: `http://${apiName}:${api.port}`, NEXUS_SOCKS: `127.0.0.1:${proxy.port}`, ...overrides,
  });
  function nexus(args: readonly string[], overrides?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(process.execPath, [cli, ...args], { env: env(overrides) }, (err, stdout, stderr) => {
        resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout, stderr });
      });
    });
  }
  async function json(args: readonly string[], overrides?: Record<string, string>): Promise<any> {
    const res = await nexus([...args, "--json"], overrides);
    assert.equal(res.code, 0, res.stderr);
    return JSON.parse(res.stdout);
  }
  return {
    registry, fake, proxy, home, api, env, nexus, json,
    callAs(id: TailnetNodeId) { caller = id; },
    localUrl: `http://127.0.0.1:${api.port}`,
  };
}

test("the CLI runs a thread's life through the SOCKS proxy, and --json prints the API's replies", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.json(["projects"]), [project]);
  assert.deepEqual((await s.json(["nodes"])).map((n: { name: string }) => n.name), [node]);

  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "\n  Fix the build  \nand run the tests"]);
  assert.equal(thread.title, "Fix the build", "a thread started with a message is titled by its first line");
  // The first message is human activity, so only the time of the last one moved since the start replied.
  const stable = ({ lastHumanActivityAt: _, ...rest }: Thread) => rest;
  assert.deepEqual(stable(s.registry.thread(thread.id)!), stable(thread));
  assert.deepEqual(s.fake.calls.at(-1)?.slice(0, 3), ["send", thread.id, "\n  Fix the build  \nand run the tests"]);
  assert.deepEqual((await s.json(["threads"])).map(stable), [stable(thread)]);
  assert.deepEqual(await s.json(["threads", "--project", "other"]), []);

  assert.deepEqual(await s.json(["send", thread.id, "now", "the", "lint"]), { submission: 7 });
  const [, , text, requestId, mode] = s.fake.calls.at(-1)!;
  assert.deepEqual([text, mode], ["now the lint", "followUp"]);
  assert.match(requestId as string, /^msg:[0-9a-f-]{36}$/);
  await s.json(["send", thread.id, "stop that", "--steer", "--request-id", "msg:fixed"]);
  assert.deepEqual(s.fake.calls.at(-1), ["send", thread.id, "stop that", "msg:fixed", "steer"]);

  const shown = await s.json(["show", thread.id]);
  assert.equal(shown.thread.id, thread.id);
  assert.deepEqual(shown.pylon, { id: thread.pylonId, node, actualState: "unknown", failed: null, observedAt: null, retryRefused: null });
  assert.deepEqual((await s.json(["conversation", thread.id])).entries.map((e: { id: number }) => e.id), [1, 2, 3]);
  const human = await s.nexus(["conversation", thread.id]);
  assert.equal(human.stdout, "> \n>   Fix the build  \n> and run the tests\n\n> now the lint\n\n> stop that\n");

  assert.equal((await s.json(["archive", thread.id])).status, "archived");
  assert.equal((await s.nexus(["send", thread.id, "x"])).code, 5, "an archived thread takes no messages");
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

test("each failure has its own exit code, and with --json its error is one JSON line on stderr", async (t) => {
  const s = await setup(t);
  const fails = async (args: readonly string[], code: number, error: Record<string, unknown>, overrides?: Record<string, string>) => {
    const res = await s.nexus([...args, "--json"], overrides);
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

  const down = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${await closedPort()}` });
  assert.match(down, /nothing is listening on the SOCKS proxy .*ts-home/);
  const refusing = await socksProxy(t, 4);
  const offline = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${refusing.port}` });
  assert.match(offline, /could not reach nexus\.test:\d+: host unreachable\. The node may be offline/);
  const hangingUp = await socksProxy(t, "close");
  const closed = await fails(["threads"], 2, { kind: "unreachable", status: null }, { NEXUS_SOCKS: `127.0.0.1:${hangingUp.port}` });
  assert.match(closed, /closed the connection before answering the CONNECT/);

  s.callAs("nSTRANGER" as TailnetNodeId);
  await fails(["threads"], 3, { kind: "refused", status: 403 });

  const human = await s.nexus(["threads"]);
  assert.deepEqual([human.code, human.stderr], [3, "nexus: caller is not a tailnet node this control plane allows\n"], "without --json the error is plain text");
});

test("the URL and the proxy come from the flags, then the environment, then the config file", async (t) => {
  const s = await setup(t);
  const unset = { NEXUS_URL: "", NEXUS_SOCKS: "" };
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const config = join(s.home, ".config", "nexus", "cli.json");
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

/** The JSON lines a watch prints, one at a time. */
function watchLines(t: TestContext, s: Awaited<ReturnType<typeof setup>>, args: readonly string[]) {
  const child = spawn(process.execPath, [cli, "watch", ...args, "--json", "--interval", "50"], { env: s.env() });
  t.after(() => { child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    async next(): Promise<any> {
      const timeout = AbortSignal.timeout(10_000);
      const line = await Promise.race([lines.next(), once(timeout, "abort").then(() => assert.fail(`no line from watch. stderr: ${stderr}`))]);
      assert.ok(!line.done, `watch ended early. stderr: ${stderr}`);
      return JSON.parse(line.value);
    },
  };
}

test("watch prints the backlog, then each new entry and state change, and ends when the thread is deleted", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id]);
  const exited = once(watch.child, "exit");

  const first = await watch.next();
  assert.deepEqual([first.type, first.entries.map((e: any) => [e.entry.id, e.entry.kind, e.text])], ["reset", [[1, "pi.user", "> hi"]]], "the first poll prints the context whole");
  const state = { type: "state", thread: thread.id, status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "unknown", failed: null };
  assert.deepEqual(await watch.next(), state);

  s.fake.transcript(thread.id).messages.push({
    role: "assistant", content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
    stopReason: "toolUse", timestamp: Date.now(),
  } as never);
  const answer = await watch.next();
  assert.deepEqual([answer.type, answer.entry.id, answer.text], ["entry", 2, 'On it.\n[tool] bash {"command":"npm test"}']);

  s.fake.transcript(thread.id).docs["pi.live"] = { run: { taskId: 1, inputs: [] } };
  s.fake.transcript(thread.id).docs["pi.inbox"] = { items: [{ id: 9, mode: "followUp", content: "and then?" }] };
  assert.deepEqual(await watch.next(), { ...state, run: "working", queued: 1 });

  await s.json(["delete", thread.id]);
  assert.deepEqual(await watch.next(), { ...state, run: "idle", status: "deleted", queued: 0 }, "a deleted thread has no conversation to be busy");
  assert.deepEqual(await exited, [0, null]);
});

/** An entry as pi-durable serves it, holding one user message. */
const userEntry = (id: number, text: string) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] }) as never;

test("watch prints the whole context again when it changes other than by an append", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "one"]);
  await s.json(["send", thread.id, "two"]);
  const transcript = s.fake.transcript(thread.id);
  const watch = watchLines(t, s, [thread.id]);
  const ids = (event: any) => [event.type, event.entries?.map((e: any) => e.entry.id) ?? event.entry.id];
  assert.deepEqual(ids(await watch.next()), ["reset", [1, 2]]);
  assert.equal((await watch.next()).type, "state");

  // A new head marker leads the active context, ahead of entries older than itself.
  transcript.entries = [userEntry(12, "summary"), userEntry(10, "one")];
  const reordered = await watch.next();
  assert.deepEqual(ids(reordered), ["reset", [12, 10]]);
  assert.deepEqual(reordered.entries.map((e: any) => e.text), ["> summary", "> one"]);
  transcript.entries = [...transcript.entries, userEntry(14, "three")];
  assert.deepEqual(ids(await watch.next()), ["entry", 14], "an append to the new context is one entry");

  // A compaction drops what it summarized.
  transcript.entries = [userEntry(15, "compacted"), userEntry(14, "three")];
  assert.deepEqual(ids(await watch.next()), ["reset", [15, 14]]);
  transcript.entries = [userEntry(15, "compacted")];
  assert.deepEqual(ids(await watch.next()), ["reset", [15]], "a context that lost its last entry is printed whole");
});

test("a config file that cannot be read fails as invalid, in JSON under --json", async (t) => {
  const s = await setup(t);
  // A directory where the file should be.
  await mkdir(join(s.home, ".config", "nexus", "cli.json"), { recursive: true });
  const res = await s.nexus(["projects", "--json"]);
  assert.equal(res.code, 64);
  const { error, ...rest } = JSON.parse(res.stderr);
  assert.deepEqual(rest, { kind: "invalid", status: null });
  assert.match(error, /^cannot read .*cli\.json: EISDIR/);
});
test("a thread ID is one path segment", async (t) => {
  const s = await setup(t);
  const res = await s.nexus(["show", `../projects?${randomUUID()}`, "--json"]);
  assert.equal(res.code, 4, res.stderr);
});
