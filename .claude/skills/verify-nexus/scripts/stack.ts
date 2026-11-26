/**
 * Verification scaffolding, not part of Nexus. One local Nexus stack on a Mac, run by `verify-nexus up`:
 *   node stack.ts <runDir>
 *
 * It composes the real parts the way src/checks/control/thread-on-node.ts does: the control plane from
 * startControlPlane (registry, loop, pi-durable harness, API and dashboard) and a probe from startProbe with
 * the Docker backend. Only the production boundaries are doubles:
 * - tailscaled's LocalAPI is a Unix socket in a directory under /tmp, named in <runDir>/socket-dir. whois answers with the shapes of
 *   src/test-support/people.ts: 127.0.0.1:7480 is the node, a connection that came through bob's port 7471 is bob, one through
 *   the node's port 7472 is the node, and every other address is alice. The API allows both as people, as for the CLI on a Mac. The probe's own whois names every caller as the
 *   control plane.
 * - the model is the scripted one from src/control/harness/test-fixture.ts: `bash: <command>` runs one bash tool call, and
 *   `stream: <n>` streams an answer of n words.
 * - `tailscale serve` is src/probe/fake-tailscale.ts, so the Mac's work tailnet is never touched.
 *
 * With NEXUS_VERIFY_THREADS=<n>, the registry starts with n archived threads of spoon, started in turn by alice and bob, so a
 * read of the thread list has rows to read and reconcile boots none of them.
 *
 * With NEXUS_VERIFY_PEOPLE=1, control.json names `people` in place of `callers`: alice is an admin and bob an engineer, each
 * admitted by their tailnet login, and each owns the threads they start. Without it the install is solo, as before.
 *
 * Everything Docker holds for the run carries the label nexus.verify=<run>. The process writes <runDir>/state.json
 * once a thread can be started, and closes the probe and the control plane on SIGTERM or SIGINT. Containers
 * outlive it, as pylons outlive a probe. `verify-nexus down` removes them.
 */
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { packagedDaemon } from "@earendil-works/pi-env";
import { createDockerBackend } from "../../../../src/backends/docker-backend.ts";
import { scriptedModel, scriptedModels } from "../../../../src/control/harness/test-fixture.ts";
import { startControlPlane } from "../../../../src/control/main.ts";
import { openRegistry } from "../../../../src/control/registry.ts";
import { nodeSecrets } from "../../../../src/probe/config.ts";
import { fakeTailscale, nodeHost, viaGateway } from "../../../../src/probe/fake-tailscale.ts";
import { startProbe } from "../../../../src/probe/server.ts";
import type { ImageId, NodeName, Person, ProjectId, TailnetNodeId } from "../../../../src/ids.ts";
import { operator } from "../../../../src/control/people.ts";
import { defaultReleaseBranch } from "../../../../src/protocol/deploy.ts";
import { probePort } from "../../../../src/protocol/routes.ts";
import { testPylon, testThread } from "../../../../src/test-support/registry-kit.ts";
import { tailnet, type WhoisAnswer } from "../../../../src/test-support/people.ts";
import type { ImageManifest } from "../../../../src/protocol/images.ts";
import type { Project } from "../../../../src/control/project.ts";

const exec = promisify(execFile);
/** Aborted by SIGTERM or SIGINT. Killing the docker CLI cancels its build, so no image lands after `verify-nexus down`. */
const startup = new AbortController();
const docker = async (...args: string[]) => (await exec("docker", args, { maxBuffer: 64 << 20, signal: startup.signal })).stdout.trim();

const runDir: string = process.argv[2] ?? (() => { throw new Error("usage: node stack.ts <runDir>"); })();
const run = basename(runDir);
const repoRoot = new URL("../../../../", import.meta.url).pathname;

