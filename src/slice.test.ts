/**
 * The first vertical slice, end to end: the control plane's planner drives a real probe over HTTP, and the
 * probe runs spawn, pause and delete with a real backend. One test body runs against one backend fixture:
 *
 * - Docker (the default), against the local Docker, in an image the test builds on Node (for the in-pylon CLI)
 *   with Herdr, tini and python3 from Debian and Herdr's installer, so it needs the network once. Everything it
 *   creates carries the label nexus.test=<run>, and cleanup removes only that.
 * - pylon-vm, when NEXUS_SLICE_BACKEND=pylon-vm, with NEXUS_PYLON_VM_IMAGE=<an image's directory in an artifact store> and
 *   NEXUS_PYLON_VM_STATE=<state root>, and optionally NEXUS_PYLON_VM_MEMORY_GIB (default 4). It boots a
 *   Gondolin VM, clones a small public repo over HTTPS, and destroys the instance at the end. With
 *   NEXUS_PYLON_VM_GIT_SSH_KEY=<private key file> (and NEXUS_PYLON_VM_KNOWN_HOSTS, default ~/.ssh/known_hosts)
 *   it clones the same repo over SSH instead, through Gondolin's SSH termination on the host, so the key
 *   must be one GitHub accepts. Its secret checks send a fake secret to postman-echo.com, which echoes it,
 *   and call api.github.com, which only the wake allows. NEXUS_PYLON_VM_SESSIONS=shell,claude-code,pi names
 *   the sessions to carry through the pause, for an image with Herdr. The default slice image has none.
 *
 * Both run the in-pylon `nexus` CLI from images/pylon/nexus inside the pylon, through the backend's host bridge.
 * Previews go through the probe's real gateway and a fake `tailscale`, so nothing touches the node's serve config.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { createDockerBackend } from "./docker-backend.ts";
import { dockerHostBridge } from "./docker-host-bridge.ts";
import { createPylonVmBackend } from "./pylon-vm-backend.ts";
import { run as pylonVm } from "./pylon-vm/client.ts";
import { startProbe, type Probe } from "./probe/server.ts";
import { fakeTailscale, nodeHost, viaGateway } from "./probe/fake-tailscale.ts";
import { pylonInfoFile, pylonVmHostBridge, type HostBridge } from "./probe/pylon-api.ts";
import { connectProbe, type DeclaredOutput, type LiveHash, type NodeName, type ProbeClient, type PylonId, type TailnetNodeId } from "./protocol.ts";
import { envelope, type PlanStep } from "./reconcile.ts";
import { newPylonRecord, nextCheckpoint, snapshot, tick, type PylonRecord } from "./tick.ts";
import type { BackendPylon, Guest, SecretSource, VmBackend } from "./backend.ts";
import { loginHosts, renderOverlay, type BootInputs, type CloneRepo, type OverlayFile, type PreviewAssignment, type ProjectId, type SessionHarness } from "./project.ts";
import { checkoutDir, sessionFacts, sessionsFile } from "./sessions.ts";
import type { CheckpointId, ImageId } from "./images.ts";

const execFileAsync = promisify(execFile);

const run = randomUUID().slice(0, 8);
const node = "slice-node" as NodeName;
const controlPlaneId = "nSLICECONTROL" as TailnetNodeId;
const probeId = "nSLICEPROBE" as TailnetNodeId;
const thread = `slice-${run}`;
const pylonId = `pylon-${thread}` as PylonId;
const cli = new URL("../images/pylon/nexus", import.meta.url).pathname;

interface SliceFixture {
  backend: VmBackend;
  image: ImageId;
  hostBridge: HostBridge;
  /** Puts this checkout's CLI and the given pylon.json into the running pylon, whatever its image has. */
  installCli(pylonJson: string): Promise<void>;
  /** The node's secret file, shared by the probe and the backend as on a real node. */
  secrets: SecretSource;
  boot: Omit<BootInputs, "source" | "pylonId" | "image">;
  /** Boot inputs the wake changes, and node secrets it rotates. A pylon applies both at every boot. */
  wake(): Partial<SliceFixture["boot"]>;
  preSetup: string | null;
  /** The overlay at each version of the live spec, or null for a backend that writes none. */
  overlay: ((version: number) => OverlayFile[]) | null;
  /** Generous for the slowest step, a fresh boot. */
  convergeMs: number;
  /** Where Guest.exec writes the marker, and the cwd it runs in. */
  marker: string;
  cwd: string;
  /** The sessions opened before the pause and expected back after the wake. Empty for an image without Herdr. */
  sessions: readonly SessionHarness[];
  /** Who a supervised service runs as. */
  serviceUser: string;
  /** The pylon's own log, which carries the `sessions:` lines. */
  pylonLog(): Promise<string>;
  setUp(): Promise<void>;
  /** Backend-specific checks of a fresh boot. */
  checkFreshBoot(guest: Guest): Promise<void>;
  /** Backend-specific checks after the wake applied `wake`. */
  checkWake(guest: Guest): Promise<void>;
  checkOverlay(guest: Guest, version: number): Promise<void>;
  /** The state a probe killed partway through ensurePaused leaves behind. */
  partialPause(checkpoint: CheckpointId): Promise<void>;
  /** Whether the planner still sees a pause to finish after partialPause, or the backend already reports it paused. */
  partialPauseResubmits: boolean;
  /** No VM runs, and the disk the checkpoint names is stored. */
  assertStored(checkpoint: CheckpointId): Promise<void>;
  /** No VM, disk, checkpoint or controller of the pylon remains. */
  assertNothingRemains(): Promise<void>;
  cleanUp(): Promise<void>;
}

