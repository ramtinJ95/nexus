/**
 * The Docker test double for VmBackend, after Amp's Docker provider example. A pylon is a container named
 * after its ID running `sleep infinity` under --init. Pause records its sessions, stops it, commits it to a
 * checkpoint image and removes it. Resume runs from that image and relaunches the sessions. Everything it
 * reports comes from Docker labels, so a probe restart loses nothing. Its services are the exception: see
 * docker-services.ts.
 *
 * A template is a Docker image committed from a build container, and its artifact is that image's
 * `docker save` archive in the artifact store, so templates move between probes as they do between nodes. A
 * template that arrived as an archive is loaded into Docker on its first boot. The double clones nothing: its
 * setup is the project's preSetup, run as root in the build container.
 */
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { artifactDirectory, fileCodec, type ArtifactDirectory } from "./artifacts.ts";
import { JobFailure, type ArtifactStore, type BackendPylon, type Guest, type VmBackend } from "./backend.ts";
import { dockerBridgeRunArgs } from "./docker-host-bridge.ts";
import { dockerServices, publishedPorts } from "./docker-services.ts";
import { processStream } from "./process-stream.ts";
import type { OverlayFile } from "./project.ts";
import type { PylonId } from "./protocol.ts";
import type { ArtifactId, CheckpointId, ImageId, PortableArtifactId, TemplateId } from "./images.ts";
import { publicUrls } from "./public-urls.ts";
import { recordBeforePause, relaunchAfterWake, type PylonLog } from "./session-wake.ts";

const execFileAsync = promisify(execFile);

const label = { pylon: "nexus.pylon", image: "nexus.image", bootedFrom: "nexus.booted-from", checkpoint: "nexus.checkpoint", templateBuild: "nexus.template-build" } as const;
const savedImage = "image.tar";
const setupLimitMs = 20 * 60_000;

