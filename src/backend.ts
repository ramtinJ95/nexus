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
import type { ByteStream, CommandResult, Job, JobErrorCode, PylonCommand, PylonId, StreamRequest } from "./protocol.ts";
import type { BootInputs, LiveSpec, OverlayFile, PreviewAssignment } from "./project.ts";
import type { ArtifactId, CheckpointId, ImageId, PortableArtifactId, TemplateBuildInputs, TemplateId } from "./images.ts";

export interface VmBackend {
  /** Boot from `boot.source` unless already running, then apply `live`. Converges from any partial state. */
  ensureRunning(boot: BootInputs, live: LiveSpec, signal: AbortSignal): Promise<void>;
  /** Record sessions, stop services, close terminals, checkpoint the disk, stop the VM. Already stopped: no-op. */
  ensurePaused(pylonId: PylonId, checkpoint: CheckpointId, signal: AbortSignal): Promise<void>;
  /** Remove the VM, its disk and its logs. Already absent: no-op. */
  ensureDeleted(pylonId: PylonId, signal: AbortSignal): Promise<void>;
  /** Boot the image, clone, preSetup, `.nexus/setup` as user, stop, publish. A setup failure publishes nothing. */
  buildTemplate(template: TemplateId, inputs: TemplateBuildInputs, signal: AbortSignal): Promise<void>;
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
}

/** Every call runs as `user`. */
export interface Guest {
  exec(argv: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number | null; output: string; truncated: boolean }>;
  /** Starts the process. A raw pipe's stream carries stdout only, and its stderr goes to `log`. */
  stream(request: StreamRequest, log: (text: string) => void): Promise<ByteStream>;
  writeFiles(files: readonly OverlayFile[]): Promise<void>;
  services(op: "ensure" | "restart" | "stop" | "logs", name?: string, lines?: number): Promise<{ services: readonly { name: string; state: string; port: number }[]; logs?: string }>;
  /** Supervise a port that is already listening. Returns the service name it was registered under. */
  linkPort(port: number, title?: string): Promise<string>;
  /** Plain-HTTP loopback origin that the probe's preview gateway forwards to. */
  previewOrigin(service: string): `http://127.0.0.1:${number}`;
}

/**
 * Immutable directories under /var/lib/nexus/artifacts/<id>/ with a manifest, at the same path on every
 * node, because checkpoints and templates are qcow2 overlays whose backing file is the image's rootfs.
 * A checkpoint holds the pylon's Claude and pi logins, so it is only ever exported to a peer probe.
 */
export interface ArtifactStore {
  list(): Promise<readonly ArtifactId[]>;
  /** Sparse-aware archive stream for a peer's GET /v1/artifacts/{id}. A paused pylon's disk exports as its checkpoint. */
  export(id: ArtifactId): Promise<{ stream: Readable; sha256: string }>;
  /** Write to <id>.partial, verify sha256, rename. A crash leaves only a .partial, which the next import removes. */
  import(id: ArtifactId, stream: Readable, sha256: string): Promise<void>;
  /** Refuses while a VM, template or checkpoint on this node still depends on it. Checkpoints are not droppable. */
  drop(id: PortableArtifactId): Promise<void>;
}

/** Node-local secret values, from a root-owned file such as /etc/nexus/secrets.env. */
export interface SecretSource { value(name: string): string | undefined }

export interface ProbeDeps {
  backend: VmBackend;
  secrets: SecretSource;
  serve: TailscaleServe;
  fetchPeer(from: string, artifact: ArtifactId): Promise<Readable>;
}

/** Owns `tailscale serve --bg --https=<port>` entries. One gateway port on loopback routes by the Host header's port. */
export interface TailscaleServe {
  /** Publish exactly these for this pylon and remove its others, then GET each until it answers (S4: the first TLS request can hang). */
  converge(pylonId: PylonId, previews: readonly PreviewAssignment[], signal: AbortSignal): Promise<void>;
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
      case "build-image": case "build-template": case "fetch-artifact": case "drop-artifact":
        throw new JobFailure("invalid", `${job.kind} jobs are not implemented in this slice yet. It runs only spawn, pause and delete`);
    }
  } catch (err) {
    if (err instanceof JobFailure) throw err;
    if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
      throw new JobFailure("deadline", `${job.kind} passed its deadline`);
    }
    throw new JobFailure("backend", err instanceof Error ? err.message : String(err));
  }
}

export async function runCommand(pylonId: PylonId, command: PylonCommand, deps: ProbeDeps): Promise<CommandResult> {
  // TODO: open-session and close-session become guest execs of Herdr's CLI, following pi-shepherdr's
  // launch.ts (start in a new tab, poll until ready, roll back on failure). exec and service map onto Guest.
  throw new Error("not implemented");
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
 * Still to change in the fork:
 * 3. A service's PUBLIC_URL is the URL the probe assigned, not a localhost preview.
 * 4. A host bridge: requests to http://nexus.pylon go to the probe's Unix socket with the instance name attached.
 * 5. Template and instance export and import as ArtifactStore archives.
 * 6. The template build, booting from a template, and the session relaunch from ~/.nexus/sessions.json.
 * The image needs pi-sandbox's `sandboxssh` helper for `shell` and streams, and openssh-client for git over SSH.
 */

// The Docker test double, createDockerBackend, lives in docker-backend.ts.
