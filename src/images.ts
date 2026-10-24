/**
 * Template image contract: the base pylon image, project templates, and how both reach nodes.
 *
 * Everything a node stores is an immutable, content-named artifact. The control plane decides what gets
 * built, where, and which node fetches what. Probes only build, serve, fetch and drop on command.
 * Dependencies run one way: a checkpoint or template depends on its image, never the reverse.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { effectiveAllowedHosts, type BootInputs, type Project, type ProjectId, type ServicesFile } from "./project.ts";
import type { NodeName } from "./protocol.ts";

/** img-<sha256 of the recipe>[:12]. The same inputs give the same ID, so a rebuild of unchanged inputs is a no-op. */
export type ImageId = `img-${string}`;
/**
 * tpl-<sha256 of the TemplateKey and the build's start time in ms>[:12]. An ID names one build, not one key:
 * the same key built twice gives two IDs, so a node's bytes under one ID never change.
 */
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
 *      needs a real sshd), openssh-client (git over Gondolin's SSH proxy), sudo, curl. The service is installed but not enabled. Also procps (enableSsh's
 *      script runs ps), e2fsprogs (rootfs growth runs resize2fs), ripgrep and fd (pi cannot download them
 *      through the allowlist), xz-utils for the Node tarball, and tini: sandboxd is PID 1 and does not reap
 *      the orphans it adopts, so long-lived trees such as the Herdr server run under `tini -s --`.
 *   3. `user`, UID 1000, passwordless sudo, /home/user/workspace.
 *   4. Node from the checksum-verified official tarball into /usr/local.
 *   5. Claude Code and pi from npm, Herdr from its official installer into /usr/local/bin,
 *      `herdr integration install` for pi and Claude Code as user (the sessions stream reads harness session
 *      IDs through them), the pi-env daemon at /usr/local/libexec/nexus/pi-env, the in-pylon `nexus` CLI, and
 *      the fallback copy of the common dotfiles layer as a git repository at /opt/nexus/dotfiles, owned by
 *      user, which boots clone and then fetch.
 *      `gondolin build` itself installs the `sandboxssh` helper that pi-sandbox's shell needs.
 *   6. gh from its checksum-verified release tarball, set in /etc/gitconfig as git's credential helper for
 *      https://github.com, so a GH_TOKEN grant pushes over HTTPS.
 * - gondolin.json: distro alpine for the kernel and initramfs, and env with PATH including /usr/local/bin
 *   (Gondolin's exec PATH lacks it, S1) and NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt (the mitm
 *   CA is unreadable to user, S2). Gondolin sources that env before sandboxd starts and from /etc/profile.d,
 *   so execs and login shells both see it. buildImage adds oci.image = the Docker build, and postBuild.copy
 *   of the kernel module seed into /lib/modules (the S1 workaround), and init.rootfsInitExtra.
 * - rootfs-init-extra.sh: run as root by Gondolin's /init before sandboxd. It sets the hostname pylon and
 *   writes /etc/hostname and /etc/hosts, because Gondolin sets no hostname and sudo warns without one.
 * - pins.json: ImageRecipe.pins. Every other file except build.sh is in ImageRecipe.files.
 * Logins and secrets are never in the image.
 */
export interface ImageRecipe {
  files: readonly { path: string; content: string }[];
  pins: {
    debianDigest: string;
    node: string; // "24.22.1"
    nodeSha256: string; // of node-v<node>-linux-x64.tar.xz, from that release's SHASUMS256.txt
    claudeCode: string;
    pi: string;
    herdr: string;
    piEnv: string; // the pi-env daemon, pinned to the harness's pi-env version
    piEnvSha256: string; // of package/bin/pi-env-linux-x64/pi-env in that npm tarball
    gondolin: string; // "0.13.0". The module seed workaround is tied to it
    alpineKernel: string; // "6.18.58-0-virt". The seed must match exactly
    dotfilesCommon: string; // commit of the baked fallback layer
    gh: string; // "2.103.2", the GitHub CLI release
    ghSha256: string; // of gh_<gh>_linux_amd64.tar.gz, from that release's checksums file
  };
}

