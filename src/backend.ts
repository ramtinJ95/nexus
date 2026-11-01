/**
 * Probe contract, node side: the VM backend that the probe's job runner (probe/run.ts) drives.
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
 * The backend speaks its own types. Wire types from src/protocol/ stop at probe/run.ts's runJob and runCommand.
 */
import type { Readable } from "node:stream";
import type { CheckpointId, ImageId, NodeName, PortableArtifactId, PylonId, TemplateId } from "./ids.ts";
import type { BrokenCause, PausedSession, ServiceFact } from "./protocol/observations.ts";
import type { ByteStream } from "./protocol/streams.ts";
import type { BootInputs, LiveSpec, OverlayFile } from "./spawn.ts";
import type { ServiceDecl, ServiceName } from "./services-file.ts";
import type { ArtifactManifest, ImageRecipe, TemplateBuildInputs } from "./images.ts";
import type { HostBridge } from "./host-bridge.ts";

export interface VmBackend {
  /**
   * Boot from `boot.source` unless already running, then apply `live`. Converges from any partial state. `relaunch`
   * false (true when omitted) leaves the sessions of a boot from an existing disk for the next spawn to bring back.
   */
  ensureRunning(boot: BootInputs, live: LiveSpec, signal: AbortSignal, relaunch?: boolean): Promise<void>;
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
  /** One pylon's VM state, as list() would report it. Cheaper than list(): it reads only that pylon, and no more than its state. */
  state(pylonId: PylonId): Promise<BackendPylon["vm"] | "absent">;
  /** Rejects with not-running unless the pylon is running. */
  guest(pylonId: PylonId): Guest;
  readonly artifacts: ArtifactStore;
  /**
   * Swap in a secret's new value on every running pylon whose boot granted it. Best effort per pylon: it returns
   * the pylons it could not reach and why. A pylon booting meanwhile starts with whatever value it was given.
   */
  updateSecret(name: string, value: string, signal?: AbortSignal): Promise<readonly { pylonId: PylonId; reason: string }[]>;
  /** Whether the node has a git SSH key, so a pylon can clone over SSH. Omitted: it has none. */
  readonly gitSsh?: boolean;
  /** Whether a pylon whose boot asks for nested virtualization gets KVM of its own here. Omitted: it does not. */
  readonly nestedVirtualization?: boolean;
  /** The SQLite file the probe journals its pylons' events in. Omitted: the journal is in memory, and a restart loses it. */
  readonly eventJournal?: string;
  /** Its end of NEXUS_API, which the in-pylon `nexus` CLI calls. Omitted: those calls go unanswered. */
  readonly hostBridge?: HostBridge;
  /** The directory it keeps pylon disks in, whose filesystem's free space the node reports. Omitted: `/`. */
  readonly storage?: string;
  /** The process each running pylon runs under on the host. Omitted: a backend that cannot name them. */
  processes?(): Promise<readonly { pylonId: PylonId; pid: number }[]>;
}

/** What every backend reports of a pylon, whatever its VM's state. */
interface BackendPylonBase {
  pylonId: PylonId;
  checkpoint: CheckpointId | null; // the checkpoint the current disk was last written as
  image: ImageId; // the image the disk is an overlay on. Observations report it as bootedFrom.image
  /**
   * What the pylon reserves on its node: CPUs and memory while its VM is up, and its disk for as long as it exists,
   * paused or not. Absent from a backend that reserves nothing, such as Docker's.
   */
  holds?: Pick<BootInputs["resources"], "cpus" | "memoryGiB" | "diskGiB">;
}

/** A pylon's VM state, with what each state carries. */
export type BackendVm =
  | { vm: "running"; bootedAt: string }
  /**
   * `sessions` is what its last pause recorded, which the backend keeps beside the checkpoint because the checkpoint
   * cannot be read while paused. Null when that pause recorded none.
   */
  | { vm: "stopped"; sessions: readonly PausedSession[] | null }
  /** `unknown` when the backend cannot tell why. `logTail` is from a backend that keeps a log of the VM's controller: that log's last lines, as read. */
  | { vm: "broken"; detail: string; cause: BrokenCause | "unknown"; logTail?: string }
  | { vm: "booting" | "stopping" | "deleting" };

export type BackendPylon = BackendPylonBase & BackendVm;

/** Every call runs as `user`. */
export interface Guest {
  exec(argv: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number | null; output: string; truncated: boolean }>;
  /** Starts the process on a raw pipe. Its stream carries stdout only, and its stderr goes to `log`. `signal` aborts a start whose caller has gone. */
  stream(argv: readonly string[], log: (text: string) => void, signal?: AbortSignal): Promise<ByteStream>;
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
  /**
   * The origin that the probe's preview gateway forwards to, or why the pylon cannot serve it now, such as when it is
   * paused. It throws only on a fault, such as a status it cannot read.
   */
  previewOrigin(service: string): PreviewOrigin | { unavailable: string };
}

/** A plain-HTTP loopback origin. */
export type PreviewOrigin = `http://127.0.0.1:${number}`;

/**
 * Immutable directories under /var/lib/nexus/artifacts/<id>/ with a manifest, at the same path on every
 * node, because checkpoints and templates are qcow2 overlays whose backing file is the image's rootfs.
 * Only images and templates move between nodes (artifacts.ts). A checkpoint holds the pylon's Claude and pi
 * logins and stays in its pylon's instance on its own node.
 */
export interface ArtifactStore {
  /** The images and templates this node holds. The probe adds its stopped pylons' checkpoints. */
  list(): Promise<readonly PortableArtifactId[]>;
  has(id: PortableArtifactId): Promise<boolean>;
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
/** `names` lists the secrets the node holds, which its probe reports. Values never leave the node. */
export interface SecretSource { value(name: string): string | undefined; names(): readonly string[] }

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
