/**
 * nexus connect and nexus attach, against the control plane's real API with a fake harness behind it. src/test-
 * support/cli-kit.ts says when a test runs the CLI in its own process and when as a child.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Thread } from "../control/thread-store.ts";
import { openTerminal, terminalSize } from "../guest-terminal.ts";
import { processStream } from "../process-stream.ts";
import type { TailnetNodeId } from "../ids.ts";
import type { ByteStream, StreamEnd } from "../protocol/streams.ts";
import { testCertificate } from "../test-certificate.ts";
import { freePort, tempDir, until } from "../test-support/kit.ts";
import { cli, laptop, phone, apiName, project, withHealth, listening, socksProxy, setup, observeRunning, versioned, bare } from "../test-support/cli-kit.ts";

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
  assert.ok(s.registry.threads.thread(thread.id)!.lastHumanActivityAt >= before, "attaching is human activity");
  assert.ok(s.proxy.connects.length > 0 && s.proxy.connects.every((c) => c === `${apiName}:${s.api.port}`), "through the proxy");
});

test("attach to an archived thread exits 5, and without a terminal 64", async (t) => {
  const s = await setup(t);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "attach"]);
  await s.json(["archive", thread.id]);
  const archived = await inTerminal(s.env(), ["attach", thread.id]);
  assert.equal(archived.code, 5, archived.screen);
  assert.match(archived.screen, /is archived, so its pylon stays paused/);

  const piped = await s.spawned(["attach", thread.id]);
  assert.equal(piped.code, 64);
  assert.match(piped.stderr, /attach needs a terminal/);
});

test("attach with a config of only the URL and the proxy prints nothing but its own error", async (t) => {
  const s = await setup(t);
  await mkdir(join(s.home, ".config", "nexus"), { recursive: true });
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), JSON.stringify({ url: s.localUrl, socks: "none" }));
  const attach = await s.spawned(["attach", "th-0123456789ab"], { NEXUS_URL: "", NEXUS_SOCKS: "" });
  assert.deepEqual([attach.code, attach.stderr], [64, "nexus: attach needs a terminal, and stdin or stdout is not one\n"]);
});

test("the attach settings retired in 0.9.0 are unknown keys of the config file, and NEXUS_ATTACH is not read", async (t) => {
  const s = await setup(t);
  await mkdir(join(s.home, ".config", "nexus"), { recursive: true });
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), JSON.stringify({ ssh: { "rj-firebat": "rj-firebat" }, attach: "ssh -t x" }));
  const projects = await s.nexus(["projects"]);
  assert.equal(projects.code, 64);
  assert.match(projects.stderr, /cli\.json is not a CLI config: config: Unrecognized keys: "ssh", "attach"/);
  await writeFile(join(s.home, ".config", "nexus", "cli.json"), "{}");
  const attach = await s.spawned(["attach", "th-0123456789ab"], { NEXUS_ATTACH: "ssh -t y" });
  assert.deepEqual([attach.code, attach.stderr], [64, "nexus: attach needs a terminal, and stdin or stdout is not one\n"]);
});

test("connect finds the API on the dashboard's HTTPS port, saves it, and the next command uses it", async (t) => {
  const s = await setup(t, { https: true });
  await until("the API serves TLS", () => s.httpsPort() !== undefined);
  const proxy = await socksProxy(t, 0, { 7443: s.httpsPort()!, 7470: s.api.port });
  const env = { NEXUS_URL: "", NEXUS_SOCKS: "", NODE_EXTRA_CA_CERTS: s.certFile };
  const config = join(s.home, ".config", "nexus", "cli.json");

  const connected = await s.spawned(["connect", apiName, "--socks", `127.0.0.1:${proxy.port}`], env);
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
  assert.deepEqual(await s.json(["projects"], env, s.spawned), [project], "the saved URL and proxy reach the API over TLS");
  assert.deepEqual(proxy.connects.slice(-1), [`${apiName}:7443`]);
  const thread: Thread = await s.json(["start", "--project", "acme", "--title", "attach over TLS"], env, s.spawned);
  await s.json(["archive", thread.id], env, s.spawned);
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
  const dir = await tempDir("nexus-cli-ip-", t);
  const server = createHttpsServer(await testCertificate(dir, "127.0.0.1"), withHealth((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ node: laptop, allowed: true, person: true, deployer: true }));
  }));
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
  const admit = "run this on the control plane's machine, in its nexus checkout after git pull. It changes the config and keeps the release that runs: sudo deploy/install.sh --admit";

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
  assert.deepEqual([refused.code, refused.stderr], [3, "nexus: caller is not a tailnet node this control plane allows. If it is your own device, run this on the control plane's machine, in its nexus checkout after git pull, to let it use Nexus and deploy: sudo deploy/install.sh --admit nSTRANGER\n"], "every other command names the line connect prints");
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
  const refusedHere = await s.nexus(["connect", `http://127.0.0.1:${dead}`, "--socks", "none"], env);
  assert.deepEqual([refusedHere.code, refusedHere.stderr], [2, `nexus: no Nexus control plane answers at http://127.0.0.1:${dead}:\n  http://127.0.0.1:${dead}: nothing is listening on 127.0.0.1:${dead}\nIf this device reaches the tailnet only through a SOCKS5 proxy, such as ts-home's userspace tailscaled, give it with --socks HOST:PORT\n`], "connect names each try's reason alone, and never itself");
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

test("connect refuses a control plane older than the CLI reads, and saves nothing", async (t) => {
  const old = await versioned(t, { commit: "a".repeat(40), https: {} });
  const res = await bare(t, ["connect", old.url, "--json"]);
  assert.equal(res.code, 1);
  assert.match(JSON.parse(res.stderr).error, /^the control plane at http:\/\/127\.0\.0\.1:\d+ runs Nexus older than [\d.]+, and this CLI needs [\d.]+ or later\. Upgrade it, as deploy\/README\.md describes$/);
  assert.deepEqual(old.paths, ["/v1/health"], "it asks no whoami");
  await assert.rejects(readFile(res.config), { code: "ENOENT" });
});
