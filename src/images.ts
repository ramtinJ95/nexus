/**
 * Template image contract: the base pylon image, project templates, and how both reach nodes.
 *
 * Everything a node stores is an immutable, content-named artifact. The control plane decides what gets
 * built, where, and which node fetches what. Probes only build, serve, fetch and drop on command.
 * Dependencies run one way: a checkpoint or template depends on its image, never the reverse.
 */
import type { NodeName } from "./protocol.ts";
import type { Project, ProjectId, ServicesFile } from "./project.ts";

/** img-<sha256 of the recipe>[:12]. The same inputs give the same ID, so a rebuild of unchanged inputs is a no-op. */
export type ImageId = `img-${string}`;
/** tpl-<sha256 of the TemplateKey>[:12]. */
export type TemplateId = `tpl-${string}`;
/** ckpt-<thread id>-<n>, minted by the control plane for each pause. */
export type CheckpointId = `ckpt-${string}`;
export type ArtifactId = ImageId | TemplateId | CheckpointId;
/** What drop-artifact may name. A checkpoint leaves a node only through delete of its pylon. */
export type PortableArtifactId = Exclude<ArtifactId, CheckpointId>;

// The base image.

/**
 * Lives in this repo under images/pylon/ and is sent inline in the build-image job:
 * - Dockerfile, in layer order:
 *   1. debian:bookworm-slim pinned by digest (glibc, which Amp's image contract also requires).
 *   2. apt: bash, coreutils, util-linux, ca-certificates, git, python3, openssh-server (S2: enableSsh
 *      needs a real sshd), sudo, curl. The service is installed but not enabled.
 *   3. `user`, UID 1000, passwordless sudo, /home/user/workspace.
 *   4. Node from the checksum-verified official tarball into /usr/local.
 *   5. Claude Code and pi from npm, Herdr from its official installer into /usr/local/bin,
 *      `herdr integration install pi` as user, the in-pylon `nexus` CLI, pi-sandbox's `sandboxssh` helper,
 *      and a fallback copy of the common dotfiles layer.
 *   6. /etc/profile.d/00-nexus-base.sh: PATH with /usr/local/bin (Gondolin's exec PATH lacks it, S1) and
 *      NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt (the mitm CA is unreadable to user, S2).
 * - gondolin.json: distro alpine for the kernel and initramfs, oci.image = the Docker build, and
 *   postBuild.copy of the kernel module seed into /lib/modules (the S1 workaround).
 * Logins and secrets are never in the image.
 */
export interface ImageRecipe {
  files: readonly { path: string; content: string }[];
  pins: {
    debianDigest: string;
    node: string; // "24.22.1"
    claudeCode: string;
    pi: string;
    herdr: string;
    gondolin: string; // "0.13.0". The module seed workaround is tied to it
    alpineKernel: string; // "6.18.58-0-virt". The seed must match exactly
    dotfilesCommon: string; // commit of the baked fallback layer
  };
}

export function imageIdOf(recipe: ImageRecipe): ImageId {
  throw new Error("not implemented");
}

export interface ImageManifest {
  id: ImageId;
  gondolinBuildId: string;
  pins: ImageRecipe["pins"];
  builtOn: NodeName;
  builtAt: string;
  sha256: string; // of the sparse archive peers fetch
}

/** Runs on the image build node inside a build-image job. The build user needs Docker access. */
export async function buildImage(recipe: ImageRecipe, outDir: string, signal: AbortSignal): Promise<ImageManifest> {
  // TODO:
  // 1. docker build the Dockerfile with a tag derived from the image ID.
  // 2. Seed: copy Gondolin's cached Alpine module tree for pins.alpineKernel, keeping the absolute
  //    vmlinuz link text. Fail with a clear error if the cached kernel version differs from the pin, because
  //    the workaround breaks silently otherwise. Delete this step once Gondolin's kernel-modules copy sets
  //    verbatimSymlinks (spikes/UPSTREAM-ISSUE-DRAFT.md).
  // 3. gondolin build into outDir.partial.
  // 4. Smoke boot: `id user`, versions of node, claude, pi and herdr, a Herdr server as user, and curl to an
  //    allowed host through TLS interception. Any failure fails the job and publishes nothing.
  // 5. Write manifest.json, then rename outDir.partial to outDir.
  throw new Error("not implemented");
}

