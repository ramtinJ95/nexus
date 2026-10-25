/**
 * Probe contract, node side: the probe's job runner and the VM backend it drives.
 *
 * The backend is an in-process TypeScript interface, not an Amp-style dispatch program. Amp's provider
 * only needs spawn, pause and delete because the orb dials out to Amp for tools, terminals and portals.
 * A Nexus pylon cannot dial out (Gondolin blocks everything but allowed HTTP, TLS and SSH), so the probe
 * carries exec, terminal streams, services and previews itself. Those are long-lived byte streams and
 * per-call results, which a one-process-per-job program with env-var parameters cannot express.
 * pi-sandbox already gives the crash-surviving process boundary a dispatch program would buy: each
 * instance has a detached controller that outlives the probe. The job shape stays Amp's, so an Amp
 * dispatch script can still back the lifecycle half later.
 *
 * The backend speaks its own types. Wire types from protocol.ts stop at runJob and runCommand.
 */
import type { Readable } from "node:stream";
import type { ArtifactCopy, BrokenCause, ByteStream, CommandResult, Job, JobErrorCode, NodeName, PausedSession, PylonCommand, PylonId, ServiceFact } from "./protocol.ts";
import { checkoutDir, closeSession, dropFailedSession, openSession } from "./sessions.ts";
import { linkedName, type BootInputs, type LiveSpec, type OverlayFile, type PreviewAssignment, type ServiceDecl, type ServiceName } from "./project.ts";
import type { ArtifactId, ArtifactManifest, CheckpointId, ImageId, ImageRecipe, PortableArtifactId, TemplateBuildInputs, TemplateId } from "./images.ts";

export interface VmBackend {
  /** Boot from `boot.source` unless already running, then apply `live`. Converges from any partial state. */
  ensureRunning(boot: BootInputs, live: LiveSpec, signal: AbortSignal): Promise<void>;
  /**
   * Record sessions, stop services, close terminals, checkpoint the disk, stop the VM. Already stopped: no-op. A disk
   * with a failed setup is never checkpointed: a VM with no checkpoint is removed, and one with a checkpoint is refused.
   */
  ensurePaused(pylonId: PylonId, checkpoint: CheckpointId, signal: AbortSignal): Promise<void>;
  /** Remove the VM, its disk and its logs. Already absent: no-op. */
  ensureDeleted(pylonId: PylonId, signal: AbortSignal): Promise<void>;
  /** Boot the image, clone, preSetup, `.nexus/setup` as user, stop, publish. A setup failure publishes nothing. Published already: no-op. */
  buildTemplate(template: TemplateId, inputs: TemplateBuildInputs, signal: AbortSignal): Promise<void>;
  /** buildImage in image-build.ts, into the artifact store under `image`, which must be the recipe's ID. Built already: no-op. */
  buildImage(image: ImageId, recipe: ImageRecipe, node: NodeName, signal: AbortSignal): Promise<void>;
  /** Cheap, with no guest exec. The probe layers guest facts (git, sessions, previews) on top. */
  list(): Promise<readonly BackendPylon[]>;
  /** Rejects with not-running unless the pylon is running. */
  guest(pylonId: PylonId): Guest;
  readonly artifacts: ArtifactStore;
}

export interface BackendPylon {
  pylonId: PylonId;
  vm: "booting" | "running" | "stopping" | "stopped" | "deleting" | "broken";
  checkpoint: CheckpointId | null; // the checkpoint the current disk was last written as
  image: ImageId; // the image the disk is an overlay on. Observations report it as bootedFrom.image
  bootedAt: string | null; // set while the VM runs
  detail?: string;
  /** Set exactly when `vm` is broken. `unknown` when the backend cannot tell why. */
  cause?: BrokenCause | "unknown";
  /**
   * Set exactly when `vm` is stopped: the sessions its last pause recorded, which the backend keeps beside the
   * checkpoint because the checkpoint cannot be read while paused. Null when that pause recorded none.
   */
  sessions?: readonly PausedSession[] | null;
}

/** Every call runs as `user`. */
export interface Guest {
  exec(argv: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number | null; output: string; truncated: boolean }>;
  /** Starts the process on a raw pipe. Its stream carries stdout only, and its stderr goes to `log`. */
  stream(argv: readonly string[], log: (text: string) => void): Promise<ByteStream>;
  writeFiles(files: readonly OverlayFile[]): Promise<void>;
  /** `list` starts and stops nothing. */
  services(op: "ensure" | "list" | "restart" | "stop" | "logs", name?: string, lines?: number): Promise<{ services: readonly ServiceFact[]; logs?: string }>;
  /** Start an ad hoc service. Rejects a name .nexus/services.yaml declares. Returns the service's facts. */
  startService(name: ServiceName, decl: ServiceDecl): Promise<readonly ServiceFact[]>;
  /** Supervise a port that is already listening. Returns the service name it was registered under. */
  linkPort(port: number, title?: string): Promise<string>;
  /**
   * Stop previewing a port linkPort linked. A port not linked is left as it is. Returns why it refused, for a port a
   * service's preview owns, or null.
   */
  unlinkPort(port: number): Promise<string | null>;
  /** Plain-HTTP loopback origin that the probe's preview gateway forwards to. */
  previewOrigin(service: string): `http://127.0.0.1:${number}`;
}

