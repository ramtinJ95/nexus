/**
 * The Mac nexus CLI as a process, against the control plane's real API with a fake harness behind it. Most calls
 * go through a fake SOCKS5 proxy that alone can resolve the API's name, as ts-home's proxy alone knows MagicDNS.
 */
import { checkoutReader } from "../checkout-files.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startApi } from "../control/api.ts";
import { threadStarter } from "../control/threads.ts";
import { pipeline, type PipelineItem } from "../control/pipeline.ts";
import { planning, planningPrefix } from "../control/planning.ts";
import { threadQueue, type QueuedThread } from "../control/queue.ts";
import { turnGate } from "../control/drain.ts";
import { fakeHarness } from "../control/fake-harness.ts";
import { openRegistry, type Thread, type ThreadId } from "../control/registry.ts";
import { personPhase, type Review, type ReviewLoop } from "../control/review.ts";
import { agentReplies } from "../control/agent-conversation.ts";
import type { Judgment } from "../control/judgment.ts";
import { startImageRollout } from "../control/image-rollout.ts";
import { usageBackfill } from "../control/usage-backfill.ts";
import type { ImageId, ImageManifest, ProjectMirror, TemplateRecord } from "../images.ts";
import type { Project, ProjectId, RemoteProject } from "../project.ts";
import { openTerminal, terminalSize } from "../guest-terminal.ts";
import { processStream } from "../process-stream.ts";
import { repoInitCommand } from "../pylon-vm-backend.ts";
import type { ByteStream, CommandResult, InterruptClaudeOutcome, NodeHealth, NodeName, PylonCommand, PylonId, ServiceFact, StreamEnd, TailnetNodeId } from "../protocol.ts";
import { checkoutDir } from "../sessions.ts";
import { claudeProjects, transcriptStart, type ClaudeEntry } from "../claude-transcript.ts";
import { testCertificate } from "../test-certificate.ts";
import { freePort, testImage, until } from "../test-kit.ts";
import { call, CliError, follow } from "./transport.ts";

const cli = fileURLToPath(new URL("./nexus.ts", import.meta.url));
const node = "rj-firebat" as NodeName;
const laptop = "nLAPTOP" as TailnetNodeId;
/** Allowed, and a person, but not a deployer. */
const phone = "nPHONE" as TailnetNodeId;
/** Only the fake proxy resolves this name, so a call that reaches the API went through it. */
const apiName = "nexus.test";
const project: Project = {
  id: "acme" as ProjectId, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const image = testImage();

async function listening(t: TestContext, server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as { port: number }).port;
}

/**
 * A SOCKS5 proxy without authentication. A `reply` other than 0 refuses every CONNECT with that code, and "close"
 * hangs up after the greeting instead. `ports` sends a CONNECT to one port on to another, as to the control plane's
 * fixed ports.
 */
async function socksProxy(t: TestContext, reply: number | "close" = 0, ports: Record<number, number> = {}) {
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
        const upstream = connect(ports[port] ?? port, host === apiName ? "127.0.0.1" : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(upstream).pipe(client);
        });
        // A pipe only ends the client when the API hangs up, and leaves it paused, so it would never read the CLI's
        // own end and the proxy's close would wait for it forever.
        upstream.on("close", () => client.destroy());
        upstream.on("error", () => {});
      });
    });
  });
  return { port: await listening(t, server), connects };
}

/** `https` also serves the API over TLS on a port of its own, as the dashboard's port, with a certificate for `apiName`. */
async function setup(t: TestContext, setupOptions: { queue?: boolean; https?: boolean; reviews?: ReviewLoop } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
  const certificate = setupOptions.https === true ? await testCertificate(dir, apiName) : null;
  const registry = openRegistry(join(dir, "registry.db"));
  registry.upsertNode({ name: node, tailnetHost: "rj-firebat.tail.ts.net", tailnetNodeId: "nFIREBAT" as TailnetNodeId });
  registry.createProject(project);
  registry.saveImage(image, null);
  registry.setCurrentImage(image.id);
  let caller: TailnetNodeId = laptop;
  let requests = 0;
  /** What the node's probe answers a guest command with. Tests replace it. */
  let answer = async (command: PylonCommand): Promise<CommandResult> =>
    command.kind === "unlink-port" ? { kind: "unlink-port", refused: null }
    : command.kind === "open-session" ? { kind: "open-session", herdrPane: "w1:p1" }
    : command.kind === "close-session" ? { kind: "close-session", outcome: "closed" }
    : { kind: "link-port", service: `port-${(command as { port: number }).port}` };
  const commands: PylonCommand[] = [];
  /** What the node's probe opens a pipe to. Tests replace it. */
  let pipe = async (argv: readonly string[]): Promise<ByteStream> => { throw new Error(`unexpected stream ${argv[0]}`); };
  let health = async (): Promise<NodeHealth> => { throw new Error("unexpected node health read"); };
  /** What the project's remote answers a setup read with. Tests replace it. */
  let read: ProjectMirror["setupInputs"] = () => Promise.reject(new Error("this test has no remote"));
  const fake = fakeHarness();
  const noJobs = () => Promise.reject(new Error("the CLI tests' nodes hold every image they roll out"));
  const images = startImageRollout({
    registry, probes: new Map([[node, { submit: noJobs, job: noJobs, manifest: async (id) => registry.image(id as ImageId) ?? null }]]), buildNode: node,
    recipe: noJobs, release: null, log: () => {},
  });
  const startThread = threadStarter({
    registry, harness: fake.harness, wake: () => {}, dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
    mirror: { setupInputs: (p: RemoteProject, ref: { branch: string } | { commit: string }) => read(p, ref) },
  });
  const backfill = usageBackfill({ registry, counter: { readWhole: () => Promise.reject(new Error("the CLI tests read no pylon")) }, wake: () => {}, intervalMs: 3_600_000, log: () => {} });
  const queue = setupOptions.queue === true ? threadQueue({ registry, startThread, gate: turnGate(() => false), send: (id, text, requestId) => fake.harness.send(id, text, requestId, "followUp") }) : null;
  const items = queue === null ? null : pipeline({ registry, queue });
  const plans = planning({ registry, pipeline: items, replies: agentReplies(registry, fake.harness) });
  const options = (port: number) => ({
    queue,
    pipeline: items,
    planning: plans,
    ...setupOptions.reviews === undefined ? {} : { reviews: setupOptions.reviews },
    deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {}, resolveMain: async () => "a".repeat(40) },
    ...certificate === null ? {} : { https: { port: 0, certificate: async () => certificate } },
    registry, host: "127.0.0.1", port, whois: async () => { requests++; return caller; }, allowed: new Set([laptop, phone]),
    hostnames: new Set([apiName, "127.0.0.1"]), harness: fake.harness, wake: () => {}, previewPorts: { first: 10200, last: 10299 }, images, usageBackfill: backfill,
    startThread,
    probes: new Map([[node, {
      command: (_pylonId: PylonId, command: PylonCommand) => { commands.push(command); return answer(command); },
      stream: (_pylonId: PylonId, argv: readonly string[]) => pipe(argv),
      health: () => health(),
    }]]),
  });
  let api = await startApi(options(0));
  t.after(async () => {
    await items?.close();
    await queue?.close();
    await api.close();
    await images.close();
    await backfill.close();
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
    registry, fake, proxy, home, api, env, nexus, json, commands, startThread,
    /** How many requests the API has admitted. */
    requests: () => requests,
    callAs(id: TailnetNodeId) { caller = id; },
    probeAnswers(next: typeof answer) { answer = next; },
    probePipes(next: typeof pipe) { pipe = next; },
    nodeHealth(next: typeof health) { health = next; },
    remoteReads(next: typeof read) { read = next; },
    localUrl: `http://127.0.0.1:${api.port}`,
    /** The TLS port, once the API serves it. */
    httpsPort: () => api.httpsPort,
    /** The certificate's file, for NODE_EXTRA_CA_CERTS, as a tailnet certificate is trusted on a real Mac. */
    certFile: join(dir, "cert.pem"),
    /** Stops the control plane, which drops every connection, and returns a function that starts it again on its port. */
    async stop() {
      const { port } = api;
      await api.close();
      return async () => { api = await startApi(options(port)); };
    },
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

test("--help or -h after a command prints its lines of nexus --help and exits 0 without a request", async (t) => {
  const s = await setup(t);
  const all = new Set((await s.nexus(["--help"])).stdout.split("\n"));
  const names = ["events", "threads", "show", "ports", "preview", "unpreview", "files", "changes", "diff", "conversation", "session open", "session close",
    "attach", "start", "start-queued", "items", "item add", "item show", "item approve", "item cancel", "send", "watch", "seen", "abort", "retry", "retry-pylon", "wake", "archive", "unarchive", "delete", "projects", "project edit",
    "project add", "review", "land", "deploy", "release", "image build", "image rollout", "image rollback", "image list", "image current", "nodes", "usage", "usage backfill"];
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
    + "    [--auto-review off|review|land]   review each builder's PR on its own, and land it too; land needs a deployer\n"
    + "    [--pipeline off|approve|start]    turn pipeline items into threads, once the person approves each or on their own\n");
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

  const human = await s.nexus(["threads"]);
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

test("project add creates a project with the contract's defaults or its flags, and maps the API's refusals", async (t) => {
  const s = await setup(t);
  const repo = "https://github.com/octocat/Hello-World.git";
  const added = await s.nexus(["project", "add", "hello", repo, "--node", node]);
  assert.deepEqual([added.code, added.stdout, added.stderr], [0, `Added project hello (${repo}) on ${node}\n`, ""]);
  assert.deepEqual(s.registry.project("hello" as ProjectId), {
    id: "hello", repoUrl: repo, defaultBranch: "main", defaultNode: node,
    resources: { cpus: 2, memoryGiB: 6, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
  }, "an unflagged project gets main, 2 CPUs, 6 GiB of memory and 10 GiB of disk");

  const custom = await s.json([
    "project", "add", "custom", "git@github.com:octocat/Spoon-Knife.git", "--node", node, "--branch", "dev", "--cpus", "4", "--memory", "8", "--disk", "20",
    "--allow-host", "registry.npmjs.org", "--login", "claude", "--allow-host", "api.stripe.com", "--login", "chatgpt",
  ]);
  assert.deepEqual(custom, {
    id: "custom", repoUrl: "git@github.com:octocat/Spoon-Knife.git", defaultBranch: "dev", defaultNode: node,
    resources: { cpus: 4, memoryGiB: 8, diskGiB: 20 }, allowedHosts: ["registry.npmjs.org", "api.stripe.com"], secrets: [], logins: ["claude", "chatgpt"], preSetup: null,
  }, "--json prints the created project, with each repeated flag's values in order");
  assert.deepEqual(s.registry.project("custom" as ProjectId), custom);
  assert.deepEqual((await s.json(["projects"])).map((p: Project) => p.id).toSorted(), ["acme", "custom", "hello"]);

  const fails = async (args: readonly string[], code: number, error: Record<string, unknown>, overrides?: Record<string, string>) => {
    const res = await s.nexus([...args, "--json"], overrides);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    const reported = JSON.parse(res.stderr);
    assert.deepEqual(Object.fromEntries(Object.keys(error).map((k) => [k, reported[k]])), error);
  };
  await fails(["project", "add", "hello", repo, "--node", node], 5, { kind: "conflict", status: 409, error: "project hello exists" });
  await fails(["project", "add", "other", repo, "--node", "nowhere"], 64, { kind: "invalid", status: 400, error: "no node nowhere" });
  await fails(["project", "add", "Not_An_Id", repo, "--node", node], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", "https://", "--node", node], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", repo, "--node", node, "--login", "gemini"], 64, { kind: "invalid", status: 400 });
  await fails(["project", "add", "other", repo, "--node", node, "--cpus", "two"], 64, { kind: "invalid", status: null, error: "--cpus takes a whole number, got two" });
  await fails(["project", "add"], 64, { kind: "invalid", status: null, error: "project add takes 1 to 2 arguments, got 0" });
  await fails(["project", "other"], 64, { kind: "invalid", status: null, error: "unknown command project" });
  assert.deepEqual(s.registry.projects().map((p) => p.id).toSorted(), ["acme", "custom", "hello"], "no refused project was created");

  const spread = await s.nexus(["project", "add", "spread", repo]);
  assert.deepEqual([spread.code, spread.stdout, spread.stderr], [0, `Added project spread (${repo}) on auto\n`, ""]);
  assert.equal(s.registry.project("spread" as ProjectId)!.defaultNode, "auto", "without --node its threads boot where they fit best");
});

test("project add --scratch makes a project with no repository, --secret grants each NAME:HOST in order, and start cannot pin its commit", async (t) => {
  const s = await setup(t);
  const added = await s.nexus(["project", "add", "sketch", "--scratch", "--node", node, "--secret", "GH_TOKEN:api.github.com,github.com", "--secret", "EXA_API_KEY:api.exa.ai"]);
  assert.deepEqual([added.code, added.stdout, added.stderr], [0, `Added scratch project sketch on ${node}\n`, ""]);
  assert.deepEqual(s.registry.project("sketch" as ProjectId), {
    id: "sketch", repoUrl: null, defaultBranch: "main", defaultNode: node, resources: { cpus: 2, memoryGiB: 6, diskGiB: 10 }, allowedHosts: [],
    secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }, { name: "EXA_API_KEY", hosts: ["api.exa.ai"] }], logins: [], preSetup: null,
  });
  assert.match((await s.nexus(["projects"])).stdout, /^sketch +node rj-firebat +branch main +auto review off +pipeline off +scratch$/m);

  const pinned = await s.nexus(["start", "--project", "sketch", "--title", "x", "--commit", "abc123", "--json"]);
  assert.equal(pinned.code, 64);
  assert.deepEqual((({ kind, status, error }) => ({ kind, status, error }))(JSON.parse(pinned.stderr)), { kind: "invalid", status: 400, error: "project sketch is a scratch project, so it has no commit to check out" });

  // Through a proxy nothing listens on, so each of these fails before it sends a request.
  const offline = { NEXUS_SOCKS: `127.0.0.1:${await freePort()}` };
  const refused = async (args: readonly string[], error: string) => {
    const res = await s.nexus(["project", "add", "other", ...args, "--node", node, "--json"], offline);
    assert.deepEqual([res.code, res.stdout], [64, ""], `${args.join(" ")}: ${res.stderr}`);
    assert.deepEqual((({ kind, status, error }) => ({ kind, status, error }))(JSON.parse(res.stderr)), { kind: "invalid", status: null, error }, args.join(" "));
    return res.stderr;
  };
  const either = "project add takes a <repo-url> or --scratch, and not both";
  await refused(["https://github.com/octocat/Hello-World.git", "--scratch"], either);
  await refused([], either);
  const grant = "--secret takes NAME:HOST[,HOST...], an upper-case name and lower-case hostnames, such as GH_TOKEN:api.github.com,github.com. The value stays in each node's secret file";
  assert.doesNotMatch(await refused(["--scratch", "--secret", "GH_TOKEN=ghp_pastedbymistake"], grant), /ghp_pastedbymistake/, "a pasted token is not repeated");
  for (const malformed of ["gh_token:github.com", "GH_TOKEN:", "GH_TOKEN:github.com,", "GH_TOKEN:ghp_pastedbymistake", "GH_TOKEN:GitHub.com"]) {
    await refused(["--scratch", "--secret", malformed], grant);
  }
  assert.deepEqual(s.registry.projects().map((p) => p.id).toSorted(), ["acme", "sketch"], "no refused project was created");
});

/** The JSON lines a watch prints, one at a time. */
function watchLines(t: TestContext, s: Awaited<ReturnType<typeof setup>>, args: readonly string[], interval = 50) {
  const child = spawn(process.execPath, [cli, "watch", ...args, "--json", "--interval", String(interval)], { env: s.env() });
  t.after(() => { child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    async next(): Promise<any> {
      // The deadline only ends a hang: a loaded suite can take seconds over what takes milliseconds alone.
      const timeout = AbortSignal.timeout(60_000);
      const line = await Promise.race([lines.next(), once(timeout, "abort").then(() => assert.fail(`no line from watch. stderr: ${stderr}`))]);
      assert.ok(!line.done, `watch ended early. stderr: ${stderr}`);
      return JSON.parse(line.value);
    },
  };
}

/** Reports the node online with the thread's pylon running these services and listening on these ports. */
function observeRunning(s: Awaited<ReturnType<typeof setup>>, thread: Thread, services: ServiceFact[], ports: number[]) {
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested({
    node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [], jobs: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
    pylons: [{
      pylonId: thread.pylonId, phase: "running", liveHash: s.registry.pylon(thread.pylonId)!.liveHash, bootedAt: "2027-01-01T00:00:00Z",
      bootedFrom: { image: image.id, checkpoint: null }, services, listening: ports.map((port) => ({ port })), previews: [], sessions: [], git: null, declaredOutputs: [], attachedClients: 0,
    }],
  }, []);
}

test("ports lists what the pylon listens on, and preview publishes one and waits until it is served", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "ports"]);
  assert.deepEqual(await s.json(["ports", thread.id]), [], "a pylon that does not run listens on nothing");
  observeRunning(s, thread, [], [3000]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 3000, service: null, preview: null }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `3000  -  -\n\`nexus preview ${thread.id} <port>\` publishes a port.\n`);

  const preview = { pylon: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: false, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual(await s.json(["preview", thread.id, "3000"]), preview, "the reply names the URL before it is served");
  const asked = s.requests();
  const waiting = s.json(["preview", thread.id, "3000", "--wait"]);
  await until("the wait polls a published preview that is not served yet", () => s.requests() >= asked + 2);
  observeRunning(s, thread, [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], [3000]);
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: true });
  assert.deepEqual(await waiting, { ...preview, ready: true });
  assert.equal((await s.nexus(["preview", thread.id, "3000", "--wait"])).stdout, `${preview.url}\n`);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `3000  port-3000  ${preview.url}\n`);
  assert.equal((await s.nexus(["preview", thread.id, "http"])).code, 64);
});

