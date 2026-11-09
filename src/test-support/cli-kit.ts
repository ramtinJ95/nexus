/**
 * The Mac nexus CLI against the control plane's real API with a fake harness behind it, for the src/cli/nexus*.test.ts
 * files. Most calls go through a fake SOCKS5 proxy that alone can resolve the API's name, as ts-home's proxy alone
 * knows MagicDNS. A test runs the CLI in its own process with `main`, and as a child process only for what needs one:
 * an exit status, a closed pipe, a signal, a terminal, stdin or NODE_EXTRA_CA_CERTS.
 */
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Thread } from "../control/thread-store.ts";
import { claudeWorkerAt } from "./registry-kit.ts";
import type { ReviewLoop } from "../control/review.ts";
import { startImageRollout } from "../control/image-rollout.ts";
import { usageBackfill } from "../control/usage-backfill.ts";
import { testApi } from "./api-kit.ts";
import type { Project } from "../control/project.ts";
import { processStream } from "../process-stream.ts";
import type { ImageId, NodeName, ProjectId, PylonId, TailnetNodeId } from "../ids.ts";
import type { ServiceFact } from "../protocol/observations.ts";
import type { CommandResult, PylonCommand } from "../protocol/commands.ts";
import type { ByteStream } from "../protocol/streams.ts";
import type { NodeHealth } from "../protocol/client.ts";
import { testCertificate } from "../test-certificate.ts";
import { runningPylon, tempDir, testCapacity, testImage, testObservation } from "./kit.ts";
import { version } from "../version.ts";
import { claudeProjects } from "../../images/pylon/nexus-contract.ts";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/nexus.ts";
import type { Io } from "../cli/kit.ts";

export const cli = fileURLToPath(new URL("../cli/nexus.ts", import.meta.url));

export interface Run { code: number; stdout: string; stderr: string }

/** One run of the CLI in this process, with `env` as its environment. */
export async function inProcess(args: readonly string[], env: Io["env"]): Promise<Run> {
  const printed = { stdout: "", stderr: "" };
  const sink = (stream: keyof typeof printed) => new Writable({ decodeStrings: false, write(chunk, _encoding, done) { printed[stream] += chunk; done(); } });
  const code = await main(args, { stdin: Readable.from([]), stdout: sink("stdout"), stderr: sink("stderr"), env });
  return { code, ...printed };
}

/** The CLI as a process of its own, with `env` as its whole environment, in `cwd` if given. */
export function inChild(args: readonly string[], env: Io["env"], cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env, ...cwd === undefined ? {} : { cwd } }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err as { code: number }).code, stdout, stderr });
    });
  });
}

