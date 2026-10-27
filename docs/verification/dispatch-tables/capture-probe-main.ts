// Runs the real probe entrypoint, src/probe/main.ts, as a child process for a pylon-vm config with and without a git
// SSH key and for a Docker config, and writes what a node and the control plane can see of each: what it prints, the
// first snapshot's grants, the files it leaves in the state root and their modes, an answer through the host bridge,
// and its exit on SIGTERM. stub-tailnet.ts lets it listen on loopback without tailscaled.
// Run from the root of a checkout: node docs/verification/dispatch-tables/capture-probe-main.ts <out-file>
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);
const controlPlane = "nCONTROL";

async function files(root: string, base = root): Promise<string[]> {
  const listed: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    const mode = ((await stat(path)).mode & 0o777).toString(8);
    const kind = entry.isDirectory() ? "dir" : entry.isSocket() ? "socket" : "file";
    listed.push(`${path.slice(base.length + 1)} ${kind} ${mode}`);
    if (entry.isDirectory()) listed.push(...await files(path, base));
  }
  return listed;
}

function get(options: { port?: number; socketPath?: string; path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", ...options, method: options.method ?? "GET" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        // The observe stream stays open. Its first line is the whole first snapshot.
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

async function run(name: string, backend: (dir: string) => Record<string, unknown>) {
  log(`## ${name}`);
  const dir = await mkdtemp(join(tmpdir(), "pm-"));
  const secretsFile = join(dir, "secrets.env");
  await writeFile(secretsFile, "GH_TOKEN=abc\n");
  await chmod(secretsFile, 0o600);
  const config = join(dir, "probe.json");
  await writeFile(config, JSON.stringify({ node: "rj-test", listen: { host: "100.64.0.1" }, auth: { controlPlane, peers: [] }, backend: backend(dir), secretsFile }));
  const child = spawn(process.execPath, ["--no-warnings", "--import", "./docs/verification/dispatch-tables/stub-tailnet.ts", "src/probe/main.ts", config], {
    env: { ...process.env, STUB_CALLER: controlPlane }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const exited = once(child, "exit");
  while (!/listening on 127\.0\.0\.1:\d+/.test(stdout) && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
  const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]);
  const scrub = (text: string) => text.replaceAll(dir, "<dir>").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>").replace(/boot [0-9a-f-]{36}/g, "boot <id>");
  if (Number.isFinite(port)) {
    const snapshot = await get({ port, path: "/v1/observe" });
    const [status, body] = [snapshot.slice(0, 3), snapshot.slice(4)];
    let summary = body;
    try {
      const event = JSON.parse(body);
      summary = JSON.stringify({ type: event.type, grants: event.observation?.grants, heldSecrets: event.observation?.heldSecrets, pylons: event.observation?.pylons, claudeLaunchRepeatable: event.observation?.claudeLaunchRepeatable, events: event.observation?.events });
    } catch { /* not JSON: kept as it came */ }
    log(`first snapshot: ${status} ${scrub(summary)}`);
    const bridge = join(dir, "state", "host-bridge.sock");
    log(`host bridge: ${scrub(await get({ socketPath: bridge, path: "/v1/request", method: "POST", headers: { "x-nexus-pylon": "pylon-x", "content-type": "application/json" }, body: "{}" }))}`);
  }
  log("state root while it runs:");
  for (const line of await files(dir)) log(`  ${line}`);
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  log(`stdout: ${JSON.stringify(scrub(stdout))}`);
  log(`stderr: ${JSON.stringify(scrub(stderr))}`);
  log(`exit: ${code} ${signal}`);
  log("state root after:");
  for (const line of await files(dir)) log(`  ${line}`);
  await rm(dir, { recursive: true, force: true });
}

await run("pylon-vm backend with a git SSH key", (dir) => ({ kind: "pylon-vm", stateRoot: join(dir, "state"), artifacts: join(dir, "artifacts"), gitSsh: { privateKeyFile: join(dir, "id"), knownHostsFile: join(dir, "known_hosts") } }));
await run("pylon-vm backend without a git SSH key", (dir) => ({ kind: "pylon-vm", stateRoot: join(dir, "state"), artifacts: join(dir, "artifacts") }));
await run("docker backend", () => ({ kind: "docker", images: {} }));

await writeFile(out, lines.join("\n") + "\n");