/** ImageRecipe.pins wherever pins arrive: pins.json, a build-image job's recipe, and POST /v1/images. */
export const pinsSchema = z.strictObject({
  debianDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  node: z.string().regex(/^\d+\.\d+\.\d+$/),
  nodeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  claudeCode: z.string().min(1),
  pi: z.string().min(1),
  herdr: z.string().min(1),
  piEnv: z.string().min(1),
  piEnvSha256: z.string().regex(/^[0-9a-f]{64}$/),
  gondolin: z.string().min(1),
  alpineKernel: z.string().min(1),
  dotfilesCommon: z.string().min(1),
  gh: z.string().regex(/^\d+\.\d+\.\d+$/),
  ghSha256: z.string().regex(/^[0-9a-f]{64}$/),
}) satisfies z.ZodType<ImageRecipe["pins"]>;

/** File order does not change the ID. Two files at one path are a broken recipe and throw. */
export function imageIdOf(recipe: ImageRecipe): ImageId {
  const files = [...recipe.files].sort((a, b) => compare(a.path, b.path));
  const duplicate = files.find((file, i) => i > 0 && files[i - 1]!.path === file.path);
  if (duplicate !== undefined) throw new Error(`the image recipe has two files at ${duplicate.path}`);
  return `img-${sha256Of({ files, pins: recipe.pins }).slice(0, 12)}`;
}

export interface ImageManifest {
  id: ImageId;
  gondolinBuildId: string;
  pins: ImageRecipe["pins"];
  builtOn: NodeName;
  builtAt: string;
  sha256: string; // of the sparse archive peers fetch, artifactArchive in artifacts.ts
}

// buildImage, which runs on the image build node, lives in image-build.ts.

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
 * change the key). Records are matched by key. The same key built twice gives two IDs, so a node's bytes
 * under one ID never change.
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

/** sha256 of setupBlob, project.preSetup and effectiveAllowedHosts(project), since the hosts setup can reach change what it can install. */
export function setupHashOf(project: Project, inputs: SetupInputs): string {
  return sha256Of({ setupBlob: inputs.setupBlob, preSetup: project.preSetup, allowedHosts: effectiveAllowedHosts(project) });
}
export function templateIdOf(key: TemplateKey, startedAt: number): TemplateId {
  return `tpl-${sha256Of({ project: key.project, image: key.image, setupHash: key.setupHash, startedAt }).slice(0, 12)}`;
}

/** Hex sha256 of canonical JSON: object keys sorted, so the same value always gives the same hash. */
function sha256Of(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => compare(a, b)))
    : v);
  return createHash("sha256").update(canonical).digest("hex");
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

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

type ReadyTemplate = Extract<TemplateRecord, { state: "ready" }>;

/**
 * template.json in a template's artifact directory, written when its build publishes. The control plane's
 * ready TemplateRecord is its copy, and sha256 is what fetch-artifact verifies a copy against.
 */
export interface TemplateManifest {
  id: TemplateId;
  key: TemplateKey;
  commit: string; // the checkout setup ran on. A pylon booted from the template checks out its own commit
  builtAt: string;
  sha256: string; // of the archive peers fetch, artifactArchive in artifacts.ts
}
/** What a peer sends ahead of an artifact's archive. A checkpoint has none, because it never leaves its node. */
export type ArtifactManifest = ImageManifest | TemplateManifest;

export type TemplateChoice =
  | { kind: "reuse"; template: TemplateId }
  | { kind: "build"; template: TemplateId; on: NodeName; inputs: TemplateBuildInputs }
  | { kind: "wait"; template: TemplateId } // another thread's build of this key is running
  | { kind: "fresh"; reason: string }; // the last build of this key failed: boot the image and run setup inline

