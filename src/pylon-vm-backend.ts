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
import { JobFailure, type ArtifactStore, type BackendPylon, type Guest, type VmBackend } from "./backend.ts";
import type { BootInputs } from "./project.ts";
import type { PylonId } from "./protocol.ts";
import type { ArtifactId, CheckpointId, ImageId } from "./images.ts";
import { run } from "./pylon-vm/client.ts";
import { statusSchema, type SandboxConfig } from "./pylon-vm/contracts.ts";
import { directory, existsError, readRecord, saveJson, shellQuote as q } from "./pylon-vm/storage.ts";

export interface PylonVmBackendOptions {
  /** A private directory for instances. Each instance's control socket path under it must stay below 104 bytes. */
  stateRoot: string;
  /** The Gondolin asset directory (manifest.json, kernel, initramfs, rootfs) that each image ID names. */
  images: Readonly<Record<ImageId, string>>;
}

const workspace = "/home/user/workspace";
const repoDir = `${workspace}/repo`;
const imageLabel = "nexus.image";
const checkpointFile = "nexus-checkpoint.json";
const pollMs = 500;
/** Measured in the pylon-vm slice: 3 GiB boots, 4, 8, 12 and 16 GiB pass the whole slice, and 2 GiB hangs at "ACPI: Core revision". */
const minMemoryGiB = 3;

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
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(pylonId)) throw new JobFailure("invalid", `pylon ID ${pylonId} is not a valid pylon-vm instance name`);
  return pylonId;
}

/** A login shell as `user`, in `cwd`. The fork runs guest commands as root. */
const asUser = (script: string, cwd: string) => `runuser -l user -c ${q(`cd ${q(cwd)} && ${script}`)}`;

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

  async function create(boot: BootInputs, signal: AbortSignal): Promise<void> {
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
    if (boot.resources.memoryGiB < minMemoryGiB) {
      throw new JobFailure("invalid", `${boot.pylonId} asks for ${boot.resources.memoryGiB} GiB, but pylon VMs need at least ${minMemoryGiB} GiB: a 2 GiB Gondolin 0.13.0 guest hangs at boot on infra-testbench`);
    }
    const config: SandboxConfig = {
      version: 1,
      profile: "small", // unused, because resources are always given
      resources: { cpus: boot.resources.cpus, memoryGiB: boot.resources.memoryGiB },
      diskGiB: boot.resources.diskGiB,
      image: assetsOf(boot),
      workspace,
      setup: setupCommands(boot, preSetup),
      resume: [],
      network: { allowedHosts: [...boot.network.allowedHosts] },
      services: {},
    };
    await sandbox({ action: "create", name: instanceName(boot.pylonId), config, labels: { [imageLabel]: boot.image } }, signal);
  }

  /** A start boots the config recorded at create, so boot inputs that changed since then are refused, never ignored. */
  async function refuseChangedBootInputs(boot: BootInputs, instance: Instance): Promise<void> {
    const { config } = await readRecord(instanceDir(boot.pylonId));
    const hosts = (h: readonly string[]) => [...h].sort().join(" ");
    const changed = [
      ...(instance.labels[imageLabel] === boot.image ? [] : ["image"]),
      ...(config.resources?.cpus === boot.resources.cpus && config.resources.memoryGiB === boot.resources.memoryGiB && config.diskGiB === boot.resources.diskGiB ? [] : ["resources"]),
      ...(hosts(config.network.allowedHosts) === hosts(boot.network.allowedHosts) ? [] : ["allowedHosts"]),
    ];
    if (changed.length > 0) throw new JobFailure("invalid", `${boot.pylonId} was created with other ${changed.join(", ")}: applying a change on a later boot is not implemented yet`);
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
      if (bootInputs.network.secrets.length > 0) throw new JobFailure("invalid", "the pylon VM backend does not pass secrets: not implemented yet");
      if (live.overlay.length > 0) throw new JobFailure("invalid", "the pylon VM backend does not write overlay files: not implemented yet");
      for (;;) {
        const instance = await settled(pylonId, signal);
        if (instance === null) {
          await boot(pylonId, () => create(bootInputs, signal), signal);
          continue;
        }
        switch (instance.status.state) {
          case "running":
            if (instance.status.startupError !== undefined) throw new JobFailure("setup-failed", `${pylonId}: ${instance.status.startupError}`);
            return;
          // The instance holds the pylon's newest disk whatever the boot source says, so it is started as it is.
          case "stopped": case "interrupted": case "failed":
            await refuseChangedBootInputs(bootInputs, instance);
            await settleSidecar(pylonId, instance.status.state === "stopped");
            await boot(pylonId, () => sandbox({ action: "start", name }, signal), signal);
            continue;
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
          case "running":
            try {
              await sandbox({ action: "stop", name });
            } catch (err) {
              throw new JobFailure("checkpoint-failed", `${pylonId}: ${(err as Error).message}`);
            }
            break;
          // Only a completed stop makes the disk a checkpoint. Booting the last one and stopping it again gives one.
          case "interrupted": case "failed":
            await sandbox({ action: "start", name }, signal);
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
        writeFiles: notYet("writeFiles"),
        services: notYet("services"),
        linkPort: notYet("linkPort"),
        previewOrigin: notYet("previewOrigin"),
      };
    },
  };
}