// Fixed, because the control plane reaches probes on probePort only and containers keep the bridge port they booted with.
const ports = { api: 7470, bob: 7471, node: 7472, probe: probePort, gateway: 7481, bridge: 7482 } as const;
const node = "verify-node" as NodeName;
const controlPlaneId = "nVERIFYCONTROL" as TailnetNodeId;
const probeId = tailnet.node.Node.StableID;
const labels = { "nexus.verify": run };
const tag = `nexus-verify-pylon:${run}`;
const imageId = "img-0000000000aa" as ImageId;
const api = `http://127.0.0.1:${ports.api}`;
const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);
// An image that already holds the packages, herdr-core and user, which .nexus/verify makes from the verify pylon's own root,
// because that pylon's allowlist reaches neither Docker Hub, Debian nor herdr.dev.
const base = process.env.NEXUS_VERIFY_BASE;
/** The repository in the stack's image that the project names and the dotfiles layer is pulled from. */
const verifyRepo = "/srv/verify.git";
/**
 * A second repository, at the same absolute path on this machine and in the stack's image, so the control plane can
 * read a project's .nexus/setup from it as `file://`, which a template needs, and a pylon can clone it. `/srv/verify.git`
 * is only in the image, so spoon always boots fresh. Not under the run directory: where the checkout is
 * /home/user/workspace/repo, as in a Nexus pylon, that is where a pylon clones its own checkout, which the copy would block.
 */
const templateRoot = `/var/tmp/nexus-verify-${run}`;
const templateRepo = join(templateRoot, "template.git");
const shared = (() => {
  const v = process.env.NEXUS_VERIFY_PEOPLE;
  if (v === undefined || v === "") return false;
  if (v !== "1") throw new Error(`NEXUS_VERIFY_PEOPLE must be 1 or unset, not ${JSON.stringify(v)}`);
  return true;
})();
const seededThreads = (() => {
  const n = process.env.NEXUS_VERIFY_THREADS;
  if (n === undefined || n === "") return 0;
  if (!/^[1-9][0-9]*$/.test(n)) throw new Error(`NEXUS_VERIFY_THREADS must be a positive integer, not ${JSON.stringify(n)}`);
  return Number(n);
})();

async function buildImage() {
  const arch = await docker("info", "--format", "{{.Architecture}}");
  const daemonArch = arch === "aarch64" || arch === "arm64" ? "arm64" : arch === "x86_64" || arch === "amd64" ? "x64" : undefined;
  if (daemonArch === undefined) throw new Error(`no pi-env build for Docker architecture ${arch}`);
  const { herdrCore } = JSON.parse(await readFile(join(repoRoot, "images/pylon/pins.json"), "utf8")) as { herdrCore: string };
  const dir = join(runDir, "image");
  await mkdir(dir, { recursive: true });
  await copyFile(packagedDaemon({ platform: "linux", arch: daemonArch }), join(dir, "pi-env"));
  await copyFile(join(repoRoot, "images/pylon/nexus"), join(dir, "nexus"));
  await cp(templateRepo, join(dir, "template.git"), { recursive: true });
  // The slice test's image, plus the harness's daemon, the in-pylon CLI and git, so `git status` outputs read a checkout,
  // and procps, whose pgrep counts the terminals attached to Herdr Core.
  await writeFile(join(dir, "Dockerfile"), [
    ...base === undefined ? [
      "FROM node:24-bookworm-slim",
      "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl tini python3 git procps && rm -rf /var/lib/apt/lists/*",
      "RUN useradd --create-home --shell /bin/bash user",
    ] : [`FROM ${base}`],
    "RUN install -d -o user -g user /home/user /home/user/workspace",
    // Docker execs run as root, unlike a pylon's, so git must accept the checkout that `user` owns.
    "RUN git config --system --add safe.directory '*'",
    // The project's repository, which each pylon clones on its first boot, as the stack's containers reach no network.
    `RUN git init --quiet --initial-branch=main /tmp/verify && printf '# verify-nexus\\n' > /tmp/verify/README.md && git -C /tmp/verify -c user.name=verify -c user.email=verify@invalid add README.md && git -C /tmp/verify -c user.name=verify -c user.email=verify@invalid commit --quiet -m init && git clone --quiet --bare /tmp/verify ${verifyRepo} && rm -rf /tmp/verify && chown -R user:user ${verifyRepo}`,
    ...base === undefined ? [
      // Core's installer takes the version and links hc.
      "ARG HERDR_CORE_VERSION",
      'RUN curl -fsSL https://releases.herdr.dev/core/install.sh -o /tmp/hc-install.sh && HC_VERSION=${HERDR_CORE_VERSION} HC_INSTALL_DIR=/usr/local/bin sh /tmp/hc-install.sh && rm /tmp/hc-install.sh && test "$(hc --version)" = "hc ${HERDR_CORE_VERSION}"',
    ] : [],
    "RUN mkdir -p /root/.config/herdr-core && printf 'notes = false\\n' > /root/.config/herdr-core/config.toml",
    "COPY pi-env /usr/local/libexec/nexus/pi-env",
    "COPY nexus /usr/local/bin/nexus",
    `COPY --chown=user:user template.git ${templateRepo}`,
    "RUN chmod 0755 /usr/local/libexec/nexus/pi-env /usr/local/bin/nexus",
  ].join("\n") + "\n");
  log(`building ${tag}`);
  await docker("build", "--quiet", "--label", `nexus.verify=${run}`, "--build-arg", `HERDR_CORE_VERSION=${herdrCore}`, "--tag", tag, dir);
}