/**
 * Where and when. Built only when a human runs `nexus image build`, on the node named by the control
 * plane's `imageBuildNode` setting (default infra-testbench, where S1 verified Docker access). A build that
 * passes its smoke boot becomes `current`, which every new pylon uses. Running and paused pylons keep the
 * image they booted from, because their disks depend on its rootfs. After a build, the control plane sends
 * fetch-artifact to every online node. A node that was offline gets it from planPylon's missing-artifact rule on first use.
 */
export interface ImageSettings { imageBuildNode: NodeName; current: ImageId }

// Project templates.

/**
 * A template is keyed on what changes setup's result. Unlike Amp, editing .nexus/setup produces a new
 * key, because with one user the edit is the moment the change should take effect. Like Amp, a template
 * is reused for at most 72 hours, which bounds drift in whatever setup fetched (lockfile changes do not
 * change the key).
 */
export interface TemplateKey {
  project: ProjectId;
  image: ImageId;
  setupHash: string;
}
export const templateMaxAgeMs = 72 * 3_600_000;

/** Read by the control plane from its bare mirror of the repo on rj-firebat. No pylon is booted to learn these. */
export interface SetupInputs {
  commit: string;
  setupBlob: string | null; // git blob ID of .nexus/setup at `commit`
  services: ServicesFile | null; // not part of the key. It lets the control plane allocate preview ports before the first boot
}
export interface ProjectMirror {
  /** git fetch, then read blobs at the resolved commit. */
  setupInputs(project: Project, ref: string): Promise<SetupInputs>;
}

export function setupHashOf(project: Project, inputs: SetupInputs): string {
  // TODO: sha256 of setupBlob, project.preSetup and effectiveAllowedHosts(project), since the hosts setup
  // can reach change what it can install.
  throw new Error("not implemented");
}
export function templateIdOf(key: TemplateKey): TemplateId {
  throw new Error("not implemented");
}

export interface TemplateBuildInputs {
  key: TemplateKey;
  repo: { url: string; branch: string; commit: string };
  preSetup: string | null;
  allowedHosts: readonly string[]; // no secrets during setup, as in Amp
  resources: Project["resources"];
}

export type TemplateRecord =
  | { id: TemplateId; key: TemplateKey; state: "building"; on: NodeName }
  | { id: TemplateId; key: TemplateKey; state: "ready"; builtOn: NodeName; builtAt: number; commit: string }
  | { id: TemplateId; key: TemplateKey; state: "failed"; on: NodeName; failedAt: number; logTail: string };

export type TemplateChoice =
  | { kind: "reuse"; template: TemplateId }
  | { kind: "build"; template: TemplateId; on: NodeName; inputs: TemplateBuildInputs }
  | { kind: "wait"; template: TemplateId } // another thread's build of this key is running
  | { kind: "fresh"; reason: string }; // the last build of this key failed: boot the image and run setup inline

export function chooseTemplate(project: Project, key: TemplateKey, templates: readonly TemplateRecord[], targetNode: NodeName, now: number): TemplateChoice {
  // TODO:
  // ready with this key and builtAt within templateMaxAgeMs -> reuse, whichever node holds it
  //   (planPylon fetches it to targetNode if needed: one LAN copy beats minutes of setup).
  // building with this key -> wait. failed with this key -> fresh, with its log, so the thread's agent can see
  //   and fix the failing setup. otherwise -> build on targetNode, so the first spawn copies nothing.
  throw new Error("not implemented");
}

/**
 * Garbage, computed by the control plane per node and sent as drop-artifact jobs: templates past
 * templateMaxAgeMs that are not their project's newest ready one, and images that are not current and back
 * no held template or checkpoint. The type cannot name a checkpoint. A wiped registry knows no templates,
 * so it may drop templates and images it does not know. ArtifactStore.drop refuses any image a local
 * checkpoint still needs, and the rest can be rebuilt.
 */
export function garbage(held: readonly ArtifactId[], templates: readonly TemplateRecord[], images: ImageSettings, now: number): readonly PortableArtifactId[] {
  throw new Error("not implemented");
}
