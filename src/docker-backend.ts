/**
 * The Docker test double for VmBackend, after Amp's Docker provider example. A pylon is a container named
 * after its ID running `sleep infinity` under --init. Pause stops it, commits it to a checkpoint image and
 * removes it. Resume runs from that image. Everything it reports comes from Docker labels, so a probe
 * restart loses nothing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JobFailure, type ArtifactStore, type BackendPylon, type VmBackend } from "./backend.ts";
import { processStream } from "./process-stream.ts";
import type { PylonId } from "./protocol.ts";
import type { ArtifactId, CheckpointId, ImageId } from "./images.ts";

const execFileAsync = promisify(execFile);

const label = { pylon: "nexus.pylon", image: "nexus.image", bootedFrom: "nexus.booted-from", checkpoint: "nexus.checkpoint" } as const;

export interface DockerBackendOptions {
  /** The local Docker image that stands in for each Nexus image. The backend never pulls. */
  images: Readonly<Record<ImageId, string>>;
  /** Put on every container and checkpoint image this backend creates, and required of everything it lists or removes. */
  labels?: Readonly<Record<string, string>>;
}

interface ContainerInfo {
  Id: string;
  State: { Status: string; StartedAt: string; ExitCode: number };
  Config: { Labels: Record<string, string> | null };
}
interface ImageInfo {
  Id: string;
  Created: string;
  Config: { Labels: Record<string, string> | null };
}

