/**
 * Where a Nexus node keeps its releases, configs and state, who owns them, and the units that run them.
 * deploy/release.sh, the deploy scripts and the units name the same paths, and src/node-layout.test.ts checks them
 * against these. The bootstrap deployer and the installers load this before npm ci, so it imports only Node's
 * builtins and modules that do too.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fullCommit } from "./protocol/deploy.ts";

export const prefix = "/opt/nexus";
export const etc = "/etc/nexus";
export const unitDir = "/etc/systemd/system";

/** The system users the probe and the control plane run as. Each owns its state directory, which is its home. */
export const users = { probe: "nexus", control: "nexus-control" } as const;
export const stateDirs = { probe: "/var/lib/nexus", control: "/var/lib/nexus-control", backup: "/var/lib/nexus-backup" } as const;

export const configFiles = {
  control: join(etc, "control.json"),
  controlPlane: join(etc, "control-plane.json"),
  probe: join(etc, "probe.json"),
  deployer: join(etc, "deployer.json"),
  secrets: join(etc, "secrets.env"),
  githubToken: join(etc, "github-token"),
  gitKey: join(etc, "git_ed25519"),
  gitKnownHosts: join(etc, "git_known_hosts"),
} as const;

/** The units' PATH, which must hold Node 26. */
export const servicePath = "/usr/local/bin:/usr/bin";
/** What a root child process of the installers and the deployer searches. */
export const rootPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const unitNames = { probe: "nexus-probe.service", control: "nexus-control.service", backup: "nexus-backup.service" } as const;

/** The links under the prefix into releases/, and who runs the release each names. */
export const links = { current: "the probe", "control-current": "the control plane", "deployer-current": "the deployer's worker" } as const;
export type LinkName = keyof typeof links;
export const roleLinks = { probe: "current", control: "control-current" } as const satisfies Record<string, LinkName>;
export const deployerLink: LinkName = "deployer-current";

/** Where release.sh installs each release, relative to the prefix. */
export const releasesDir = "releases";

/** The deployer's files, relative to the prefix. */
export const deployerFiles = {
  lock: "deployer/lock",
  roles: "deployer/roles",
  repo: "deployer/repo",
  rejected: "deployer/rejected",
  releaseBytes: "deployer/release-bytes.json",
} as const;
/** Each role's install journal, relative to the prefix. */
export const deployJournal = (role: keyof typeof roleLinks) => `${role}-deploy.json`;

/** The probe writes it to start the deployer, and deploy/nexus-deployer.path watches it. */
export const deployerWakeFile = join(stateDirs.probe, "deployer-wake");
export const backupStatusFile = join(stateDirs.backup, "status.json");

/** A release is named by its content hash, as release.sh cuts it, or by the full commit the deployer installed. */
export const releaseName = /^(?:[0-9a-f]{12}|[0-9a-f]{40})$/;

/** The file release.sh writes at the root of the release in `dir`, naming the commit it was built from. */
export const releaseCommitFile = (dir: string) => join(dir, "release-commit");

/** The commit a `release-commit` file names, or null when it holds no full commit. */
export function parseReleaseCommit(text: string): string | null {
  const commit = text.trim();
  return fullCommit.test(commit) ? commit : null;
}

/** The commit the release in `dir` was built from, or null when it records none that can be read. */
export async function readReleaseCommit(dir: string): Promise<string | null> {
  return parseReleaseCommit(await readFile(releaseCommitFile(dir), "utf8").catch(() => ""));
}
