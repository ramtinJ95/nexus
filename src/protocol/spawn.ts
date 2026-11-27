/** What a spawn carries, split by when it applies. */
import { z } from "zod";
import { canonicalSha256 } from "../util/canonical-sha256.ts";
import type { CheckpointId, ImageId, LiveHash, PortableArtifactId, PylonId, TemplateId } from "../ids.ts";
import type { SecretGrant } from "./secret-grants.ts";

export const gitIdentitySchema = z.strictObject({
  name: z.string().trim().min(1).refine((s) => !/[\x00-\x1f\x7f]/.test(s), "must be a single line"),
  email: z.email(),
});
export type GitIdentity = z.infer<typeof gitIdentitySchema>;

export interface PylonResources { cpus: number; memoryGiB: number; diskGiB: number }

/**
 * The least memory a pylon VM boots with, which the pylon-vm backend enforces and the API refuses below. Measured in
 * the pylon-vm slice: 3 GiB boots, 4, 8, 12 and 16 GiB pass the whole slice, and 2 GiB hangs at "ACPI: Core revision".
 */
export const minPylonMemoryGiB = 3;
export const minPylonMemoryReason = `pylon VMs need at least ${minPylonMemoryGiB} GiB: a 2 GiB Gondolin 0.13.0 guest hangs at boot on infra-testbench`;

export type PylonSource =
  | { kind: "template"; template: TemplateId }
  | { kind: "resume"; checkpoint: CheckpointId } // the pylon's own disk on this node
  | { kind: "fresh"; preSetup: string | null }; // image only: clone or init, preSetup and .nexus/setup inline. Used when no template exists

export interface Checkout { branch: string; commit: string }
/**
 * What a fresh or template boot puts at /home/user/workspace/repo, decided once when the thread starts. An empty
 * repository has a branch and no commit, so "check out a commit of a repo that has none" cannot be written down.
 */
export type RepoInit =
  | { kind: "clone"; url: string; checkout: Checkout }
  | { kind: "empty"; branch: string };
export type CloneRepo = Extract<RepoInit, { kind: "clone" }>;

/** Applied only when the VM boots. Changing these on a running pylon takes effect at its next wake. */
export interface BootInputs {
  gitIdentity?: GitIdentity | undefined;
  pylonId: PylonId;
  image: ImageId;
  source: PylonSource;
  /** `nestedVirtualization` loads the KVM modules at boot, which only a node that reports it can give. */
  resources: PylonResources & { nestedVirtualization?: true };
  /** `defaultBranch` is the project's, which an owner boot's GitHub guard refuses pushes to. A pylon stored before it has none. */
  network: { allowedHosts: readonly string[]; secrets: readonly SecretGrant[]; defaultBranch?: string | undefined };
  /**
   * On a shared install, the hosts in `network.allowedHosts` that the pylon's owner added at its start, so the control
   * plane can tell them from its project's. The probe does not read it.
   */
  ownerHosts?: readonly string[] | undefined;
  repo: RepoInit; // set up on template and fresh boots only
  /** Pulled on every boot. Absent, a boot keeps the image's baked layer. */
  dotfiles?: { repo: string; ref: string } | undefined;
}

/** The image first, because a template or checkpoint is an overlay on it. */
/** Whether a pylon booted with its owner's logins, which only a start on a shared install gives it. */
export const ownerBoot = (boot: Pick<BootInputs, "network">) => boot.network.secrets.some((grant) => grant.owner === true);

/** Whether git reaches `url` over SSH: `ssh://`, or git's scp-like `[user@]host:path`, with a colon before any slash. */
export const sshGitUrl = (url: string) => url.startsWith("ssh://") || /^(?:[^@/:]+@)?[^@/:]+:(?!\/\/)/.test(url);

/**
 * Why a boot with its owner's logins cannot boot, or null. Git on a shared install goes over HTTPS only, so the
 * owner's GH_TOKEN placeholder authenticates it and every push passes the HTTP hook. Over SSH it would push with the
 * node's one key, as whichever person, where no HTTP hook sees it. A solo install keeps SSH.
 */
export function sshRefusal(boot: Pick<BootInputs, "network" | "repo" | "dotfiles">): string | null {
  if (!ownerBoot(boot)) return null;
  const ssh = [
    ...boot.repo.kind === "clone" && sshGitUrl(boot.repo.url) ? [`the project's repoUrl ${boot.repo.url} is SSH, so an admin adds the project again with its https:// URL`] : [],
    ...boot.dotfiles !== undefined && sshGitUrl(boot.dotfiles.repo) ? [`the dotfiles repo ${boot.dotfiles.repo} is SSH, so an admin sets an https:// one in control.json`] : [],
  ];
  return ssh.length === 0 ? null : `git on a shared install goes over HTTPS only, and ${ssh.join("; and ")}`;
}

export function requiredArtifacts(boot: BootInputs): readonly PortableArtifactId[] {
  return boot.source.kind === "template" ? [boot.image, boot.source.template] : [boot.image];
}

/** Applied on every spawn, including to a running pylon. Hashed into LiveHash. */
export interface LiveSpec {
  previews: readonly PreviewAssignment[];
  overlay: readonly OverlayFile[];
}
/** sha256 of the LiveSpec with sorted keys, so equal specs hash equally however they were built. */
export function liveHashOf(live: LiveSpec): LiveHash {
  return canonicalSha256(live) as LiveHash;
}

/** The control plane allocates https ports from a per-node range. The probe publishes them with `tailscale serve`. */
export interface PreviewAssignment { service: string; httpsPort: number }
export interface OverlayFile { path: `/${string}`; mode: 0o644 | 0o755; owner: "user" | "root"; content: string }
