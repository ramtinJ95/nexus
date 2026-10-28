// One node on this machine, infra-testbench: a real probe (startProbe) over a real pylon-vm backend, followed by the
// real control-plane loop, API and dashboard on 127.0.0.1:7470, as src/control/main.ts wires them. This pylon has no
// KVM, so the backend's boot is the one stand-in:
//  - A pylon of project `flaky` fails as its controller did three times on infra-testbench on 2026-10-27: the
//    instance is left as a controller that failed to boot the VM leaves it, status `failed`, with a controller.log
//    that ends in the guest-command timeout and holds the node's GH_TOKEN value, planted in it.
//  - A pylon of any other project runs the real src/pylon-vm/daemon.ts with vm-stand-in.ts as its runtime, a child
//    process standing in for QEMU: `acme`'s keeps half a CPU busy and holds 300 MiB, `docs`'s idles.
// Everything from the instance directories up, list(), the probe's observations and routes, the planner, the
// registry, the API and the dashboard, is the code under test. The same file runs on main and on the branch.
//
// whois answers the laptop, a deployer, until POST /verify/caller on port 7489 names the phone, which the API allows
// but which is not a deployer. POST /verify/restart stops the probe, so the node goes away, then closes the control
// plane and starts it again on the same registry file.
//
//   EVIDENCE=<dir> node docs/verification/node-diagnostics/stack.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApi } from "../../../src/control/api.ts";
import { fakeHarness } from "../../../src/control/fake-harness.ts";
import { startLoop } from "../../../src/control/loop.ts";
import { openRegistry } from "../../../src/control/registry.ts";
import { threadStarter } from "../../../src/control/threads.ts";
import { parseSecretsEnv, nodeSecrets } from "../../../src/probe/config.ts";
import { startProbe } from "../../../src/probe/server.ts";
import { connectProbe, type NodeName, type TailnetNodeId } from "../../../src/protocol.ts";
import { createPylonVmBackend } from "../../../src/pylon-vm-backend.ts";
import { ingest } from "../../../src/reconcile.ts";
import type { ImageId } from "../../../src/images.ts";

const evidence = process.env.EVIDENCE ?? "/tmp/nexus-diag-evidence";
mkdirSync(evidence, { recursive: true });
// Under /tmp, not the evidence directory: a controller's Unix socket path must stay short.
const root = "/tmp/nexus-diag";
await rm(root, { recursive: true, force: true });
const node = "infra-testbench" as NodeName;
const nodeId = "nTESTBENCH" as TailnetNodeId;
const controlPlane = "nFIREBAT" as TailnetNodeId;
const callers = { laptop: "nLAPTOP" as TailnetNodeId, phone: "nPHONE" as TailnetNodeId };
let caller = callers.laptop;
const image = "img-0000000000dd" as ImageId;
const planted = "nexus-planted-gh-token-4f2a9c71";

const artifacts = join(root, "artifacts");
await mkdir(join(artifacts, image), { recursive: true });
await writeFile(join(artifacts, image, "manifest.json"), "{}");
await writeFile(join(artifacts, image, "image.json"), "{}");
const stateRoot = join(root, "n");
const instances = join(stateRoot, "instances");
await mkdir(instances, { recursive: true, mode: 0o700 });

const flakyLog = (pylonId: string) => [
  `2026-10-27T03:11:56.208Z controller: booting ${pylonId} from ${image}, 2 CPUs, 2 GiB`,
  "2026-10-27T03:11:57.031Z gondolin: qemu started, waiting for the guest agent",
  `2026-10-27T03:11:58.442Z dotfiles: git fetch https://x-access-token:${planted}@github.com/ramtinJ95/dotfiles.git main`,
  `2026-10-27T03:11:58.443Z env: GH_TOKEN=${planted}`,
  "2026-10-27T03:11:59.010Z herdr: waiting for the guest's exec channel",
  "2026-10-27T03:12:12.010Z Error: Guest command got no answer within 13000 ms",
].join("\n") + "\n";

const daemons: ChildProcess[] = [];
const daemon = fileURLToPath(new URL("../../../src/pylon-vm/daemon.ts", import.meta.url));
const standIn = fileURLToPath(new URL("./vm-stand-in.ts", import.meta.url));

