/**
 * Template image contract: the base pylon image, project templates, and how both reach nodes.
 *
 * Everything a node stores is an immutable, content-named artifact. The control plane decides what gets
 * built, where, and which node fetches what. Probes only build, serve, fetch and drop on command.
 * Dependencies run one way: a checkpoint or template depends on its image, never the reverse.
 */
import { z } from "zod";
import { canonicalSha256, type PylonResources } from "./spawn.ts";
import type { ImageId, NodeName, ProjectId, TemplateId } from "./ids.ts";

// Temporary: the artifact IDs moved to ids.ts, and E1 deletes this re-export.
export type { ArtifactId, CheckpointId, ImageId, PortableArtifactId, TemplateId } from "./ids.ts";

// The base image.

/**
 * Lives in this repo under images/pylon/ and is sent inline in the build-image job:
 * - Dockerfile, in layer order:
 *   1. debian:bookworm-slim pinned by digest (glibc, which Amp's image contract also requires).
 *   2. apt: bash, coreutils, util-linux, ca-certificates, git, python3, openssh-server (S2: enableSsh
 *      needs a real sshd), openssh-client (git over Gondolin's SSH proxy), sudo, curl. The service is installed but not enabled. Also procps (enableSsh's
 *      script runs ps), e2fsprogs (rootfs growth runs resize2fs), ripgrep and fd (pi cannot download them
 *      through the allowlist), xz-utils for the Node tarball, libatomic1, which Node 26's binary links, tini,
 *      which rootfs-init-extra.sh makes PID 1 because sandboxd does not reap the orphans it adopts, and kmod for
 *      nexus-kvm.
 *   3. `user`, UID 1000, passwordless sudo, /home/user/workspace.
 *   4. Node from the checksum-verified official tarball into /usr/local.
 *   5. Claude Code and pi from npm, Herdr from its official installer into /usr/local/bin,
 *      `herdr integration install` for pi and Claude Code as user (the sessions stream reads harness session
 *      IDs through them), the pi-env daemon at /usr/local/libexec/nexus/pi-env, the in-pylon `nexus` CLI,
 *      nexus-kvm at /usr/local/libexec/nexus/nexus-kvm, and
 *      the fallback copy of the common dotfiles layer as a git repository at /opt/nexus/dotfiles, owned by
 *      user, which boots clone and then fetch.
 *      `gondolin build` itself installs the `sandboxssh` helper that pi-sandbox's shell needs.
 *   6. gh from its checksum-verified release tarball, set in /etc/gitconfig as git's credential helper for
 *      https://github.com, so a GH_TOKEN grant pushes over HTTPS, and Neovim from its checksum-verified release
 *      tarball into /usr/local.
 *   7. The agent setup in agent-setup/manifest.json (images/pylon/agent-setup/manifest.ts), installed as user by
 *      agent-setup/install.ts, then Herdr's integrations, then ~/.claude/CLAUDE.md importing ~/.nexus/PYLON.md and
 *      ~/.pi/agent/AGENTS.md linking to it.
 * - gondolin.json: distro alpine for the kernel and initramfs, and env with PATH including /usr/local/bin
 *   (Gondolin's exec PATH lacks it, S1), NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt (the mitm
 *   CA is unreadable to user, S2), and PI_OFFLINE and CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL,
 *   since pi's update checks and Claude Code's official marketplace cannot pass the allowlist. Gondolin sources that env before sandboxd starts and from /etc/profile.d,
 *   so execs and login shells both see it. buildImage adds oci.image = the Docker build, and postBuild.copy
 *   of the kernel module seed into /lib/modules (the S1 workaround), and init.rootfsInitExtra.
 * - rootfs-init-extra.sh: run as root by Gondolin's /init before sandboxd. It sets the hostname pylon and
 *   writes /etc/hostname and /etc/hosts, because Gondolin sets no hostname and sudo warns without one. It then
 *   execs tini as PID 1 with sandboxd as its child, so every orphan in the guest is reaped, and ignores SIGPIPE
 *   first, which sandboxd does not handle and as PID 1 never received.
 * - nexus-kvm: run as root by the pylon-vm controller on every boot of a pylon whose boot spec asks for
 *   nestedVirtualization (src/pylon-vm/runtime.ts). It loads kvm_intel or kvm_amd for the guest's CPU, with kvm and
 *   irqbypass, and overlay, and opens /dev/kvm to user, or fails the boot with the reason. An ordinary pylon never runs it.
 * - pins.json: ImageRecipe.pins. Every other file except build.sh is in ImageRecipe.files, with the mode git gives
 *   it, 0755 when executable and 0644 otherwise, because Docker's COPY keeps a file's mode.
 * Logins and secrets are never in the image.
 */
export interface ImageRecipe {
  files: readonly { path: string; mode: 0o644 | 0o755; content: string }[];
  pins: {
    debianDigest: string;
    node: string; // "26.12.1"
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
    neovim: string; // "0.12.6". The review-pane Claude Code mod needs 0.10 or later, and bookworm ships 0.7
    neovimSha256: string; // of nvim-linux-x86_64.tar.gz, that release asset's digest on GitHub
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
  neovim: z.string().regex(/^\d+\.\d+\.\d+$/),
  neovimSha256: z.string().regex(/^[0-9a-f]{64}$/),
}) satisfies z.ZodType<ImageRecipe["pins"]>;

/** File order does not change the ID. Two files at one path are a broken recipe and throw. */
export function imageIdOf(recipe: ImageRecipe): ImageId {
  const files = [...recipe.files].sort((a, b) => compare(a.path, b.path));
  const duplicate = files.find((file, i) => i > 0 && files[i - 1]!.path === file.path);
  if (duplicate !== undefined) throw new Error(`the image recipe has two files at ${duplicate.path}`);
  return `img-${canonicalSha256({ files, pins: recipe.pins }).slice(0, 12)}`;
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

export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface TemplateBuildInputs {
  key: TemplateKey;
  repo: { url: string; branch: string; commit: string };
  preSetup: string | null;
  allowedHosts: readonly string[]; // no secrets during setup, as in Amp
  resources: PylonResources;
}

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