test("show reports a published preview whose service is starting as not ready, and one whose service failed as not ready, and why", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "failed web"]);
  const web = (state: ServiceFact["state"]): ServiceFact => ({ name: "web", state, port: 8003, declared: true, wantsPreview: true });
  observeRunning(s, thread, [web("ready")], [8003]);
  s.registry.allocatePreviews(thread.pylonId, ["web"], { first: 10200, last: 10299 });
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "web", httpsPort: 10200, ready: true });
  const preview = { pylon: thread.pylonId, service: "web", httpsPort: 10200, ready: true, failed: null, url: "https://rj-firebat.tail.ts.net:10200/" };
  assert.deepEqual((await s.json(["show", thread.id])).previews, [preview]);

  observeRunning(s, thread, [web("starting")], [8003]);
  assert.deepEqual((await s.json(["show", thread.id])).previews, [{ ...preview, ready: false }], "the node publishes it, but it answers 502 until the service is ready");
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^preview: web at ${preview.url}, not ready$`, "m"));
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `8003  web  ${preview.url} (not served yet)\n`);
  s.probeAnswers(async () => ({ kind: "link-port", service: "web" })); // a port a declared service owns is previewed under it
  const asked = s.requests();
  const waiting = s.json(["preview", thread.id, "8003", "--wait"]);
  await until("the wait polls while the service starts", () => s.requests() >= asked + 2);
  observeRunning(s, thread, [web("ready")], [8003]);
  assert.deepEqual(await waiting, preview, "--wait returns once the service is ready");

  observeRunning(s, thread, [web("failed")], []);
  const failed = "the service web failed. `nexus service logs web` in the pylon shows why";
  assert.deepEqual((await s.json(["show", thread.id])).previews, [{ ...preview, ready: false, failed }], "the node still publishes it, but nothing answers");
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^preview: web at ${preview.url}, not ready: the service web failed\\. \`nexus service logs web\` in the pylon shows why$`, "m"));

  // A service that listens but fails its health check is failed too.
  observeRunning(s, thread, [web("failed")], [8003]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 8003, service: "web", preview: { ...preview, ready: false, failed } }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `8003  web  ${preview.url} (not ready: ${failed})\n`);

  observeRunning(s, thread, [web("ready")], [8003]);
  assert.deepEqual((await s.json(["show", thread.id])).previews, [preview], "a restarted service's preview is ready again");

  // A ready service whose port has no route into the pylon answers nothing either, and says why.
  const unrouted = "the relay cannot listen on its relay port 127.0.0.1:700: [Errno 98] Address already in use";
  observeRunning(s, thread, [{ ...web("ready"), unrouted }], [8003]);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 8003, service: "web", preview: { ...preview, ready: false, failed: unrouted } }]);
  assert.equal((await s.nexus(["ports", thread.id])).stdout, `8003  web  ${preview.url} (not ready: ${unrouted})\n`);
});

test("a preview from a control plane older than Preview.failed reads as not failed, a session older than Session.state as running, and a thread older than Thread.working as working while its session turn runs", async (t) => {
  const s = await setup(t);
  // That control plane's shapes: a Preview with no `failed`, and a Session with no `id`, `state` or `message`.
  const web = { pylon: "pylon-th-old", service: "web", httpsPort: 10200, ready: true, url: "https://rj-firebat.tail.ts.net:10200/" };
  const api = { ...web, service: "api", httpsPort: 10201, ready: false, url: "https://rj-firebat.tail.ts.net:10201/" };
  const detail = {
    thread: { id: "th-old", title: "old", project: "acme", status: "active", agentTurnRunning: false, sessionTurnRunning: true },
    pylon: { id: "pylon-th-old", node, actualState: "running", failed: null, observedAt: null, retryRefused: null },
    sessions: [{ pylon: "pylon-th-old", herdrPane: "w1:p1", harness: "pi", harnessSessionId: null, status: "idle", title: "plan" }], previews: [api, web], ports: [{ port: 3000, service: "web", preview: web }, { port: 4000, service: "api", preview: api }], outputs: [], agent: null,
  };
  const old = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "POST" ? web : detail));
  });
  const overrides = { NEXUS_URL: `http://${apiName}:${await listening(t, old)}` };
  const run = async (args: string[]) => {
    const res = await s.nexus(args, overrides);
    assert.equal(res.code, 0, res.stderr);
    return res.stdout;
  };
  const shown = await run(["show", "th-old"]);
  assert.match(shown, /^preview: api at https:\/\/rj-firebat\.tail\.ts\.net:10201\/, not ready$/m);
  assert.match(shown, /^preview: web at https:\/\/rj-firebat\.tail\.ts\.net:10200\/$/m);
  assert.match(shown, /^session: pi "plan" in pane w1:p1, idle$/m);
  assert.match(shown, /^status: active, agent working$/m);
  assert.equal(await run(["ports", "th-old"]), `3000  web  ${web.url}\n4000  api  ${api.url} (not served yet)\n`);
  assert.equal(await run(["preview", "th-old", "3000"]), `${web.url}\n`);
});

test("files, changes and diff read the pylon's checkout, and wait for a paused pylon to run", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "checkout"]);
  const repo = await mkdtemp(join(tmpdir(), "nexus-cli-checkout-"));
  t.after(() => rm(repo, { recursive: true }));
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  // Enough lines stay the same that the renamed file is still similar enough for git to call it a rename.
  const kept = "keep\n".repeat(4);
  await writeFile(join(repo, "app.txt"), `one\n${kept}`);
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-q", "-m", "first");
  await git("update-ref", "refs/nexus/base", "HEAD");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(repo, "app.txt"), `two\n${kept}`);
  await git("commit", "-q", "-am", "agent work");
  await git("mv", "app.txt", "main.txt");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "x.ts"), "x\n");
  let refusals = 2;
  s.probePipes(async (argv) => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {});
  });

  const listed = await s.nexus(["files", thread.id]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stdout, ".git/\nmain.txt  24\nsrc/\n", "a paused pylon is woken and asked again until it runs");
  assert.deepEqual((await s.json(["files", thread.id, "src"])).entries, [{ name: "x.ts", kind: "file", size: 2 }]);

  assert.equal((await s.nexus(["changes", thread.id])).stdout, [
    `Changes since the commit the pylon booted at, ${base.slice(0, 12)}:`,
    "renamed  +1 -1  main.txt (from app.txt)",
    "added    +1 -0  src/x.ts",
    "",
  ].join("\n"));
  const uncommitted = await s.json(["changes", thread.id, "--uncommitted"]);
  assert.equal(uncommitted.base.kind, "head");
  assert.deepEqual(uncommitted.files.map((f: { path: string; status: string }) => [f.status, f.path]), [["renamed", "main.txt"], ["added", "src/x.ts"]]);

  const diff = await s.nexus(["diff", thread.id, "src/x.ts"]);
  assert.equal(diff.stdout, "diff --git a/src/x.ts b/src/x.ts\nnew file mode 100644\nindex 0000000..587be6b\n--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+x\n");
  assert.equal((await s.nexus(["diff", thread.id, "nothing-here"])).stdout, "No changes.\n");
  const renamed = await s.json(["diff", thread.id, "--uncommitted", "app.txt", "main.txt"]);
  assert.match(renamed.diff, /rename from app.txt\nrename to main.txt/, "a rename shows as one when both paths are named");

  s.fake.harness.latestTurn = async () => "42";
  assert.equal((await s.nexus(["changes", thread.id, "--turn", "--json"])).code, 1);
  await checkoutReader(async (argv) => processStream(argv[0]!, argv.slice(1), () => {}), repo).snapshot("42");
  await writeFile(join(repo, "turn.txt"), "latest reply\n");
  const turn = await s.json(["changes", thread.id, "--turn"]);
  assert.equal(turn.base.kind, "turn");
  assert.deepEqual(turn.files.map((f: { path: string }) => f.path), ["turn.txt"]);
  const turnDiff = await s.json(["diff", thread.id, "--turn", "turn.txt"]);
  assert.deepEqual(turnDiff.base, turn.base);
  assert.match(turnDiff.diff, /\+latest reply/);
  assert.equal((await s.nexus(["changes", thread.id, "--turn", "--uncommitted"])).code, 64);

  const missing = await s.nexus(["files", thread.id, "nope", "--json"]);
  assert.equal(missing.code, 4);
  assert.match(JSON.parse(missing.stderr).error, /nope does not exist/);
});

test("changes and diff of a scratch thread are against the empty tree, before its first commit and after", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "scratch"]);
  const scratch = await mkdtemp(join(tmpdir(), "nexus-cli-scratch-"));
  t.after(() => rm(scratch, { recursive: true }));
  const repo = join(scratch, "repo");
  await promisify(execFile)("sh", ["-c", repoInitCommand({ kind: "empty", branch: "main" }, repo)]);
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === checkoutDir ? repo : arg), () => {}));
  const output = async (args: string[]) => {
    const res = await s.nexus(args);
    assert.equal(res.code, 0, res.stderr);
    return res.stdout;
  };
  await writeFile(join(repo, "README.md"), "# sketch\n");

  const sinceBoot = "Changes since the pylon booted an empty repository:\nadded  +1 -0  README.md\n";
  assert.equal(await output(["changes", thread.id]), sinceBoot);
  assert.equal(await output(["changes", thread.id, "--uncommitted"]), "Changes since HEAD, which names no commit yet:\nadded  +1 -0  README.md\n");
  const firstDiff = await output(["diff", thread.id]);
  assert.match(firstDiff, /^diff --git a\/README.md b\/README.md\nnew file mode 100644\n[^]*\n\+# sketch\n$/);
  assert.equal(await output(["diff", thread.id, "--uncommitted"]), firstDiff);

  await git("add", "-A");
  await git("commit", "-q", "-m", "first");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  assert.equal(await output(["changes", thread.id]), sinceBoot, "the agent's commit is a change since the start too");
  assert.equal(await output(["diff", thread.id]), firstDiff);
  assert.equal(await output(["changes", thread.id, "--uncommitted"]), `No changes since HEAD, ${head.slice(0, 12)}.\n`);
});

test("unpreview unpublishes a port, waits for a paused pylon to run, and fails with the contract's exit codes", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "unpreview"]);
  observeRunning(s, thread, [], [3000]);
  const preview = await s.json(["preview", thread.id, "3000"]);
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null);
  assert.deepEqual(await s.json(["ports", thread.id]), [{ port: 3000, service: null, preview: null }]);
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null, "a port with no linked preview succeeds");
  assert.equal((await s.nexus(["unpreview", thread.id, "3000"])).stdout, `Unpublished port 3000 of ${thread.id}.\n`);
  assert.deepEqual(await s.json(["preview", thread.id, "3000"]), preview, "the port can be published again");

  let refusals = 2;
  s.probeAnswers(async (command) => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return { kind: "unlink-port", refused: null };
  });
  s.commands.length = 0;
  assert.equal(await s.json(["unpreview", thread.id, "3000"]), null, "a paused pylon is woken and asked again until it runs");
  assert.deepEqual(s.commands, Array(3).fill({ kind: "unlink-port", port: 3000 }));

  const fails = async (args: string[], code: number) => {
    const res = await s.nexus([...args, "--json"]);
    assert.equal(res.code, code, `${args.join(" ")}: ${res.stderr}`);
    assert.equal(res.stdout, "");
    return JSON.parse(res.stderr) as { error: string; kind: string; status: number | null };
  };
  const reason = "Port 5173 is the preview of service web, not a linked port. Remove the preview from /home/user/workspace/repo/.nexus/services.yaml to unpublish it";
  s.probeAnswers(async () => ({ kind: "unlink-port", refused: reason }));
  s.commands.length = 0;
  assert.deepEqual(await fails(["unpreview", thread.id, "5173"], 1), { error: reason, kind: "failed", status: 422, code: null }, "the refusal is the pylon's reason alone, and is not tried again");
  assert.equal(s.commands.length, 1);
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: connect ECONNREFUSED"), { code: "unreachable" }); });
  await fails(["unpreview", thread.id, "3000"], 1);
  s.commands.length = 0;
  for (const port of ["http", "0", "70000"]) await fails(["unpreview", thread.id, port], 64);
  assert.deepEqual(s.commands, [], "a bad port never reaches the API");
  await s.json(["archive", thread.id]);
  await fails(["unpreview", thread.id, "3000"], 5);
  await s.json(["delete", thread.id]);
  await fails(["unpreview", thread.id, "3000"], 5);
});

test("session open opens Claude Code by default, waits for a paused pylon, and session close closes a pane or says why not", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "sessions"]);
  assert.deepEqual(await s.json(["session", "open", thread.id]), { herdrPane: "w1:p1", harness: "claude-code", title: "claude-code" });
  assert.equal((await s.nexus(["session", "open", thread.id, "--harness", "pi", "--title", "plan"])).stdout,
    `Opened pi session "plan" in pane w1:p1 of ${thread.id}. \`nexus attach ${thread.id}\` attaches to it.\n`);
  assert.deepEqual(s.commands, [{ kind: "open-session", harness: "claude-code", title: "claude-code" }, { kind: "open-session", harness: "pi", title: "plan" }]);

  s.commands.length = 0;
  assert.equal((await s.nexus(["session", "close", thread.id, "w1:p1"])).stdout, `Closed session w1:p1 of ${thread.id}.\n`);
  assert.deepEqual(s.commands, [{ kind: "close-session", herdrPane: "w1:p1" }]);

  // Not asked again: after the wake the pane may name another session.
  s.probeAnswers(async () => { throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" }); });
  s.commands.length = 0;
  const waking = await s.nexus(["session", "close", thread.id, "w1:p1"]);
  assert.equal(waking.code, 5);
  assert.match(waking.stderr, /is not running yet. This request wakes it/);
  assert.equal(s.commands.length, 1);
  s.probeAnswers(async () => ({ kind: "close-session", outcome: "not-open" }));
  const stale = await s.nexus(["session", "close", thread.id, "w1:p1"]);
  assert.equal(stale.code, 4);
  assert.match(stale.stderr, /no session is open in pane w1:p1 .* A wake may have moved it/);

  // A paused session is refused at once, and its pylon is not asked.
  s.registry.apply({ record: "sessions", pylonId: thread.pylonId, sessions: [
    { id: "w1:p1", state: "paused", herdrPane: "w1:p1", harness: "claude-code", harnessSessionId: null, title: "review", status: null, message: null },
    { id: "failed-0123456789ab", state: "failed", herdrPane: null, harness: "pi", harnessSessionId: null, title: "plan", status: null, message: "pi exited 1" },
  ] });
  s.commands.length = 0;
  const paused = await s.nexus(["session", "close", thread.id, "w1:p1"]);
  assert.equal(paused.code, 5);
  assert.match(paused.stderr, /session w1:p1 is paused with its pylon and resumes when its pylon wakes/);
  assert.deepEqual(s.commands, []);
  const shown = (await s.nexus(["show", thread.id])).stdout;
  assert.match(shown, /^session: claude-code "review" in pane w1:p1, paused \(resumes on wake\)$/m);
  assert.match(shown, /^session: pi "plan" as failed-0123456789ab, failed: pi exited 1$/m);
  s.probeAnswers(async () => ({ kind: "drop-failed-session", dropped: true }));
  assert.equal((await s.nexus(["session", "close", thread.id, "failed-0123456789ab"])).code, 0);
  assert.deepEqual(s.commands, [{ kind: "drop-failed-session", id: "failed-0123456789ab" }]);

  assert.equal((await s.nexus(["session", "open", thread.id, "--harness", "codex"])).code, 64);
  assert.equal((await s.nexus(["session", "close", thread.id])).code, 64);
  await s.json(["archive", thread.id]);
  s.commands.length = 0;
  const archived = await s.nexus(["session", "open", thread.id]);
  assert.equal(archived.code, 5);
  assert.match(archived.stderr, /is archived, so its pylon stays paused/);
  assert.deepEqual(s.commands, []);
  assert.match((await s.nexus(["show", thread.id])).stdout, /^session: claude-code "review" in pane w1:p1, paused \(resumes on unarchive\)$/m);
});

/** A pipe to the relay in the guest that prints Herdr's screen once its source is in, and exits 0 when its stdin ends. */
function herdrPipe(): ByteStream {
  const output = new PassThrough();
  const end = Promise.withResolvers<StreamEnd>();
  let printed = false;
  return {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    async write() {
      if (printed) return;
      printed = true;
      output.write("herdr screen\r\n");
      setTimeout(() => {
        output.end();
        end.resolve({ kind: "exited", code: 0 });
      }, 50);
    },
    async close() {},
    abort() {},
    done: end.promise,
  };
}