export interface DockerBackendOptions {
  /** The local Docker image that stands in for each Nexus image. The backend never pulls. An image booted with an overlay needs a `user`, who owns its home files. */
  images: Readonly<Record<ImageId, string>>;
  /** Put on every container and checkpoint image this backend creates, and required of everything it lists or removes. */
  labels?: Readonly<Record<string, string>>;
  /** The host previews are published on, which each previewed service's PUBLIC_URL names. */
  previewHost?: string;
  /** The artifact store for templates. Omitted: the backend builds, boots and holds no templates. */
  artifacts?: string;
  /** Gives each new container a NEXUS_API that dockerHostBridge(port) answers. Omitted: containers have no NEXUS_API. */
  hostBridgePort?: number;
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
  async function dockerWithInput(args: readonly string[], input: string): Promise<void> {
    const child = spawn("docker", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    // A docker exec that exits before reading its input breaks the pipe, which its exit code then explains.
    let broken: Error | undefined;
    child.stdin.on("error", (err) => { broken = err; }).end(input);
    const code = await new Promise<number | null>((resolve, reject) => child.on("error", reject).on("close", resolve));
    if (code !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")}: exited ${code}: ${stderr.trim()}`);
    if (broken) throw new Error(`docker ${args.slice(0, 3).join(" ")}: its input broke off: ${broken.message}`);
  }

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

  const services = dockerServices();
  const checkpointRef = (pylonId: PylonId, checkpoint: CheckpointId) => `nexus-checkpoint/${pylonId}:${checkpoint}`;

  /** The container's own log, `docker logs`, by way of the init process's stdout. */
  const containerLog = (pylonId: PylonId): PylonLog => async (line) => {
    await docker(["exec", pylonId, "sh", "-c", 'printf "%s\\n" "$1" > /proc/1/fd/1', "sh", line]);
  };

  /**
   * Set on a disk whose sessions are to be relaunched, and cleared once they are. It is on the disk, so a
   * probe that dies before the relaunch finishes leaves it for the next spawn.
   */
  const relaunchMark = "/var/lib/nexus/relaunch";
  const markRelaunch = (pylonId: PylonId) => docker(["exec", pylonId, "sh", "-c", 'mkdir -p "${1%/*}" && touch "$1"', "sh", relaunchMark]);

  /** Writes the overlay, applies the live spec's URLs to the services, and relaunches the sessions of a boot from an existing disk. */
  async function afterBoot(pylonId: PylonId, overlay: readonly OverlayFile[], urls: Record<string, string>, disk: "fresh" | "existing" | "running"): Promise<void> {
    // A checkpoint carries the mark from its pause. A container stopped some other way gets it here.
    if (disk === "existing") await markRelaunch(pylonId);
    // Before the services and sessions start, as in a pylon, so both read this spawn's files.
    await guest(pylonId).writeFiles(overlay);
    await services.apply(pylonId, urls, disk !== "running");
    if (await docker(["exec", pylonId, "sh", "-c", 'test -e "$1" && echo marked || true', "sh", relaunchMark]) !== "marked") return;
    await relaunchAfterWake(guest(pylonId), containerLog(pylonId));
    await docker(["exec", pylonId, "rm", "-f", relaunchMark]);
  }

  function guest(pylonId: PylonId): Guest {
    const notYet = (member: string) => () => { throw new Error(`the Docker backend has no Guest.${member} yet`); };
    return {
      // As root, unlike a pylon: a container image need not have a `user`.
      async exec(argv, { cwd, timeoutMs }) {
        // docker exec reports a missing or stopped container as an ordinary exit code 1.
        const existing = await container(pylonId, AbortSignal.timeout(timeoutMs));
        if (existing?.State.Status !== "running") throw new Error(`${pylonId} is not running`);
        return execIn(pylonId, cwd, argv, timeoutMs);
      },
      async stream(request, log) {
        if (request.pty !== null) throw new Error("the Docker backend has no pty streams");
        const existing = await container(pylonId, AbortSignal.timeout(30_000));
        if (existing?.State.Status !== "running") throw new Error(`${pylonId} is not running`);
        return processStream("docker", ["exec", "--interactive", pylonId, ...request.argv], log);
      },
      /** Each file through stdin. Missing parents are made as the file's owner, as in a pylon. */
      async writeFiles(files) {
        for (const file of files) {
          await dockerWithInput(["exec", "--interactive", pylonId, "sh", "-c", [
            'dir=$(dirname "$1")',
            'if [ "$2" = root ]; then mkdir -p "$dir"; else runuser -u "$2" -- mkdir -p "$dir"; fi',
            'cat > "$1.nexus-write"',
            'install -o "$2" -g "$(id -gn "$2")" -m "$3" "$1.nexus-write" "$1"',
            'rm -f "$1.nexus-write"',
          ].join(" && "), "sh", file.path, file.owner, file.mode.toString(8)], file.content);
        }
      },
      async services(op, name, lines) {
        if (op === "logs") {
          if (name === undefined) throw new Error("service logs needs the service's name");
          return services.logs(pylonId, name, lines);
        }
        return { services: await services.operate(pylonId, op, name) };
      },
      startService: notYet("startService"),
      linkPort: (port) => services.link(pylonId, port),
      previewOrigin: (service) => services.origin(pylonId, service),
    };
  }

  const templateRef = (template: TemplateId) => `nexus-template:${template}`;
  const labelsOf = (info: { Config: { Labels: Record<string, string> | null } }) => info.Config.Labels ?? {};

  const store: ArtifactDirectory | null = options.artifacts === undefined ? null : artifactDirectory(options.artifacts, fileCodec(savedImage));
  function templates(): ArtifactDirectory {
    if (store === null) throw new JobFailure("invalid", "this Docker backend has no artifact store, so it has no templates");
    return store;
  }
  /** Docker images stand in for Nexus images and are configured per node, so only templates move or go. */
  function templateId(id: PortableArtifactId): TemplateId {
    if (!id.startsWith("tpl-")) throw new JobFailure("invalid", `the Docker backend's images are configured Docker images, so ${id} is neither copied nor dropped`);
    return id as TemplateId;
  }

  async function imageRef(image: ImageId, signal?: AbortSignal): Promise<string> {
    const ref = options.images[image];
    if (ref === undefined) throw new JobFailure("artifact-missing", `no Docker image stands in for ${image}`);
    if (!await imagePresent(ref, signal)) throw new JobFailure("artifact-missing", `Docker image ${ref} for ${image} is not on this node`);
    return ref;
  }

  /** A template that arrived as an archive is loaded on its first boot. */
  async function templateImage(template: TemplateId, image: ImageId, signal: AbortSignal): Promise<string> {
    const manifest = await templates().manifest(template);
    if (manifest === null) throw new JobFailure("artifact-missing", `template ${template} is not on this node`);
    if (manifest.key.image !== image) throw new JobFailure("invalid", `template ${template} was built on ${manifest.key.image}, and the pylon boots ${image}`);
    const ref = templateRef(template);
    if (!await imagePresent(ref, signal)) await docker(["load", "--input", join(templates().path(template), savedImage)], signal);
    return ref;
  }

  async function removeContainer(name: string): Promise<void> {
    const ids = await docker(["ps", "-a", "-q", "--filter", `name=^${name}$`]);
    if (ids !== "") await docker(["rm", "--force", ...ids.split("\n")]);
  }

  const artifacts: ArtifactStore = {
    async list() {
      const images = await Promise.all(Object.entries(options.images).map(async ([id, ref]) => await imagePresent(ref) ? id as ImageId : null));
      const checkpoints = (await checkpointImages(null)).map((img) => labelsOf(img)[label.checkpoint] as CheckpointId);
      return [...images.filter((id): id is ImageId => id !== null), ...await store?.list() ?? [], ...new Set(checkpoints)] satisfies ArtifactId[];
    },
    manifest: (id) => templates().manifest(templateId(id)),
    export: (id) => templates().export(templateId(id)),
    import(manifest, stream, signal) {
      templateId(manifest.id);
      return templates().import(manifest, stream, signal);
    },
    // Pylons booted from the template keep its layers, so nothing on the node depends on its tag.
    async drop(id) {
      const template = templateId(id);
      await templates().drop(template, []);
      if (await imagePresent(templateRef(template))) await docker(["rmi", "--force", templateRef(template)]);
    },
  };

  return {
    artifacts,

    async ensureRunning(boot, live, signal) {
      const urls = publicUrls(boot.pylonId, live.previews, options.previewHost);
      const existing = await container(boot.pylonId, signal);
      if (existing?.State.Status === "running") return afterBoot(boot.pylonId, live.overlay, urls, "running");
      // A container that exists holds the newest disk, newer than any checkpoint, so it is started as it is.
      if (existing !== null) {
        await docker(["start", existing.Id], signal);
        return afterBoot(boot.pylonId, live.overlay, urls, "existing");
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
        case "fresh":
          from = await imageRef(boot.image, signal);
          break;
        case "template":
          from = await templateImage(boot.source.template, boot.image, signal);
          break;
      }
      await docker([
        "run", "--detach", "--init", "--pull", "never", "--name", boot.pylonId,
        "--label", `${label.pylon}=${boot.pylonId}`,
        "--label", `${label.image}=${boot.image}`,
        "--label", `${label.bootedFrom}=${bootedFrom ?? ""}`,
        ...scope.flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        "--publish", `127.0.0.1::${publishedPorts.first}-${publishedPorts.last}`,
        ...(options.hostBridgePort === undefined ? [] : dockerBridgeRunArgs(options.hostBridgePort)),
        from, "sleep", "infinity",
      ], signal);
      await afterBoot(boot.pylonId, live.overlay, urls, bootedFrom === null ? "fresh" : "existing");
    },

    async ensurePaused(pylonId, checkpoint, signal) {
      const existing = await container(pylonId, signal);
      // No container: only checkpoints remain, or nothing does. Both are already paused.
      if (existing === null) return;
      if (existing.State.Status === "running") {
        await recordBeforePause(guest(pylonId), containerLog(pylonId));
        await markRelaunch(pylonId);
      }
      await docker(["stop", existing.Id], signal);
      const labels = { ...labelsOf(existing), [label.checkpoint]: checkpoint };
      await docker([
        "commit",
        ...Object.entries(labels).flatMap(([k, v]) => ["--change", `LABEL ${k}="${v}"`]),
        existing.Id, checkpointRef(pylonId, checkpoint),
      ], signal);
      await docker(["rm", existing.Id], signal);
      // Only now, because snapshots read the services of a container for as long as it runs.
      services.forget(pylonId);
    },

    async ensureDeleted(pylonId, signal) {
      services.forget(pylonId);
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

    async buildTemplate(template, inputs, signal) {
      const store = templates();
      if (await store.manifest(template) !== null) return;
      const from = await imageRef(inputs.key.image, signal);
      const build = `nexus-build-${template}`;
      // What an earlier, interrupted build left is started over.
      await removeContainer(build);
      await docker(["run", "--detach", "--init", "--pull", "never", "--name", build, "--label", `${label.templateBuild}=${template}`, ...scope.flatMap(([k, v]) => ["--label", `${k}=${v}`]), from, "sleep", "infinity"], signal);
      try {
        if (inputs.preSetup !== null) {
          const setup = await execIn(build, "/", ["sh", "-c", inputs.preSetup], setupLimitMs);
          if (setup.exitCode !== 0) throw new JobFailure("setup-failed", `the setup of template ${template} ${setup.exitCode === null ? "passed its 20-minute limit" : `exited ${setup.exitCode}`}`, setup.output.slice(-4096));
        }
        await docker(["stop", build], signal);
        await docker(["commit", build, templateRef(template)], signal);
      } finally {
        await removeContainer(build);
      }
      await store.publish(
        { id: template, key: inputs.key, commit: inputs.repo.commit, builtAt: new Date().toISOString() },
        async (dir) => { await docker(["save", "--output", join(dir, savedImage), templateRef(template)], signal); },
        signal,
      );
    },
    buildImage(image) { return Promise.reject(new JobFailure("invalid", `the Docker backend uses configured Docker images and builds none, so it cannot build ${image}`)); },
    guest,
  };
}

/** A timeout reports exitCode null, as a pylon's exec does. */
async function execIn(container: string, cwd: string, argv: readonly string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string; truncated: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["exec", "--workdir", cwd, container, ...argv], { timeout: timeoutMs, maxBuffer: 64 << 20 });
    return { exitCode: 0, output: stdout + stderr, truncated: false };
  } catch (err) {
    const { code, killed, stdout = "", stderr = "" } = err as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
    if (killed) return { exitCode: null, output: stdout + stderr, truncated: false };
    if (typeof code !== "number") throw err;
    return { exitCode: code, output: stdout + stderr, truncated: false };
  }
}

/**
 * A container that is not running was stopped by something other than a completed pause, which would have
 * removed it: a probe that died mid-pause or mid-boot, or a Docker restart. It reports as broken, so a desired
 * pause finishes the job and a desired run waits for a human, as for a VM the backend saw fail.
 */
function containerState(c: ContainerInfo): Pick<BackendPylon, "vm" | "detail" | "cause"> {
  switch (c.State.Status) {
    case "running": return { vm: "running" };
    case "restarting": return { vm: "booting" };
    case "removing": return { vm: "deleting" };
    default: return { vm: "broken", detail: `container is ${c.State.Status} (exit code ${c.State.ExitCode}) outside a completed pause`, cause: "controller" };
  }
}
