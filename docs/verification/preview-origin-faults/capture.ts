// Runs the real probe entrypoint, src/probe/main.ts, with the pylon-vm backend and a preview gateway, over instance
// directories that hold only the status.json a controller would write. Writes each preview's answer and the probe's
// log lines about preview origins. stub-tailnet.ts lets it listen on loopback, and a `tailscale` on PATH answers
// `status --json` with a MagicDNS name. Run from the root of a checkout:
//   node docs/verification/preview-origin-faults/capture.ts <out-file>
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2]!;
const lines: string[] = [];
const host = "node.example.ts.net";

async function listen(handler: Parameters<typeof createServer>[0] = () => {}): Promise<{ port: number; close(): void }> {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } };
}

const web = await listen((_req, res) => res.end("served by web, first origin"));
const moved = await listen((_req, res) => res.end("served by web, origin after the rewrite"));
const free = await listen();
const gatewayPort = free.port;
free.close();

const dir = await mkdtemp(join(tmpdir(), "pof-"));
const stateRoot = join(dir, "state");
const status = async (pylonId: string, value: unknown) => {
  const instance = join(stateRoot, "instances", pylonId);
  await mkdir(instance, { recursive: true, mode: 0o700 });
  // By rename, as the controller's saveJson writes it.
  await writeFile(join(instance, "status.json.tmp"), typeof value === "string" ? value : JSON.stringify(value));
  await rename(join(instance, "status.json.tmp"), join(instance, "status.json"));
};
const cases = [
  { port: 10001, pylonId: "pylon-running", service: "web", label: "running, with a preview of web" },
  { port: 10002, pylonId: "pylon-paused", service: "web", label: "paused" },
  { port: 10003, pylonId: "pylon-running", service: "api", label: "running, no preview of api" },
  { port: 10004, pylonId: "pylon-absent", service: "web", label: "not on this node" },
  { port: 10005, pylonId: "pylon-garbled", service: "web", label: "status.json that is not JSON" },
  { port: 10006, pylonId: "pylon-foreign", service: "web", label: "origin that is not a loopback port" },
];
await status("pylon-running", { name: "pylon-running", state: "running", previews: { web: `http://127.0.0.1:${web.port}` } });
await status("pylon-paused", { name: "pylon-paused", state: "stopped" });
await status("pylon-garbled", "{ not json");
await status("pylon-foreign", { name: "pylon-foreign", state: "running", previews: { web: "http://10.0.0.5:3000" } });
const routesFile = join(dir, "routes.json");
await writeFile(routesFile, JSON.stringify(cases.map(({ port, pylonId, service }) => ({ httpsPort: port, pylonId, service }))));

const bin = join(dir, "bin");
await mkdir(bin);
await writeFile(join(bin, "tailscale"), `#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"${host}."}}'; else echo '{}'; fi\n`, { mode: 0o755 });
const secretsFile = join(dir, "secrets.env");
await writeFile(secretsFile, "GH_TOKEN=abc\n");
await chmod(secretsFile, 0o600);
const config = join(dir, "probe.json");
await writeFile(config, JSON.stringify({
  node: "rj-test", listen: { host: "100.64.0.1" }, auth: { controlPlane: "nCONTROL", peers: [] }, secretsFile,
  backend: { kind: "pylon-vm", stateRoot, artifacts: join(dir, "artifacts") },
  previews: { gatewayPort, routesFile },
}));
const child = spawn(process.execPath, ["--no-warnings", "--import", "./docs/verification/preview-origin-faults/stub-tailnet.ts", "src/probe/main.ts", config], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_CALLER: "nCONTROL" }, stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
const exited = once(child, "exit");
while (!/listening on/.test(stdout) && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
if (child.exitCode !== null) throw new Error(`the probe exited ${child.exitCode}: ${stderr}`);

const visit = (port: number) => new Promise<string>((resolve) => {
  request({ host: "127.0.0.1", port: gatewayPort, headers: { host: `${host}:${port}`, accept: "application/json" } }, async (res) => {
    let body = "";
    for await (const chunk of res) body += chunk;
    resolve(`${res.statusCode} ${body.trim()}`);
  }).on("error", (err) => resolve(`error ${err.message}`)).end();
});
const scrub = (text: string) => text.replaceAll(dir, "<dir>").replaceAll(String(web.port), "<web>").replaceAll(String(moved.port), "<moved>");

for (const c of cases) lines.push(`${c.label}: ${scrub(await visit(c.port))}`);
await status("pylon-running", { name: "pylon-running", state: "running", previews: { web: `http://127.0.0.1:${moved.port}` } });
lines.push(`running, status.json replaced by rename: ${scrub(await visit(10001))}`);
lines.push("probe log lines about preview origins:");
for (const line of stderr.split("\n").filter((l) => /preview origin/.test(l))) lines.push(`  ${scrub(line)}`);

child.kill("SIGTERM");
await exited;
web.close();
moved.close();
await rm(dir, { recursive: true, force: true });
await writeFile(out, lines.join("\n") + "\n");
