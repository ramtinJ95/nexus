/**
 * Prints what a person, a node or a pylon controller can observe of the paths issue #135 removes: the CLI's exit codes
 * and stderr for each config file and NEXUS_ATTACH, the stream request the control plane sends a probe, and how a pylon
 * controller boots from each shape of intent.json. It imports the checkout given as its argument, so run.sh runs it
 * unchanged against main and against the branch.
 *
 *   node docs/verification/drop-old-compat/capture.ts <checkout> <stream-url-file>
 */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(process.argv[2] ?? ".");
const urlFile = process.argv[3];
const src = (path: string) => import(join(root, "src", path));
const work = await mkdtemp(join(tmpdir(), "nexus-capture-"));
const lines: string[] = [];
const scrubs: [string, string][] = [[work, "<tmp>"], [root, "<checkout>"]];
const scrub = (text: string) => scrubs.reduce((t, [from, to]) => t.replaceAll(from, to), text);
const say = (line: string) => lines.push(scrub(line));
const section = (title: string) => say(`\n## ${title}`);

section("CLI: `nexus projects` against a closed port, and `nexus attach` without a terminal, per config file and NEXUS_ATTACH");
{
  const home = join(work, "home");
  const config = join(home, ".config", "nexus", "cli.json");
  await mkdir(join(home, ".config", "nexus"), { recursive: true });
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const port = (closed.address() as { port: number }).port;
  closed.close();
  scrubs.push([`:${port}`, ":<port>"]);
  const nexus = (args: string[], env: Record<string, string>) => new Promise<string>((done) => {
    execFile(process.execPath, [join(root, "src/cli/nexus.ts"), ...args], { env: { PATH: process.env.PATH!, HOME: home, NEXUS_SOCKS: "none", ...env } }, (err, _stdout, stderr) => {
      done(`exit ${err === null ? 0 : (err as { code: number }).code}, stderr ${JSON.stringify(stderr)}`);
    });
  });
  const configs: [string, object | null][] = [
    ["no config file", null],
    ["{}", {}],
    ["url and socks", { url: `http://127.0.0.1:${port}`, socks: "none" }],
    ["ssh and attach", { ssh: { "rj-firebat": "rj-firebat" }, attach: "ssh -t x" }],
    ["ssh alone", { ssh: { "rj-firebat": "rj-firebat" } }],
    ["attach alone", { attach: "ssh -t x" }],
    ["url and an unknown key", { url: `http://127.0.0.1:${port}`, proxy: "x" }],
  ];
  for (const [label, body] of configs) {
    if (body === null) await rm(config, { force: true });
    else await writeFile(config, JSON.stringify(body));
    say(`${label}:`);
    say(`  projects: ${await nexus(["projects"], { NEXUS_URL: `http://127.0.0.1:${port}` })}`);
    say(`  attach: ${await nexus(["attach", "th-0123456789ab"], {})}`);
    say(`  attach with NEXUS_ATTACH: ${await nexus(["attach", "th-0123456789ab"], { NEXUS_ATTACH: "ssh -t y" })}`);
  }
}

section("stream request: what ProbeClient.stream sends, what this checkout's probe parses of it, and the outcome of a 409");
{
  const { connectProbe, parseStreamRequest } = await src("protocol.ts");
  const seen: { url: string; headers: Record<string, unknown> }[] = [];
  const probe = createServer((req, res) => {
    seen.push({ url: req.url!, headers: { connection: req.headers.connection, upgrade: req.headers.upgrade } });
    res.writeHead(409).end("pylon-x is not running");
  });
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const client = connectProbe("node-a", "127.0.0.1", "nodeid-a", { port: (probe.address() as { port: number }).port, whois: async () => "nodeid-a" });
  for (const argv of [["true"], ["sh", "-c", "printf '%s' \"$1\"", "x", "a b"]]) {
    try {
      await client.stream("pylon-x", argv);
      say(`argv ${JSON.stringify(argv)}: resolves`);
    } catch (err) {
      say(`argv ${JSON.stringify(argv)}: rejects ${(err as { code?: string }).code} ${JSON.stringify((err as Error).message)}`);
    }
    const { url, headers } = seen.at(-1)!;
    const parsed = new URL(url, "http://probe");
    say(`  path ${parsed.pathname}, headers ${JSON.stringify(headers)}`);
    say(`  request ${parsed.searchParams.get("request")}`);
    say(`  parsed by this checkout's probe ${JSON.stringify(parseStreamRequest("nexus-stream", parsed))}`);
  }
  probe.close();
  if (urlFile !== undefined) await writeFile(urlFile, `${seen.map((s) => s.url).join("\n")}\n`);
}

section("pylon controller: daemon.ts over fake-runtime.ts, per intent.json");
{
  const { directory, privateDirectory } = await src("pylon-vm/storage.ts");
  const { saveJson } = await src("json-file.ts");
  const spec = { resources: { cpus: 1, memoryGiB: 1 }, allowedHosts: [], secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null };
  const intents: [string, unknown][] = [
    ["as the client writes it", { prepare: false }],
    ["older, setup ran", { prepare: false, fresh: false }],
    ["older, setup failed", { prepare: false, fresh: false, setupError: "Setup exited 1" }],
    ["older, setup not run", { prepare: false, fresh: true }],
    ["malformed", { prepare: "yes" }],
  ];
  for (const [label, intent] of intents) {
    const dir = directory(work, "instances", label.replaceAll(/\W+/g, "-"));
    await privateDirectory(dir);
    await saveJson(join(dir, "record.json"), { version: 1, name: "pylon-t1", config: {}, createdAt: "2026-10-01T00:00:00.000Z", labels: {} });
    await saveJson(join(dir, "intent.json"), intent);
    const child = spawn(process.execPath, ["--import", join(root, "src/pylon-vm/fake-runtime.ts"), join(root, "src/pylon-vm/daemon.ts"), dir], { stdio: ["pipe", "ignore", "pipe"] });
    let log = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (log += chunk));
    child.stdin.end(JSON.stringify(spec));
    const exited = once(child, "exit");
    while (child.exitCode === null && !existsSync(join(dir, "control.sock"))) await delay(10);
    let state = "no socket";
    if (child.exitCode === null) {
      state = await new Promise<string>((done, fail) => {
        const req = request({ socketPath: join(dir, "control.sock"), method: "POST", path: "/" }, (res) => {
          let body = "";
          res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk)).on("end", () => done(JSON.parse(body).result.status.state));
        });
        req.on("error", fail);
        req.end(JSON.stringify({ action: "inspect", name: "pylon-t1" }));
      });
      child.kill("SIGTERM");
    }
    const [code] = await exited;
    say(`${label} ${JSON.stringify(intent)}: inspect ${state}, exit ${code}, files left ${JSON.stringify((await readdir(dir)).sort())}`);
    for (const line of log.split("\n").filter((l) => l !== "" && !/^\s+at /.test(l))) say(`  stderr ${line}`);
  }
}

await rm(work, { recursive: true, force: true });
process.stdout.write(`${lines.join("\n").trimStart()}\n`);
