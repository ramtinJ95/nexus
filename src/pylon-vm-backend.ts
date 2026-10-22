/**
 * The pylon VM backend: one pylon-vm instance per pylon, named after the pylon ID, driven through the fork's
 * `run`. Every answer comes from the instance directories and their detached controllers, so a probe restart
 * loses nothing.
 *
 * A pi-sandbox instance has a single disk, which every completed stop rewrites (disk.next.qcow2, then a
 * rename). A CheckpointId names that disk as the pause that wrote it, in a sidecar file in the instance
 * directory that list() reads back. ensurePaused writes the ID as `pausing` before it stops the VM and
 * moves it to `checkpoint` after, so a probe that dies between the two still reports a stopped disk under
 * the pause that wrote it. A resume boots whatever disk the instance holds. Checkpoints therefore exist
 * only on their own node, one per pylon.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { JobFailure, type ArtifactStore, type BackendPylon, type Guest, type SecretSource, type VmBackend } from "./backend.ts";
import type { BootInputs, LiveSpec } from "./project.ts";
import type { PylonId } from "./protocol.ts";
import type { ArtifactId, CheckpointId, ImageId } from "./images.ts";
import { controlSocket, run, socketPathLimit } from "./pylon-vm/client.ts";
import { statusSchema, type BootSpec, type SandboxConfig } from "./pylon-vm/contracts.ts";
import { directory, existsError, readRecord, saveJson, shellQuote as q } from "./pylon-vm/storage.ts";

export interface PylonVmBackendOptions {
  /**
   * A private directory for instances. Each instance's control socket lives under it, so it may be at most
   * 39 bytes long (checked at creation). /var/lib/nexus/pylons gives an 85-byte socket path at most.
   */
  stateRoot: string;
  /** The Gondolin asset directory (manifest.json, kernel, initramfs, rootfs) that each image ID names. */
  images: Readonly<Record<ImageId, string>>;
  /**
   * Read at every boot and handed to the instance's controller on its stdin, so no value is written to the
   * instance directory, the controller's log or the guest. The guest sees placeholders, which the host swaps
   * for values only in requests to the grant's hosts. A granted host that echoes a credential back in its
   * response still shows the value to the guest, so grant only hosts that do not reflect credentials.
   */
  secrets: SecretSource;
  /**
   * The node's git SSH identity, for SSH repository and dotfiles URLs. Gondolin terminates the guest's SSH on
   * this host and authenticates upstream with this key, so the key never enters a pylon. Upstream host keys
   * are checked against knownHostsFile. Without it, a node boots only pylons whose remotes are HTTPS.
   * SSH egress is not governed by the allowlist: it reaches only the pylon's own repository and dotfiles
   * remotes, and only to fetch from and push to them.
   */
  gitSsh?: { privateKeyFile: string; knownHostsFile: string };
}

const workspace = "/home/user/workspace";
const repoDir = `${workspace}/repo`;
const dotfilesDir = "/home/user/.nexus/dotfiles";
/** Where the image bakes the common dotfiles layer, as a git repository owned by user. */
const bakedDotfiles = "/opt/nexus/dotfiles";
const imageLabel = "nexus.image";
const checkpointFile = "nexus-checkpoint.json";
const pollMs = 500;
/** Measured in the pylon-vm slice: 3 GiB boots, 4, 8, 12 and 16 GiB pass the whole slice, and 2 GiB hangs at "ACPI: Core revision". */
const minMemoryGiB = 3;
/** The pi-sandbox instance name limit, which PylonId keeps to. */
const maxPylonIdLength = 40;

const instanceSchema = z.object({ name: z.string(), labels: z.record(z.string(), z.string()), status: statusSchema });
type Instance = z.infer<typeof instanceSchema>;
const execReplySchema = z.object({
  pid: z.string(),
  running: z.boolean(),
  output: z.string(),
  exitCode: z.number().int().optional(),
  truncated: z.boolean().optional(),
});
const checkpointId = z.custom<CheckpointId>((v) => typeof v === "string" && v.startsWith("ckpt-"));
const sidecarSchema = z.strictObject({ checkpoint: checkpointId.nullable(), pausing: checkpointId.optional() });
type Sidecar = z.infer<typeof sidecarSchema>;