export const node = "rj-firebat" as NodeName;
export const laptop = "nLAPTOP" as TailnetNodeId;
/** Allowed, and a person, but not a deployer. */
export const phone = "nPHONE" as TailnetNodeId;
/** Only the fake proxy resolves this name, so a call that reaches the API went through it. */
export const apiName = "nexus.test";
export const project: Project = {
  id: "acme" as ProjectId, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 2, memoryGiB: 4, diskGiB: 10 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
export const image = testImage();

/** A hand-written control plane's handler, which answers its health as one of this CLI's version does. */
export const withHealth = (handler: RequestListener): RequestListener => (req, res) => req.method === "GET" && req.url === "/v1/health"
  ? void res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" }).end(JSON.stringify({ commit: null, version }))
  : handler(req, res);

export async function listening(t: TestContext, server: Server): Promise<number> {
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
export async function socksProxy(t: TestContext, reply: number | "close" = 0, ports: Record<number, number> = {}) {
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
export async function setup(t: TestContext, setupOptions: { queue?: boolean; https?: boolean; reviews?: ReviewLoop } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
  const certificate = setupOptions.https === true ? await testCertificate(dir, apiName) : null;
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
  const noJobs = () => Promise.reject(new Error("the CLI tests' nodes hold every image they roll out"));
  const control = await testApi(t, {
    queue: setupOptions.queue === true,
    pipeline: setupOptions.queue === true,
    planning: true,
    dotfiles: { repo: "https://github.com/ramtin/dotfiles.git", ref: "main" },
    images: (registry) => startImageRollout({
      registry, probes: new Map([[node, { submit: noJobs, job: noJobs, manifest: async (id) => registry.images.image(id as ImageId) ?? null }]]), buildNode: node,
      recipe: noJobs, release: null, log: () => {},
    }),
    usageBackfill: (registry) => usageBackfill({ registry, counter: { readWhole: () => Promise.reject(new Error("the CLI tests read no pylon")) }, wake: () => {}, intervalMs: 3_600_000, log: () => {} }),
    ...setupOptions.reviews === undefined ? {} : { reviews: setupOptions.reviews },
    deployment: { self: "nFIREBAT" as TailnetNodeId, deployers: new Set([laptop]), keys: {}, resolveMain: async () => "a".repeat(40) },
    ...certificate === null ? {} : { https: { port: 0, certificate: async () => certificate } },
    allowed: new Set([laptop, phone]),
    hostnames: new Set([apiName, "127.0.0.1"]),
    probes: new Map([[node, {
      command: (_pylonId: PylonId, command: PylonCommand) => { commands.push(command); return answer(command); },
      stream: (_pylonId: PylonId, argv: readonly string[]) => pipe(argv),
      health: () => health(),
    }]]),
  });
  const { registry, fake, startThread } = control;
  registry.projects.createProject(project);
  registry.images.saveImage(image, null);
  registry.images.setCurrentImage(image.id);
  t.after(() => rm(dir, { recursive: true }));
  const proxy = await socksProxy(t);
  const home = join(dir, "home");
  await mkdir(home);
  /** The environment of a CLI run: a home of its own, and the API through the proxy. */
  const env = (overrides: Record<string, string> = {}) => ({
    PATH: process.env.PATH!, HOME: home, NEXUS_URL: `http://${apiName}:${control.port}`, NEXUS_SOCKS: `127.0.0.1:${proxy.port}`, ...overrides,
  });
  const nexus = (args: readonly string[], overrides?: Record<string, string>) => inProcess(args, env(overrides));
  /**
   * For what only a process shows: its exit status, NODE_EXTRA_CA_CERTS, attach's want of a terminal, and the
   * checkout `cwd` names, whose origin a start without --project reads.
   */
  const spawned = (args: readonly string[], overrides?: Record<string, string>, cwd?: string) => inChild(args, env(overrides), cwd);
  async function json(args: readonly string[], overrides?: Record<string, string>, run = nexus): Promise<any> {
    const res = await run([...args, "--json"], overrides);
    assert.equal(res.code, 0, res.stderr);
    return JSON.parse(res.stdout);
  }
  return {
    registry, fake, proxy, home, get api() { return control.api; }, env, nexus, spawned, json, commands, startThread,
    requests: control.requests,
    callAs: control.callAs,
    probeAnswers(next: typeof answer) { answer = next; },
    probePipes(next: typeof pipe) { pipe = next; },
    nodeHealth(next: typeof health) { health = next; },
    remoteReads: control.remoteReads,
    localUrl: `http://127.0.0.1:${control.port}`,
    /** The TLS port, once the API serves it. */
    httpsPort: () => control.httpsPort,
    /** The certificate's file, for NODE_EXTRA_CA_CERTS, as a tailnet certificate is trusted on a real Mac. */
    certFile: join(dir, "cert.pem"),
    stop: control.stop,
  };
}

/** Reports the node online with the thread's pylon running these services and listening on these ports, and its guest not answering if given. */
export function observeRunning(s: Awaited<ReturnType<typeof setup>>, thread: Thread, services: ServiceFact[], ports: number[], notAnswering?: { since: string; timeouts: number }) {
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  s.registry.threads.ingested(testObservation(node, {
    pylons: [runningPylon(thread.pylonId, { liveHash: s.registry.threads.pylon(thread.pylonId)!.liveHash, bootedFrom: { image: image.id, checkpoint: null }, services, listening: ports.map((port) => ({ port })), ...notAnswering === undefined ? {} : { notAnswering } })],
  }), []);
}

/** Reports the node online with no pylon on it, so each thread's pylon is absent. */
export function observeAbsent(s: Awaited<ReturnType<typeof setup>>) {
  s.registry.threads.apply({ record: "node", node, state: "online", capacity: testCapacity() });
  s.registry.threads.ingested(testObservation(node), []);
}

/**
 * A Claude worker thread whose session's transcript is the returned file, read from a pylon reported running. Its
 * launch has opened session s1 unless `launched` is false.
 */
export async function claudeWatched(t: TestContext, s: Awaited<ReturnType<typeof setup>>, launched = true) {
  const thread: Thread = await s.json(["start", "--project", "acme", "--claude", "count the lines"]);
  if (launched) claudeWorkerAt(s.registry, thread.id, "started", { session: "s1" });
  const projects = await tempDir("nexus-claude-projects-", t);
  await mkdir(join(projects, "-home-user-workspace-repo"));
  s.probePipes(async (argv) => processStream(argv[0]!, argv.slice(1).map((arg) => arg === claudeProjects ? projects : arg), () => {}));
  observeRunning(s, thread, [], []);
  let sequence = 0;
  return {
    thread, transcript: join(projects, "-home-user-workspace-repo", "s1.jsonl"),
    report: (kind: "session.turn-started" | "session.turn-ended") => s.registry.threads.reportSession(node, { sequence: ++sequence, pylon: thread.pylonId, time: Date.now(), event: { kind, session: "s1" } }),
  };
}

export const at = (n: number) => new Date(Date.UTC(2026, 9, 26, 2, 0, n)).toISOString();

/** A control plane whose health answers `health`, and every other GET an empty list. Answers the paths it was sent. */
export async function versioned(t: TestContext, health: unknown) {
  const paths: string[] = [];
  const server = createHttpServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.url === "/v1/health" ? health : []));
  });
  return { url: `http://127.0.0.1:${await listening(t, server)}`, paths };
}

/** The CLI with a home of its own and no proxy. */
export async function bare(t: TestContext, args: readonly string[], env: Record<string, string> = {}) {
  const home = await tempDir("nexus-cli-home-", t);
  const res = await inProcess(args, { PATH: process.env.PATH!, HOME: home, NEXUS_SOCKS: "none", ...env });
  return { ...res, config: join(home, ".config", "nexus", "cli.json") };
}