/** Runs the CLI in a terminal of its own, made as a pylon makes one, and returns its exit code and screen. */
async function inTerminal(env: Record<string, string>, args: readonly string[]): Promise<{ code: number; screen: string }> {
  const terminal = await openTerminal(async (argv) => processStream(argv[0]!, argv.slice(1), () => {}), terminalSize(100, 30), "xterm-256color",
    ["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, cli, ...args]);
  let screen = "";
  for await (const chunk of terminal) screen += Buffer.from(chunk).toString();
  const end = await terminal.done;
  return { code: end.kind === "exited" ? end.code : -1, screen };
}

test("attach gives this terminal to the pylon's Herdr session through the SOCKS proxy, and Herdr's exit 0 is the CLI's", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "attach"]);
  observeRunning(s, thread, [], []);
  const argvs: (readonly string[])[] = [];
  s.probePipes(async (argv) => {
    argvs.push(argv);
    return herdrPipe();
  });
  const before = Date.now();
  const attached = await inTerminal(s.env(), ["attach", thread.id]);
  assert.equal(attached.code, 0, attached.screen);
  assert.match(attached.screen, /herdr screen/);
  assert.deepEqual(argvs[0]!.slice(5, 8), ["100", "30", "xterm-256color"], "the terminal's size and TERM reached the pylon");
  assert.ok(s.registry.thread(thread.id)!.lastHumanActivityAt >= before, "attaching is human activity");
  assert.ok(s.proxy.connects.length > 0 && s.proxy.connects.every((c) => c === `${apiName}:${s.api.port}`), "through the proxy");
});

test("attach to an archived thread exits 5, without a terminal 64, and against a control plane without the route says to upgrade it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "attach"]);
  await s.json(["archive", thread.id]);
  const archived = await inTerminal(s.env(), ["attach", thread.id]);
  assert.equal(archived.code, 5, archived.screen);
  assert.match(archived.screen, /is archived, so its pylon stays paused/);

  const piped = await s.nexus(["attach", thread.id]);
  assert.equal(piped.code, 64);
  assert.match(piped.stderr, /attach needs a terminal/);

  // As a control plane before the route answers any path it does not know.
  const old = createHttpServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `no route ${new URL(req.url!, "http://x").pathname}` }));
  });
  const port = await listening(t, old);
  const upgrade = await inTerminal(s.env({ NEXUS_URL: `http://127.0.0.1:${port}`, NEXUS_SOCKS: "none" }), ["attach", thread.id]);
  assert.equal(upgrade.code, 1, upgrade.screen);
  assert.match(upgrade.screen, new RegExp(`the control plane at 127\\.0\\.0\\.1:${port} has no attach route\\. Upgrade it, as deploy/README\\.md describes`));
});

test("attach with a config of only the URL and the proxy prints nothing but its own error", async (t) => {
  const s = await setup(t);
  await mkdir(join(s.home, ".config", "nexus"), { recursive: true });
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), JSON.stringify({ url: s.localUrl, socks: "none" }));
  const attach = await s.nexus(["attach", "th-0123456789ab"], { NEXUS_URL: "", NEXUS_SOCKS: "" });
  assert.deepEqual([attach.code, attach.stderr], [64, "nexus: attach needs a terminal, and stdin or stdout is not one. Run nexus --help for usage\n"]);
});

test("the attach settings retired in 0.9.0 are unknown keys of the config file, and NEXUS_ATTACH is not read", async (t) => {
  const s = await setup(t);
  await mkdir(join(s.home, ".config", "nexus"), { recursive: true });
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), JSON.stringify({ ssh: { "rj-firebat": "rj-firebat" }, attach: "ssh -t x" }));
  const projects = await s.nexus(["projects"]);
  assert.equal(projects.code, 64);
  assert.match(projects.stderr, /cli\.json is not a CLI config: config: Unrecognized keys: "ssh", "attach"/);
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), "{}");
  const attach = await s.nexus(["attach", "th-0123456789ab"], { NEXUS_ATTACH: "ssh -t y" });
  assert.deepEqual([attach.code, attach.stderr], [64, "nexus: attach needs a terminal, and stdin or stdout is not one. Run nexus --help for usage\n"]);
});

test("watch prints the backlog, then each new entry and state change, and ends when the thread is deleted", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id]);
  const exited = once(watch.child, "exit");

  const first = await watch.next();
  assert.deepEqual([first.type, first.entries.map((e: any) => [e.entry.id, e.entry.kind, e.text])], ["reset", [[1, "pi.user", "> hi"]]], "the first poll prints the context whole");
  const state = { type: "state", thread: thread.id, status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "unknown", failed: null, ports: [] };
  assert.deepEqual(await watch.next(), state);
  const quiet = { type: "live", thread: thread.id, queued: [], tools: [], partial: null, retry: null };
  assert.deepEqual(await watch.next(), quiet, "the run in flight follows the first state");

  s.fake.transcript(thread.id).messages.push({
    role: "assistant", content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
    stopReason: "toolUse", timestamp: Date.now(),
  } as never);
  s.fake.commit(thread.id);
  const answer = await watch.next();
  assert.deepEqual([answer.type, answer.entry.id, answer.text], ["entry", 2, 'On it.\n[tool] bash {"command":"npm test"}']);

  s.fake.transcript(thread.id).docs["pi.live"] = {
    run: { taskId: 1, inputs: [] },
    tools: [{ callId: "c1", status: "running", output: "PASS 3/9" }, { callId: "c0", status: "done", output: "old" }],
    generation: { message: { role: "assistant", content: [{ type: "text", text: "Tests are " }, { type: "text", text: "running." }] }, retry: { error: "overloaded" } },
  };
  s.fake.transcript(thread.id).docs["pi.inbox"] = { items: [{ id: 9, mode: "followUp", content: "and then?" }, { id: 10, mode: "write", content: "x" }] };
  s.fake.commit(thread.id);
  assert.deepEqual(await watch.next(), { ...state, run: "working", queued: 1 });
  assert.deepEqual(await watch.next(), {
    ...quiet, queued: ["and then?"], tools: [{ callId: "c1", output: "PASS 3/9" }], partial: "Tests are running.", retry: "overloaded",
  }, "live carries the queued texts, the running tools' output, the streaming answer and a pending retry");

  await s.json(["delete", thread.id]);
  assert.deepEqual(await watch.next(), { ...state, run: "idle", status: "deleted", queued: 0 }, "a deleted thread has no conversation to be busy");
  assert.deepEqual(await exited, [0, null]);
});

test("a watch whose consumer is killed outright exits, though an idle thread never writes to the dead pipe", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "idle"]);
  const out = join(await mkdtemp(join(tmpdir(), "nexus-orphan-")), "watch.jsonl");
  // The shell starts the watch with its output in a file, so killing the shell leaves no pipe for the watch to find closed.
  const sh = spawn("sh", ["-c", `"$0" "$1" watch "$2" --json --interval 50 > "$3" 2>&1 & echo $!; wait`, process.execPath, cli, thread.id, out], { env: s.env() });
  t.after(() => { sh.kill("SIGKILL"); });
  const [pidLine] = await once(sh.stdout, "data") as [Buffer];
  const pid = Number(pidLine.toString().trim());
  t.after(() => { try { process.kill(pid); } catch {} });
  const alive = async () => {
    try {
      process.kill(pid, 0);
      // A container's PID 1 may leave an exited orphan as a zombie.
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      return !/\) Z /.test(stat);
    } catch { return false; }
  };
  // The deadlines only end a hang: a loaded suite can take seconds over what takes milliseconds alone.
  for (const deadline = Date.now() + 60_000; !(await readFile(out, "utf8").catch(() => "")).includes('"type":"state"');) {
    assert.ok(Date.now() < deadline, "the watch printed the thread's state");
    await new Promise((r) => setTimeout(r, 50));
  }
  sh.kill("SIGKILL");
  await once(sh, "exit");
  for (const deadline = Date.now() + 60_000; await alive();) {
    assert.ok(Date.now() < deadline, "the orphaned watch exited");
    await new Promise((r) => setTimeout(r, 50));
  }
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
  assert.equal((await watch.next()).type, "live");

  // A new head marker leads the active context, ahead of entries older than itself.
  transcript.entries = [userEntry(12, "summary"), userEntry(10, "one")];
  s.fake.commit(thread.id);
  const reordered = await watch.next();
  assert.deepEqual(ids(reordered), ["reset", [12, 10]]);
  assert.deepEqual(reordered.entries.map((e: any) => e.text), ["> summary", "> one"]);
  transcript.entries = [...transcript.entries, userEntry(14, "three")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["entry", 14], "an append to the new context is one entry");

  // A compaction drops what it summarized.
  transcript.entries = [userEntry(15, "compacted"), userEntry(14, "three")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["reset", [15, 14]]);
  transcript.entries = [userEntry(15, "compacted")];
  s.fake.commit(thread.id);
  assert.deepEqual(ids(await watch.next()), ["reset", [15]], "a context that lost its last entry is printed whole");
});

/** The run in flight with this partial answer, as pi-durable's live document holds it. */
const streaming = (partial: string) => ({ run: { taskId: 1, inputs: [] }, tools: [], generation: { message: { role: "assistant", content: [{ type: "text", text: partial }] } } });

test("watch prints each commit of the run as it streams, between polls, and an answer's entry before the live event that drops it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  // One poll in the whole test, so everything after the first prints comes from the stream.
  const watch = watchLines(t, s, [thread.id], 600_000);
  assert.equal((await watch.next()).type, "reset");
  assert.equal((await watch.next()).type, "state");
  assert.equal((await watch.next()).partial, null);

  const transcript = s.fake.transcript(thread.id);
  transcript.docs["pi.live"] = streaming("The");
  s.fake.commit(thread.id);
  assert.deepEqual(await watch.next(), { type: "state", thread: thread.id, status: "active", run: "working", parkedTasks: 0, queued: 0, pylon: "unknown", failed: null, ports: [] });
  assert.equal((await watch.next()).partial, "The");
  for (const partial of ["The build", "The build passes", "The build passes."]) {
    transcript.docs["pi.live"] = streaming(partial);
    s.fake.commit(thread.id);
    assert.deepEqual(await watch.next(), { type: "live", thread: thread.id, queued: [], tools: [], partial, retry: null }, "each commit of the partial is one live event");
  }

  // pi-durable commits the answer and clears the live document together.
  transcript.messages.push({ role: "assistant", content: [{ type: "text", text: "The build passes." }], stopReason: "stop", timestamp: Date.now() } as never);
  transcript.docs["pi.live"] = {};
  s.fake.commit(thread.id);
  const answer = await watch.next();
  assert.deepEqual([answer.type, answer.text], ["entry", "The build passes."]);
  assert.equal((await watch.next()).run, "idle");
  assert.equal((await watch.next()).partial, null, "the partial goes once its entry is printed");
});

test("watch opens a dropped stream again, reports the outage once, and prints the state again when the control plane is back", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--message", "hi"]);
  const watch = watchLines(t, s, [thread.id]);
  assert.equal((await watch.next()).type, "reset");
  const state = await watch.next();
  assert.equal((await watch.next()).type, "live");
  assert.equal(s.fake.watching(thread.id), 1);

  const restart = await s.stop();
  const errors = [await watch.next()];
  // The poll and the stream both retry while it is down, every 50 ms.
  const tried = s.proxy.connects.length;
  await until("the watch retried a few times", () => s.proxy.connects.length >= tried + 6);
  await restart();
  let back = await watch.next();
  for (; back.type === "error"; back = await watch.next()) errors.push(back);
  assert.ok(errors.every((e) => e.type === "error" && e.kind === "unreachable"), JSON.stringify(errors));
  assert.equal(new Set(errors.map((e) => e.message)).size, errors.length, "each message is reported once, whichever source failed with it");
  assert.deepEqual(back, state, "the state again says the control plane is back");

  s.fake.transcript(thread.id).docs["pi.live"] = streaming("Back");
  s.fake.commit(thread.id);
  assert.equal((await watch.next()).run, "working");
  assert.equal((await watch.next()).partial, "Back", "the stream follows the control plane that came back");
  assert.equal(s.fake.watching(thread.id), 1, "the old stream's watch stopped when its connection dropped");
});

/**
 * A Claude worker thread whose session's transcript is the returned file, read from a pylon reported running. Its
 * launch has opened session s1 unless `launched` is false.
 */
async function claudeWatched(t: TestContext, s: Awaited<ReturnType<typeof setup>>, launched = true) {
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  if (launched) s.registry.setClaudeWorker(thread.id, "/poteto-mode count the lines", "started", undefined, "s1");
  const projects = await mkdtemp(join(tmpdir(), "nexus-claude-projects-"));
  t.after(() => rm(projects, { recursive: true }));
  await mkdir(join(projects, "-home-user-workspace-repo"));
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {}));
  observeRunning(s, thread, [], []);
  let sequence = 0;
  return {
    thread, transcript: join(projects, "-home-user-workspace-repo", "s1.jsonl"),
    report: (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1" } }),
  };
}

const at = (n: number) => new Date(Date.UTC(2026, 9, 26, 2, 0, n)).toISOString();
const claudeRecords = {
  prompt: { type: "user", timestamp: at(1), origin: { kind: "human" }, message: { role: "user", content: "Count the lines of hello.py" } },
  call: { type: "assistant", timestamp: at(2), message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "wc -l hello.py" } }] } },
  failed: { type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "wc: hello.py: No such file", is_error: true }] } },
  reply: { type: "assistant", timestamp: at(4), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "There is no hello.py." }] } },
  pr: { type: "pr-link", sessionId: "s1", prNumber: 7, prUrl: "https://github.com/acme/shop/pull/7", prRepository: "acme/shop", timestamp: at(5) },
};
const jsonl = (...records: object[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

test("watch follows a Claude worker's transcript: the entries whole, then each new one as Claude writes it, and whether Claude works", async (t) => {
  const s = await setup(t);
  const c = await claudeWatched(t, s);
  await writeFile(c.transcript, jsonl(claudeRecords.prompt));
  // The conversation route reads the transcript, so the stream's first frame holds what that read found.
  assert.equal((await s.json(["conversation", c.thread.id])).entries.length, 1);
  const watch = watchLines(t, s, [c.thread.id]);
  const exited = once(watch.child, "exit");

  assert.deepEqual(await watch.next(), {
    type: "claude-reset", thread: c.thread.id, session: "s1", dropped: 0,
    entries: [{ entry: { kind: "prompt", at: Date.parse(at(1)), text: "Count the lines of hello.py", from: "person" }, text: "> Count the lines of hello.py" }],
  });
  const state = { type: "state", thread: c.thread.id, status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "running", failed: null, ports: [] };
  assert.deepEqual(await watch.next(), state);
  const quiet = { type: "live", thread: c.thread.id, queued: [], tools: [], partial: null, retry: null };
  assert.deepEqual(await watch.next(), quiet);

  c.report("session.turn-started");
  assert.deepEqual(await watch.next(), { ...state, run: "working" });
  await appendFile(c.transcript, jsonl(claudeRecords.call));
  c.report("session.turn-started");
  const call = await watch.next();
  assert.deepEqual([call.type, call.entry.kind, call.text], ["claude-entry", "tool", '[tool] Bash {"command":"wc -l hello.py"}']);
  assert.deepEqual(await watch.next(), { ...quiet, tools: [{ callId: "t1", output: "" }] }, "the turn's call runs until its result");

  await appendFile(c.transcript, jsonl(claudeRecords.failed, claudeRecords.reply, claudeRecords.pr, { ...claudeRecords.pr, timestamp: at(6) }));
  c.report("session.turn-ended");
  const texts: string[] = [];
  let idle = false;
  while (texts.length < 4 || !idle) {
    const line = await watch.next();
    if (line.type === "claude-entry") texts.push(line.text);
    idle ||= line.type === "state" && line.run === "idle";
  }
  assert.deepEqual(texts, ["[tool error] wc: hello.py: No such file", "There is no hello.py.", "[pull request] Opened pull request #7: https://github.com/acme/shop/pull/7", ""],
    "a pull request Claude Code names again prints nothing the second time");

  const restart = await s.stop();
  await restart();
  await appendFile(c.transcript, jsonl({ ...claudeRecords.reply, timestamp: at(7), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } }));
  c.report("session.turn-ended");
  let line = await watch.next();
  for (; line.type !== "claude-entry"; line = await watch.next()) assert.notEqual(line.type, "claude-reset", "a reconnect prints no entry again");
  assert.equal(line.text, "Done.", "only the entry Claude wrote since");

  await s.json(["delete", c.thread.id]);
  for (let line = await watch.next(); ; line = await watch.next()) {
    if (line.type === "state" && line.status === "deleted") break;
  }
  assert.deepEqual(await exited, [0, null]);
});

test("watch prints one new entry past the kept 3,000 of a Claude transcript, across a reconnect too", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  s.registry.setClaudeWorker(thread.id, "/poteto-mode count the lines", "started", undefined, "s1");
  const prompt = (n: number): ClaudeEntry => ({ kind: "prompt", at: n, text: `prompt ${n}`, from: "person" });
  let offset = 0;
  const read = (entries: ClaudeEntry[]) => {
    const from = { ...transcriptStart, offset };
    offset += entries.length;
    assert.ok(s.registry.appendClaudeRead(thread.id, { session: "s1", from, entries, cursor: { ...transcriptStart, offset }, reset: false, readAt: Date.now() }));
  };
  let sequence = 0;
  const report = (kind: "session.turn-started" | "session.turn-ended") => s.registry.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1" } });
  read(Array.from({ length: 3000 }, (_, i) => prompt(i)));
  const watch = watchLines(t, s, [thread.id]);
  const first = await watch.next();
  assert.deepEqual([first.type, first.entries.length, first.dropped], ["claude-reset", 3000, 0]);
  const next = async (what: string) => {
    for (;;) {
      const line = await watch.next();
      assert.notEqual(line.type, "claude-reset", what);
      if (line.type === "claude-entry") return line.entry;
    }
  };

  read([prompt(3000)]);
  report("session.turn-started");
  assert.deepEqual(await next("an entry past the kept 3,000 is no reset"), prompt(3000));
  const restart = await s.stop();
  await restart();
  read([prompt(3001)]);
  report("session.turn-ended");
  assert.deepEqual(await next("a reconnect at the limit prints no entry again"), prompt(3001));
  const reread = await s.json(["conversation", thread.id]);
  assert.deepEqual([reread.entries.length, reread.dropped], [3000, 2]);
});