/** The pi-sandbox instance name rule. Pylon IDs are kept within it (see PylonId). */
function instanceName(pylonId: PylonId): string {
  if (!new RegExp(`^[a-z][a-z0-9-]{0,${maxPylonIdLength - 1}}$`).test(pylonId)) throw new JobFailure("invalid", `pylon ID ${pylonId} is not a valid pylon-vm instance name`);
  return pylonId;
}

/** A login shell as `user`, in `cwd`. The fork runs guest commands as root. */
const asUser = (script: string, cwd: string) => `runuser -l user -c ${q(`cd ${q(cwd)} && ${script}`)}`;

type SshRemote = NonNullable<BootSpec["ssh"]>["remotes"][number];

/**
 * `[user@]host:path` (git's scp-like form: a colon before any slash), `ssh://[user@]host[:port]/path`, or HTTPS.
 * The path is kept as git sends it: git percent-decodes an ssh:// path and drops its slash before `~`.
 */
function sshRemoteOf(url: string): SshRemote | null {
  if (url.startsWith("https://")) return null;
  if (url.startsWith("ssh://")) {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), port: u.port === "" ? 22 : Number(u.port), username: decodeURIComponent(u.username) || "git", repo: decodeURIComponent(u.pathname).replace(/^\/~/, "~") };
  }
  const scp = /^(?:([^@/:]+)@)?([^@/:]+):(?!\/\/)(.+)$/.exec(url);
  if (scp === null) throw new JobFailure("invalid", `${url} is neither an SSH nor an HTTPS git URL`);
  return { host: scp[2]!.toLowerCase(), port: 22, username: scp[1] ?? "git", repo: scp[3]! };
}

/**
 * Gondolin holds one credential per host and port, and its git command parser fails closed on a repository
 * path without an owner (`org/repo`), so both are refused here instead of failing later inside the guest.
 */
function checkSshRemotes(pylonId: PylonId, remotes: readonly SshRemote[]): void {
  for (const r of remotes) {
    if (!r.repo.replace(/^(?:~\/|\/)+/, "").includes("/")) throw new JobFailure("invalid", `${pylonId}: ${r.host}:${r.repo} has no owner in its path, and git over SSH takes only owner/name paths`);
    const other = remotes.find((o) => o.host === r.host && o.port === r.port && o.username !== r.username);
    if (other !== undefined) throw new JobFailure("invalid", `${pylonId}: ${r.host}:${r.port} is used as ${r.username} and as ${other.username}, and one node key logs in as one user per host`);
  }
}

/**
 * Every boot, as user, before setup or resume. A failed or slow pull keeps what the disk has, which is the
 * image's baked copy until a pull succeeds. Then the layer's install runs and Herdr's integrations are
 * reinstalled. Each step's outcome (pull, install, Herdr) is one `dotfiles:` or `herdr:` line in the controller log, and none fails the
 * boot. The fetch has its own limit, so the fork's 120 s hook deadline never cuts off what follows it.
 */