/** The instance as pylon-vm leaves it once a boot of `pylonId` got as far as the record and its controller. */
async function boot(pylonId: string, project: string, resources: { cpus: number; memoryGiB: number; diskGiB: number }) {
  const dir = join(instances, pylonId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const config = { version: 1, diskGiB: resources.diskGiB, image: join(artifacts, image), workspace: "/home/user/workspace", setup: [], resume: [], services: {} };
  await writeFile(join(dir, "record.json"), JSON.stringify({ version: 1, name: pylonId, config, createdAt: new Date().toISOString(), labels: { "nexus.image": image } }));
  if (project === "flaky") {
    await writeFile(join(dir, "controller.log"), flakyLog(pylonId), { mode: 0o600 });
    await writeFile(join(dir, "status.json"), JSON.stringify({ name: pylonId, state: "failed", resources: { cpus: resources.cpus, memoryGiB: resources.memoryGiB }, diskGiB: resources.diskGiB }));
    return;
  }
  await writeFile(join(dir, "status.json"), JSON.stringify({ name: pylonId, state: "starting", resources: { cpus: resources.cpus, memoryGiB: resources.memoryGiB } }));
  await writeFile(join(dir, "intent.json"), JSON.stringify({ prepare: false }));
  const log = openSync(join(dir, "controller.log"), "a", 0o600);
  const env = { PATH: process.env.PATH, VM_MIB: project === "acme" ? "300" : "40", VM_BUSY: project === "acme" ? "50" : "0" };
  const child = spawn(process.execPath, ["--import", standIn, daemon, dir], { detached: true, stdio: ["pipe", log, log], env });
  child.stdin!.end(JSON.stringify({ resources: { cpus: resources.cpus, memoryGiB: resources.memoryGiB }, allowedHosts: [], secrets: {}, ssh: null, files: [], hooks: [], publicUrls: {}, hostBridge: null }));
  daemons.push(child);
  const answers = () => new Promise<boolean>((resolve) => {
    const req = request({ socketPath: join(dir, "control.sock"), method: "POST", path: "/" }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.end(JSON.stringify({ action: "inspect", name: pylonId }));
  });
  while (!await answers()) await new Promise((r) => setTimeout(r, 50));
}

const secrets = nodeSecrets(parseSecretsEnv(`GH_TOKEN=${planted}\n`));
const real = createPylonVmBackend({ stateRoot, artifacts, secrets });
const backend = {
  ...real,
  async ensureRunning(inputs: Parameters<typeof real.ensureRunning>[0]) {
    const project = inputs.repo.kind === "clone" ? new URL(inputs.repo.url).pathname.split("/").pop()!.replace(/\.git$/, "") : "scratch";
    await boot(inputs.pylonId, project, inputs.resources);
  },
} as typeof real;
const probe = await startProbe({ node, host: "127.0.0.1", port: 0, auth: { controlPlane, peers: [] }, whois: async () => controlPlane, backend, secrets });
const client = connectProbe(node, "127.0.0.1", nodeId, { port: probe.port, whois: async () => nodeId });

const registryFile = join(root, "registry.db");
const dotfiles = { repo: "https://github.com/ramtinJ95/dotfiles.git", ref: "main" };
function controlPlaneUp(port: number) {
  const registry = openRegistry(registryFile);
  const loop = startLoop({ registry, probes: [client], ingest, previewPorts: { first: 10200, last: 10299 }, log: (line) => writeLog("loop.log", line) });
  const { harness } = fakeHarness();
  const wake = (n: NodeName) => { void loop.wake(n); };
  const startThread = threadStarter({ registry, harness, wake, dotfiles, mirror: { setupInputs: () => Promise.reject(new Error("the verify stack reads no remote")) } });
  return startApi({
    registry, whois: async () => caller, host: "127.0.0.1", port, allowed: new Set(Object.values(callers)), hostnames: new Set(["127.0.0.1"]),
    deployment: { self: controlPlane, deployers: new Set([callers.laptop]), keys: {} },
    dotfiles, harness, startThread, wake, probes: new Map([[node, client]]), previewPorts: { first: 10200, last: 10299 },
  } as never).then((api) => ({ api, loop, registry }));
}
const writeLog = (file: string, line: string) => writeFileSync(join(evidence, file), `${new Date().toISOString()} ${line}\n`, { flag: "a" });

{
  const registry = openRegistry(registryFile);
  registry.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: nodeId });
  registry.saveImage({ id: image, gondolinBuildId: "b", builtOn: node, builtAt: "2026-10-27T00:00:00Z", sha256: "d".repeat(64), pins: {} } as never, null);
  registry.setCurrentImage(image);
  const project = (id: string, cpus: number) => ({ id, repoUrl: `https://github.com/ramtinJ95/${id}.git`, defaultBranch: "main", defaultNode: node, resources: { cpus, memoryGiB: 2, diskGiB: 10 }, allowedHosts: [], logins: [], preSetup: null, secrets: [{ name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] }] });
  for (const [id, cpus] of [["flaky", 2], ["acme", 2], ["docs", 1]] as const) registry.createProject(project(id, cpus) as never);
  registry.close();
}
let cp = await controlPlaneUp(7470);

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    if (req.method === "POST" && req.url === "/verify/caller") {
      caller = callers[JSON.parse(body).as as keyof typeof callers];
      writeLog("stack.log", `whois now answers ${caller}`);
      return void res.writeHead(204).end();
    }
    if (req.method === "POST" && req.url === "/verify/restart") {
      await probe.close();
      writeLog("stack.log", "the probe stopped, so infra-testbench went away");
      await cp.api.close();
      await cp.loop.close();
      cp.registry.close();
      writeLog("stack.log", "the control plane stopped");
      cp = await controlPlaneUp(7470);
      writeLog("stack.log", "the control plane started again on the same registry file");
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
}).listen(7489, "127.0.0.1");

const stop = () => {
  for (const d of daemons) try { process.kill(-d.pid!, "SIGKILL"); } catch {}
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(JSON.stringify({ node, planted, callers, evidence, root }));
