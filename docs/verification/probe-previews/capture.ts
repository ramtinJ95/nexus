// Runs the real probe entrypoint, src/probe/main.ts, as a child process and writes what the guest and the control plane
// see of the boundaries this branch moved: NEXUS_API's answers to bodies it does not take, the raw reply to an upgrade
// the probe refuses, a command to link a port of a pylon that does not run, and the error a
// probe.json that is not JSON stops the probe with. stub-tailnet.ts lets it listen on loopback without tailscaled.
// Run from the root of a checkout: node docs/verification/probe-previews/capture.ts <out-file>
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);
const controlPlane = "nCONTROL";

function call(options: { port?: number; socketPath?: string; path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", ...options, method: options.method ?? "GET" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        if (options.path === "/v1/observe" && text.includes("\n")) {
          resolve(`${res.statusCode} ${text.split("\n")[0]}`);
          res.destroy();
        }
      });
      res.on("end", () => resolve(`${res.statusCode} ${text}`));
    });
    req.on("error", (err) => resolve(`error ${err.message}`));
    req.end(options.body);
  });
}

function rawUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: nexus-stream\r\n\r\n`));
    socket.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; }).on("close", () => resolve(text)).on("error", (err) => resolve(`error ${err.message}`));
  });
}

async function probe(config: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pp-"));
  const secretsFile = join(dir, "secrets.env");
  await writeFile(secretsFile, "GH_TOKEN=abc\n");
  await chmod(secretsFile, 0o600);
  const path = join(dir, "probe.json");
  await writeFile(path, typeof config === "string" ? config : JSON.stringify({ ...config as object, secretsFile, backend: { kind: "pylon-vm", stateRoot: join(dir, "state"), artifacts: join(dir, "artifacts") } }));
  const child = spawn(process.execPath, ["--no-warnings", "--import", "./docs/verification/probe-previews/stub-tailnet.ts", "src/probe/main.ts", path], {
    env: { ...process.env, STUB_CALLER: controlPlane }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const exited = once(child, "exit");
  while (!/listening on 127\.0\.0\.1:\d+/.test(stdout) && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
  const scrub = (text: string) => text.replaceAll(dir, "<dir>").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>").replace(/boot [0-9a-f-]{36}/g, "boot <id>");
  return { dir, child, exited, scrub, port: Number(/listening on 127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]), stderr: () => stderr };
}

const p = await probe({ node: "rj-test", listen: { host: "100.64.0.1" }, auth: { controlPlane, peers: [] } });
const bridge = join(p.dir, "state", "host-bridge.sock");
const guest = (body: string) => call({ socketPath: bridge, path: "/v1/request", method: "POST", headers: { "x-nexus-pylon": "pylon-x", "content-type": "application/json" }, body });
log(`host bridge, a body that is not JSON: ${p.scrub(await guest("not json"))}`);
log(`host bridge, an op it does not take: ${p.scrub(await guest(JSON.stringify({ op: "shell" })))}`);
log(`host bridge, a preview port out of range: ${p.scrub(await guest(JSON.stringify({ op: "preview", port: 0 })))}`);
log(`upgrade to no route: ${JSON.stringify(await rawUpgrade(p.port, "/v1/nope"))}`);
log(`upgrade for a pylon that does not run: ${JSON.stringify(await rawUpgrade(p.port, "/v1/pylons/pylon-x/shell"))}`);
log(`link-port for a pylon that does not run: ${p.scrub(await call({ port: p.port, path: "/v1/pylons/pylon-x/commands", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "link-port", port: 3000 }) }))}`);
p.child.kill("SIGTERM");
await p.exited;
await rm(p.dir, { recursive: true, force: true });

const bad = await probe("{");
const [code] = await bad.exited;
log(`probe.json that is not JSON: exit ${code}, stderr ${JSON.stringify(bad.scrub(bad.stderr()).split("\n").find((line) => line.includes("probe.json")))}`);
await rm(bad.dir, { recursive: true, force: true });

await writeFile(out, lines.join("\n") + "\n");