/**
 * Rules, first match wins:
 * - ready with this key and built less than templateMaxAgeMs ago: reuse, whichever node holds it
 *   (planPylon fetches it to targetNode if needed: one LAN copy beats minutes of setup).
 * - building with this key: wait.
 * - failed with this key: fresh, with its log, so the thread's agent can see and fix the failing setup.
 * - otherwise: build on targetNode, so the first spawn copies nothing. The build checks out `checkout`,
 *   the commit setupInputs resolved for the thread that asked, under a new ID minted from `now`.
 * reuse and wait return the ID of the record they found.
 */
export function chooseTemplate(project: Project, key: TemplateKey, checkout: BootInputs["repo"]["checkout"], templates: readonly TemplateRecord[], targetNode: NodeName, now: number): TemplateChoice {
  const records = templates.filter((t) => t.key.project === key.project && t.key.image === key.image && t.key.setupHash === key.setupHash);
  const reusable = records
    .filter((t): t is ReadyTemplate => t.state === "ready" && now - t.builtAt < templateMaxAgeMs)
    .sort((a, b) => b.builtAt - a.builtAt)[0];
  if (reusable !== undefined) return { kind: "reuse", template: reusable.id };
  const building = records.find((t) => t.state === "building");
  if (building !== undefined) return { kind: "wait", template: building.id };
  const failed = records.find((t) => t.state === "failed");
  if (failed !== undefined) return { kind: "fresh", reason: `the setup of template ${failed.id} failed on ${failed.on}:\n${failed.logTail}` };
  return {
    kind: "build",
    template: templateIdOf(key, now),
    on: targetNode,
    inputs: {
      key,
      repo: { url: project.repoUrl, ...checkout },
      preSetup: project.preSetup,
      allowedHosts: effectiveAllowedHosts(project),
      resources: project.resources,
    },
  };
}

/**
 * Garbage, computed by the control plane per node and sent as drop-artifact jobs: templates past
 * templateMaxAgeMs that are not their project's newest ready one, and images that are not current and back
 * no held template or checkpoint. The type cannot name a checkpoint. A wiped registry knows no templates,
 * so it may drop templates and images it does not know. ArtifactStore.drop refuses any image a local
 * checkpoint still needs, and the rest can be rebuilt.
 *
 * A building template and its image are kept, and a template whose only record is failed is garbage like one the registry does
 * not know. A held template backs its image until it is dropped, even in this same pass, so an image goes
 * on a later pass, after its templates. A checkpoint ID does not name its image, so this function cannot
 * see that dependency, and ArtifactStore.drop's refusal enforces it.
 */
export function garbage(held: readonly ArtifactId[], templates: readonly TemplateRecord[], images: ImageSettings, now: number): readonly PortableArtifactId[] {
  const newestReady = new Map<ProjectId, ReadyTemplate>();
  for (const t of templates) {
    if (t.state !== "ready") continue;
    const newest = newestReady.get(t.key.project);
    if (newest === undefined || t.builtAt > newest.builtAt) newestReady.set(t.key.project, t);
  }
  const keepTemplate = (id: TemplateId): boolean => templates.some((t) => t.id === id && (
    t.state === "building"
    || (t.state === "ready" && (now - t.builtAt < templateMaxAgeMs || newestReady.get(t.key.project) === t))
  ));
  const heldTemplates = held.filter(isTemplateId);
  const backsTemplate = (id: ImageId): boolean => templates.some((t) => t.key.image === id && (t.state === "building" || heldTemplates.includes(t.id)));
  return held.filter((id): id is PortableArtifactId => isTemplateId(id)
    ? !keepTemplate(id)
    : isImageId(id) && id !== images.current && !backsTemplate(id));
}
const isTemplateId = (id: ArtifactId): id is TemplateId => id.startsWith("tpl-");
const isImageId = (id: ArtifactId): id is ImageId => id.startsWith("img-");