test("watch's text says a Claude transcript was replaced only when it printed some of it, not when the worker's first session starts", async (t) => {
  const s = await setup(t);
  const c = await claudeWatched(t, s, false);
  const child = spawn(process.execPath, [cli, "watch", c.thread.id, "--interval", "50"], { env: s.env() });
  t.after(() => { child.kill(); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, "-- active, pylon running");
  await writeFile(c.transcript, jsonl(claudeRecords.prompt));
  s.registry.setClaudeWorker(c.thread.id, "/poteto-mode count the lines", "started", undefined, "s1");
  c.report("session.turn-started");
  const printed: string[] = [];
  while (!printed.includes("> Count the lines of hello.py")) printed.push((await lines.next()).value as string);
  assert.ok(!printed.some((line) => line.includes("replaced")), printed.join("\n"));
});

test("watch says to use conversation when the control plane is older than the Claude transcript stream", async (t) => {
  const s = await setup(t);
  const c = await claudeWatched(t, s);
  const detail = await s.json(["show", c.thread.id]);
  const old = createHttpServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path === `/v1/threads/${c.thread.id}`) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(detail));
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `no route ${path}` }));
  });
  const port = await listening(t, old);
  const child = spawn(process.execPath, [cli, "watch", c.thread.id, "--interval", "50"], { env: s.env({ NEXUS_URL: `http://127.0.0.1:${port}`, NEXUS_SOCKS: "none" }) });
  t.after(() => { child.kill(); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, `-- The control plane does not stream Claude transcripts. Upgrade it, or run nexus conversation ${c.thread.id}`);
  assert.equal((await lines.next()).value, "-- active, pylon running", "the thread's state still prints");
});

test("watch ends with the API's exit code when it refuses the stream", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "x"]);
  s.callAs("nSTRANGER" as TailnetNodeId);
  const res = await s.nexus(["watch", thread.id, "--json", "--interval", "50"]);
  assert.equal(res.code, 3, res.stderr);
  assert.equal(JSON.parse(res.stderr).kind, "refused");
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
      (err) => err instanceof CliError && err.kind === "unreachable" && err.message === `the control plane at ${apiName}:${port} sent nothing for 0.2s`);
  } finally {
    // The proxy keeps its leg to the silent server open after the CLI gives up, which would hold the server's close.
    for (const socket of held) socket.destroy();
  }
});

test("connect finds the API on the dashboard's HTTPS port, saves it, and the next command uses it", async (t) => {
  const s = await setup(t, { https: true });
  await until("the API serves TLS", () => s.httpsPort() !== undefined);
  const proxy = await socksProxy(t, 0, { 7443: s.httpsPort()!, 7470: s.api.port });
  const env = { NEXUS_URL: "", NEXUS_SOCKS: "", NODE_EXTRA_CA_CERTS: s.certFile };
  const config = join(s.home, ".config", "nexus", "cli.json");

  const connected = await s.nexus(["connect", apiName, "--socks", `127.0.0.1:${proxy.port}`], env);
  assert.equal(connected.code, 0, connected.stderr);
  assert.equal(connected.stdout, [
    `Connected to https://${apiName}:7443, saved in ${config}.`,
    `This device is tailnet node ${laptop}. It`,
    "  may read threads, projects and nodes",
    "  may start and message threads",
    "  may deploy, land reviews and build images",
    "",
  ].join("\n"));
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { url: `https://${apiName}:7443`, socks: `127.0.0.1:${proxy.port}` });
  assert.equal((await stat(config)).mode & 0o777, 0o600, "only its owner reads the config");
  assert.deepEqual(await s.json(["projects"], env), [project], "the saved URL and proxy reach the API over TLS");
  assert.deepEqual(proxy.connects.slice(-1), [`${apiName}:7443`]);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "attach over TLS"], env);
  await s.json(["archive", thread.id], env);
  const attach = await inTerminal(s.env(env), ["attach", thread.id]);
  assert.equal(attach.code, 5, attach.screen);
  assert.match(attach.screen, /is archived, so its pylon stays paused/, "attach's WebSocket reaches the API over TLS too");

  const plain = await s.nexus(["connect", apiName, "--json"], { ...env, NODE_EXTRA_CA_CERTS: "" });
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout), {
    url: `http://${apiName}:7470`, socks: `127.0.0.1:${proxy.port}`, config,
    caller: { node: laptop, allowed: true, person: true, deployer: true },
  }, "a certificate this device does not trust falls back to HTTP, and the saved proxy is kept");
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { url: `http://${apiName}:7470`, socks: `127.0.0.1:${proxy.port}` });
});

test("connect checks an IP address URL's certificate against that address", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-cli-ip-"));
  t.after(() => rm(dir, { recursive: true }));
  const server = createHttpsServer(await testCertificate(dir, "127.0.0.1"), (req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.url === "/v1/whoami" ? { node: laptop, allowed: true, person: true, deployer: true } : { commit: "a".repeat(40) }));
  });
  const url = `https://127.0.0.1:${await listening(t, server)}`;
  const env = { PATH: process.env.PATH!, HOME: join(dir, "home"), NODE_EXTRA_CA_CERTS: join(dir, "cert.pem") };
  const res = await new Promise<{ code: number; stderr: string }>((resolve) => execFile(process.execPath, [cli, "connect", url], { env },
    (err, _stdout, stderr) => resolve({ code: err === null ? 0 : (err as { code: number }).code, stderr })));
  assert.equal(res.code, 0, res.stderr);
});

test("connect says what this device may do, and the line that admits it when it may not", async (t) => {
  const s = await setup(t);
  const env = { NEXUS_URL: "", NEXUS_SOCKS: "" };
  const config = join(s.home, ".config", "nexus", "cli.json");
  const admit = "run this on the control plane's machine, in its nexus checkout: sudo deploy/install.sh --admit";

  s.callAs(phone);
  const person = await s.nexus(["connect", s.localUrl, "--socks", "none"], env);
  assert.equal(person.code, 0, person.stderr);
  assert.equal(person.stdout, [
    `Connected to ${s.localUrl}, saved in ${config}.`,
    `This device is tailnet node ${phone}. It`,
    "  may read threads, projects and nodes",
    "  may start and message threads",
    "  may not deploy, land reviews and build images",
    `To let it deploy, ${admit} ${phone}`,
    "",
  ].join("\n"));
  assert.equal((await s.nexus(["threads"], env)).code, 0, "a person reads threads");

  s.callAs("nSTRANGER" as TailnetNodeId);
  const stranger = await s.nexus(["connect", s.localUrl], { ...env, NEXUS_URL: "http://elsewhere:7470" });
  assert.equal(stranger.code, 0, stranger.stderr);
  assert.equal(stranger.stdout, [
    `Connected to ${s.localUrl}, saved in ${config}.`,
    "This device is tailnet node nSTRANGER. It",
    "  may not read threads, projects and nodes",
    "  may not start and message threads",
    "  may not deploy, land reviews and build images",
    `To let it use Nexus and deploy, ${admit} nSTRANGER`,
    `NEXUS_URL is set, so it overrides ${config} until you unset it.`,
    "",
  ].join("\n"));
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { url: s.localUrl, socks: "none" }, "the URL is saved for once the device is allowed, with the proxy setting kept");
  const refused = await s.nexus(["threads"], env);
  assert.deepEqual([refused.code, refused.stderr], [3, "nexus: caller is not a tailnet node this control plane allows\n"]);
});

test("connect fails without saving when no control plane answers, or one does not answer to the name", async (t) => {
  const s = await setup(t);
  const env = { NEXUS_URL: "", NEXUS_SOCKS: "" };
  const config = join(s.home, ".config", "nexus", "cli.json");
  const dead = await freePort();
  const proxy = await socksProxy(t, 0, { 7443: dead, 7470: dead });

  const down = await s.nexus(["connect", apiName, "--socks", `127.0.0.1:${proxy.port}`], env);
  assert.equal(down.code, 2);
  assert.match(down.stderr, new RegExp(`^nexus: no Nexus control plane answers at ${apiName} through the SOCKS proxy at 127\\.0\\.0\\.1:${proxy.port}:\n  https://${apiName}:7443: the SOCKS proxy .+\n  http://${apiName}:7470: the SOCKS proxy .+\n$`));
  const direct = await s.nexus(["connect", "127.0.0.1"], env);
  assert.equal(direct.code, 2);
  assert.match(direct.stderr, /give it with --socks HOST:PORT\n$/);

  const wrongName = await s.nexus(["connect", `http://localhost:${s.api.port}`, "--json"], env);
  assert.equal(wrongName.code, 3);
  assert.deepEqual(JSON.parse(wrongName.stderr), {
    error: `the control plane at http://localhost:${s.api.port} answers, but the API does not answer to host localhost:${s.api.port}. Connect with the name the control plane lists in listen.hostnames, such as its full MagicDNS name`,
    kind: "refused", status: 403, code: null,
  });
  assert.equal((await s.nexus(["connect", "rj firebat"], env)).code, 64);
  assert.deepEqual(JSON.parse((await s.nexus(["connect", "999.999.999.999", "--json"], env)).stderr),
    { error: "the control plane URL https://999.999.999.999:7443 is not a URL", kind: "invalid", status: null, code: null });
  await assert.rejects(readFile(config), { code: "ENOENT" });
});

test("connect to a control plane older than whoami saves it and says it cannot tell what this device may do", async (t) => {
  const old = createHttpServer((req, res) => {
    const known = req.url === "/v1/health";
    res.writeHead(known ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(known ? { commit: "a".repeat(40) } : { error: `no route ${req.url}` }));
  });
  const url = `http://127.0.0.1:${await listening(t, old)}`;
  const home = await mkdtemp(join(tmpdir(), "nexus-cli-home-"));
  t.after(() => rm(home, { recursive: true }));
  const res = await new Promise<{ code: number; stdout: string }>((resolve) => execFile(process.execPath, [cli, "connect", url], { env: { PATH: process.env.PATH!, HOME: home } },
    (err, stdout) => resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout })));
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^Connected to http:\/\/127\.0\.0\.1:\d+, saved in .*\nThis control plane allows this device, and is too old to say whether it may start threads or deploy\./);
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


test("seen and --unread share the API marker without waking an archived thread", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "read me"]);
  await s.json(["archive", thread.id]);
  s.registry.recordReply(thread.id, 1000);
  const before = s.registry.thread(thread.id)!;
  assert.equal(await s.json(["seen", thread.id]), null);
  assert.ok(s.registry.thread(thread.id)!.seenAt! >= 1000);
  assert.equal(await s.json(["seen", thread.id, "--unread"]), null);
  assert.deepEqual(s.registry.thread(thread.id), { ...before, seenAt: 999 });
});

test("seen --last-reply-at marks only up to the reply the client showed, and never lowers the mark", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "read me"]);
  s.registry.recordReply(thread.id, 1000);
  s.registry.recordReply(thread.id, 2000);
  const seen = async (...flags: string[]) => {
    assert.equal(await s.json(["seen", thread.id, ...flags]), null);
    return s.registry.thread(thread.id)!.seenAt;
  };
  assert.equal(await seen("--last-reply-at", "1000"), 1000, "a reply that landed after the one shown stays unread");
  assert.equal((await s.json(["show", thread.id])).attention, "reply");
  assert.equal(await seen("--last-reply-at", "500"), 1000, "an older mark does not lower it");
  assert.equal(await seen("--last-reply-at", "2000"), 2000);
  assert.equal((await s.json(["show", thread.id])).attention, null);
  for (const flags of [["--last-reply-at", "soon"], ["--last-reply-at", "-1"], ["--last-reply-at", "1000", "--unread"]]) {
    const refused = await s.nexus(["seen", thread.id, ...flags]);
    assert.equal(refused.code, 64, flags.join(" "));
  }
  assert.equal(s.registry.thread(thread.id)!.seenAt, 2000);
});

test("seen encodes a thread ID so it cannot become an unarchive request", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Stay archived"]);
  await s.json(["archive", thread.id]);
  const before = s.registry.thread(thread.id);
  for (const flags of [[], ["--unread"]]) {
    const result = await s.nexus(["seen", `${thread.id}/unarchive?`, ...flags, "--json"]);
    assert.equal(result.code, 4, result.stderr);
    assert.deepEqual(s.registry.thread(thread.id), before);
  }
});

