/**
 * Verification scaffolding, not part of Nexus. One local Nexus stack on a Mac, run by `verify-nexus up`:
 *   node stack.ts <runDir>
 *
 * It composes the real parts the way src/control/thread-on-node.ts does: the control plane from
 * startControlPlane (registry, loop, pi-durable harness, API and dashboard) and a probe from startProbe with
 * the Docker backend. Only the production boundaries are doubles:
 * - tailscaled's LocalAPI is a Unix socket in a directory under /tmp, named in <runDir>/socket-dir. whois names 127.0.0.1:7480 as the probe and
 *   every other address as the control plane's own node, which the API allows, as for the CLI on rj-firebat.
 * - the model is the scripted one from src/harness/test-fixture.ts: `bash: <command>` runs one bash tool call, and
 *   `stream: <n>` streams an answer of n words.
 * - `tailscale serve` is src/probe/fake-tailscale.ts, so the Mac's work tailnet is never touched.
 *
 * Everything Docker holds for the run carries the label nexus.verify=<run>. The process writes <runDir>/state.json
 * once a thread can be started, and closes the probe and the control plane on SIGTERM or SIGINT. Containers
 * outlive it, as pylons outlive a probe. `verify-nexus down` removes them.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { packagedDaemon } from "@earendil-works/pi-env";
import { createDockerBackend } from "../../../../src/docker-backend.ts";
import { dockerHostBridge } from "../../../../src/docker-host-bridge.ts";
import { scriptedModel, scriptedModels } from "../../../../src/harness/test-fixture.ts";
import { pylonRepoPath } from "../../../../src/harness/host.ts";
import { startControlPlane } from "../../../../src/control/main.ts";
import { fakeTailscale, nodeHost, viaGateway } from "../../../../src/probe/fake-tailscale.ts";
import { startProbe } from "../../../../src/probe/server.ts";
import { localApiWhois } from "../../../../src/tailscale.ts";
import { probePort, type NodeName, type TailnetNodeId } from "../../../../src/protocol.ts";
import type { ImageId, ImageManifest } from "../../../../src/images.ts";
import type { Project, ProjectId } from "../../../../src/project.ts";

const exec = promisify(execFile);
/** Aborted by SIGTERM or SIGINT. Killing the docker CLI cancels its build, so no image lands after `verify-nexus down`. */
const startup = new AbortController();
const docker = async (...args: string[]) => (await exec("docker", args, { maxBuffer: 64 << 20, signal: startup.signal })).stdout.trim();

const runDir: string = process.argv[2] ?? (() => { throw new Error("usage: node stack.ts <runDir>"); })();
const run = basename(runDir);
const repoRoot = new URL("../../../../", import.meta.url).pathname;

// Fixed, because the control plane reaches probes on probePort only and containers keep the bridge port they booted with.
const ports = { api: 7470, probe: probePort, gateway: 7481, bridge: 7482 } as const;
const node = "verify-node" as NodeName;
const controlPlaneId = "nVERIFYCONTROL" as TailnetNodeId;
const probeId = "nVERIFYPROBE" as TailnetNodeId;
const labels = { "nexus.verify": run };
const tag = `nexus-verify-pylon:${run}`;
const imageId = "img-0000000000aa" as ImageId;
const api = `http://127.0.0.1:${ports.api}`;
const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);

async function buildImage() {
  const arch = await docker("info", "--format", "{{.Architecture}}");
  const daemonArch = arch === "aarch64" || arch === "arm64" ? "arm64" : arch === "x86_64" || arch === "amd64" ? "x64" : undefined;
  if (daemonArch === undefined) throw new Error(`no pi-env build for Docker architecture ${arch}`);
  const { herdr } = JSON.parse(await readFile(join(repoRoot, "images/pylon/pins.json"), "utf8")) as { herdr: string };
  const dir = join(runDir, "image");
  await mkdir(dir, { recursive: true });
  await copyFile(packagedDaemon({ platform: "linux", arch: daemonArch }), join(dir, "pi-env"));
  await copyFile(join(repoRoot, "images/pylon/nexus"), join(dir, "nexus"));
  // The slice test's image, plus the harness's daemon, the in-pylon CLI and git, so `git status` outputs read a checkout.
  await writeFile(join(dir, "Dockerfile"), [
    "FROM node:24-bookworm-slim",
    "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl tini python3 git && rm -rf /var/lib/apt/lists/*",
    `RUN useradd --create-home --shell /bin/bash user && install -d -o user -g user /home/user/workspace ${pylonRepoPath}`,
    // Docker execs run as root, unlike a pylon's, so git must accept the checkout that `user` owns.
    "RUN git config --system --add safe.directory '*'",
    `RUN git init --quiet --initial-branch=main ${pylonRepoPath} && printf '# verify-nexus\\n' > ${pylonRepoPath}/README.md && git -C ${pylonRepoPath} -c user.name=verify -c user.email=verify@invalid add README.md && git -C ${pylonRepoPath} -c user.name=verify -c user.email=verify@invalid commit --quiet -m init`,
    "ARG HERDR_VERSION",
    'RUN curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh && HERDR_INSTALL_DIR=/usr/local/bin sh /tmp/herdr-install.sh && rm /tmp/herdr-install.sh && test "$(herdr --version)" = "herdr ${HERDR_VERSION}"',
    "RUN mkdir -p /root/.config/herdr && printf '[session]\\nresume_agents_on_restore = false\\n' > /root/.config/herdr/config.toml",
    "COPY pi-env /usr/local/libexec/nexus/pi-env",
    "COPY nexus /usr/local/bin/nexus",
    "RUN chmod 0755 /usr/local/libexec/nexus/pi-env /usr/local/bin/nexus",
  ].join("\n") + "\n");
  log(`building ${tag}`);
  await docker("build", "--quiet", "--label", `nexus.verify=${run}`, "--build-arg", `HERDR_VERSION=${herdr}`, "--tag", tag, dir);
}