export function createDockerBackend(options: DockerBackendOptions): VmBackend {
  const scope = Object.entries(options.labels ?? {});
  const scopeFilters = scope.flatMap(([k, v]) => ["--filter", `label=${k}=${v}`]);

  /**
   * The signal is checked before each call, never passed to the CLI: killing the CLI does not stop the
   * daemon's operation, so the job would end and free its subject while Docker was still stopping or committing.
   */
  async function docker(args: readonly string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    try {
      const { stdout } = await execFileAsync("docker", args, { maxBuffer: 64 << 20 });
      return stdout.trim();
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      throw new Error(`docker ${args.join(" ")}: ${stderr || (err as Error).message}`);
    }
  }

  /** Inspects each ID. One removed since it was listed is absent now, so it is left out. */
  async function inspect<T>(kind: "container" | "image", ids: readonly string[], signal?: AbortSignal): Promise<T[]> {
    const found: (T | null)[] = await Promise.all(ids.map(async (id) => {
      try {
        return (JSON.parse(await docker([kind, "inspect", id], signal)) as T[])[0] ?? null;
      } catch (err) {
        if (/No such (container|image|object)/i.test((err as Error).message)) return null;
        throw err;
      }
    }));
    return found.filter((x): x is T => x !== null);
  }

  async function containers(pylonId: PylonId | null, signal?: AbortSignal): Promise<ContainerInfo[]> {
    const ids = await docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${pylonId === null ? label.pylon : `${label.pylon}=${pylonId}`}`, ...scopeFilters], signal);
    return inspect<ContainerInfo>("container", ids === "" ? [] : ids.split("\n"), signal);
  }

  async function container(pylonId: PylonId, signal: AbortSignal): Promise<ContainerInfo | null> {
    const found = await containers(pylonId, signal);
    if (found.length > 1) throw new Error(`${found.length} containers carry ${label.pylon}=${pylonId}`);
    return found[0] ?? null;
  }

  /** Newest first. */
  async function checkpointImages(pylonId: PylonId | null, signal?: AbortSignal): Promise<ImageInfo[]> {
    const pylonFilter = pylonId === null ? [] : ["--filter", `label=${label.pylon}=${pylonId}`];
    const ids = await docker(["images", "-q", "--no-trunc", "--filter", `label=${label.checkpoint}`, ...pylonFilter, ...scopeFilters], signal);
    const unique = [...new Set(ids === "" ? [] : ids.split("\n"))];
    const images = await inspect<ImageInfo>("image", unique, signal);
    return images.sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
  }

  async function imagePresent(ref: string, signal?: AbortSignal): Promise<boolean> {
    return (await docker(["images", "-q", "--filter", `reference=${ref}`], signal)) !== "";
  }

  const checkpointRef = (pylonId: PylonId, checkpoint: CheckpointId) => `nexus-checkpoint/${pylonId}:${checkpoint}`;
  const labelsOf = (info: { Config: { Labels: Record<string, string> | null } }) => info.Config.Labels ?? {};

  const artifacts: ArtifactStore = {
    async list() {
      const images = await Promise.all(Object.entries(options.images).map(async ([id, ref]) => await imagePresent(ref) ? id as ImageId : null));
      const checkpoints = (await checkpointImages(null)).map((img) => labelsOf(img)[label.checkpoint] as CheckpointId);
      return [...images.filter((id): id is ImageId => id !== null), ...new Set(checkpoints)] satisfies ArtifactId[];
    },
    export() { return Promise.reject(new Error("the Docker backend does not export artifacts")); },
    import() { return Promise.reject(new Error("the Docker backend does not import artifacts")); },
    drop() { return Promise.reject(new Error("the Docker backend does not drop artifacts")); },
  };

  return {
    artifacts,

    async ensureRunning(boot, live, signal) {
      if (live.overlay.length > 0) throw new JobFailure("invalid", "the Docker backend does not write overlay files yet");
      const existing = await container(boot.pylonId, signal);
      if (existing?.State.Status === "running") return;
      // A container that exists holds the newest disk, newer than any checkpoint, so it is started as it is.
      if (existing !== null) {
        await docker(["start", existing.Id], signal);
        return;
      }
      let from: string;
      let bootedFrom: CheckpointId | null = null;
      switch (boot.source.kind) {
        case "resume": {
          from = checkpointRef(boot.pylonId, boot.source.checkpoint);
          bootedFrom = boot.source.checkpoint;
          if (!await imagePresent(from, signal)) throw new JobFailure("artifact-missing", `checkpoint ${boot.source.checkpoint} of ${boot.pylonId} is not on this node`);
          break;
        }
        case "fresh": {
          const ref = options.images[boot.image];
          if (ref === undefined) throw new JobFailure("artifact-missing", `no Docker image stands in for ${boot.image}`);
          if (!await imagePresent(ref, signal)) throw new JobFailure("artifact-missing", `Docker image ${ref} for ${boot.image} is not on this node`);
          from = ref;
          break;
        }
        case "template":
          throw new JobFailure("invalid", "the Docker backend does not boot from templates yet");
      }
      await docker([
        "run", "--detach", "--init", "--pull", "never", "--name", boot.pylonId,
        "--label", `${label.pylon}=${boot.pylonId}`,
        "--label", `${label.image}=${boot.image}`,
        "--label", `${label.bootedFrom}=${bootedFrom ?? ""}`,
        ...scope.flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        from, "sleep", "infinity",
      ], signal);
    },

    async ensurePaused(pylonId, checkpoint, signal) {
      const existing = await container(pylonId, signal);
      // No container: only checkpoints remain, or nothing does. Both are already paused.
      if (existing === null) return;
      await docker(["stop", existing.Id], signal);
      const labels = { ...labelsOf(existing), [label.checkpoint]: checkpoint };
      await docker([
        "commit",
        ...Object.entries(labels).flatMap(([k, v]) => ["--change", `LABEL ${k}="${v}"`]),
        existing.Id, checkpointRef(pylonId, checkpoint),
      ], signal);
      await docker(["rm", existing.Id], signal);
    },

    async ensureDeleted(pylonId, signal) {
      const existing = await container(pylonId, signal);
      if (existing !== null) await docker(["rm", "--force", existing.Id], signal);
      // Newest first, one at a time, because removing a checkpoint can also remove the untagged parent it was committed on.
      for (let images = await checkpointImages(pylonId, signal); images.length > 0; images = await checkpointImages(pylonId, signal)) {
        await docker(["rmi", "--force", images[0]!.Id], signal);
      }
    },

    async list() {
      const [running, checkpoints] = await Promise.all([containers(null), checkpointImages(null)]);
      const pylons = new Map<PylonId, BackendPylon>();
      for (const c of running) {
        const labels = labelsOf(c);
        const pylonId = labels[label.pylon] as PylonId;
        pylons.set(pylonId, {
          pylonId,
          ...containerState(c),
          checkpoint: (labels[label.bootedFrom] || null) as CheckpointId | null,
          image: labels[label.image] as ImageId,
          bootedAt: c.State.Status === "running" ? c.State.StartedAt : null,
        });
      }
      for (const img of checkpoints) {
        const labels = labelsOf(img);
        const pylonId = labels[label.pylon] as PylonId;
        if (pylons.has(pylonId)) continue;
        pylons.set(pylonId, { pylonId, vm: "stopped", checkpoint: labels[label.checkpoint] as CheckpointId, image: labels[label.image] as ImageId, bootedAt: null });
      }
      return [...pylons.values()];
    },

    buildTemplate() { return Promise.reject(new Error("the Docker backend does not build templates yet")); },
    guest(pylonId) {
      const notYet = (member: string) => () => { throw new Error(`the Docker backend has no Guest.${member} yet`); };
      return {
        // As root, unlike a pylon: the container image has no `user`.
        async exec(argv, { cwd, timeoutMs }) {
          // docker exec reports a missing or stopped container as an ordinary exit code 1.
          const existing = await container(pylonId, AbortSignal.timeout(timeoutMs));
          if (existing?.State.Status !== "running") throw new Error(`${pylonId} is not running`);
          try {
            const { stdout, stderr } = await execFileAsync("docker", ["exec", "--workdir", cwd, pylonId, ...argv], { timeout: timeoutMs, maxBuffer: 64 << 20 });
            return { exitCode: 0, output: stdout + stderr, truncated: false };
          } catch (err) {
            const { code, killed, stdout = "", stderr = "" } = err as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
            if (killed) return { exitCode: null, output: stdout + stderr, truncated: false };
            if (typeof code !== "number") throw err;
            return { exitCode: code, output: stdout + stderr, truncated: false };
          }
        },
        async stream(request, log) {
          if (request.pty !== null) throw new Error("the Docker backend has no pty streams");
          const existing = await container(pylonId, AbortSignal.timeout(30_000));
          if (existing?.State.Status !== "running") throw new Error(`${pylonId} is not running`);
          return processStream("docker", ["exec", "--interactive", pylonId, ...request.argv], log);
        },
        writeFiles: notYet("writeFiles"),
        services: notYet("services"),
        linkPort: notYet("linkPort"),
        previewOrigin: notYet("previewOrigin"),
      };
    },
  };
}

/**
 * A container that is not running was stopped by something other than a completed pause, which would have
 * removed it: a probe that died mid-pause or mid-boot, or a Docker restart. It reports as broken, so a desired
 * pause finishes the job and a desired run waits for a human, as for a VM the backend saw fail.
 */
function containerState(c: ContainerInfo): Pick<BackendPylon, "vm" | "detail"> {
  switch (c.State.Status) {
    case "running": return { vm: "running" };
    case "restarting": return { vm: "booting" };
    case "removing": return { vm: "deleting" };
    default: return { vm: "broken", detail: `container is ${c.State.Status} (exit code ${c.State.ExitCode}) outside a completed pause` };
  }
}