test("start --node auto picks the node with room, show says why, and nodes prints what pylons hold", async (t) => {
  const s = await setup(t);
  s.registry.upsertNode({ name: "spare" as NodeName, tailnetHost: "spare.tail.ts.net", tailnetNodeId: "nSPARE" as TailnetNodeId });
  const capacity = { cpus: 16, committedCpus: 6, memoryGiB: 62.75, committedMemoryGiB: 16, diskFreeGiB: 180.25, committedDiskGiB: 120 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [image.id], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  assert.match((await s.nexus(["nodes"])).stdout, /^rj-firebat +online +observed .+ {2}6\/16 CPUs, 16\/62\.8 GiB memory committed, 120 GiB disk committed, 180\.3 GiB disk free$/m);

  const plain: Thread = await s.json(["start", "--project", "acme", "--title", "default"]);
  assert.match((await s.nexus(["show", plain.id])).stdout, /^placement: rj-firebat, the project's default node$/m);
  const auto: Thread = await s.json(["start", "--project", "acme", "--title", "auto", "--node", "auto"]);
  assert.match((await s.nexus(["show", auto.id])).stdout,
    /^placement: auto chose rj-firebat, which had the most room left after this pylon; rj-firebat had 38\.8 GiB memory, 6 CPUs and 160\.3 GiB disk left; spare is offline$/m,
    "the default thread's pylon, which the node has yet to report, counts against it");
});

test("show says how the pylon got its setup: fresh and why, with the build it asked for, or from a template its node holds", async (t) => {
  const s = await setup(t);
  const shown = async (title: string) => {
    const thread: Thread = await s.json(["start", "--project", "acme", "--title", title]);
    return { thread, line: (await s.nexus(["show", thread.id])).stdout.split("\n").find((l) => l.startsWith("setup: ")) };
  };
  assert.equal((await shown("unread")).line, "setup: fresh boot runs .nexus/setup, because the control plane could not read .nexus/setup at main: this test has no remote");

  s.remoteReads(async () => ({ commit: "2".repeat(40), setupBlob: "b".repeat(40) }));
  const built = await shown("built");
  const [building] = s.registry.templates(project.id) as Extract<TemplateRecord, { state: "building" }>[];
  assert.equal(built.line, `setup: fresh boot runs .nexus/setup, because no template of this setup is on rj-firebat yet; ${building!.id} builds for the next thread`);

  const log = `the setup of template ${building!.id} failed: Setup exited 1\nnpm ERR! 404`;
  s.registry.saveTemplate({ id: building!.id, key: building!.key, state: "failed", on: node, failedAt: Date.now(), logTail: log });
  const failed = await shown("failed");
  assert.equal(failed.line, `setup: fresh boot runs .nexus/setup, because the build of template ${building!.id} failed on rj-firebat: the setup of template ${building!.id} failed: Setup exited 1`, "the log stays out of the text");
  assert.equal((await s.json(["show", failed.thread.id])).thread.setup.reason, `the build of template ${building!.id} failed on rj-firebat: ${log}`);

  s.registry.saveTemplate({ id: building!.id, key: building!.key, state: "ready", builtOn: node, builtAt: Date.now() - 3 * 60_000, commit: "2".repeat(40) });
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [image.id, building!.id], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  assert.equal((await shown("reused")).line, `setup: from template ${building!.id}, built 3m ago, then checked out 222222222222`);
});

test("start --cpus, --memory and --disk size the thread over its project's, and show prints the size", async (t) => {
  const s = await setup(t);
  const sized: Thread = await s.json(["start", "--project", "acme", "--title", "sized", "--memory", "12", "--cpus", "4"]);
  assert.deepEqual(s.registry.pylon(sized.pylonId)!.boot.resources, { cpus: 4, memoryGiB: 12, diskGiB: 10 }, "the disk it leaves out is the project's");
  assert.match((await s.nexus(["show", sized.id])).stdout, /^size: 4 CPUs, 12 GiB memory, 10 GiB disk$/m);
  const disk: Thread = await s.json(["start", "--project", "acme", "--title", "disk", "--disk", "40"]);
  assert.deepEqual(s.registry.pylon(disk.pylonId)!.boot.resources, { cpus: 2, memoryGiB: 4, diskGiB: 40 });
  const plain: Thread = await s.json(["start", "--project", "acme", "--title", "plain"]);
  assert.match((await s.nexus(["show", plain.id])).stdout, /^size: 2 CPUs, 4 GiB memory, 10 GiB disk$/m, "a thread started without them has its project's size");
  const pylon = s.registry.pylon(plain.pylonId)!;
  s.registry.savePylon({ ...pylon, boot: { ...pylon.boot, resources: { ...pylon.boot.resources, memoryGiB: 8, nestedVirtualization: true } } });
  assert.match((await s.nexus(["show", plain.id])).stdout, /^size: 2 CPUs, 8 GiB memory, 10 GiB disk, nested virtualization$/m, "a verify pylon's size says it nests");

  for (const [flag, value, status] of [["--memory", "0", 400], ["--cpus", "-2", null], ["--disk", "1.5", null], ["--memory", "lots", null]] as const) {
    const res = await s.nexus(["start", "--project", "acme", "--title", "wrong", flag, value, "--json"]);
    assert.equal(res.code, 64, `${flag} ${value}: ${res.stderr}`);
    assert.deepEqual((({ kind, status }) => ({ kind, status }))(JSON.parse(res.stderr)), { kind: "invalid", status }, `${flag} ${value}`);
  }
  assert.deepEqual((await s.json(["threads"])).map((r: Thread) => r.title).toSorted(), ["disk", "plain", "sized"], "no refused start made a thread");
});

test("nodes marks an overcommitted node and says what its pylons hold", async (t) => {
  const s = await setup(t);
  const [up, paused, archived, crashed] = await Promise.all(["up", "paused", "archived", "crashed"].map((title) => s.json(["start", "--project", "acme", "--title", title]))) as Thread[];
  await s.nexus(["archive", archived!.id]);
  const capacity = { cpus: 8, committedCpus: 2, memoryGiB: 22.8, committedMemoryGiB: 40, diskFreeGiB: 100, committedDiskGiB: 30 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const stopped = (t: Thread) => ({ pylonId: t.pylonId, phase: "stopped" as const, checkpoint: null, sessions: null });
  s.registry.ingested({
    node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [image.id], jobs: [],
    pylons: [{ pylonId: up!.pylonId, phase: "booting" }, stopped(paused!), stopped(archived!), { pylonId: "pylon-x" as PylonId, phase: "booting" },
      { pylonId: crashed!.pylonId, phase: "broken", detail: "the controller exited", cause: "controller", logTail: "" }],
    grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [],
  }, []);
  const text = (await s.nexus(["nodes"])).stdout;
  assert.match(text, /^rj-firebat +online +observed .+ {2}2\/8 CPUs, 40\/22\.8 GiB memory committed, overcommitted, 30 GiB disk committed, 100 GiB disk free$/m);
  assert.match(text, /^ {2}pylons: 1 up holding 2 CPUs and 4 GiB, 1 paused needing 4 GiB to wake, 1 archived, 1 crashed needing 4 GiB to retry, 1 orphaned \(pylon-x\)$/m);
});

test("nodes prints what an older probe does not count as unknown, never as 0, with --json or without", async (t) => {
  const s = await setup(t);
  const capacity = { memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100 } as never;
  s.registry.apply({ record: "node", node, state: "online", capacity });
  const text = await s.nexus(["nodes"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^rj-firebat +online +.+ {2}unknown\/unknown CPUs, unknown\/64 GiB memory committed, unknown GiB disk committed, 100 GiB disk free$/m);
  assert.deepEqual((await s.json(["nodes"]))[0].capacity, capacity);
});

test("show prints PR metadata and one disabled-watch notice without waking the pylon", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "PR"]);
  const pr = { repo: "acme/repo", number: 12, title: "Fix build", url: "https://github.com/acme/repo/pull/12", state: "open", checks: "failed", review: "changes_requested", conflict: false } as const;
  s.registry.savePrWatch(thread.id, { links: [{ pr, seen: [], failed: false }], commentWakes: 0, pending: null, error: null });
  const before = s.registry.thread(thread.id)!.lastHumanActivityAt;
  const shown = await s.nexus(["show", thread.id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /PR #12: Fix build — open, checks failed, review changes_requested/);
  assert.equal((shown.stdout.match(/PR watch: off/g) ?? []).length, 1);
  const detail = await s.json(["show", thread.id]);
  assert.deepEqual(detail.pullRequests, [pr]);
  assert.equal(detail.prWatch.enabled, false);
  assert.equal(s.registry.thread(thread.id)!.lastHumanActivityAt, before);
});

test("show prints each question with its options, its reserved case, and who must answer it or how it was answered", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Image"]);
  s.registry.askQuestion({ id: "qn-image", thread: thread.id, text: "Rebuild the pylon image?\nIt changes the base layer.", options: ["Rebuild", "Not now"], reserved: "image-rebuild", answerer: "deployer", askedAt: 1 });
  s.registry.askQuestion({ id: "qn-brief", thread: thread.id, text: "Start the next brief?", options: ["Yes", "No"], reserved: null, answerer: "person", askedAt: 2 });
  const shown = await s.nexus(["show", thread.id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^attention: decision$/m);
  assert.match(shown.stdout, /^question qn-image: Rebuild the pylon image\?\n {2}options: "Rebuild", "Not now"\n {2}reserved: pylon image rebuilds\n {2}needs a deployer\nquestion qn-brief: Start the next brief\?\n {2}options: "Yes", "No"\n {2}needs you$/m);
  s.registry.answerQuestion("qn-brief", { option: "Yes", by: laptop, at: Date.UTC(2026, 9, 28, 9) });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^question qn-brief: Start the next brief\?\n {2}options: "Yes", "No"\n {2}answered "Yes" by nLAPTOP at 2026-10-28T09:00:00.000Z$/m);
  assert.deepEqual((await s.json(["show", thread.id])).questions.map((q: { id: string }) => q.id), ["qn-image", "qn-brief"]);
});

test("show prints a Claude worker's ask with a line per question it asks, and the choices that answered it in one line", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Ask"]);
  const option = (label: string) => ({ label, description: "" });
  const questions = [
    { question: "Which drink?", header: "Drink", multiSelect: false, options: [option("Tea"), option("Coffee")] },
    { question: "What goes in it?", header: "Extras", multiSelect: true, options: [option("Milk"), option("Sugar")] },
  ];
  s.registry.askQuestion({ id: "ask-toolu_1", thread: thread.id, text: "Drink: Which drink?\nExtras: What goes in it?", options: [], reserved: null, answerer: "person", askedAt: 1, ask: { session: "s1", toolUseId: "toolu_1", questions } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^question ask-toolu_1: Drink: Which drink\?\n {2}Extras: What goes in it\?\n {2}needs you$/m);
  s.registry.answerQuestion("ask-toolu_1", { option: "Drink: Tea; Extras: Milk, Oat cream", by: laptop, at: Date.UTC(2026, 9, 28, 9), choices: [{ picked: ["Tea"] }, { picked: ["Milk"], own: "Oat cream" }] });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^question ask-toolu_1: Drink: Which drink\?\n {2}Extras: What goes in it\?\n {2}answered "Drink: Tea; Extras: Milk, Oat cream" by nLAPTOP at 2026-10-28T09:00:00.000Z$/m);
});

test("show prints each judgment of a failed pylon: its verdict and who gave it, then what Nexus did or what it waits for", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Flaky node"]);
  const judgment = (failure: number, phase: Judgment["phase"]): Judgment => ({
    failure, thread: thread.id, node, failed: "pylon is broken: the controller exited\nqemu: terminating", startedAt: Date.UTC(2026, 9, 28, 9), request: { brief: "Is it the node?", token: "t" },
    conversation: 3, reply: null, phase,
  });
  s.registry.saveJudgment(judgment(812, { kind: "done", verdict: { answer: "retry", why: "The controller died while the node was swapping.", by: "judgment" }, outcome: { kind: "retried", node, on: "verdict" } }), null);
  s.registry.saveJudgment(judgment(813, { kind: "asked", verdict: { answer: "person", why: "the judgment did not answer within 15 minutes", by: "control plane" } }), null);
  s.registry.saveJudgment(judgment(814, { kind: "judging", deadline: null }), null);
  const shown = await s.nexus(["show", thread.id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`^judgment of failure 812 on ${node}: retry, by the judgment: The controller died while the node was swapping\\.\n {2}retried the pylon on ${node}
judgment of failure 813 on ${node}: person, by the control plane: the judgment did not answer within 15 minutes\n {2}waits for your answer to question judgment:813
judgment of failure 814 on ${node}: no verdict yet\n {2}judging since 2026-10-28T09:00:00\\.000Z$`, "m"));
  const [done] = (await s.json(["show", thread.id])).judgments;
  assert.deepEqual(done, { failure: 812, node, failed: "pylon is broken: the controller exited\nqemu: terminating", startedAt: Date.UTC(2026, 9, 28, 9), phase: "done",
    verdict: { answer: "retry", why: "The controller died while the node was swapping.", by: "judgment" }, outcome: `retried the pylon on ${node}`, question: null, brief: "Is it the node?", reply: null });
});