/** tailscaled's LocalAPI whois, answered by port: the probe's is the probe, everything else is the control plane. */
async function fakeTailscaled(socket: string) {
  const server = createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    const id = addr.endsWith(`:${ports.probe}`) ? probeId : controlPlaneId;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Node: { StableID: id } }));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
  return server;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${api}${path}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : await res.json() as unknown;
}

// Armed before anything starts, so a stop during the build or the startup closes what is up and nothing else.
const closers: (() => Promise<void> | void)[] = [];
process.on("exit", (code) => log(`stack.ts exiting with code ${code}`));
process.on("SIGHUP", () => log("SIGHUP ignored: the stack runs until verify-nexus down"));
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log(`${signal}: closing what started. Containers stay for verify-nexus down`);
    startup.abort();
    (async () => { for (const close of closers.reverse()) await close(); })().then(() => process.exit(0), (err: unknown) => { console.error(err); process.exit(1); });
  });
}

await mkdir(runDir, { recursive: true });
await buildImage();
// Not in the run directory: a socket path must fit macOS's 104-byte sun_path, and a worktree's path can be too long.
// verify-nexus down removes the directory.
const socketDir = await mkdtemp("/tmp/nexus-verify-");
await writeFile(join(runDir, "socket-dir"), `${socketDir}\n`);
const socket = join(socketDir, "tailscaled.sock");
const tailscaled = await fakeTailscaled(socket);
closers.push(() => { tailscaled.close(); });
const whois = localApiWhois(socket);
const serve = fakeTailscale();

const probe = await startProbe({
  node, host: "127.0.0.1", port: ports.probe,
  auth: { controlPlane: controlPlaneId, peers: [] },
  whois,
  backend: createDockerBackend({ images: { [imageId]: tag }, labels, hostBridgePort: ports.bridge, previewHost: nodeHost, artifacts: join(runDir, "artifacts") }),
  secrets: { value: () => undefined },
  log: (message) => log(`probe: ${message}`),
  previews: { gatewayPort: ports.gateway, routesFile: join(runDir, "preview-routes.json"), tailscale: serve.cli, get: viaGateway(() => `http://127.0.0.1:${ports.gateway}`).get },
  hostBridge: dockerHostBridge(ports.bridge, labels),
});
closers.push(() => probe.close());
log(`probe ${node} on 127.0.0.1:${probe.port}, boot ${probe.bootId}`);

const controlPlane = await startControlPlane({
  db: join(runDir, "registry.db"),
  listen: { host: "127.0.0.1", port: ports.api, hostnames: ["127.0.0.1", "localhost"] },
  self: { tailnetNodeId: controlPlaneId },
  nodes: [{ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: probeId }],
  callers: [],
  dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
  harness: { storage: join(runDir, "harness.sqlite"), credentials: join(runDir, "unused-credentials.json"), model: scriptedModel },
  tailscaledSocket: socket,
  previewPorts: { first: 10200, last: 10299 },
}, scriptedModels());
closers.push(() => controlPlane.close());

// Seed through the API, as release tooling does: the image, made current, and one project on the node.
const manifest: ImageManifest = {
  id: imageId, gondolinBuildId: `docker:${tag}`, builtOn: node, builtAt: new Date().toISOString(), sha256: "0".repeat(64),
  pins: {
    debianDigest: "docker", node: "24", nodeSha256: "docker", claudeCode: "none", pi: "none", herdr: "pinned", piEnv: "packaged", piEnvSha256: "docker",
    gondolin: "none", alpineKernel: "none", dotfilesCommon: "none",
  },
};
const project: Project = {
  id: "spoon" as ProjectId, repoUrl: "https://github.com/octocat/Spoon-Knife.git", defaultBranch: "main", defaultNode: node,
  resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
await call("POST", "/v1/images", manifest);
await call("PUT", "/v1/images/current", { image: imageId });
await call("POST", "/v1/projects", project);

// Ready means a thread can start and its pylon can be planned: the node is online in the registry.
const deadline = Date.now() + 60_000;
for (;;) {
  const nodes = await call("GET", "/v1/nodes") as { name: string; state: string }[];
  if (nodes.some((n) => n.name === node && n.state === "online")) break;
  if (Date.now() > deadline) throw new Error(`${node} is not online after 60 s: ${JSON.stringify(nodes)}`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const head = (await exec("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"])).stdout.trim();
const dirty = (await exec("git", ["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== "";
await writeFile(join(runDir, "state.json"), JSON.stringify({
  run, pid: process.pid, api, ports, node, project: project.id, image: imageId, dockerTag: tag, label: `nexus.verify=${run}`,
  revision: `${head}${dirty ? "-dirty" : ""}`, startedAt: new Date().toISOString(),
}, null, 2) + "\n");
log(`nexus-verify: ready ${api} run ${run}`);
