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
import { artifactDirectory, manifestFiles, tarCodec } from "./artifacts.ts";
import { JobFailure, type ArtifactStore, type BackendPylon, type Guest, type SecretSource, type VmBackend } from "./backend.ts";
import { buildImage as buildPylonImage } from "./image-build.ts";
import type { BootInputs, LiveSpec } from "./project.ts";
import { isImageId, isTemplateId, type PylonId } from "./protocol.ts";
import { imageIdOf, type ArtifactId, type CheckpointId, type ImageId, type PortableArtifactId, type TemplateId, type TemplateManifest } from "./images.ts";
import * as templates from "./pylon-vm-templates.ts";
import { publicUrls } from "./public-urls.ts";
import { recordBeforePause, relaunchAfterWake } from "./session-wake.ts";
import { controlSocket, run, socketPathLimit } from "./pylon-vm/client.ts";
import { statusSchema, type BootSpec, type SandboxConfig } from "./pylon-vm/contracts.ts";
import { hostBridgeSocket } from "./pylon-vm/host-bridge.ts";
import { asUser, controllerLog, pylonGuest } from "./pylon-vm/pylon-guest.ts";
import { directory, existsError, readRecord, saveJson, shellQuote as q } from "./pylon-vm/storage.ts";

export interface PylonVmBackendOptions {
  /**
   * A private directory for instances. Each instance's control socket lives under it, so it may be at most
   * 39 bytes long (checked at creation). /var/lib/nexus/pylons gives an 85-byte socket path at most.
   */
  stateRoot: string;
  /**
   * The artifact store (artifacts.ts), at the same path on every node. Each image is <artifacts>/<image ID>/, a
   * Gondolin asset directory with its image.json, and each template is <artifacts>/<template ID>/.
   */
  artifacts: string;
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
  /** The node's tailnet DNS name, which previews are published on. Each previewed service's PUBLIC_URL is on it. */
  previewHost?: string;
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
const checkpointId = z.custom<CheckpointId>((v) => typeof v === "string" && v.startsWith("ckpt-"));
/** `relaunch` is set before a boot from the instance's own disk and cleared once its sessions are relaunched. */
const sidecarSchema = z.strictObject({ checkpoint: checkpointId.nullable(), pausing: checkpointId.optional(), relaunch: z.literal(true).optional() });
type Sidecar = z.infer<typeof sidecarSchema>;

/** The pi-sandbox instance name rule. Pylon IDs are kept within it (see PylonId). */
function instanceName(pylonId: PylonId): string {
  if (!new RegExp(`^[a-z][a-z0-9-]{0,${maxPylonIdLength - 1}}$`).test(pylonId)) throw new JobFailure("invalid", `pylon ID ${pylonId} is not a valid pylon-vm instance name`);
  return pylonId;
}

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
function checkSshRemotes(subject: string, remotes: readonly SshRemote[]): void {
  for (const r of remotes) {
    if (!r.repo.replace(/^(?:~\/|\/)+/, "").includes("/")) throw new JobFailure("invalid", `${subject}: ${r.host}:${r.repo} has no owner in its path, and git over SSH takes only owner/name paths`);
    const other = remotes.find((o) => o.host === r.host && o.port === r.port && o.username !== r.username);
    if (other !== undefined) throw new JobFailure("invalid", `${subject}: ${r.host}:${r.port} is used as ${r.username} and as ${other.username}, and one node key logs in as one user per host`);
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

/** Runs as root from the workspace once, inside the instance's or template build's controller, on a fresh disk. 20-minute limit. */
function setupCommands(url: string, checkout: BootInputs["repo"]["checkout"], preSetup: string | null): string[] {
  return [
    `chown user:user ${q(workspace)}`,
    asUser(`git clone --no-checkout ${q(url)} ${q(repoDir)} && git -C ${q(repoDir)} checkout -B ${q(checkout.branch)} ${q(checkout.commit)}`, workspace),
    ...(preSetup === null ? [] : [asUser(`bash -c ${q(preSetup)}`, repoDir)]),
    asUser("if test -e .nexus/setup; then ./.nexus/setup; fi", repoDir),
  ];
}

/** The setup of a pylon booted from a template, run once: the template's clone moves to the pylon's remote and commit. */
function checkoutCommands({ url, checkout }: BootInputs["repo"]): string[] {
  return [asUser(`git remote set-url origin ${q(url)} && git fetch --quiet origin && git checkout --quiet -B ${q(checkout.branch)} ${q(checkout.commit)}`, repoDir)];
}

export function createPylonVmBackend(options: PylonVmBackendOptions): VmBackend {
  const { stateRoot } = options;
  const longest = controlSocket(directory(stateRoot, "instances", "p".repeat(maxPylonIdLength)));
  if (Buffer.byteLength(longest) >= socketPathLimit) {
    throw new Error(`state root ${stateRoot} is too long: a pylon's control socket would be ${Buffer.byteLength(longest)} bytes, and a Unix socket path must stay under ${socketPathLimit}`);
  }
  const sandbox = (action: Record<string, unknown>, signal?: AbortSignal) => run(stateRoot, action, signal);
  const store = artifactDirectory(options.artifacts, tarCodec);
  // A create, a template build or a template import depends on its image, and a create on its template, before
  // its instance, build or manifest is there for drop to see. Jobs on different subjects run at once, so the two sides shut each other out here.
  const using = new Map<PortableArtifactId, number>();
  const dropping = new Set<PortableArtifactId>();
  async function holding<T>(ids: PortableArtifactId[], work: () => Promise<T>): Promise<T> {
    const gone = ids.find((id) => dropping.has(id));
    if (gone !== undefined) throw new JobFailure("artifact-missing", `${gone} is being dropped from this node`);
    for (const id of ids) using.set(id, (using.get(id) ?? 0) + 1);
    try {
      return await work();
    } finally {
      for (const id of ids) using.set(id, using.get(id)! - 1);
    }
  }
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

  /** A published image only. Gondolin checks the assets themselves when it boots them. */
  function assetsOf(image: ImageId): string {
    const assets = store.path(image);
    if (!existsSync(join(assets, manifestFiles.image))) throw new JobFailure("artifact-missing", `${image} is not in this node's artifact store ${options.artifacts}`);
    return assets;
  }

  async function gitSshOf(subject: string, remotes: SshRemote[]): Promise<BootSpec["ssh"]> {
    if (remotes.length === 0) return null;
    checkSshRemotes(subject, remotes);
    const { gitSsh } = options;
    const named = remotes.map((r) => `${r.host}:${r.repo}`).join(", ");
    if (gitSsh === undefined) throw new JobFailure("secret-missing", `${subject} uses ${named} over SSH, and this node has no git SSH key`);
    if (!existsSync(gitSsh.knownHostsFile)) throw new JobFailure("secret-missing", `${subject} uses ${named} over SSH, and this node's known_hosts file ${gitSsh.knownHostsFile} is missing`);
    try {
      return { privateKey: await readFile(gitSsh.privateKeyFile, "utf8"), knownHostsFile: gitSsh.knownHostsFile, remotes };
    } catch (err) {
      throw new JobFailure("secret-missing", `${subject} uses ${named} over SSH, and this node's git SSH key ${gitSsh.privateKeyFile} is unreadable: ${(err as Error).message}`);
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
      publicUrls: publicUrls(boot.pylonId, live.previews, options.previewHost),
      hostBridge: hostBridgeSocket(options.stateRoot),
    };
  }

  async function create(boot: BootInputs, live: LiveSpec, signal: AbortSignal): Promise<void> {
    const needs: PortableArtifactId[] = boot.source.kind === "template" ? [boot.image, boot.source.template] : [boot.image];
    await holding(needs, async () => {
      let setup: string[];
      let disk: string | undefined;
      switch (boot.source.kind) {
        case "resume":
          throw new JobFailure("artifact-missing", `checkpoint ${boot.source.checkpoint} of ${boot.pylonId} is not on this node`);
        case "template":
          disk = await templates.templateDisk(store, boot.source.template, boot.image);
          setup = checkoutCommands(boot.repo);
          break;
        case "fresh":
          setup = setupCommands(boot.repo.url, boot.repo.checkout, boot.source.preSetup);
          break;
      }
      const config: SandboxConfig = {
        version: 1,
        diskGiB: boot.resources.diskGiB,
        image: assetsOf(boot.image),
        workspace,
        setup,
        retrySetup: boot.source.kind === "template",
        // The fork runs resume on every boot from a disk: each wake, and a template boot after its checkout.
        resume: [asUser("if test -e .nexus/resume; then ./.nexus/resume; fi", repoDir)],
        services: {},
      };
      const spec = await bootSpec(boot, live);
      await sandbox({ action: "create", name: instanceName(boot.pylonId), config, ...(disk === undefined ? {} : { disk }), boot: spec, labels: { [imageLabel]: boot.image } }, signal);
    });
  }

  /**
   * What a pylon running with a startupError fails its job with. A template boot's setup is only Nexus's
   * checkout (retrySetup), which fails for reasons that pass, such as a fetch during an outage. When that
   * checkout is what failed, on a disk that has never finished setup, no agent has run on the pylon and nothing
   * on it is the user's: the instance is removed and the job's retry boots from the template again. Every other
   * failure is final and the instance stays: a project's setup, a service, or a disk that finished setup once.
   */
  async function setupFailure(pylonId: PylonId, status: Instance["status"]): Promise<JobFailure> {
    const startupError = status.startupError ?? "";
    const { config } = await readRecord(instanceDir(pylonId));
    const checkoutFailed = config.retrySetup && status.setupRecorded === false && status.startupFailures?.some((f) => f.kind === "setup") === true;
    // The startupError only points at the controller log, which holds what setup printed, so the log travels with the failure.
    const log = await templates.controllerLogTail(instanceDir(pylonId));
    if (!checkoutFailed) return new JobFailure("setup-failed", `${pylonId}: ${startupError}`, log);
    const name = instanceName(pylonId);
    await sandbox({ action: "destroy", kind: "instances", name, confirm: name });
    return new JobFailure("backend", `${pylonId} could not check out its commit on its template's disk, so it was removed and boots from the template again: ${startupError}`, log);
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
      // A running pylon's disk has moved on from the checkpoint it booted from, so only stopped disks count.
      const checkpoints = (await list()).flatMap((p) => p.vm === "stopped" && p.checkpoint !== null ? [p.checkpoint] : []);
      return [...await store.list(), ...checkpoints] satisfies ArtifactId[];
    },
    manifest: (id) => store.manifest(id),
    export: (id) => store.export(id),
    // A template is a disk over its image, so its image is held until the template is published, where drop sees it.
    async import(manifest, stream, signal) {
      if (!isTemplateId(manifest.id)) return store.import(manifest, stream, signal);
      const { image } = (manifest as TemplateManifest).key;
      try {
        await holding([image], async () => {
          assetsOf(image);
          await store.import(manifest, stream, signal);
        });
      } finally {
        stream.destroy(); // a copy refused before it was read still holds its connection to the peer
      }
    },
    async drop(id) {
      if ((using.get(id) ?? 0) > 0) throw new JobFailure("invalid", `${id} is still needed by a pylon or template that is being created or copied in`);
      dropping.add(id);
      try {
        if (!isImageId(id)) return await store.drop(id, []);
        // Pylons and templates are qcow2 overlays on the image's rootfs. A checkpoint is its stopped pylon's disk.
        const held = await Promise.all((await store.list()).filter(isTemplateId).map((t) => store.manifest(t)));
        await store.drop(id, [
          ...(await list()).filter((p) => p.image === id).map((p) => `pylon ${p.pylonId}`),
          ...held.flatMap((t) => t?.key.image === id ? [`template ${t.id}`] : []),
          ...await templates.buildsFrom(stateRoot, id),
        ]);
      } finally {
        dropping.delete(id);
      }
    },
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
          case "running": {
            if (instance.status.startupError !== undefined) throw await setupFailure(pylonId, instance.status);
            // A boot wrote the overlay and started the services before its hooks ran. A running VM gets both
            // again in case they changed, and a changed URL restarts the services it reaches.
            await sandbox({ action: "write-files", name, files: live.overlay }, signal);
            await sandbox({ action: "public-urls", name, urls: publicUrls(pylonId, live.previews, options.previewHost) }, signal);
            const sidecar = await readSidecar(pylonId);
            if (sidecar.relaunch) {
              await relaunchAfterWake(pylonGuest(pylonId, instanceDir(pylonId), sandbox), controllerLog(instanceDir(pylonId)));
              await writeSidecar(pylonId, { checkpoint: sidecar.checkpoint });
            }
            return;
          }
          // The instance holds the pylon's newest disk whatever the boot source says, so it is started as it is.
          // Its sessions file is on that disk, so the boot is marked for a relaunch, which a later spawn finishes
          // if this probe dies first.
          case "stopped": case "interrupted": case "failed": {
            await refuseFixedChanges(bootInputs, instance);
            const spec = await bootSpec(bootInputs, live);
            await settleSidecar(pylonId, instance.status.state === "stopped");
            await writeSidecar(pylonId, { checkpoint: (await readSidecar(pylonId)).checkpoint, relaunch: true });
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
        // While the guest still runs, so the checkpoint carries the record. A dead controller's disk keeps its last one.
        if (instance.status.state === "running") await recordBeforePause(pylonGuest(pylonId, instanceDir(pylonId), sandbox), controllerLog(instanceDir(pylonId)));
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

    async buildTemplate(template, inputs, signal) {
      const { key, repo, resources } = inputs;
      if (resources.memoryGiB < minMemoryGiB) throw new JobFailure("invalid", `template ${template} asks for ${resources.memoryGiB} GiB, but pylon VMs need at least ${minMemoryGiB} GiB`);
      const remote = sshRemoteOf(repo.url);
      await holding([key.image], async () => templates.buildTemplate(stateRoot, store, {
        config: { version: 1, diskGiB: resources.diskGiB, image: assetsOf(key.image), workspace, setup: setupCommands(repo.url, repo, inputs.preSetup), retrySetup: false, resume: [], services: {} },
        // No secrets and no overlay during setup, so a template never holds either. No pylon owns the build, so nexus.pylon is blocked like any unlisted host.
        boot: { resources: { cpus: resources.cpus, memoryGiB: resources.memoryGiB }, allowedHosts: [...inputs.allowedHosts], secrets: {}, ssh: await gitSshOf(template, remote === null ? [] : [remote]), files: [], hooks: [], publicUrls: {}, hostBridge: null },
        manifest: { id: template, key, commit: repo.commit },
      }, signal));
    },

    async buildImage(image, recipe, node, signal) {
      if (imageIdOf(recipe) !== image) throw new JobFailure("invalid", `the recipe is image ${imageIdOf(recipe)}, not ${image}`);
      await buildPylonImage(recipe, node, store.path(image), signal);
    },

    guest(pylonId): Guest {
      instanceName(pylonId);
      return pylonGuest(pylonId, instanceDir(pylonId), sandbox);
    },
  };
}