test("deploy and release use the shared release view and wait for both roles", async (t) => {
  const s = await setup(t);
  assert.equal((await s.nexus(["--version"])).stdout.trim(), "nexus 0.51.0");
  assert.equal((await s.nexus(["deploy", "bad"])).code, 64);
  const requested = await s.json(["deploy", "main"]);
  assert.equal(requested.desired.commit, "a".repeat(40));
  assert.equal(requested.desired.requestedBy, laptop);
  for (const role of ["control", "probe"] as const) s.registry.reportRelease({ node, role, commit: requested.desired.commit, target: requested.desired.commit, state: "healthy", reason: null, observedAt: Date.now() });
  assert.equal((await s.json(["deploy", "main", "--wait"])).nodes.every((r: { state: string }) => r.state === "healthy"), true);
  assert.equal((await s.json(["release"])).desired.commit, requested.desired.commit);
  s.registry.reportRelease({ node, role: "control", commit: "b".repeat(40), target: requested.desired.commit, state: "rolled-back", reason: "failed to bind", observedAt: Date.now() });
  const failed = await s.nexus(["deploy", "main", "--wait", "--json"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /failed to bind/);
});

test("image list and current print each image's role, build, release and nodes, and rollout --wait follows the rollout until it is done", async (t) => {
  const s = await setup(t);
  const older: ImageManifest = { ...image, id: "img-00000000000a" as ImageId, builtAt: "2026-12-01T00:00:00Z" };
  s.registry.saveImage(older, "f".repeat(40));
  const capacity = { cpus: 16, committedCpus: 0, memoryGiB: 64, committedMemoryGiB: 0, diskFreeGiB: 100, committedDiskGiB: 0 };
  s.registry.apply({ record: "node", node, state: "online", capacity });
  s.registry.ingested({ node, observedAt: new Date().toISOString(), probeBootId: "b", events: [], capacity, artifacts: [image.id, older.id], jobs: [], pylons: [], grants: { secrets: [], gitSsh: false }, previewRoutes: [], heldSecrets: [] }, []);
  const entry = { ...image, release: null, nodes: [node] };
  const olderEntry = { ...older, release: "f".repeat(40), nodes: [node] };

  assert.equal((await s.nexus(["image", "list"])).stdout, [
    "img-0123456789ab  current  built 2027-01-01T00:00:00Z on rj-firebat  release unknown       on rj-firebat",
    "img-00000000000a  -        built 2026-12-01T00:00:00Z on rj-firebat  release ffffffffffff  on rj-firebat",
  ].join("\n") + "\n");
  assert.deepEqual(await s.json(["image", "list"]), { current: image.id, previous: null, images: [entry, olderEntry], operation: null });
  assert.equal((await s.nexus(["image", "current"])).stdout, "img-0123456789ab  current  built 2027-01-01T00:00:00Z on rj-firebat  release unknown  on rj-firebat\n");

  const rolled = await s.nexus(["image", "rollout", older.id, "--wait"]);
  assert.equal(rolled.code, 0, rolled.stderr);
  assert.equal(rolled.stdout, [
    "img-0123456789ab  previous  built 2027-01-01T00:00:00Z on rj-firebat  release unknown       on rj-firebat",
    "img-00000000000a  current   built 2026-12-01T00:00:00Z on rj-firebat  release ffffffffffff  on rj-firebat",
    "rollout img-00000000000a: done",
    "  rj-firebat: done",
  ].join("\n") + "\n");
  assert.deepEqual(await s.json(["image", "current"]), { current: olderEntry, previous: entry });

  const unknown = await s.nexus(["image", "rollout", "img-ffffffffffff", "--json"]);
  assert.deepEqual([unknown.code, JSON.parse(unknown.stderr)], [4, { error: "no image img-ffffffffffff is recorded", kind: "not-found", status: 404, code: null }]);
});

test("review and land reach the review loop's routes, and show prints a review and what it needs from the person", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Cache"]);
  const refused = await s.nexus(["review", thread.id, "--json"]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /github.tokenFile/);
  assert.equal((await s.nexus(["land", thread.id])).code, 5);
  assert.equal((await s.nexus(["review", thread.id, "--rounds", "two"])).code, 64);
  assert.equal((await s.nexus(["review", thread.id, "--rounds", "6"])).code, 64, "a review runs at most 5 rounds");
  const review: Review = {
    id: "rv-1", builder: thread.id, reviewer: "th-reviewer" as ThreadId, pr: { repo: "octocat/Spoon-Knife", number: 7, url: "https://github.com/octocat/Spoon-Knife/pull/7", title: "Cache", branch: "cache" }, reviewerKind: "claude",
    models: { builder: "gpt-6-astra", reviewer: "claude-opus-5-5" }, maxRounds: 5, land: null, auto: false, merged: null, waiver: null, expect: "rv-1:t", sent: 1, outbox: null, asked: "", since: 0, nudges: 0, startedAt: 0,
    rounds: [{ head: "1".repeat(40), verdict: null, check: null, answers: null }],
    phase: { ...personPhase("The reviewer still requests changes after 5 rounds, the most this review allows.", "Nexus could not add the label \"needs human review\" to pull request #7 (GitHub answered 403: Forbidden)."), label: { state: "failed", why: "GitHub answered 403: Forbidden" } },
  };
  s.registry.saveReview(review);
  const shown = await s.nexus(["show", thread.id]);
  assert.match(shown.stdout, /^attention: decision$/m);
  assert.match(shown.stdout, /^review rv-1 of PR #7: needs-person, round 1 of 5, reviewer th-reviewer on claude-opus-5-5, label "needs human review" not added$/m);
  assert.match(shown.stdout, /^needs you: The reviewer still requests changes after 5 rounds, the most this review allows\.$/m);
  assert.match(shown.stdout, /^needs you: Nexus could not add the label "needs human review" to pull request #7 \(GitHub answered 403: Forbidden\)\.$/m);
  assert.deepEqual((await s.json(["show", thread.id])).review, review);

  s.registry.saveReview({ ...review, phase: { kind: "cancelled", who: "reviewer", status: "archived" } });
  const cancelled = await s.nexus(["show", thread.id]);
  assert.match(cancelled.stdout, /^review rv-1 of PR #7: cancelled, round 1 of 5, reviewer th-reviewer on claude-opus-5-5, the reviewer thread th-reviewer was archived$/m);
  assert.doesNotMatch(cancelled.stdout, /^attention: decision$|^needs you:/m);
  s.registry.saveReview({ ...review, phase: { kind: "merged" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^review rv-1 of PR #7: merged, round 1 of 5, reviewer th-reviewer on claude-opus-5-5$/m);

  const head = "1".repeat(40);
  const checked = { ...review.rounds[0]!, check: { passed: true, output: "ok" } };
  s.registry.saveReview({ ...review, rounds: [checked], phase: { kind: "verifying", startedAt: 0, thread: "th-0123456789ab" as ThreadId } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^review rv-1 of PR #7: verifying, .*\nlive check running \.nexus\/verify at 111111111111 in verify pylon th-0123456789ab$/m);
  s.registry.saveReview({ ...review, rounds: [{ ...checked, live: { kind: "ran", thread: "th-0123456789ab" as ThreadId, passed: false, output: "booting the fleet\nthe thread never reported running" } }], phase: { kind: "fixing" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^live check failed at 111111111111\n {2}booting the fleet\n {2}the thread never reported running$/m);
  s.registry.saveReview({ ...review, rounds: [{ ...checked, live: { kind: "ran", thread: "th-0123456789ab" as ThreadId, passed: true, output: "fleet ok" } }], phase: { kind: "approved" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^live check passed at 111111111111$/m);
  s.registry.saveReview({ ...review, rounds: [checked], phase: personPhase({ code: "live-failed", text: `The live check could not run at ${head}.` }) });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^no live check ran at 111111111111$/m, "a live check that gave no verdict is not a missing script");
  s.registry.saveReview({ ...review, rounds: [{ ...checked, live: { kind: "absent" } }], phase: { kind: "approved" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, new RegExp(`^no live check: ${head.slice(0, 12)} has no \\.nexus/verify, so the landing reads the pull request's statement of what could not be checked live$`, "m"));

  const approval = { ...checked, verdict: { token: "a", verdict: "approve" as const, findings: [], reserved: [], notCheckedLive: null } };
  s.registry.saveReview({ ...review, rounds: [approval, { head: "2".repeat(40), verdict: null, check: null, answers: null }], phase: { kind: "reviewing" } });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^review rv-1 of PR #7: reviewing, round 2 of 5, .*\na new round reviews 222222222222, since the pull request's head moved from 111111111111 after its approval$/m);

  const hold = "Always needs the person: changes to login or auth, as it changes src/control/api.ts.";
  s.registry.saveReview({ ...review, land: { requestedBy: "nLAPTOP" }, phase: { kind: "landed", commit: "4".repeat(40) }, waiver: { head: "1".repeat(40), holds: [hold], codes: ["reserved-path:auth"], by: "nLAPTOP", at: Date.UTC(2026, 9, 27, 9) } });
  const waived = await s.nexus(["show", thread.id]);
  assert.match(waived.stdout, new RegExp(`^waived by nLAPTOP at ${"1".repeat(40)}, 2026-10-27T09:00:00.000Z:\n  ${hold.replace(/[.()]/g, "\\$&")}$`, "m"));
  const events = await s.nexus(["events", "--thread", thread.id, "--kind", "review.waived"]);
  assert.match(events.stdout, /review.waived/);
});

test("review --cancel ends the thread's running review through its route, and prints who cancelled it", async (t) => {
  const asked: unknown[][] = [];
  let review: Review | null = null;
  const reviews = { cancel(builder: ThreadId, by: string) { asked.push([builder, by]); return { ...review!, phase: { kind: "cancelled", who: "person", by } }; } } as never as ReviewLoop;
  const s = await setup(t, { reviews });
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Cache"]);
  review = {
    id: "rv-1", builder: thread.id, reviewer: "th-reviewer" as ThreadId, pr: { repo: "octocat/Spoon-Knife", number: 7, url: "https://github.com/octocat/Spoon-Knife/pull/7", title: "Cache", branch: "cache" }, reviewerKind: "harness",
    models: { builder: "claude-opus-5-5", reviewer: "gpt-6-astra" }, maxRounds: 5, land: null, auto: false, merged: null, waiver: null, expect: "rv-1:t", sent: 1, outbox: null, asked: "", since: 0, nudges: 0, startedAt: 0,
    rounds: [{ head: "1".repeat(40), verdict: null, check: null, answers: null }], phase: { kind: "reviewing" },
  };
  assert.equal((await s.nexus(["review", "--cancel", thread.id])).stdout, `Cancelled review rv-1 of PR #7: cancelled, round 1 of 5, reviewer th-reviewer on gpt-6-astra, cancelled by ${laptop}\n`);
  assert.deepEqual((await s.json(["review", thread.id, "--cancel"])).phase, { kind: "cancelled", who: "person", by: laptop });
  assert.deepEqual(asked, [[thread.id, laptop], [thread.id, laptop]]);
  for (const extra of [["--land"], ["--pr", "7"], ["--rounds", "2"]]) assert.equal((await s.nexus(["review", "--cancel", thread.id, ...extra])).code, 64, `--cancel with ${extra[0]}`);
  assert.equal(asked.length, 2, "a refused flag sends nothing");
});

test("project edit replaces supplied grants and preserves omitted settings", async (t) => {
  const repo = "https://github.com/example/repo.git";
  const s = await setup(t);
  await s.nexus(["project", "add", "editable", repo, "--node", node]);
  const changed = await s.nexus(["project", "edit", "editable", "--login", "claude", "--secret", "CLAUDE_CODE_OAUTH_TOKEN:api.anthropic.com", "--git-name", "Example Person", "--git-email", "person@example.com", "--json"]);
  assert.equal(changed.code, 0, changed.stderr);
  const p = JSON.parse(changed.stdout);
  assert.deepEqual(p.secrets, [{ name: "CLAUDE_CODE_OAUTH_TOKEN", hosts: ["api.anthropic.com"] }]);
  assert.equal(p.repoUrl, repo);
  assert.equal(p.defaultNode, node);
  assert.equal((await s.nexus(["project", "edit", "editable", "--secret", "TOKEN:*.example.com"])).code, 64);
  assert.equal((await s.json(["project", "edit", "editable", "--node", "auto"])).defaultNode, "auto");
  assert.match((await s.nexus(["projects"])).stdout, /^editable +node auto +branch main/m);
  const cleared = await s.nexus(["project", "edit", "editable", "--clear-secrets", "--clear-git-identity", "--json"]);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(cleared.stdout).secrets, []);
  assert.equal(JSON.parse(cleared.stdout).gitIdentity, null);
});

test("project edit turns reviews of its own on and off, and projects shows who turned them on", async (t) => {
  const s = await setup(t);
  await s.nexus(["project", "add", "auto", "--scratch", "--node", node]);
  assert.match((await s.nexus(["projects"])).stdout, new RegExp(`^auto +node ${node} +branch main +auto review off +pipeline off +scratch$`, "m"));
  assert.equal((await s.nexus(["project", "edit", "auto", "--auto-review", "always"])).code, 64);
  const landing = await s.nexus(["project", "edit", "auto", "--auto-review", "land"]);
  assert.equal(landing.stdout, `Updated project auto, auto review and land, for ${laptop}, pipeline off. Existing threads keep their boot settings and grants; start a new thread to apply them.\n`);
  assert.match((await s.nexus(["projects"])).stdout, new RegExp(`^auto +node ${node} +branch main +auto review and land, for ${laptop} +pipeline off +scratch$`, "m"));
  assert.deepEqual((await s.json(["project", "edit", "auto", "--auto-review", "review"])).autoReview, { land: false, enabledBy: laptop });
  assert.equal((await s.json(["project", "edit", "auto", "--auto-review", "off"])).autoReview, undefined);
});

test("concurrent project edits preserve independently changed resources", async (t) => {
  const s = await setup(t);
  assert.equal((await s.nexus(["project", "add", "concurrent", "--scratch", "--node", node, "--cpus", "1", "--memory", "1", "--disk", "10"])).code, 0);
  const before = s.proxy.connects.length;
  const edits = await Promise.all([
    s.nexus(["project", "edit", "concurrent", "--cpus", "4"]),
    s.nexus(["project", "edit", "concurrent", "--memory", "8"]),
  ]);
  for (const result of edits) assert.equal(result.code, 0, result.stderr);
  assert.equal(s.proxy.connects.length - before, 2, "each edit sends only its PATCH, without reading the project first");
  const projects = await s.json(["projects"]);
  assert.deepEqual(projects.find((p: Project) => p.id === "concurrent").resources, { cpus: 4, memoryGiB: 8, diskGiB: 10 });
});

test("project add and edit exit 64 for duplicate secret names and explain how to combine hosts", async (t) => {
  const s = await setup(t);
  const before = s.registry.project(project.id);
  for (const args of [
    ["project", "add", "duplicate", "--scratch", "--node", node],
    ["project", "edit", project.id],
  ]) {
    const result = await s.nexus([...args, "--secret", "TOKEN:a.example", "--secret", "TOKEN:b.example", "--json"]);
    assert.equal(result.code, 64);
    const error = JSON.parse(result.stderr);
    assert.equal(error.status, 400);
    assert.match(error.error, /duplicate secret names: list all of a secret's hosts in one grant/);
  }
  assert.equal(s.registry.project("duplicate" as ProjectId), undefined);
  assert.deepEqual(s.registry.project(project.id), before);
  const added = await s.json(["project", "add", "combined", "--scratch", "--node", node, "--secret", "TOKEN:a.example,b.example"]);
  assert.deepEqual(added.secrets, [{ name: "TOKEN", hosts: ["a.example", "b.example"] }]);
  const edited = await s.json(["project", "edit", project.id, "--secret", "TOKEN:a.example,b.example"]);
  assert.deepEqual(edited.secrets, added.secrets);
});

test("events prints one JSON object per line and resumes after a cursor", async (t) => {
  const s = await setup(t);
  const first = s.registry.appendEvent("release.changed", null, { state: "pending" });
  const second = s.registry.appendEvent("release.changed", null, { state: "healthy" });
  const reply = await s.nexus(["events", "--since", first.id, "--kind", "release.changed", "--json"]);
  assert.equal(reply.code, 0, reply.stderr);
  assert.deepEqual(reply.stdout.trim().split("\n").map((line) => JSON.parse(line)), [second]);
});

test("start --claude queues a poteto worker without sending a harness message", async (t) => {
  const s = await setup(t);
  const thread = await s.json(["start", "--project", "acme", "--claude", "/poteto-mode fix it"]);
  assert.equal(thread.conversationId, null);
  assert.deepEqual(s.registry.claudeWorker(thread.id), { model: "claude-opus-5-5", prompt: "/poteto-mode fix it", state: "pending", session: null });
  assert.equal((await s.nexus(["start", "--project", "acme", "--claude", "fix", "--message", "also fix"])).code, 64);
});

test("the SSE reader waits for its consumer before delivering more data or a cursor", async (t) => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\nid: 10\n: ping\n\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: unknown[] = [];
  const cursors: string[] = [];
  const reading = follow({ url: new URL(`http://127.0.0.1:${port}`), socks: null }, "/events", async (data) => {
    seen.push(data);
    entered.resolve();
    await release.promise;
  }, new AbortController().signal, (id) => cursors.push(id));
  await entered.promise;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [{ n: 1 }]);
  assert.deepEqual(cursors, [], "a cursor never acknowledges an unconsumed event");
  release.resolve();
  await reading;
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(cursors, ["1", "2", "10"]);
});

test("events resumes from an id-only heartbeat without printing it", { timeout: 60_000 }, async (t) => {
  const paths: string[] = [];
  const reconnected = Promise.withResolvers<void>();
  const server = createHttpServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (paths.length === 1) res.end("id: 12000\n: ping\n\n");
    else { res.write(": connected\n\n"); reconnected.resolve(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [cli, "events", "--follow", "--kind", "session.turn-ended", "--json", "--url", `http://127.0.0.1:${port}`, "--socks", "none"]);
  t.after(() => { child.kill(); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  await reconnected.promise;
  assert.equal(new URL(paths[1]!, "http://nexus").searchParams.get("since"), "12000");
  assert.equal(output, "");
  child.kill();
  await once(child, "exit");
});

test("events bounds stdout buffering when its pipe is not read", { timeout: 60_000 }, async (t) => {
  const event = JSON.stringify({ id: "1", time: 0, thread: null, project: null, kind: "release.changed", payload: { message: "x".repeat(2048) } });
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(Array.from({ length: 10_000 }, () => `data: ${event}\n\n`).join(""));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const script = `
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => {
      const ready = write(...args);
      if (!ready) process.send({ buffered: process.stdout.writableLength });
      return ready;
    };
    process.argv = [process.execPath, ${JSON.stringify(cli)}, "events", "--follow", "--json", "--url", "http://127.0.0.1:${port}", "--socks", "none"];
    await import(${JSON.stringify(cli)});
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { child.kill(); });
  const blocked = Promise.withResolvers<void>();
  let maxBuffered = 0;
  child.on("message", (message: { buffered: number }) => { maxBuffered = Math.max(maxBuffered, message.buffered); blocked.resolve(); });
  await blocked.promise;
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(maxBuffered <= 128 * 1024, `stdout buffered ${maxBuffered} bytes into an unread pipe`);
  child.kill();
  assert.deepEqual(await once(child, "exit"), [0, null], "a blocked follower still responds to termination");
});

test("a dropped SSE connection cannot reconnect around a blocked consumer", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"n":1}\n\n');
    void entered.promise.then(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { release.resolve(); server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  let settled = false;
  const reading = follow({ url: new URL(`http://127.0.0.1:${port}`), socks: null }, "/events", async () => {
    entered.resolve();
    await release.promise;
  }, new AbortController().signal).then(() => { settled = true; }, () => { settled = true; });
  await entered.promise;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false);
  release.resolve();
  await reading;
  assert.equal(settled, true);
});

test("show exposes the registry's failed worker and its selected model", async (t) => {
  const s = await setup(t);
  const thread = await s.json(["start", "--project", "acme", "--claude", "fix it", "--model", "claude-sonnet-5-5"]);
  const message = "Claude launch did not complete: agent executable missing";
  s.registry.setClaudeWorker(thread.id, "/poteto-mode fix it", "failed", message);
  s.registry.appendEvent("thread.failed", thread.id, { message });
  const detail = await s.json(["show", thread.id]);
  assert.deepEqual(detail.claudeWorker, { state: "failed", model: "claude-sonnet-5-5", message });
  assert.equal(detail.attention, "failed");
  assert.deepEqual(detail.sessions, []);
  const text = (await s.nexus(["show", thread.id])).stdout;
  assert.match(text, /Claude worker: failed, model claude-sonnet-5-5/);
  assert.ok(text.includes(message));
  assert.equal(s.registry.events().filter((e) => e.kind === "thread.failed").at(-1)?.payload.message, detail.claudeWorker.message);
  assert.equal((await s.nexus(["start", "--project", "acme", "--title", "no worker", "--model", "x"])).code, 64);
});

test("threads and show say a Claude worker is working while its session's turn runs", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  s.registry.setClaudeWorker(thread.id, "/poteto-mode count the lines", "started", undefined, "s1");
  const report = (sequence: number, kind: "session.turn-started" | "session.turn-ended") =>
    s.registry.reportSession(node, { sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1" } });
  report(1, "session.turn-started");
  assert.match((await s.nexus(["threads"])).stdout, new RegExp(`${thread.id} +active +working +pylon`));
  assert.match((await s.nexus(["show", thread.id])).stdout, /^status: active, agent working$/m);
  report(2, "session.turn-ended");
  assert.match((await s.nexus(["threads"])).stdout, new RegExp(`${thread.id} +active +- +pylon`));
  assert.match((await s.nexus(["show", thread.id])).stdout, /^status: active$/m);
});

test("threads, show and conversation say a Claude worker stopped on its usage limit, until when, and how to resume it", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  s.registry.setClaudeWorker(thread.id, "/poteto-mode count the lines", "started", undefined, "s1");
  const resetsAt = Date.now() + 3_600_000;
  const until = `${new Date(resetsAt).toISOString().slice(11, 16)} UTC`;
  const entries: ClaudeEntry[] = [{ kind: "notice", at: 1, tone: "error", text: "You've hit your session limit", usageLimit: { resetsAt } }];
  s.registry.appendClaudeRead(thread.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 9 }, reset: false, readAt: Date.now() });
  assert.match((await s.nexus(["threads"])).stdout, new RegExp(`${thread.id} +active +stopped on its usage limit until ${until}`));
  const shown = (await s.nexus(["show", thread.id])).stdout;
  assert.ok(shown.includes("attention: limited"), shown);
  assert.ok(shown.includes(`usage limit: stopped on its usage limit until ${until}. \`nexus send ${thread.id} continue\` resumes it once the limit resets`), shown);
  assert.ok((await s.nexus(["conversation", thread.id])).stdout.endsWith(`(Claude stopped on its usage limit until ${until}. Send it "continue" after the reset to resume)\n`));
});

test("conversation prints a Claude worker's transcript, and send types into its session, waiting for a paused pylon under one request ID", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  s.registry.setClaudeWorker(thread.id, "/poteto-mode count the lines", "started", undefined, "s1");
  const entries: ClaudeEntry[] = [
    { kind: "prompt", at: 1, text: "Count the lines\nof hello.py", from: "person", images: [{ offset: 0, bytes: 900, sha256: "a".repeat(64), index: 0 }] },
    { kind: "tool", at: 2, id: "t1", name: "Bash", input: { command: "wc -l hello.py" } },
    { kind: "result", at: 3, toolUseId: "t1", output: "1 hello.py", isError: false },
    { kind: "tool", at: 4, id: "t2", name: "Bash", input: { command: "false" } },
    { kind: "result", at: 5, toolUseId: "t2", output: "Exit code 1", isError: true },
    { kind: "reply", at: 6, text: "It has 1 line." },
    { kind: "task", at: 7, toolUseId: "t1", status: "completed", summary: 'Agent "Count" finished', result: null },
    { kind: "notice", at: 8, tone: "error", text: "The model failed" },
    { kind: "turn", at: 9, durationMs: 72_000 },
    { kind: "record", at: null, type: "mystery", summary: '{"type":"mystery"}' },
    { kind: "pull-request", at: 10, number: 7, url: "https://github.com/acme/shop/pull/7", repository: "acme/shop" },
    { kind: "pull-request", at: 10, number: 7, url: "https://github.com/acme/shop/pull/7", repository: "acme/shop" },
    { kind: "prompt", at: 10, text: "/compact", from: "command" },
    { kind: "queue", at: 11, op: "enqueue", text: "and then deploy" },
    { kind: "tool", at: 12, id: "t3", name: "Read", input: { file_path: "hello.py" } },
  ];
  const readAt = Date.now();
  s.registry.appendClaudeRead(thread.id, { session: "s1", from: transcriptStart, entries, cursor: { ...transcriptStart, offset: 9 }, reset: false, readAt });

  assert.deepEqual(await s.json(["conversation", thread.id]), { kind: "claude", session: "s1", entries, dropped: 0, readAt, working: false, usageLimit: null }, "--json prints the API's reply");
  const transcript = [
    "> Count the lines\n> of hello.py\n> [image]",
    '[tool] Bash {"command":"wc -l hello.py"} (ok)',
    '[tool] Bash {"command":"false"} (failed)',
    "It has 1 line.",
    '[task] completed: Agent "Count" finished',
    "[error] The model failed",
    "[turn] 72s",
    '[record] mystery: {"type":"mystery"}',
    "[pull request] Opened pull request #7: https://github.com/acme/shop/pull/7",
    "> [slash command] /compact",
  ];
  assert.equal((await s.nexus(["conversation", thread.id])).stdout, [...transcript, '[tool] Read {"file_path":"hello.py"} (no result)', "(queued) > and then deploy"].join("\n\n") + "\n");
  s.registry.reportSession(node, { sequence: 1, pylon: thread.pylonId, time: Date.now(), event: { kind: "session.turn-started", session: "s1" } });
  assert.equal((await s.nexus(["conversation", thread.id])).stdout, [...transcript, '[tool] Read {"file_path":"hello.py"} (running)', "(queued) > and then deploy", "(Claude is working)"].join("\n\n") + "\n");

  let refusals = 2;
  s.probeAnswers(async () => {
    if (refusals-- > 0) throw Object.assign(new Error("rj-firebat: pylon-x is stopped, not running"), { code: "not-running" });
    return { kind: "send-claude", outcome: "queued", herdrPane: "w1:p1", resumed: true };
  });
  s.commands.length = 0;
  const queued = await s.nexus(["send", thread.id, "and", "then", '"deploy"', "--request-id", "msg:fixed"]);
  assert.equal(queued.code, 0, queued.stderr);
  assert.equal(queued.stdout, `Queued for Claude in ${thread.id}, which takes it at its next step. Its session was resumed to take it.\n`);
  assert.deepEqual(s.commands, Array(3).fill({ kind: "send-claude", session: "s1", text: 'and then "deploy"', requestId: "msg:fixed", model: "claude-opus-5-5" }), "a paused pylon is woken and asked again until it runs");
  assert.deepEqual(await s.json(["send", thread.id, "and", "then", '"deploy"', "--request-id", "msg:fixed"]), { claude: { session: "s1", outcome: "queued", resumed: true } });
  assert.equal(s.commands.length, 3, "a resend under the same request ID is not typed again");
  s.probeAnswers(async () => ({ kind: "send-claude", outcome: "sent", herdrPane: "w1:p1", resumed: false }));
  assert.equal((await s.nexus(["send", thread.id, "go", "--steer"])).stdout, `Sent to Claude in ${thread.id}.\n`);
  assert.deepEqual(s.fake.calls.filter(([call]) => call === "send"), [], "the harness is sent nothing");
  assert.match((await s.nexus(["send", "--help"])).stdout, /typed into the Claude worker's session/);
});

test("send to a Claude worker that waits at a prompt in its terminal fails at once with exit code 5, and is typed once", { timeout: 10_000 }, async (t) => {
  const s = await setup(t);
  const { thread } = await claudeWatched(t, s);
  s.probeAnswers(async () => ({ kind: "send-claude", outcome: "blocked", herdrPane: "w1:p1", resumed: false }));
  s.commands.length = 0;
  const blocked = await s.nexus(["send", thread.id, "deploy", "--json"]);
  assert.equal(blocked.code, 5, blocked.stderr);
  const reported = JSON.parse(blocked.stderr);
  assert.match(reported.error, /^Claude waits at a prompt in its terminal, so nothing was typed/);
  assert.deepEqual([reported.kind, reported.status, reported.code], ["conflict", 409, "blocked"]);
  assert.equal(s.commands.filter((c) => c.kind === "send-claude").length, 1);
});

test("send to a Claude worker tries a 409 without a code again, as a control plane older than error codes sends it", async (t) => {
  const s = await setup(t);
  let refusals = 2;
  const sends: string[] = [];
  const old = createHttpServer((req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET") return reply(200, { thread: { status: "active" }, claudeWorker: {} });
    sends.push(req.url!);
    if (refusals-- > 0) return reply(409, { error: "pylon pylon-x is not running yet. This request wakes it, so ask again once it runs" });
    reply(202, { claude: { session: "s1", outcome: "sent", resumed: false } });
  });
  const port = await listening(t, old);
  const sent = await s.nexus(["send", "th-0123456789ab", "deploy"], { NEXUS_URL: `http://127.0.0.1:${port}`, NEXUS_SOCKS: "none" });
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.stdout, "Sent to Claude in th-0123456789ab.\n");
  assert.equal(sends.length, 3);
});

test("abort interrupts a Claude worker's turn with Esc in its pane, and fails with exit code 5 when Claude was not working", async (t) => {
  const s = await setup(t);
  const { thread } = await claudeWatched(t, s);
  let outcome: InterruptClaudeOutcome = "interrupted";
  s.probeAnswers(async (command) => command.kind === "interrupt-claude" ? { kind: "interrupt-claude", outcome } : assert.fail(`unexpected ${command.kind}`));
  s.commands.length = 0;
  const done = await s.nexus(["abort", thread.id]);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(s.commands, [{ kind: "interrupt-claude", session: "s1" }]);
  assert.deepEqual(s.fake.calls.filter(([call]) => call === "abort"), [], "the harness aborts nothing");
  outcome = "blocked";
  const refused = await s.nexus(["abort", thread.id]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, new RegExp(`Claude waits at a prompt in its terminal, which Esc would cancel, so nothing was pressed\\. Attach to the pylon \\(\`nexus attach ${thread.id}\`\\)`));
});

test("start --request-id starts one thread and sends its first message once, however often it is run", async (t) => {
  const s = await setup(t);
  const args = ["start", "--project", "acme", "--message", "Fix the build", "--request-id", "start:cli"];
  const before = s.requests();
  const first: Thread = await s.json(args);
  assert.equal(s.requests() - before, 1, "one request starts it with its first message");
  const again = await s.nexus(args);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `Started ${first.id} on acme: Fix the build\nSent the first message.\n`);
  assert.deepEqual((await s.json(["threads"])).map((r: Thread) => r.id), [first.id]);
  assert.deepEqual(s.fake.transcript(first.id).messages.map((m) => m.content), ["Fix the build"]);
  const other = await s.nexus(["start", "--project", "acme", "--message", "Fix the tests", "--request-id", "start:cli", "--json"]);
  assert.equal(other.code, 5, "another start under the same request ID is a conflict");
  assert.match(other.stderr, new RegExp(`request ID start:cli started thread ${first.id} with another body`));
});

test("start --plan starts a planning thread, whose first message carries the guide, and show says it plans", async (t) => {
  const s = await setup(t);
  assert.equal((await s.nexus(["start", "--project", "acme", "--plan", "--claude", "Plan it"])).code, 64);
  const started = await s.nexus(["start", "--project", "acme", "--plan", "--message", "Plan the orchestration wave"]);
  assert.equal(started.code, 0, started.stderr);
  const id = /^Started planning thread (th-[0-9a-f]+) on acme: Plan the orchestration wave\nSent the first message\.$/.exec(started.stdout.trim())?.[1];
  assert.ok(id !== undefined, started.stdout);
  const first = s.fake.transcript(id).messages[0]!.content as string;
  assert.ok(first.startsWith(planningPrefix) && first.endsWith("Plan the orchestration wave"));
  assert.match((await s.nexus(["show", id])).stdout, /^planning: its proposed items become questions you accept or reject$/m);
  assert.equal((await s.json(["show", id])).planning, true);
});

test("start --after --request-id answers the queued thread, and the thread once it has started", async (t) => {
  const s = await setup(t, { queue: true });
  const first: Thread = await s.json(["start", "--project", "acme", "--title", "First"]);
  const args = ["start", "--project", "acme", "--message", "Then this", "--after", first.id, "--request-id", "start:queued"];
  const queued: QueuedThread = await s.json(args);
  assert.deepEqual(await s.json(args), queued);
  assert.equal((await s.nexus(["start-queued", queued.id])).code, 0);
  const again = await s.nexus(args);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `Started ${queued.id} on acme: Then this\n`);
});

test("item add lines up items behind each other, project edit --pipeline decides whether they start on their own, and items and item show say each one's phase", async (t) => {
  const s = await setup(t, { queue: true });
  const off = await s.nexus(["item", "add", "--project", "acme", "--message", "Build A"]);
  assert.deepEqual([off.code, off.stderr], [5, "nexus: the pipeline does not run for project acme. nexus project edit acme --pipeline start turns it on\n"]);
  assert.equal((await s.nexus(["item", "add", "--project", "acme", "--title", "No brief"])).code, 64);
  assert.equal((await s.nexus(["project", "edit", "acme", "--pipeline", "sometimes"])).code, 64);
  assert.match((await s.nexus(["project", "edit", "acme", "--pipeline", "approve"])).stdout, /^Updated project acme, auto review off, pipeline waits for approval\./);
  assert.match((await s.nexus(["projects"])).stdout, /^acme\s+node rj-firebat\s+branch main\s+auto review off\s+pipeline waits for approval\s/m);

  const added = await s.nexus(["item", "add", "--project", "acme", "--message", "Build A\nwith tests"]);
  assert.equal(added.code, 0, added.stderr);
  const [a] = s.registry.items();
  assert.equal(added.stdout, `Added ${a!.id} to acme: Build A. It is held: project acme waits for the person to approve each item: nexus item approve ${a!.id}.\n`);
  const b: PipelineItem = await s.json(["item", "add", "--project", "acme", "--title", "B", "--claude", "Build B", "--model", "claude-sonnet-5-5", "--after", a!.id]);
  assert.deepEqual([b.worker, b.model, b.brief, b.after, b.phase.kind], ["claude", "claude-sonnet-5-5", "Build B", [a!.id], "planned"]);
  assert.equal((await s.nexus(["item", "add", "--project", "acme", "--message", "x", "--after", "it-000000000000"])).code, 4);

  const approved = await s.nexus(["item", "approve", a!.id]);
  assert.equal(approved.code, 0, approved.stderr);
  const thread = s.registry.queuedThread(s.registry.queuedThreads()[0]!.id)!;
  assert.match(approved.stdout, new RegExp(`^Approved ${a!.id}\\. It is (queued|building): `));
  assert.equal(thread.message, "Build A\nwith tests", "the brief is the queued thread's first message");
  const cancelled = await s.nexus(["item", "cancel", b.id]);
  assert.equal(cancelled.stdout, `Cancelled ${b.id}. It will never become a thread.\n`);
  assert.equal((await s.nexus(["item", "cancel", a!.id])).code, 5, "an item that is a thread is cancelled by archiving its thread");

  const rows = (await s.nexus(["items"])).stdout;
  assert.match(rows, new RegExp(`^${a!.id}\\s+(queued|building)\\s+.+\\s+${thread.id}\\s+acme\\s+\\S+ ago\\s+Build A$`, "m"));
  assert.doesNotMatch(rows, new RegExp(b.id), "a cancelled item is listed only with --all");
  assert.match((await s.nexus(["items", "--all"])).stdout, new RegExp(`^${b.id}\\s+cancelled\\s+cancelled by nLAPTOP\\s+no thread yet\\s`, "m"));
  assert.deepEqual((await s.json(["items", "--project", "other"])), []);
  const shown = (await s.nexus(["item", "show", b.id])).stdout;
  assert.equal(shown, [
    `${b.id}  B`, "project: acme", "phase: cancelled, cancelled by nLAPTOP", "thread: none yet", "worker: Claude worker, model claude-sonnet-5-5", `after: ${a!.id}`, "brief: Build B",
    shown.split("\n")[7], "",
  ].join("\n"));
  assert.match(shown.split("\n")[7]!, /^added by nLAPTOP \S+ ago$/);
  assert.equal((await s.nexus(["item", "show", "it-000000000000"])).code, 4);
});

test("start --after queues a thread in one request, and threads, show, start-queued and archive speak of it as queued", async (t) => {
  const s = await setup(t, { queue: true });
  const first: Thread = await s.json(["start", "--project", "acme", "--title", "First"]);
  const second: Thread = await s.json(["start", "--project", "acme", "--title", "Second"]);
  const before = s.requests();
  const queuedText = await s.nexus(["start", "--project", "acme", "--message", "Fix the next bug\nthen push", "--after", `${first.id}, ${second.id}`]);
  assert.equal(queuedText.code, 0, queuedText.stderr);
  assert.equal(s.requests() - before, 1, "one request queues it with its first message");
  const [record] = s.registry.queuedThreads();
  const id = record!.id;
  assert.equal(queuedText.stdout, `Queued ${id} on acme: Fix the next bug. It starts once ${first.id} and ${second.id} have merged their pull requests.\n`);
  assert.equal(record!.message, "Fix the next bug\nthen push");
  assert.deepEqual(s.fake.calls.filter((c) => c[0] === "send"), [], "the first message waits for the start");

  const later: QueuedThread = await s.json(["start", "--project", "acme", "--title", "Later", "--claude", "Do it", "--after", id]);
  assert.deepEqual([later.worker, later.model, later.prompt], ["claude", "claude-opus-5-5", "Do it"]);
  assert.deepEqual(later.waits, [{ thread: id, state: "waiting", why: "is queued" }]);
  assert.equal((await s.nexus(["start", "--project", "acme", "--title", "x", "--after", "th-nope"])).code, 4);
  assert.equal((await s.nexus(["start", "--project", "acme", "--title", "x", "--after", ","])).code, 64);

  const pr = (number: number, state: "open" | "closed") => ({ pr: { repo: "octocat/Spoon-Knife", number, title: "PR", url: "", state, checks: "none" as const, review: "none", conflict: null }, seen: [], failed: false });
  s.registry.savePrWatch(first.id, { links: [pr(3, "open")], commentWakes: 0, pending: null, error: null });
  s.registry.savePrWatch(second.id, { links: [pr(4, "closed")], commentWakes: 0, pending: null, error: null });
  const rows = (await s.nexus(["threads"])).stdout;
  assert.match(rows, new RegExp(`^${id}\\s+blocked\\s+blocked by ${second.id}: PR #4 closed without merging\\s+node rj-firebat\\s+acme\\s+\\S+ ago\\s+Fix the next bug$`, "m"));
  assert.match(rows, new RegExp(`^${later.id}\\s+queued\\s+waits for ${id}: is queued\\s`, "m"));
  assert.deepEqual((await s.json(["threads"])).map((r: Thread) => r.id), [first.id, second.id], "--json prints the thread rows alone, as before");
  assert.deepEqual((await s.json(["threads", "--queued"])).map((q: QueuedThread) => q.id), [id, later.id]);
  assert.doesNotMatch((await s.nexus(["threads", "--queued"])).stdout, new RegExp(first.id));

  assert.equal((await s.nexus(["show", id])).stdout, [
    `${id}  Fix the next bug`, "project: acme", "status: blocked", "node: rj-firebat", "worker: Nexus agent", "size: 2 CPUs, 4 GiB memory, 10 GiB disk",
    "first message: Fix the next bug", `waits for ${first.id}: PR #3 is open`, `blocked by ${second.id}: PR #4 closed without merging`,
    `nexus start-queued ${id} starts it now; nexus archive ${id} cancels it.`, "",
  ].join("\n"));
  assert.equal((await s.json(["show", id])).blocked, true);
  assert.equal((await s.nexus(["show", "th-nope"])).code, 4, "an unknown thread is still not found");

  assert.equal((await s.nexus(["start-queued", id])).stdout, `Started ${id} on acme: Fix the next bug\n`);
  assert.deepEqual(s.fake.calls.at(-1), ["send", id, "Fix the next bug\nthen push", `queued:${id}`, "followUp"]);
  assert.equal((await s.json(["show", id])).thread.id, id);
  assert.equal((await s.nexus(["start-queued", id])).code, 5, "a started thread is not queued");

  assert.equal((await s.nexus(["archive", later.id])).stdout, `Archived ${later.id}. Its queued start is cancelled.\n`);
  assert.doesNotMatch((await s.nexus(["threads"])).stdout, new RegExp(later.id));
  assert.match((await s.nexus(["threads", "--all"])).stdout, new RegExp(`^${later.id}\\s+cancelled\\s`, "m"));
  assert.match((await s.nexus(["show", later.id])).stdout, new RegExp(`^status: cancelled$[^]*^nexus unarchive ${later.id} queues it again\\.$`, "m"));
  assert.equal((await s.nexus(["start-queued", later.id])).code, 5);
  assert.equal((await s.nexus(["unarchive", later.id])).stdout, `Unarchived ${later.id}. It is queued again.\n`);
  assert.equal((await s.json(["delete", later.id])).status, "deleted");
});

test("start --after against a control plane without its GitHub token exits 5 and says why", async (t) => {
  const s = await setup(t);
  const refused = await s.nexus(["start", "--project", "acme", "--title", "x", "--after", "th-any"]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /queued threads need the control plane's GitHub token \(github.tokenFile\)/);
  assert.equal((await s.nexus(["threads"])).stdout, "No threads.\n");
  assert.equal((await s.nexus(["threads", "--queued"])).stdout, "No queued threads.\n");
});

test("usage backfill starts a run, --dry-run lists what it would read, --stop stops it, and usage prints the run in a line, with what it skipped once done", async (t) => {
  const s = await setup(t);
  const old: Thread = await s.json(["start", "--project", "acme", "--title", "Old work"]);
  const gone: Thread = await s.json(["start", "--project", "acme", "--title", "Gone"]);
  await s.json(["start", "--project", "acme", "--title", "Still going"]);
  for (const thread of [old, gone]) await s.json(["archive", thread.id]);
  const backfillLine = async () => (await s.nexus(["usage"])).stdout.split("\n").slice(1).join("\n").replace(/\nNo model calls[^]*$/, "");
  assert.equal(await backfillLine(), "Backfill: not run. A deployer runs `nexus usage backfill` to read archived threads' pylons.");

  const dry = await s.nexus(["usage", "backfill", "--dry-run"]);
  assert.equal(dry.stdout, `A start reads 2 archived threads, one pylon at a time:\n${old.id}  acme  rj-firebat  Old work\n${gone.id}  acme  rj-firebat  Gone\n`);
  assert.deepEqual(await s.json(["usage", "backfill", "--dry-run"]), {
    backfill: { state: "never" },
    plan: [{ thread: old.id, project: "acme", node, title: "Old work", reason: null }, { thread: gone.id, project: "acme", node, title: "Gone", reason: null }],
  });
  assert.equal((await s.nexus(["usage", "backfill"])).stdout, "Backfill: running, 0 of 2 threads read, recovered 0 calls and 0 tokens.\n");
  assert.equal(await backfillLine(), "Backfill: running, 0 of 2 threads read, recovered 0 calls and 0 tokens. It waits: rj-firebat is offline.");
  assert.equal((await s.nexus(["usage", "backfill", "--stop"])).stdout, "Backfill: stopped at 0 of 2 threads read, recovered 0 calls and 0 tokens.\n");
  assert.equal((await s.json(["usage", "backfill", "--stop"])).state, "stopped", "--json prints the API's state");
  assert.equal((await s.nexus(["usage", "backfill", "--dry-run", "--stop"])).code, 64);

  s.registry.startUsageBackfill([old.id, gone.id], Date.parse("2026-10-28T09:00:00Z"));
  s.registry.recordUsage(old.id, Array.from({ length: 1234 }, (_, i) => ({ id: `claude:msg_${i}`, agent: "claude" as const, model: "claude-opus-5-5", at: 1_000, input: i === 0 ? 5_600_000 - 1233 : 1, output: 0, cacheWrite: 0, cacheRead: 0 })), [], true);
  s.registry.finishUsageBackfillThread(old.id, "done", null, Date.parse("2026-10-28T09:10:00Z"));
  s.registry.finishUsageBackfillThread(gone.id, "skipped", "rj-firebat holds no disk for its pylon", Date.parse("2026-10-28T09:11:00Z"));
  s.registry.finishUsageBackfill(Date.parse("2026-10-28T09:12:00Z"));
  assert.equal(await backfillLine(), `Backfill: done at 2026-10-28 09:12 UTC, 2 of 2 threads read, 1 skipped, recovered 1234 calls and 5.6M tokens.\nSkipped:\n${gone.id}  Gone  rj-firebat holds no disk for its pylon`);
  assert.equal((await s.nexus(["usage", "backfill", "--dry-run"])).stdout, `A start reads 1 archived thread, one pylon at a time:\n${gone.id}  acme  rj-firebat  Gone\n  skipped before: rj-firebat holds no disk for its pylon\n`);
});

test("a control plane older than the usage backfill reports none, so usage prints no backfill line, and usage backfill fails as for a missing route", async (t) => {
  const s = await setup(t);
  const { backfill: _, ...report } = await s.json(["usage", "--since", "all"]);
  const old = createHttpServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/v1/usage") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(report));
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `no route ${path}` }));
  });
  const env = { NEXUS_URL: `http://127.0.0.1:${await listening(t, old)}`, NEXUS_SOCKS: "none" };
  const usage = await s.nexus(["usage"], env);
  assert.match(usage.stdout, /^Usage of all projects for all time\. Counting started [^\n]*\.\nNo model calls were counted in this period\.\n$/);
  assert.equal((await s.nexus(["usage", "backfill"], env)).code, 4);
});

test("usage prints the tokens of the last 7 days in all and by each breakdown, --since, --project and --by narrow it, and --json is the API's report", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "Usage"]);
  const hour = 3_600_000;
  const call = (id: string, agent: "claude" | "pi", model: string, ago: number, [input, output, cacheWrite, cacheRead]: number[]) =>
    ({ id, agent, model, at: Date.now() - ago, input: input!, output: output!, cacheWrite: cacheWrite!, cacheRead: cacheRead! });
  s.registry.recordUsage(thread.id, [
    call("claude:m1", "claude", "claude-opus-5-5", hour, [1_200, 300, 50_000, 1_250_000]),
    call("pi:r1", "pi", "gpt-6-astra", 72 * hour, [10_000, 2_000, 0, 30_000]),
    call("pi:r2", "pi", "gpt-6-astra", 20 * 24 * hour, [5_000_000, 0, 0, 0]),
  ]);

  const text = await s.nexus(["usage"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Usage of all projects since \d{4}-\d\d-\d\d \d\d:\d\d UTC\. Counting started \d{4}-\d\d-\d\d \d\d:\d\d UTC\.\nBackfill: not run\. .*\n\n/);
  const since = Date.parse(`${/since (\S+ \S+) UTC/.exec(text.stdout)![1]!.replace(" ", "T")}Z`);
  assert.equal(since, Date.now() - (Date.now() % (24 * hour)) - 6 * 24 * hour, "the period is today and the 6 UTC days before it unless --since says otherwise");
  assert.match(text.stdout, /\n +Input +Output +Cache write +Cache read +Total +Calls\nTotal +11\.2k +2\.3k +50k +1\.3M +1\.3M +2\n/, "the call 20 days ago is outside the period");
  assert.match(text.stdout, /\nBy model\nModel +Input +Output +Cache write +Cache read +Total +Calls\nclaude-opus-5-5 +1\.2k +300 +50k +1\.3M +1\.3M +1\ngpt-6-astra +10k +2k +0 +30k +42k +1\n/);
  assert.deepEqual([...text.stdout.matchAll(/^By .*$/gm)].map((m) => m[0]), ["By model", "By project", "By agent", "By role", "By day (UTC)"]);
  assert.match(text.stdout, /\nBy role\nRole +Input.*\nbuilder +11\.2k +2\.3k +50k +1\.3M +1\.3M +2\n/);

  const all = await s.json(["usage", "--since", "all"]);
  assert.deepEqual([all.since, all.project, all.thread], [null, null, null]);
  assert.deepEqual(all.total, { input: 5_011_200, output: 2_300, cacheWrite: 50_000, cacheRead: 1_280_000, total: 6_343_500, calls: 3 });
  assert.deepEqual(Object.keys(all.by), ["model", "project", "kind", "role", "day"]);
  assert.deepEqual(all.by.project, [{ key: "acme", input: 5_011_200, output: 2_300, cacheWrite: 50_000, cacheRead: 1_280_000, total: 6_343_500, calls: 3 }]);

  const byModel = await s.nexus(["usage", "--since", "30d", "--by", "model"]);
  assert.match(byModel.stdout, /\nTotal +5M .* 3\n\nBy model\n/);
  assert.deepEqual([...byModel.stdout.matchAll(/^By .*$/gm)].map((m) => m[0]), ["By model"], "--by prints only that breakdown");
  assert.deepEqual(Object.keys((await s.json(["usage", "--by", "day"])).by), ["day"]);

  const other = await s.nexus(["usage", "--project", "other", "--since", "2020-01-01"]);
  assert.match(other.stdout, /^Usage of project other since 2020-01-01 00:00 UTC\. Counting started .*\nBackfill: not run\. .*\nNo model calls were counted in this period\.\n$/);
  assert.equal((await s.nexus(["usage", "--by", "week"])).code, 64, "the API refuses an unknown breakdown");
  assert.equal((await s.nexus(["usage", "--since", "last week"])).code, 64, "and an unknown period");
});