function dotfilesPull({ repo, ref }: BootInputs["dotfiles"]): string {
  const at = `$(git -C ${dotfilesDir} rev-parse --short HEAD 2>/dev/null || echo nothing)`;
  return asUser([
    `test -d ${dotfilesDir}/.git || git clone --quiet ${bakedDotfiles} ${dotfilesDir} || git init --quiet ${dotfilesDir}`,
    `if timeout 60 git -C ${dotfilesDir} fetch --quiet --depth 1 ${q(repo)} ${q(ref)} && git -C ${dotfilesDir} checkout --quiet --detach FETCH_HEAD`,
    `then echo ${q(`dotfiles: pulled ${repo} ${ref} at`)} "${at}"`,
    `else echo ${q(`dotfiles: the pull of ${repo} ${ref} failed, keeping`)} "${at}"`,
    "fi",
    `if ! test -x ${dotfilesDir}/install; then echo 'dotfiles: no install script'`,
    `elif (cd ${dotfilesDir} && ./install); then echo 'dotfiles: installed'`,
    `else echo "dotfiles: install exited $?"; fi`,
    // The layer's install may replace ~/.claude and ~/.pi/agent files that hold Herdr's hooks, which report session IDs.
    "if ! command -v herdr >/dev/null; then echo 'herdr: not installed, integrations skipped'",
    "elif herdr integration install pi && herdr integration install claude; then echo 'herdr: reinstalled the pi and claude integrations'",
    "else echo 'herdr: reinstalling the pi and claude integrations failed'; fi",
  ].join("\n"), "/home/user");
}

/** Runs as root from the workspace once, inside the instance's controller, on a fresh disk. 20-minute limit. */
function setupCommands(boot: BootInputs, preSetup: string | null): string[] {
  const { url, checkout } = boot.repo;
  return [
    `chown user:user ${q(workspace)}`,
    asUser(`git clone --no-checkout ${q(url)} ${q(repoDir)} && git -C ${q(repoDir)} checkout -B ${q(checkout.branch)} ${q(checkout.commit)}`, workspace),
    ...(preSetup === null ? [] : [asUser(`bash -c ${q(preSetup)}`, repoDir)]),
    asUser("if test -e .nexus/setup; then ./.nexus/setup; fi", repoDir),
  ];
}

