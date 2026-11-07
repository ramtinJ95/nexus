/** What a spawn carries, split by when it applies. */
import { z } from "zod";
import { canonicalSha256 } from "./util/canonical-sha256.ts";
import type { CheckpointId, ImageId, LiveHash, PortableArtifactId, PylonId, TemplateId } from "./ids.ts";
import type { SecretGrant } from "./secret-grants.ts";
import type { ServiceName } from "./services-file.ts";

export const gitIdentitySchema = z.strictObject({
  name: z.string().trim().min(1).refine((s) => !/[\x00-\x1f\x7f]/.test(s), "must be a single line"),
  email: z.email(),
});
export type GitIdentity = z.infer<typeof gitIdentitySchema>;

/** The CPUs, memory and disk a pylon boots with. */
export interface PylonResources { cpus: number; memoryGiB: number; diskGiB: number }

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
  network: { allowedHosts: readonly string[]; secrets: readonly SecretGrant[] };
  repo: RepoInit; // set up on template and fresh boots only
  dotfiles: { repo: string; ref: string }; // pulled on every boot
}

/** The image first, because a template or checkpoint is an overlay on it. */
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
export interface PreviewAssignment { service: ServiceName; httpsPort: number }
export interface OverlayFile { path: `/${string}`; mode: 0o644 | 0o755; owner: "user" | "root"; content: string }