/**
 * Immutable directories under /var/lib/nexus/artifacts/<id>/ with a manifest, at the same path on every
 * node, because checkpoints and templates are qcow2 overlays whose backing file is the image's rootfs.
 * Only images and templates move between nodes (artifacts.ts). A checkpoint holds the pylon's Claude and pi
 * logins and stays in its pylon's instance on its own node.
 */
export interface ArtifactStore {
  list(): Promise<readonly ArtifactId[]>;
  /** The manifest of an image or template this node holds, or null. */
  manifest(id: PortableArtifactId): Promise<ArtifactManifest | null>;
  /** The sparse archive a peer's GET /v1/artifacts/{id} streams, and the manifest whose sha256 it hashes to. */
  export(id: PortableArtifactId): Promise<{ manifest: ArtifactManifest; stream: Readable }>;
  /** Stage the whole stream in <id>.partial, verify it against manifest.sha256, then rename it in. A crash leaves only a .partial, which the next import removes. */
  import(manifest: ArtifactManifest, stream: Readable, signal: AbortSignal): Promise<void>;
  /** Refuses while a VM, template or checkpoint on this node still depends on it. Checkpoints are not droppable. */
  drop(id: PortableArtifactId): Promise<void>;
}

/** Node-local secret values, from a root-owned file such as /etc/nexus/secrets.env. */
export interface SecretSource { value(name: string): string | undefined }

export interface ProbeDeps {
  node: NodeName;
  backend: VmBackend;
  secrets: SecretSource;
  serve: TailscaleServe;
  /** GET /v1/artifacts/{id} on the peer probe. The stream is unverified until ArtifactStore.import checks it. */
  fetchPeer(from: NodeName, artifact: PortableArtifactId, sha256: string, signal: AbortSignal): Promise<ArtifactCopy>;
}

/** Owns `tailscale serve --bg --https=<port>` entries. One gateway port on loopback routes by the Host header's port. */
export interface TailscaleServe {
  /** Publish exactly these for this pylon and remove its others, then GET each until it answers (S4: the first TLS request can hang). */
  converge(pylonId: PylonId, previews: readonly PreviewAssignment[], signal: AbortSignal): Promise<void>;
  /** Stops routing the service's https port now, so it answers 404 until a converge removes its serve entry. */
  withdraw(pylonId: PylonId, service: ServiceName): Promise<void>;
}

export class JobFailure extends Error {
  readonly code: JobErrorCode;
  readonly logTail: string;
  constructor(code: JobErrorCode, message: string, logTail = "") {
    super(message);
    this.code = code;
    this.logTail = logTail;
  }
}

/**
 * One switch, and no other logic. The probe keeps the liveHash of each successful spawn for its
 * observations. Backend errors become JobFailure with the closest code, and deadline aborts "deadline".
 */