function dockerFixture(): SliceFixture {
  const docker = async (...args: string[]) => (await execFileAsync("docker", args, { maxBuffer: 64 << 20 })).stdout.trim();
  // What the test's image builds on. Node, for the in-pylon CLI.
  const baseImage = "node:24-bookworm-slim";
  const labels = { "nexus.test": `slice-${run}` };
  const testLabel = `nexus.test=slice-${run}`;
  const tag = `nexus-slice-test:${run}`;
  // Fixed for the run, because each container's NEXUS_API names it and the probe restarts.
  const bridgePort = 20_000 + Math.floor(Math.random() * 10_000);
  const containers = async () => (await docker("ps", "-a", "-q", "--filter", `label=nexus.pylon=${pylonId}`, "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
  const checkpointImage = async (checkpoint: string) => docker("images", "-q", "--filter", `label=nexus.pylon=${pylonId}`, "--filter", `label=nexus.checkpoint=${checkpoint}`, "--filter", `label=${testLabel}`);
  const image: ImageId = "img-slicetest0000";
  return {
    backend: createDockerBackend({ images: { [image]: tag }, labels, hostBridgePort: bridgePort, previewHost: nodeHost }),
    image,
    hostBridge: dockerHostBridge(bridgePort, labels),
    async installCli(pylonJson) {
      await docker("cp", cli, `${pylonId}:/usr/local/bin/nexus`);
      await docker("exec", pylonId, "sh", "-c", `mkdir -p /home/user/.nexus && printf '%s' "$1" > ${pylonInfoFile}`, "sh", pylonJson);
    },
    secrets: { value: () => undefined },
    boot: {
      resources: { cpus: 1, memoryGiB: 1, diskGiB: 1 },
      network: { allowedHosts: [], secrets: [] },
      repo: { kind: "clone", url: "git@example.com:slice.git", checkout: { branch: "main", commit: "0000000" } },
      dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" },
    },
    wake: () => ({}),
    preSetup: null,
    overlay: (version) => [
      { path: "/home/user/.nexus/PYLON.md", mode: 0o644, owner: "user", content: `slice ${run} overlay ${version}\n` },
      { path: "/home/user/.nexus/bin/slice-hello", mode: 0o755, owner: "user", content: "#!/bin/sh\necho hello\n" },
      { path: "/etc/profile.d/nexus.sh", mode: 0o644, owner: "root", content: `export NEXUS_PYLON_ID=${pylonId}\n` },
    ],
    convergeMs: 90_000,
    marker: "/root/marker",
    cwd: "/",
    sessions: ["shell"],
    serviceUser: "root",
    pylonLog: async () => {
      const { stdout, stderr } = await execFileAsync("docker", ["logs", pylonId]);
      return stdout + stderr;
    },
    // Docker execs run as root, so Herdr's config is root's. The pylon image turns off Herdr's agent resume the same way.
    async setUp() {
      const { herdr } = JSON.parse(await readFile(new URL("../images/pylon/pins.json", import.meta.url), "utf8")) as { herdr: string };
      const dir = await mkdtemp(join(tmpdir(), "nexus-slice-image-"));
      try {
        await writeFile(join(dir, "Dockerfile"), [
          `FROM ${baseImage}`,
          "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl tini python3 && rm -rf /var/lib/apt/lists/*",
          // The base image's `node` already has uid 1000.
          `RUN useradd --create-home --shell /bin/bash user && install -d -o user -g user /home/user/workspace ${checkoutDir}`,
          "ARG HERDR_VERSION",
          'RUN curl -fsSL https://herdr.dev/install.sh -o /tmp/herdr-install.sh && HERDR_INSTALL_DIR=/usr/local/bin sh /tmp/herdr-install.sh && rm /tmp/herdr-install.sh && test "$(herdr --version)" = "herdr ${HERDR_VERSION}"',
          "RUN mkdir -p /root/.config/herdr && printf '[session]\\nresume_agents_on_restore = false\\n' > /root/.config/herdr/config.toml",
        ].join("\n") + "\n");
        await docker("build", "--quiet", "--label", testLabel, "--build-arg", `HERDR_VERSION=${herdr}`, "--tag", tag, dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async checkFreshBoot(guest) {
      await this.checkOverlay(guest, 1);
    },
    async checkWake() {},
    // Docker execs are not login shells, so the profile.d file is read by hand.
    async checkOverlay(guest, version) {
      const sh = (script: string) => guest.exec(["sh", "-c", script], { cwd: "/home/user", timeoutMs: 30_000 });
      assert.deepEqual(await sh("stat -c '%U %a %n' .nexus/PYLON.md .nexus/bin .nexus/bin/slice-hello /etc/profile.d/nexus.sh"), {
        exitCode: 0,
        output: "user 644 .nexus/PYLON.md\nuser 755 .nexus/bin\nuser 755 .nexus/bin/slice-hello\nroot 644 /etc/profile.d/nexus.sh\n",
        truncated: false,
      });
      assert.deepEqual(await sh(". /etc/profile.d/nexus.sh && cat .nexus/PYLON.md && .nexus/bin/slice-hello && echo $NEXUS_PYLON_ID"), {
        exitCode: 0, output: `slice ${run} overlay ${version}\nhello\n${pylonId}\n`, truncated: false,
      });
    },
    // The pause dies after `docker stop` and before `docker commit`.
    async partialPause() {
      await docker("stop", pylonId);
      assert.equal(await docker("inspect", "-f", "{{.State.Status}}", pylonId), "exited");
    },
    partialPauseResubmits: true,
    async assertStored(checkpoint) {
      assert.deepEqual(await containers(), []);
      assert.notEqual(await checkpointImage(checkpoint), "");
    },
    async assertNothingRemains() {
      assert.deepEqual(await containers(), []);
      assert.equal(await docker("images", "-q", "--filter", `label=nexus.pylon=${pylonId}`), "");
    },
    async cleanUp() {
      const ids = (await docker("ps", "-a", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
      if (ids.length > 0) await docker("rm", "--force", ...ids);
      for (;;) {
        const images = (await docker("images", "-q", "--filter", `label=${testLabel}`)).split("\n").filter(Boolean);
        if (images.length === 0) break;
        await docker("rmi", "--force", images[0]!);
      }
    },
  };
}

function pylonVmFixture(): SliceFixture {
  const assets = process.env["NEXUS_PYLON_VM_IMAGE"];
  const stateRoot = process.env["NEXUS_PYLON_VM_STATE"];
  if (!assets || !stateRoot) throw new Error("NEXUS_SLICE_BACKEND=pylon-vm needs NEXUS_PYLON_VM_IMAGE and NEXUS_PYLON_VM_STATE");
  const memoryGiB = Number(process.env["NEXUS_PYLON_VM_MEMORY_GIB"] ?? 4);
  if (!Number.isInteger(memoryGiB)) throw new Error(`NEXUS_PYLON_VM_MEMORY_GIB must be a whole number of GiB, got ${process.env["NEXUS_PYLON_VM_MEMORY_GIB"]}`);
  const instances = join(stateRoot, "instances");
  const instanceDir = join(instances, pylonId);
  const sshKey = process.env["NEXUS_PYLON_VM_GIT_SSH_KEY"];
  const gitSsh = sshKey === undefined ? undefined : { privateKeyFile: sshKey, knownHostsFile: process.env["NEXUS_PYLON_VM_KNOWN_HOSTS"] ?? join(homedir(), ".ssh", "known_hosts") };
  const repo: CloneRepo = {
    kind: "clone",
    url: gitSsh === undefined ? "https://github.com/octocat/Hello-World.git" : "git@github.com:octocat/Hello-World.git",
    checkout: { branch: "master", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" },
  };
  const secretValues = [`slice-secret-${run}-1`, `slice-secret-${run}-2`] as const;
  // The first line of the key's body is unique to the key.
  const keyLine = gitSsh === undefined ? [] : [readFileSync(gitSsh.privateKeyFile, "utf8").split("\n")[1]!];
  const secret = { name: "NEXUS_SLICE_SECRET", value: secretValues[0] as string, host: "postman-echo.com" };
  const sessions = (process.env["NEXUS_PYLON_VM_SESSIONS"] ?? "").split(",").filter(Boolean) as SessionHarness[];
  // The hosts a project with a Claude login gets, which Claude Code needs to start at all.
  const allowedHosts = ["github.com", secret.host, ...sessions.includes("claude-code") ? loginHosts.claude : []];
  const python = (script: string) => `python3 -c ${JSON.stringify(script)}`;
  // Prints only a digest of what the host received, so the value never reaches guest output or disk. A refusal
  // prints its status and Server header, and its body only when there is no Server header: Gondolin's own
  // refusals carry none and name the blocked secret in the body, while an upstream body may echo the value.
  const echoedDigest = python(`import hashlib, http.client as h, json, os; c = h.HTTPSConnection("${secret.host}", timeout=20); c.request("GET", "/headers", headers={"x-nexus-slice": os.environ["${secret.name}"], "user-agent": "nexus-slice"}); r = c.getresponse(); b = r.read(); s = r.getheader("server"); print(hashlib.sha256(json.loads(b)["headers"]["x-nexus-slice"].encode()).hexdigest() if r.status == 200 else f"HTTP {r.status} server={s}: " + (b[:300].decode(errors="replace") if s is None else f"{len(b)} bytes"))`);
  const digest = (value: string) => `${createHash("sha256").update(value).digest("hex")}\n`;
  const githubApi = python(`import urllib.request as u; print(u.urlopen("https://api.github.com/zen", timeout=20).status)`);
  const assertSecretOffDisk = async () => {
    try {
      const found = await execFileAsync("grep", ["-rlF", "-D", "skip", ...[...secretValues, ...keyLine].flatMap((v) => ["-e", v]), instanceDir]);
      assert.fail(`a secret value or the git SSH key is on disk in ${found.stdout}`);
    } catch (err) {
      assert.equal((err as { code?: unknown }).code, 1, String(err)); // grep found nothing
    }
  };
  const home = "/home/user";
  const asUser = { cwd: home, timeoutMs: 30_000 };
  const overlay = (version: number): OverlayFile[] => [
    { path: `${home}/.nexus/PYLON.md`, mode: 0o644, owner: "user", content: `slice ${run} overlay ${version}\n` },
    { path: `${home}/.nexus/bin/slice-hello`, mode: 0o755, owner: "user", content: "#!/bin/sh\necho hello\n" },
    { path: "/etc/profile.d/nexus.sh", mode: 0o644, owner: "root", content: `export NEXUS_PYLON_ID=${pylonId}\n` },
  ];
  const sh = (guest: Guest, script: string) => guest.exec(["sh", "-c", script], asUser);
  const checkOverlay = async (guest: Guest, version: number) => {
    assert.deepEqual(await sh(guest, "stat -c '%U %a %n' .nexus .nexus/bin .nexus/PYLON.md .nexus/bin/slice-hello /etc/profile.d/nexus.sh"), {
      exitCode: 0,
      output: "user 755 .nexus\nuser 755 .nexus/bin\nuser 644 .nexus/PYLON.md\nuser 755 .nexus/bin/slice-hello\nroot 644 /etc/profile.d/nexus.sh\n",
      truncated: false,
    });
    // A login shell, as every guest command is, reads the profile.d file.
    assert.deepEqual(await sh(guest, "cat .nexus/PYLON.md && .nexus/bin/slice-hello && echo $NEXUS_PYLON_ID"), {
      exitCode: 0, output: `slice ${run} overlay ${version}\nhello\n${pylonId}\n`, truncated: false,
    });
  };
  const controllers = async () => {
    try {
      return (await execFileAsync("pgrep", ["-f", instanceDir])).stdout.trim();
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return ""; // pgrep found nothing
      throw err;
    }
  };
  const secrets: SecretSource = { value: (name) => name === secret.name ? secret.value : undefined };
  return {
    backend: createPylonVmBackend({ stateRoot, artifacts: dirname(assets), secrets, previewHost: nodeHost, ...(gitSsh === undefined ? {} : { gitSsh }) }),
    image: basename(assets) as ImageId,
    hostBridge: pylonVmHostBridge(stateRoot),
    async installCli(pylonJson) {
      await this.backend.guest(pylonId).writeFiles([
        { path: "/usr/local/bin/nexus", mode: 0o755, owner: "root", content: readFileSync(cli, "utf8") },
        { path: pylonInfoFile, mode: 0o644, owner: "user", content: pylonJson },
      ]);
    },
    secrets,
    boot: {
      resources: { cpus: 2, memoryGiB, diskGiB: 8 },
      network: { allowedHosts, secrets: [{ name: secret.name, hosts: [secret.host] }] },
      repo,
      // Not on the allowlist, so the first boot's pull fails and keeps the image's baked copy.
      dotfiles: { repo: "https://dotfiles.invalid/common.git", ref: "main" },
    },
    wake() {
      secret.value = secretValues[1];
      return {
        resources: { cpus: 2, memoryGiB: memoryGiB + 1, diskGiB: 8 },
        network: { allowedHosts: [...allowedHosts, "api.github.com"], secrets: [{ name: secret.name, hosts: [secret.host] }] },
        dotfiles: { repo: repo.url, ref: repo.checkout.commit },
      };
    },
    preSetup: `mkdir -p .nexus && printf '#!/bin/sh\\necho resumed >> ${home}/resume.log\\n' > .nexus/resume && chmod +x .nexus/resume`,
    overlay,
    convergeMs: 300_000,
    marker: "/home/user/workspace/marker",
    cwd: "/home/user/workspace",
    sessions,
    serviceUser: "user",
    pylonLog: () => readFile(join(instanceDir, "controller.log"), "utf8"),
    async setUp() {
      assert.ok(existsSync(join(assets, "manifest.json")) && existsSync(join(assets, "image.json")), `${assets} is not a published image: it needs Gondolin's manifest.json and Nexus's image.json`);
    },
    async checkFreshBoot(guest) {
      const opts = { cwd: "/home/user/workspace/repo", timeoutMs: 30_000 };
      assert.deepEqual(await guest.exec(["id", "-un"], opts), { exitCode: 0, output: "user\n", truncated: false });
      assert.deepEqual(await guest.exec(["git", "rev-parse", "HEAD"], opts), { exitCode: 0, output: `${repo.checkout.commit}\n`, truncated: false });
      assert.deepEqual(await guest.exec(["git", "symbolic-ref", "--short", "HEAD"], opts), { exitCode: 0, output: `${repo.checkout.branch}\n`, truncated: false });
      // The kernel keeps some memory for itself, so MemTotal is a little under the size the VM was given.
      const meminfo = await guest.exec(["grep", "MemTotal", "/proc/meminfo"], opts);
      const memTotalGiB = Number(/MemTotal:\s+(\d+) kB/.exec(meminfo.output)?.[1]) / 2 ** 20;
      assert.ok(memTotalGiB > memoryGiB * 0.9 && memTotalGiB <= memoryGiB, `asked for ${memoryGiB} GiB, the guest sees ${memTotalGiB.toFixed(2)} GiB`);
      assert.equal((await guest.exec(["git", "remote", "get-url", "origin"], opts)).output, `${repo.url}\n`, "later fetches and pushes take the same path as the clone");

      assert.equal((await sh(guest, "test -e resume.log")).exitCode, 1, "the boot that ran setup skips .nexus/resume");
      const baked = await sh(guest, "git -C /opt/nexus/dotfiles rev-parse HEAD");
      assert.equal(baked.exitCode, 0, baked.output);
      assert.deepEqual(await sh(guest, "git -C .nexus/dotfiles rev-parse HEAD"), baked, "a failed dotfiles pull keeps the baked copy");
      assert.deepEqual(await sh(guest, "cat .nexus/dotfiles-installed"), baked, "the layer's install ran");
      assert.match(await readFile(join(instanceDir, "controller.log"), "utf8"), /^dotfiles: installed$/m, "the install's outcome is logged");

      const placeholder = (await sh(guest, `printenv ${secret.name}`)).output.trim();
      assert.ok(placeholder !== "" && !placeholder.includes(secret.value), `the guest sees ${placeholder}`);
      assert.deepEqual(await sh(guest, echoedDigest), { exitCode: 0, output: digest(secret.value), truncated: false }, `${secret.host} received the value`);
      await assertSecretOffDisk();
      // Searched by its header, so no part of the node's key is ever sent into the guest to look for it.
      const keys = await sh(guest, "sudo grep -rlsF -e 'PRIVATE KEY-----' /home /root /etc /tmp /var/lib/pi-sandbox");
      assert.equal(keys.output, "", "no private key is in the guest");
      assert.notEqual((await sh(guest, githubApi)).exitCode, 0, "api.github.com is not on the first boot's allowlist");
      await checkOverlay(guest, 1);
    },
    async checkWake(guest) {
      assert.deepEqual(await sh(guest, "cat resume.log"), { exitCode: 0, output: "resumed\n", truncated: false }, "the wake ran .nexus/resume once");
      assert.match(await readFile(join(instanceDir, "controller.log"), "utf8"), /^resume: exited 0$/m, "the resume's outcome is logged");
      assert.deepEqual(await sh(guest, "git -C .nexus/dotfiles rev-parse HEAD"), { exitCode: 0, output: `${repo.checkout.commit}\n`, truncated: false }, "the wake pulled the new dotfiles repo");
      const meminfo = await guest.exec(["grep", "MemTotal", "/proc/meminfo"], asUser);
      const memTotalGiB = Number(/MemTotal:\s+(\d+) kB/.exec(meminfo.output)?.[1]) / 2 ** 20;
      assert.ok(memTotalGiB > memoryGiB, `the wake asked for ${memoryGiB + 1} GiB, the guest sees ${memTotalGiB.toFixed(2)} GiB`);
      assert.deepEqual(await sh(guest, githubApi), { exitCode: 0, output: "200\n", truncated: false }, "the wake's allowlist reaches the VM");
      assert.deepEqual(await sh(guest, echoedDigest), { exitCode: 0, output: digest(secret.value), truncated: false }, "the wake sends the rotated value");
      const lsRemote = await guest.exec(["git", "ls-remote", "origin", "HEAD"], { cwd: `${home}/workspace/repo`, timeoutMs: 30_000 });
      assert.equal(lsRemote.exitCode, 0, lsRemote.output);
    },
    checkOverlay,
    // The pause dies after the VM stopped and before the checkpoint ID moved from `pausing` to `checkpoint`.
    async partialPause(checkpoint) {
      const sidecar = join(instanceDir, "nexus-checkpoint.json");
      const previous = JSON.parse(await readFile(sidecar, "utf8")) as { checkpoint: string | null };
      await writeFile(sidecar, JSON.stringify({ checkpoint: previous.checkpoint, pausing: checkpoint }));
      await pylonVm(stateRoot, { action: "stop", name: pylonId });
    },
    partialPauseResubmits: false,
    async assertStored() {
      assert.ok(existsSync(join(instanceDir, "disk.qcow2")), "the instance has no disk.qcow2");
      assert.equal(await controllers(), "", "a controller of the stopped instance still runs");
      await assertSecretOffDisk();
    },
    async assertNothingRemains() {
      assert.deepEqual((await readdir(instances)).filter((name) => name.includes(pylonId)), []);
      assert.equal(await controllers(), "");
    },
    async cleanUp() {
      if (!existsSync(instanceDir)) return;
      // The test failed before delete. The controller log goes with the instance, so print it first.
      console.error((await pylonVm(stateRoot, { action: "logs", name: pylonId, lines: 200 }) as { output: string }).output);
      await pylonVm(stateRoot, { action: "destroy", kind: "instances", name: pylonId, confirm: pylonId });
    },
  };
}

const fixture = process.env["NEXUS_SLICE_BACKEND"] === "pylon-vm" ? pylonVmFixture() : dockerFixture();
const backend = fixture.backend;

const pylon: PylonRecord = newPylonRecord({
  thread, pylonId, node,
  desired: "running",
  boot: { pylonId, image: fixture.image, ...fixture.boot },
  firstBoot: { kind: "fresh", preSetup: fixture.preSetup },
  live: { previews: [], overlay: fixture.overlay?.(1) ?? [] },
  liveHash: "live-slice-1" as LiveHash,
});

let probe: Probe;
let port = 0;
let client: ProbeClient;
/** Fixed across probe restarts, as on a node, so each probe owns the serve entries the last one added. */
let gatewayPort: number;
let stateDir: string;
const tailscale = fakeTailscale();

async function startTestProbe(b: VmBackend = backend) {
  probe = await startProbe({
    node, host: "127.0.0.1", port,
    auth: { controlPlane: controlPlaneId, peers: [] },
    // Every caller on loopback is the control plane. Tests never ask tailscaled.
    whois: async () => controlPlaneId,
    backend: b,
    secrets: fixture.secrets,
    previews: { gatewayPort, routesFile: join(stateDir, "routes.json"), tailscale: tailscale.cli, get: viaGateway(() => `http://127.0.0.1:${gatewayPort}`).get },
    hostBridge: fixture.hostBridge,
  });
  port = probe.port;
  client ??= connectProbe(node, "127.0.0.1", probeId, { port, whois: async () => probeId });
}

/** The record lives in memory, and one node means nothing can be fetched from a peer. */
async function tickOnce(): Promise<PlanStep> {
  return tick(pylon, {
    probe: client,
    observation: await snapshot(client),
    holders: () => [],
    artifactSha256: (id) => { throw new Error(`no node holds ${id}, so it has no recorded sha256`); },
    save() {},
  });
}

/** Ticks until the planner says done. Returns every step, so tests can see what was sent. */
async function converge(timeoutMs = fixture.convergeMs): Promise<PlanStep[]> {
  const steps: PlanStep[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const step = await tickOnce();
    steps.push(step);
    if (step.kind === "done") return steps;
    if (step.kind === "fail") throw new Error(`planner gave up: ${step.reason}`);
    if (Date.now() > deadline) throw new Error(`no convergence in ${timeoutMs} ms: ${JSON.stringify(steps.slice(-5))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const submitted = (steps: PlanStep[]) => steps.flatMap((s) => s.kind === "submit" ? [s.job.kind] : []);
const listed = async (): Promise<BackendPylon | undefined> => (await backend.list()).find((p) => p.pylonId === pylonId);
const inGuest = (script: string) => backend.guest(pylonId).exec(["sh", "-c", script], { cwd: fixture.cwd, timeoutMs: 30_000 });

async function assertPaused(checkpoint: CheckpointId) {
  const p = await listed();
  assert.equal(p?.vm, "stopped");
  assert.equal(p.checkpoint, checkpoint);
  await fixture.assertStored(checkpoint);
}

/** A browser's visit to a published preview, as `tailscale serve` hands it to the gateway after TLS. */
function visit(httpsPort: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: gatewayPort, headers: { host: `${nodeHost}:${httpsPort}`, accept: "application/json" } }, async (res) => {
      let text = "";
      for await (const chunk of res) text += chunk;
      resolve({ status: res.statusCode!, body: res.statusCode === 200 ? JSON.parse(text) : text });
    }).on("error", reject).end();
  });
}

/** What the slice's web service answers: its PUBLIC_URL, the Host it was sent, and the user it runs as. */
const served = (httpsPort: number) => ({ status: 200, body: { publicUrl: `https://${nodeHost}:${httpsPort}`, host: `${nodeHost}:${httpsPort}`, user: fixture.serviceUser } });

const web: PreviewAssignment = { service: "web", httpsPort: 10100 };
const serviceFiles: OverlayFile[] = [
  {
    path: `${checkoutDir}/.nexus/services.yaml`, mode: 0o644, owner: "user",
    content: "services:\n  web:\n    command: python3 -u .nexus/slice-web.py\n    port: 8000\n    preview: true\n    health: /\n",
  },
  {
    path: `${checkoutDir}/.nexus/slice-web.py`, mode: 0o644, owner: "user",
    content: [
      "import http.server, json, os, pwd",
      "class Handler(http.server.BaseHTTPRequestHandler):",
      "    def do_GET(self):",
      '        body = json.dumps({"publicUrl": os.environ.get("PUBLIC_URL"), "host": self.headers.get("host"), "user": pwd.getpwuid(os.getuid()).pw_name}).encode()',
      "        self.send_response(200)",
      '        self.send_header("content-type", "application/json")',
      '        self.send_header("content-length", str(len(body)))',
      "        self.end_headers()",
      "        self.wfile.write(body)",
      'http.server.ThreadingHTTPServer(("", int(os.environ["PORT"])), Handler).serve_forever()',
      "",
    ].join("\n"),
  },
];

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "nexus-slice-probe-"));
  const free = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => free.once("listening", resolve));
  gatewayPort = (free.address() as { port: number }).port;
  await new Promise((resolve) => free.close(resolve));
  await fixture.setUp();
  await startTestProbe();
});

after(async () => {
  await probe?.close();
  await fixture.cleanUp();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

test("running: the planner spawns a fresh pylon from the image", async () => {
  const steps = await converge();
  assert.deepEqual(submitted(steps), ["spawn"]);
  const p = await listed();
  assert.equal(p?.vm, "running");
  assert.equal(p.checkpoint, null);
  await fixture.checkFreshBoot(backend.guest(pylonId));
  assert.deepEqual(await inGuest(`echo ${run} > ${fixture.marker}`), { exitCode: 0, output: "", truncated: false });
});

test("sessions open in the running pylon", { skip: fixture.sessions.length === 0 && "this image has no Herdr" }, async () => {
  for (const harness of fixture.sessions) {
    const opened = await client.command(pylonId, { kind: "open-session", harness, title: `slice ${harness}` });
    assert.equal(opened.kind, "open-session");
  }
  const facts = await sessionFacts(backend.guest(pylonId));
  assert.deepEqual(facts.map((f) => f.harness).sort(), [...fixture.sessions].sort());
});

test("a declared service with a preview runs with its https PUBLIC_URL and answers through the preview gateway", async () => {
  await backend.guest(pylonId).writeFiles(serviceFiles);
  pylon.live = { ...pylon.live, previews: [web] };
  pylon.liveHash = "live-slice-preview-1" as LiveHash;
  assert.deepEqual(submitted(await converge()), ["spawn"]);
  assert.deepEqual(await client.command(pylonId, { kind: "service", op: "ensure" }), {
    kind: "service", services: [{ name: "web", state: "ready", port: 8000, declared: true, wantsPreview: true }],
  });
  assert.deepEqual(await visit(web.httpsPort), served(web.httpsPort));
  const observed = (await snapshot(client))?.pylons.find((p) => p.pylonId === pylonId);
  assert.ok(observed?.phase === "running");
  assert.deepEqual(observed.services, [{ name: "web", state: "ready", port: 8000, declared: true, wantsPreview: true }], "the observation reports the service");
});

test("the same envelope twice gives the same status back", async () => {
  const env = envelope({ kind: "spawn", pylonId, boot: { ...pylon.boot, source: pylon.firstBoot }, live: pylon.live, liveHash: pylon.liveHash }, node, Date.now());
  const first = await client.submit(env);
  const second = await client.submit(env);
  assert.ok("accepted" in first && "accepted" in second);
  assert.equal(second.accepted.jobId, first.accepted.jobId);
  let status = await client.job(env.jobId);
  while (status !== "unknown" && status.state === "running") status = await client.job(env.jobId);
  assert.ok(status !== "unknown" && status.state === "succeeded", JSON.stringify(status));
  assert.deepEqual(await client.submit(env), { accepted: status });
  assert.deepEqual(await client.submit(env), { accepted: status });
});

test("an expired envelope is rejected", async () => {
  const env = envelope({ kind: "pause", pylonId, checkpoint: nextCheckpoint(pylon) }, node, Date.now() - 31_000);
  assert.deepEqual(await client.submit(env), { rejected: "expired" });
  assert.equal(await client.job(env.jobId), "unknown");
  assert.equal((await listed())?.vm, "running");
});

test("paused: the VM is gone and its checkpoint is stored", async () => {
  pylon.desired = "paused";
  const checkpoint = nextCheckpoint(pylon);
  assert.deepEqual(submitted(await converge()), ["pause"]);
  await assertPaused(checkpoint);
  assert.equal((await visit(web.httpsPort)).status, 503, "a paused pylon keeps its preview, which shows the waking page");
});

test("running again: resumes from the checkpoint with the marker intact and the new boot inputs applied", async () => {
  pylon.desired = "running";
  pylon.boot = { ...pylon.boot, ...fixture.wake() };
  assert.deepEqual(submitted(await converge()), ["spawn"]);
  const p = await listed();
  assert.equal(p?.vm, "running");
  assert.equal(p.checkpoint, `ckpt-${thread}-1`);
  assert.deepEqual(await inGuest(`cat ${fixture.marker}`), { exitCode: 0, output: `${run}\n`, truncated: false });
  await fixture.checkWake(backend.guest(pylonId));
  assert.deepEqual(await visit(web.httpsPort), served(web.httpsPort), "the wake started the service again");
});

test("the sessions open before the pause come back after the wake", { skip: fixture.sessions.length === 0 && "this image has no Herdr" }, async () => {
  const guest = backend.guest(pylonId);
  assert.deepEqual((await sessionFacts(guest)).map((f) => f.harness).sort(), [...fixture.sessions].sort());
  const file = await guest.exec(["cat", sessionsFile], { cwd: "/", timeoutMs: 10_000 });
  assert.deepEqual(JSON.parse(file.output).failed, [], "no session is left to retry");
  const log = await fixture.pylonLog();
  for (const harness of fixture.sessions) {
    const session = `"slice ${harness}" \\(${harness}\\)`;
    assert.match(log, new RegExp(`^sessions: (relaunched ${session} in |${session} was already running in )`, "m"));
  }
});

test("the in-pylon CLI reaches the probe through the host bridge, and a declared output reaches the observation", async () => {
  const pylonJson = renderOverlay({
    pylonId, threadId: thread, project: "slice" as ProjectId, node, allowedHosts: [], previews: [], logins: [],
    dotfiles: { repo: "https://example.com/dotfiles.git", ref: "main" }, repo: { kind: "empty", branch: "main" }, secrets: [],
  }).find((f) => f.path === pylonInfoFile)!.content;
  await fixture.installCli(pylonJson);
  const nexus = async (...args: string[]) => {
    const { exitCode, output } = await backend.guest(pylonId).exec(["nexus", ...args, "--json"], { cwd: fixture.cwd, timeoutMs: 30_000 });
    assert.equal(exitCode, 0, `nexus ${args.join(" ")}: ${output}`);
    return JSON.parse(output) as unknown;
  };
  assert.deepEqual(await nexus("info"), JSON.parse(pylonJson));
  // A guest that names another pylon in the bridge's own header is still answered as itself.
  const spoofed = `fetch((process.env.NEXUS_API || "http://nexus.pylon") + "/v1/request", { method: "POST", headers: { "x-nexus-pylon": "pylon-other", "content-type": "application/json" }, body: JSON.stringify({ op: "info" }) }).then(async (r) => console.log(r.status, (await r.json()).pylonId))`;
  assert.deepEqual(await backend.guest(pylonId).exec(["node", "-e", spoofed], { cwd: fixture.cwd, timeoutMs: 30_000 }), { exitCode: 0, output: `200 ${pylonId}\n`, truncated: false });
  assert.deepEqual(await inGuest(`printf 'shot' > ${fixture.cwd}/shot.txt`), { exitCode: 0, output: "", truncated: false });
  const { output } = await nexus("output", "add", "file", "shot.txt", "--title", "Shot") as { output: DeclaredOutput };
  assert.deepEqual(output, { id: output.id, kind: "file", path: posix.join(fixture.cwd, "shot.txt"), title: "Shot", sha256: createHash("sha256").update("shot").digest("hex") });
  assert.deepEqual(await nexus("output", "list"), { outputs: [output] });
  const observed = (await snapshot(client))?.pylons.find((p) => p.pylonId === pylonId);
  assert.ok(observed?.phase === "running");
  assert.deepEqual(observed.declaredOutputs, [output]);
});

test("a probe restart makes the planner re-send spawn, which leaves the running VM alone", async () => {
  const before = (await listed())?.bootedAt;
  assert.ok(before);
  await probe.close();
  await startTestProbe();
  const steps = await converge();
  assert.equal(steps[0]?.kind, "submit");
  assert.deepEqual(submitted(steps), ["spawn"]);
  assert.equal((await listed())?.bootedAt, before);
  assert.deepEqual(await inGuest(`cat ${fixture.marker}`), { exitCode: 0, output: `${run}\n`, truncated: false });
});

test("a new preview port restarts the service with the PUBLIC_URL on it", async () => {
  const moved: PreviewAssignment = { service: "web", httpsPort: 10101 };
  pylon.live = { ...pylon.live, previews: [moved] };
  pylon.liveHash = "live-slice-preview-2" as LiveHash;
  assert.deepEqual(submitted(await converge()), ["spawn"]);
  assert.deepEqual(await visit(moved.httpsPort), served(moved.httpsPort));
  assert.equal((await visit(web.httpsPort)).status, 404, "the old port is no longer published");
});

test("a changed overlay is written into the running pylon", { skip: fixture.overlay === null && "this backend writes no overlay" }, async () => {
  const before = (await listed())?.bootedAt;
  pylon.live = { ...pylon.live, overlay: fixture.overlay!(2) };
  pylon.liveHash = "live-slice-2" as LiveHash;
  assert.deepEqual(submitted(await converge()), ["spawn"]);
  assert.equal((await listed())?.bootedAt, before);
  await fixture.checkOverlay(backend.guest(pylonId), 2);
});

test("a probe killed during a pause: the next ticks finish the pause", async () => {
  await probe.close();
  const stopped = Promise.withResolvers<void>();
  await startTestProbe({
    ...backend,
    async ensurePaused(_id, checkpoint, signal) {
      await fixture.partialPause(checkpoint);
      stopped.resolve();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  pylon.desired = "paused";
  const checkpoint = nextCheckpoint(pylon);
  const first = await tickOnce();
  assert.ok(first.kind === "submit" && first.job.kind === "pause");
  await stopped.promise;
  await probe.close();

  await startTestProbe();
  const steps = await converge();
  assert.deepEqual(submitted(steps), fixture.partialPauseResubmits ? ["pause"] : []);
  await assertPaused(checkpoint);
});

test("deleted: nothing of the pylon remains", async () => {
  pylon.desired = "deleted";
  assert.deepEqual(submitted(await converge()), ["delete"]);
  assert.equal(await listed(), undefined);
  await fixture.assertNothingRemains();
});