test("a bare thread has no conversation to print, send to or watch", async (t) => {
  const s = await setup(t);
  const bare = await s.startThread({ project: "acme", title: "Check", bare: true }, "nLAPTOP");
  const refused = { code: 5, stdout: "", stderr: `nexus: thread ${bare.id} has no conversation\n` };
  const run = async (args: string[]) => {
    const { code, stdout, stderr } = await s.nexus(args);
    return { code, stdout, stderr };
  };
  assert.deepEqual(await run(["conversation", bare.id]), refused);
  assert.deepEqual(await run(["send", bare.id, "hi"]), refused);
  assert.deepEqual(await run(["abort", bare.id]), refused);
  const watch = watchLines(t, s, [bare.id]);
  const printed = [await watch.next()];
  const exited = once(watch.child, "exit");
  await s.json(["delete", bare.id]);
  for (let line = await watch.next(); ; line = await watch.next()) {
    printed.push(line);
    if (line.type === "state" && line.status === "deleted") break;
  }
  assert.deepEqual((await exited)[0], 0);
  assert.deepEqual(printed.map((l) => `${l.type} ${l.status ?? ""}`), ["reset ", "state active", "live ", "state deleted"], "a bare thread's watch prints its state and an empty conversation, and ends once it is deleted");
});

test("show prints a failed pylon's log under its reason, indented, and --json carries the failure whole", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "x"]);
  const failed = "pylon is broken: the controller failed to boot the VM\nqemu: booting\nError: Guest command got no answer within 13000 ms";
  s.registry.savePylon({ ...s.registry.pylon(thread.pylonId)!, failed });
  assert.match((await s.nexus(["show", thread.id])).stdout, /^failed: pylon is broken: the controller failed to boot the VM\n {2}qemu: booting\n {2}Error: Guest command got no answer within 13000 ms$/m);
  assert.equal((await s.json(["show", thread.id])).pylon.failed, failed);
});