/**
 * The local port of each forwarder's connection to the API, with whose request it carries. A closed one stays a minute,
 * with the timer that forgets it, because the API may still be asking whois about its last request.
 */
const forwarded = new Map<number, { answer: WhoisAnswer; forget: NodeJS.Timeout | null }>();

/**
 * tailscaled's LocalAPI whois for the control plane, answered by port: the probe's is the node, a forwarded connection
 * is whoever its forwarder carries, and everything else is alice. It logs each identity the first time it names it.
 */
async function fakeTailscaled(socket: string) {
  const named = new Set<string>();
  const server = createServer((req, res) => {
    const addr = new URL(req.url ?? "/", "http://local-tailscaled.sock").searchParams.get("addr") ?? "";
    const port = Number(addr.slice(addr.lastIndexOf(":") + 1));
    const answer: WhoisAnswer = port === ports.probe ? tailnet.node : forwarded.get(port)?.answer ?? tailnet.alice;
    if (!named.has(answer.Node.StableID)) {
      named.add(answer.Node.StableID);
      log(`whois: answered ${answer.Node.StableID} as ${answer.Node.Tags?.length ? `tags ${answer.Node.Tags.join(",")}` : answer.UserProfile?.LoginName}`);
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
  return server;
}

/**
 * A way in as `answer`: a TCP forwarder from 127.0.0.1:`listen` to the API. Each connection's local port is recorded
 * before any of its bytes reach the API, so the API's whois of that connection finds it.
 */
async function forwarder(listen: number, answer: WhoisAnswer) {
  const server = createTcpServer((client) => {
    const upstream = connect(ports.api, "127.0.0.1");
    let port: number | undefined;
    upstream.once("connect", () => {
      port = upstream.localPort!;
      clearTimeout(forwarded.get(port)?.forget ?? undefined);
      forwarded.set(port, { answer, forget: null });
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("close", () => {
      if (port !== undefined) {
        const closed = port;
        forwarded.set(closed, { answer, forget: setTimeout(() => forwarded.delete(closed), 60_000).unref() });
      }
      client.destroy();
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(listen, "127.0.0.1", resolve));
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

async function makeTemplateRepo() {
  const work = join(runDir, "template-work");
  const git = (...args: string[]) => exec("git", ["-C", work, "-c", "user.name=verify", "-c", "user.email=verify@invalid", ...args]);
  await mkdir(work, { recursive: true });
  await git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(work, "README.md"), "# verify-nexus template repository\n");
  await git("add", "README.md");
  await git("commit", "--quiet", "-m", "init");
  await exec("git", ["clone", "--quiet", "--bare", work, templateRepo]);
  await rm(work, { recursive: true, force: true });
}

await mkdir(runDir, { recursive: true });
closers.push(() => rm(templateRoot, { recursive: true, force: true }));
await makeTemplateRepo();
await buildImage();
// Not in the run directory: a socket path must fit macOS's 104-byte sun_path, and a worktree's path can be too long.
// verify-nexus down removes the directory.
const socketDir = await mkdtemp("/tmp/nexus-verify-");
await writeFile(join(runDir, "socket-dir"), `${socketDir}\n`);
const socket = join(socketDir, "tailscaled.sock");
const tailscaled = await fakeTailscaled(socket);
closers.push(() => { tailscaled.close(); });
for (const [listen, answer] of [[ports.bob, tailnet.bob], [ports.node, tailnet.node]] as const) {
  const server = await forwarder(listen, answer);
  closers.push(() => { server.close(); });
}
const serve = fakeTailscale();

const probe = await startProbe({
  node, host: "127.0.0.1", port: ports.probe,
  auth: { controlPlane: controlPlaneId, peers: [] },
  whois: async () => controlPlaneId,
  backend: createDockerBackend({ images: { [imageId]: tag }, labels, hostBridgePort: ports.bridge, previewHost: nodeHost, artifacts: join(runDir, "artifacts") }),
  secrets: nodeSecrets({ value: () => undefined, names: () => [] }),
  log: (message) => log(`probe: ${message}`),
  previews: { gatewayPort: ports.gateway, routesFile: join(runDir, "preview-routes.json"), tailscale: serve.cli, get: viaGateway(() => `http://127.0.0.1:${ports.gateway}`).get },
});
closers.push(() => probe.close());
log(`probe ${node} on 127.0.0.1:${probe.port}, boot ${probe.bootId}`);

// The Docker image, current. A rollout needs a deployer, and the stack lists none.
const manifest: ImageManifest = {
  id: imageId, gondolinBuildId: `docker:${tag}`, builtOn: node, builtAt: new Date().toISOString(), sha256: "0".repeat(64),
  pins: {
    debianDigest: `sha256:${"0".repeat(64)}`, node: "0.0.0", nodeSha256: "0".repeat(64), claudeCode: "none", pi: "none",
    piEnv: "packaged", piEnvSha256: "0".repeat(64), gondolin: "none", alpineKernel: "none", dotfilesCommon: "none", gh: "0.0.0", ghSha256: "0".repeat(64),
    neovim: "0.0.0", neovimSha256: "0".repeat(64),
  },
};
// One project on the node. The API adds it, unless threads are seeded, which need it in the registry first.
const project: Project = {
  id: "spoon" as ProjectId, repoUrl: verifyRepo, defaultBranch: "main", defaultNode: node,
  resources: { cpus: 1, memoryGiB: 3, diskGiB: 1 }, allowedHosts: [], secrets: [], logins: [], preSetup: null,
};
const seed = openRegistry(join(runDir, "registry.db"));
seed.images.saveImage(manifest, null);
seed.images.setCurrentImage(imageId);
if (seededThreads > 0) {
  seed.nodes.upsertNode({ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: probeId });
  seed.projects.createProject(project);
  const now = Date.now();
  for (let i = 0; i < seededThreads; i++) {
    const person = i % 2 === 0 ? tailnet.alice : tailnet.bob;
    const thread = testThread({
      project: project.id, title: `Seeded ${i + 1}`, startedBy: person.Node.StableID, owner: shared ? person.UserProfile!.LoginName as Person : operator,
      createdAt: now - (seededThreads - i) * 60_000, lastAgentActivityAt: now - 3_600_000, lastHumanActivityAt: now - 3_600_000,
    });
    seed.threads.createThread(thread, testPylon(thread, {
      node, boot: { image: imageId, resources: project.resources, repo: { kind: "clone", url: verifyRepo, checkout: { branch: "main", commit: "origin/main" } }, dotfiles: { repo: verifyRepo, ref: "main" } },
    }));
    seed.threads.setThreadStatus(thread.id, "archived");
  }
  log(`seeded ${seededThreads} archived threads of ${project.id}`);
}
seed.close();

const controlPlane = await startControlPlane({
  db: join(runDir, "registry.db"),
  listen: { host: "127.0.0.1", port: ports.api, hostnames: ["127.0.0.1", "localhost"] },
  self: { tailnetNodeId: controlPlaneId },
  nodes: [{ name: node, tailnetHost: "127.0.0.1", tailnetNodeId: probeId }],
  imageBuildNode: node,
  releaseBranch: defaultReleaseBranch,
  ...shared ? { people: { [tailnet.alice.UserProfile!.LoginName]: "admin", [tailnet.bob.UserProfile!.LoginName]: "engineer" } }
    : { callers: [tailnet.alice.Node.StableID, tailnet.bob.Node.StableID] },
  dotfiles: { repo: verifyRepo, ref: "main" },
  harness: { storage: join(runDir, "harness.sqlite"), credentials: join(runDir, "unused-credentials.json"), model: scriptedModel },
  tailscaledSocket: socket,
  previewPorts: { first: 10200, last: 10299 },
  resumeAfterUsageLimit: false,
}, scriptedModels());
closers.push(() => controlPlane.close());

if (seededThreads === 0) await call("POST", "/v1/projects", project);

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
  run, pid: process.pid, api, bobApi: `http://127.0.0.1:${ports.bob}`, nodeApi: `http://127.0.0.1:${ports.node}`, ports, node, project: project.id, image: imageId, dockerTag: tag, label: `nexus.verify=${run}`,
  revision: `${head}${dirty ? "-dirty" : ""}`, seededThreads, templateRepo: `file://${templateRepo}`, startedAt: new Date().toISOString(),
}, null, 2) + "\n");
log(`nexus-verify: ready ${api} run ${run}`);