export function createPylonVmBackend(options: PylonVmBackendOptions): VmBackend {
  const { stateRoot } = options;
  const longest = controlSocket(directory(stateRoot, "instances", "p".repeat(maxPylonIdLength)));
  if (Buffer.byteLength(longest) >= socketPathLimit) {
    throw new Error(`state root ${stateRoot} is too long: a pylon's control socket would be ${Buffer.byteLength(longest)} bytes, and a Unix socket path must stay under ${socketPathLimit}`);
  }
  const sandbox = (action: Record<string, unknown>, signal?: AbortSignal) => run(stateRoot, action, signal);
  const instanceDir = (pylonId: PylonId) => directory(stateRoot, "instances", pylonId);

  async function inspect(pylonId: PylonId): Promise<Instance | null> {
    const name = instanceName(pylonId);
    if (!existsSync(instanceDir(pylonId))) return null;
    return instanceSchema.parse(await sandbox({ action: "inspect", name }));
  }

  /** Waits out a controller that is starting or stopping. Never cuts one short: the deadline only ends the wait. */
  async function settled(pylonId: PylonId, signal: AbortSignal): Promise<Instance | null> {
    for (;;) {
      signal.throwIfAborted();
      const instance = await inspect(pylonId);
      if (instance === null || !["starting", "unavailable", "stopping"].includes(instance.status.state)) return instance;
      await delay(pollMs, undefined, { signal });
    }
  }

  async function readSidecar(pylonId: PylonId): Promise<Sidecar> {
    try {
      return sidecarSchema.parse(JSON.parse(await readFile(join(instanceDir(pylonId), checkpointFile), "utf8")));
    } catch (err) {
      if (existsError(err, "ENOENT")) return { checkpoint: null };
      throw err;
    }
  }
  const writeSidecar = (pylonId: PylonId, sidecar: Sidecar) => saveJson(join(instanceDir(pylonId), checkpointFile), sidecar);

  /** Before a boot. A pause that reached stopped wrote its checkpoint. Any other pending pause did not. */
  async function settleSidecar(pylonId: PylonId, stopped: boolean): Promise<void> {
    const { checkpoint, pausing } = await readSidecar(pylonId);
    if (pausing !== undefined) await writeSidecar(pylonId, { checkpoint: stopped ? pausing : checkpoint });
  }

  function assetsOf(boot: BootInputs): string {
    const assets = options.images[boot.image];
    if (assets === undefined) throw new JobFailure("artifact-missing", `no Gondolin assets are configured for ${boot.image}`);
    if (!existsSync(join(assets, "manifest.json"))) throw new JobFailure("artifact-missing", `${assets} holds no Gondolin image for ${boot.image}`);
    return assets;
  }

  async function gitSshOf(pylonId: PylonId, remotes: SshRemote[]): Promise<BootSpec["ssh"]> {
    if (remotes.length === 0) return null;
    checkSshRemotes(pylonId, remotes);
    const { gitSsh } = options;
    const named = remotes.map((r) => `${r.host}:${r.repo}`).join(", ");
    if (gitSsh === undefined) throw new JobFailure("secret-missing", `${pylonId} uses ${named} over SSH, and this node has no git SSH key`);
    if (!existsSync(gitSsh.knownHostsFile)) throw new JobFailure("secret-missing", `${pylonId} uses ${named} over SSH, and this node's known_hosts file ${gitSsh.knownHostsFile} is missing`);
    try {
      return { privateKey: await readFile(gitSsh.privateKeyFile, "utf8"), knownHostsFile: gitSsh.knownHostsFile, remotes };
    } catch (err) {
      throw new JobFailure("secret-missing", `${pylonId} uses ${named} over SSH, and this node's git SSH key ${gitSsh.privateKeyFile} is unreadable: ${(err as Error).message}`);
    }
  }

  /** Everything a boot applies. Built only when a VM is about to boot, because a running VM ignores boot inputs. */
  async function bootSpec(boot: BootInputs, live: LiveSpec): Promise<BootSpec> {
    if (boot.resources.memoryGiB < minMemoryGiB) {
      throw new JobFailure("invalid", `${boot.pylonId} asks for ${boot.resources.memoryGiB} GiB, but pylon VMs need at least ${minMemoryGiB} GiB: a 2 GiB Gondolin 0.13.0 guest hangs at boot on infra-testbench`);
    }
    const secrets: BootSpec["secrets"] = {};
    for (const grant of boot.network.secrets) {
      const value = options.secrets.value(grant.name);
      if (value === undefined) throw new JobFailure("secret-missing", `secret ${grant.name} is not in this node's secret file`);
      secrets[grant.name] = { hosts: [...grant.hosts], value };
    }
    const remotes = [boot.repo.url, boot.dotfiles.repo].flatMap((url) => sshRemoteOf(url) ?? []);
    return {
      resources: { cpus: boot.resources.cpus, memoryGiB: boot.resources.memoryGiB },
      allowedHosts: [...boot.network.allowedHosts],
      secrets,
      ssh: await gitSshOf(boot.pylonId, remotes),
      files: [...live.overlay],
      hooks: [dotfilesPull(boot.dotfiles)],
    };
  }

  async function create(boot: BootInputs, live: LiveSpec, signal: AbortSignal): Promise<void> {
    let preSetup: string | null;
    switch (boot.source.kind) {
      case "resume":
        throw new JobFailure("artifact-missing", `checkpoint ${boot.source.checkpoint} of ${boot.pylonId} is not on this node`);
      case "template":
        throw new JobFailure("invalid", "the pylon VM backend does not boot from templates: not implemented yet");
      case "fresh":
        preSetup = boot.source.preSetup;
        break;
    }
    const config: SandboxConfig = {
      version: 1,
      diskGiB: boot.resources.diskGiB,
      image: assetsOf(boot),
      workspace,
      setup: setupCommands(boot, preSetup),
      // The fork runs resume on every boot that did not run setup.
      resume: [asUser("if test -e .nexus/resume; then ./.nexus/resume; fi", repoDir)],
      services: {},
    };
    const spec = await bootSpec(boot, live);
    await sandbox({ action: "create", name: instanceName(boot.pylonId), config, boot: spec, labels: { [imageLabel]: boot.image } }, signal);
  }

  /** CPUs, memory, the allowlist, secrets and SSH remotes apply at every boot. The image and the disk size are fixed at create. */
  async function refuseFixedChanges(boot: BootInputs, instance: Instance): Promise<void> {
    const created = instance.labels[imageLabel];
    if (created !== boot.image) throw new JobFailure("invalid", `${boot.pylonId} was created from ${created} and cannot boot ${boot.image}: a pylon keeps its image`);
    const { config } = await readRecord(instanceDir(boot.pylonId));
    if (config.diskGiB !== boot.resources.diskGiB) {
      throw new JobFailure("invalid", `${boot.pylonId} has a ${config.diskGiB} GiB disk and cannot boot with ${boot.resources.diskGiB} GiB: a pylon's disk size is fixed when it is created`);
    }
  }

  /** Runs a create or start. A setup failure leaves the VM running with a startupError, which the caller reports. */
  async function boot(pylonId: PylonId, start: () => Promise<unknown>, signal: AbortSignal): Promise<void> {
    try {
      await start();
    } catch (err) {
      if (signal.aborted) throw err;
      const after = await inspect(pylonId);
      if (after?.status.state !== "running" || after.status.startupError === undefined) throw err;
    }
  }

  function vmState(instance: Instance): Pick<BackendPylon, "vm" | "detail"> {
    const { status } = instance;
    switch (status.state) {
      case "starting": case "unavailable": return { vm: "booting" };
      case "running":
        return status.startupError === undefined ? { vm: "running" } : { vm: "broken", detail: status.startupError };
      case "stopping": return { vm: "stopping" };
      case "stopped": return { vm: "stopped" };
      case "interrupted": return { vm: "broken", detail: status.recovery ?? "the controller exited without completing a stop" };
      case "failed": return { vm: "broken", detail: "the controller failed to boot the VM. Read controller.log in the instance directory" };
      case "prepared": throw new Error(`instance ${instance.name} is a prepared template, which is never a pylon`);
    }
  }

  async function list(): Promise<BackendPylon[]> {
    const instances = z.array(instanceSchema).parse(await sandbox({ action: "list", kind: "instances" }));
    return Promise.all(instances.map(async (instance) => {
      const pylonId = instance.name as PylonId;
      const image = instance.labels[imageLabel];
      if (image === undefined) throw new Error(`instance ${pylonId} in ${stateRoot} has no ${imageLabel} label, so this backend did not create it`);
      const state = vmState(instance);
      const sidecar = await readSidecar(pylonId);
      return {
        pylonId,
        ...state,
        checkpoint: state.vm === "stopped" ? sidecar.pausing ?? sidecar.checkpoint : sidecar.checkpoint,
        image: image as ImageId,
        bootedAt: state.vm === "running" ? instance.status.bootedAt ?? null : null,
      };
    }));
  }

  const artifacts: ArtifactStore = {
    async list() {
      const images = Object.entries(options.images).flatMap(([id, assets]) => existsSync(join(assets, "manifest.json")) ? [id as ImageId] : []);
      // A running pylon's disk has moved on from the checkpoint it booted from, so only stopped disks count.
      const checkpoints = (await list()).flatMap((p) => p.vm === "stopped" && p.checkpoint !== null ? [p.checkpoint] : []);
      return [...images, ...checkpoints] satisfies ArtifactId[];
    },
    export() { return Promise.reject(new Error("the pylon VM backend does not export artifacts yet")); },
    import() { return Promise.reject(new Error("the pylon VM backend does not import artifacts yet")); },
    drop() { return Promise.reject(new Error("the pylon VM backend does not drop artifacts yet")); },
  };

  return {
    artifacts,
    list,

    async ensureRunning(bootInputs, live, signal) {
      const { pylonId } = bootInputs;
      const name = instanceName(pylonId);
      for (;;) {
        const instance = await settled(pylonId, signal);
        if (instance === null) {
          await boot(pylonId, () => create(bootInputs, live, signal), signal);
          continue;
        }
        switch (instance.status.state) {
          case "running":
            if (instance.status.startupError !== undefined) throw new JobFailure("setup-failed", `${pylonId}: ${instance.status.startupError}`);
            // A boot wrote the overlay before its hooks ran. A running VM gets it again in case it changed.
            await sandbox({ action: "write-files", name, files: live.overlay }, signal);
            return;
          // The instance holds the pylon's newest disk whatever the boot source says, so it is started as it is.
          case "stopped": case "interrupted": case "failed": {
            await refuseFixedChanges(bootInputs, instance);
            const spec = await bootSpec(bootInputs, live);
            await settleSidecar(pylonId, instance.status.state === "stopped");
            await boot(pylonId, () => sandbox({ action: "start", name, boot: spec }, signal), signal);
            continue;
          }
          default:
            throw new Error(`instance ${pylonId} is ${instance.status.state}, which ensureRunning cannot start`);
        }
      }
    },

    async ensurePaused(pylonId, checkpoint, signal) {
      const name = instanceName(pylonId);
      for (let instance = await settled(pylonId, signal); instance?.status.state !== "stopped"; instance = await settled(pylonId, signal)) {
        if (instance === null) return;
        signal.throwIfAborted();
        await writeSidecar(pylonId, { checkpoint: (await readSidecar(pylonId)).checkpoint, pausing: checkpoint });
        switch (instance.status.state) {
          // A running VM checkpoints its disk. One whose controller died settles on its last completed checkpoint.
          case "running": case "interrupted": case "failed":
            try {
              await sandbox({ action: "stop", name });
            } catch (err) {
              throw new JobFailure("checkpoint-failed", `${pylonId}: ${(err as Error).message}`);
            }
            break;
          default:
            throw new Error(`instance ${pylonId} is ${instance.status.state}, which ensurePaused cannot stop`);
        }
      }
      const sidecar = await readSidecar(pylonId);
      if (sidecar.checkpoint !== checkpoint || sidecar.pausing !== undefined) await writeSidecar(pylonId, { checkpoint });
    },

    async ensureDeleted(pylonId, signal) {
      const name = instanceName(pylonId);
      await settled(pylonId, signal);
      signal.throwIfAborted();
      // Also when absent, because destroy sweeps what an interrupted create or destroy left aside.
      await sandbox({ action: "destroy", kind: "instances", name, confirm: name });
    },

    buildTemplate() { return Promise.reject(new Error("the pylon VM backend does not build templates yet")); },

    guest(pylonId): Guest {
      const name = instanceName(pylonId);
      const notYet = (member: string) => () => { throw new Error(`the pylon VM backend has no Guest.${member} yet`); };
      return {
        async exec(argv, { cwd, timeoutMs }) {
          const deadline = Date.now() + timeoutMs;
          // The fork waits at most 60 s per call, and a wait never kills the command.
          const wait = () => Math.max(0, Math.min(60_000, deadline - Date.now()));
          const cmd = asUser(argv.map(q).join(" "), cwd);
          let reply = execReplySchema.parse(await sandbox({ action: "exec", name, cmd, cwd: "/", timeoutMs: wait() }));
          let output = reply.output;
          while (reply.running) {
            if (Date.now() >= deadline) {
              await sandbox({ action: "exec-kill", name, pid: reply.pid });
              return { exitCode: null, output, truncated: reply.truncated ?? false };
            }
            reply = execReplySchema.parse(await sandbox({ action: "exec-status", name, pid: reply.pid, timeoutMs: wait() }));
            output += reply.output;
          }
          if (reply.exitCode === undefined) throw new Error(`exec in ${pylonId} finished without an exit code`);
          return { exitCode: reply.exitCode, output, truncated: reply.truncated ?? false };
        },
        stream: notYet("stream"),
        async writeFiles(files) {
          await sandbox({ action: "write-files", name, files });
        },
        services: notYet("services"),
        linkPort: notYet("linkPort"),
        previewOrigin: notYet("previewOrigin"),
      };
    },
  };
}