test("node prints a node's health, unknown where the host exposes nothing, and --json the API's reply", async (t) => {
  const s = await setup(t);
  const health: NodeHealth = {
    node, readAt: "2027-01-01T00:00:00.000Z", cpus: 16, load: { one: 2.5, five: 1.75, fifteen: 1 },
    memory: { totalGiB: 62.8, availableGiB: 40.24, swapTotalGiB: 8, swapFreeGiB: 6 }, disk: { path: "/var/lib/nexus", totalGiB: 457.1, freeGiB: 180.33 },
    temperatures: [{ sensor: "k10temp Tctl", celsius: 54.125 }, { sensor: "nvme Composite", celsius: 41.85 }],
    pylons: [{ pylonId: "pylon-th-aaaaaaaaaaaa" as PylonId, processes: 2, cpuPercent: 112.46, residentGiB: 6.25 }, { pylonId: "pylon-th-bbbbbbbbbbbb" as PylonId, processes: 1, cpuPercent: 0, residentGiB: 0.1 }],
  };
  s.nodeHealth(async () => health);
  assert.deepEqual(await s.json(["node", node]), health);
  assert.equal((await s.nexus(["node", node])).stdout, [
    `node: ${node}, read 2027-01-01T00:00:00.000Z`,
    "load: 2.50 1.75 1.00 (1, 5, 15 min) on 16 CPUs",
    "memory: 40.2 of 62.8 GiB available",
    "swap: 2 of 8 GiB used",
    "disk: 180.3 of 457.1 GiB free at /var/lib/nexus",
    "temperatures: k10temp Tctl 54.1 °C, nvme Composite 41.9 °C",
    "pylon: pylon-th-aaaaaaaaaaaa, 2 processes, 112.5% CPU, 6.3 GiB resident",
    "pylon: pylon-th-bbbbbbbbbbbb, 1 process, 0% CPU, 0.1 GiB resident",
    "",
  ].join("\n"));
  s.nodeHealth(async () => ({ ...health, load: null, memory: null, temperatures: null, pylons: null }));
  assert.match((await s.nexus(["node", node])).stdout, /^load: unknown on 16 CPUs\nmemory: unknown\nswap: unknown\n.*\ntemperatures: unknown\npylons: unknown\n$/m);
});

test("start and item add check their worker flags alike, and item add refuses an --after that names nothing without a request", async (t) => {
  const s = await setup(t, { queue: true });
  for (const command of [["start"], ["item", "add"]]) {
    const res = await s.nexus([...command, "--project", "acme", "--message", "Build A", "--model", "claude-opus-5-5"]);
    assert.deepEqual([res.code, res.stderr], [64, "nexus: --model requires --claude. Run nexus --help for usage\n"], command.join(" "));
  }
  await s.nexus(["project", "edit", "acme", "--pipeline", "start"]);
  const asked = s.requests();
  const empty = await s.nexus(["item", "add", "--project", "acme", "--message", "Build A", "--after", " , "]);
  assert.deepEqual([empty.code, empty.stderr], [64, "nexus: --after needs a thread. Run nexus --help for usage\n"]);
  assert.equal(s.requests(), asked, "nothing was sent");
  assert.deepEqual(await s.json(["items"]), []);
});

test("preview --wait rides through a restart of the control plane and prints the preview once it is served", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "ports"]);
  observeRunning(s, thread, [], [3000]);
  const { url } = await s.json(["preview", thread.id, "3000"]);
  const asked = s.requests();
  const waiting = s.nexus(["preview", thread.id, "3000", "--wait"]);
  await until("the wait polls a preview that is not served yet", () => s.requests() >= asked + 2);
  const restart = await s.stop();
  const tried = s.proxy.connects.length;
  await until("a poll met the stopped control plane", () => s.proxy.connects.length > tried);
  await restart();
  observeRunning(s, thread, [{ name: "port-3000", state: "ready", port: 3000, declared: false, wantsPreview: true }], [3000]);
  s.registry.apply({ record: "preview", pylonId: thread.pylonId, service: "port-3000", httpsPort: 10200, ready: true });
  const served = await waiting;
  assert.deepEqual([served.code, served.stdout], [0, `${url}\n`], served.stderr);
});

test("send to a Claude worker whose message meets an unreachable control plane fails at once with exit code 2, and is not sent again", { timeout: 30_000 }, async (t) => {
  const s = await setup(t);
  const sends: string[] = [];
  const dropping = createHttpServer((req, res) => {
    if (req.method === "GET") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ thread: { status: "active" }, claudeWorker: {} }));
    sends.push(req.url!);
    req.socket.destroy();
  });
  const port = await listening(t, dropping);
  const started = Date.now();
  const sent = await s.nexus(["send", "th-0123456789ab", "deploy", "--json"], { NEXUS_URL: `http://127.0.0.1:${port}`, NEXUS_SOCKS: "none" });
  assert.equal(sent.code, 2, sent.stderr);
  assert.equal(JSON.parse(sent.stderr).kind, "unreachable");
  assert.equal(sends.length, 1, "the message may have run, so it is not sent again");
  assert.ok(Date.now() - started < 10_000, "it fails at once rather than waiting for the pylon");
});

/** Runs `args` with its output in a file under a shell, kills the shell once the output has `ready`, and answers how long the orphan outlived it. */
async function orphanLife(t: TestContext, s: Awaited<ReturnType<typeof setup>>, args: readonly string[], ready: string): Promise<number> {
  const out = join(await mkdtemp(join(tmpdir(), "nexus-orphan-")), "out");
  const sh = spawn("sh", ["-c", `"$0" "$@" > "${out}" 2>&1 & echo $!; wait`, process.execPath, cli, ...args], { env: s.env() });
  t.after(() => { sh.kill("SIGKILL"); });
  const [pidLine] = await once(sh.stdout, "data") as [Buffer];
  const pid = Number(pidLine.toString().trim());
  t.after(() => { try { process.kill(pid); } catch {} });
  await until(`${args[0]} printed ${ready}`, async () => (await readFile(out, "utf8").catch(() => "")).includes(ready));
  sh.kill("SIGKILL");
  await once(sh, "exit");
  const killed = Date.now();
  await until(`the orphaned ${args[0]} exited`, async () => {
    try {
      process.kill(pid, 0);
      // A container's PID 1 may leave an exited orphan as a zombie.
      return /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""));
    } catch { return true; }
  });
  return Date.now() - killed;
}

test("a watch or events --follow whose parent is killed exits within about a second, however long the watch's interval", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "idle"]);
  // The bounds are well under the minute's interval, and loose for a loaded suite.
  assert.ok(await orphanLife(t, s, ["watch", thread.id, "--json", "--interval", "60000"], '"type":"state"') < 10_000, "the watch did not wait out its interval");
  s.registry.appendEvent("release.changed", null, { state: "pending" });
  assert.ok(await orphanLife(t, s, ["events", "--follow"], "release.changed") < 10_000, "events --follow exited");
});