export async function runJob(job: Job, deps: ProbeDeps, signal: AbortSignal): Promise<void> {
  try {
    switch (job.kind) {
      case "spawn":
        for (const grant of job.boot.network.secrets) {
          if (deps.secrets.value(grant.name) === undefined) throw new JobFailure("secret-missing", `secret ${grant.name} is not in this node's secret file`);
        }
        await deps.backend.ensureRunning(job.boot, job.live, signal);
        await deps.serve.converge(job.pylonId, job.live.previews, signal);
        return;
      case "pause":
        // Previews stay published, so a hit on a paused pylon reaches the gateway, which reports it and shows a waking page.
        await deps.backend.ensurePaused(job.pylonId, job.checkpoint, signal);
        return;
      case "delete":
        await deps.serve.converge(job.pylonId, [], signal);
        await deps.backend.ensureDeleted(job.pylonId, signal);
        return;
      case "build-image":
        await deps.backend.buildImage(job.image, job.recipe, deps.node, signal);
        return;
      case "build-template":
        await deps.backend.buildTemplate(job.template, job.inputs, signal);
        return;
      case "fetch-artifact": {
        if (job.artifact.startsWith("ckpt-")) throw new JobFailure("invalid", `${job.artifact} is a checkpoint, and a checkpoint never leaves its node`);
        const artifact = job.artifact as PortableArtifactId;
        const held = await deps.backend.artifacts.manifest(artifact);
        if (held !== null) {
          if (held.sha256 !== job.sha256) throw new JobFailure("invalid", `this node holds ${artifact} with sha256 ${held.sha256}, and the job asks for ${job.sha256}`);
          return;
        }
        const copy = await deps.fetchPeer(job.from, artifact, job.sha256, signal);
        if ("refused" in copy) throw new JobFailure("invalid", `${job.from} refuses the copy: ${copy.refused}`);
        if (copy.manifest.id !== artifact || copy.manifest.sha256 !== job.sha256) {
          copy.stream.destroy();
          throw new JobFailure("invalid", `${job.from} offers ${copy.manifest.id} with sha256 ${copy.manifest.sha256}, and the job asks for ${artifact} with ${job.sha256}`);
        }
        await deps.backend.artifacts.import(copy.manifest, copy.stream, signal);
        return;
      }
      case "drop-artifact":
        await deps.backend.artifacts.drop(job.artifact);
        return;
    }
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
      throw new JobFailure("deadline", `${job.kind} passed its deadline`);
    }
    throw new JobFailure("backend", err instanceof Error ? err.message : String(err));
  }
}

/** The caller has checked that the pylon runs. Sessions open in the checkout. */
export async function runCommand(pylonId: PylonId, command: PylonCommand, deps: ProbeDeps): Promise<CommandResult> {
  const guest = deps.backend.guest(pylonId);
  switch (command.kind) {
    case "exec":
      return { kind: "exec", ...await guest.exec(command.argv, { cwd: command.cwd, timeoutMs: command.timeoutMs }) };
    case "open-session": {
      const { harness, title, resume } = command;
      return { kind: "open-session", herdrPane: await openSession(guest, { harness, title, cwd: checkoutDir, ...(resume === undefined ? {} : { resume }) }) };
    }
    case "close-session":
      return { kind: "close-session", outcome: await closeSession(guest, command.herdrPane, command.session) };
    case "drop-failed-session":
      return { kind: "drop-failed-session", dropped: await dropFailedSession(guest, command.id) };
    case "service": {
      const { services, logs } = await guest.services(command.op, command.name, command.lines);
      return { kind: "service", services, ...(logs === undefined ? {} : { logs }) };
    }
    case "link-port":
      return { kind: "link-port", service: await guest.linkPort(command.port) };
    case "unlink-port": {
      const refused = await guest.unlinkPort(command.port);
      if (refused === null) await deps.serve.withdraw(pylonId, linkedName(command.port));
      return { kind: "unlink-port", refused };
    }
  }
}

// The pylon VM backend, createPylonVmBackend, lives in pylon-vm-backend.ts.

/**
 * It drives src/pylon-vm/, a hard fork of pi-sandbox (MIT) that Nexus owns and does not track upstream.
 * src/pylon-vm/FORK.md names the upstream commit and every edit. pi-sandbox stays the reference to compare
 * against. Kept from it: the detached controller per instance, the checkpoint written to disk.next.qcow2 and
 * renamed, template prepare and copy, the services supervisor and the port linking behind previews.
 *
 * Done: config is a typed object, and a fresh boot clones and runs preSetup and `.nexus/setup` as `user`.
 * Secrets reach createHttpHooks from the probe's SecretSource, never from the instance record, and are never
 * written into the guest, though a granted host that echoes one back shows it to the guest (change 1).
 * Network policy, secrets and resources are inputs to every start, and only the image and the disk size are
 * fixed at create (change 2). Git over SSH is terminated on the host. Every boot writes the overlay and pulls
 * the dotfiles, every boot after the first runs `.nexus/resume`, and every spawn rewrites the overlay.
 * A template is the fork's prepare published into the artifact store (pylon-vm-templates.ts). A pylon booted
 * from one copies its disk in, and its first boot checks out the pylon's own commit and runs `.nexus/resume`.
 * Images and templates move between nodes as verified ArtifactStore archives (artifacts.ts).
 * Requests to http://nexus.pylon go to the probe's Unix socket with the instance name attached (change 4).
 * Still to change in the fork:
 * 3. A service's PUBLIC_URL is the URL the probe assigned, not a localhost preview.
 * 5. Instance export and import, for moving a paused pylon's checkpoint to another node.
 * 6. The session relaunch from ~/.nexus/sessions.json.
 * The image needs pi-sandbox's `sandboxssh` helper for `shell` and streams, and openssh-client for git over SSH.
 */

// The Docker test double, createDockerBackend, lives in docker-backend.ts.
