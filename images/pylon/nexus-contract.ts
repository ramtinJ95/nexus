/**
 * The pylon guest as the image makes it: where the user's files live, where the image installs its tools, and what
 * the in-pylon API and the image's helpers agree on. It imports nothing, so the helpers load it at run time from
 * beside them in helpersDir, and the probe, the backends, the image build and the control plane import it from the
 * repo. The image ships this file, so a change to it is a new image. How the probe drives the guest is in
 * src/guest-contract.ts. The Dockerfile, gondolin.json and rootfs-init-extra.sh cannot import it, and
 * src/image/nexus-contract.test.ts holds them to it.
 */

export const home = "/home/user";
export const workspaceDir = `${home}/workspace`;
/** Where the repository is checked out in every pylon. */
export const checkoutDir = `${workspaceDir}/repo`;
export const servicesFile = `${checkoutDir}/.nexus/services.yaml`;

export const pylonInfoFile = `${home}/.nexus/pylon.json`;
/** Written on every spawn. The image points Claude Code's CLAUDE.md and pi's AGENTS.md at it. */
export const pylonGuideFile = `${home}/.nexus/PYLON.md`;
export const sessionsFile = `${home}/.nexus/sessions.json`;
export const claudeLaunchesDir = `${home}/.nexus/claude-launches`;
export const outputsDir = `${home}/.nexus/outputs`;
/** The dotfiles layer every boot pulls into, cloned first from bakedDotfilesDir. */
export const dotfilesDir = `${home}/.nexus/dotfiles`;
export const claudeProjects = `${home}/.claude/projects`;
export const piSessions = `${home}/.pi/agent/sessions`;

export const bakedDotfilesDir = "/opt/nexus/dotfiles";
export const agentSetupInstaller = "/opt/nexus/agent-setup/install.ts";
export const piEnv = "/usr/local/libexec/nexus/pi-env";
/** Run as root at boot by a pylon that asks for nested virtualization. */
export const nexusKvm = "/usr/local/libexec/nexus/nexus-kvm";
/** Where the image installs its helpers, which import each other and this file from beside them. */
export const helpersDir = "/usr/local/bin";
export const nexusCli = `${helpersDir}/nexus`;
/** Claude Code's hook, which the control plane also runs through the probe. */
export const claudeHook = `${helpersDir}/nexus-claude-hook`;
/** Carries the hook's events to NEXUS_API. Every boot starts it for the events a pause left behind. */
export const nexusOutbox = `${helpersDir}/nexus-outbox.ts`;
export const nexusTurn = `${helpersDir}/nexus-turn.ts`;
/** The image's copy of checkout-files.py, which the control plane reads a turn's snapshot back with. */
export const checkoutHelper = "/usr/local/lib/nexus/checkout-files.py";

/** The host the guest's NEXUS_API names. Each backend's host bridge answers it on the node, so it needs no allowlist entry or DNS name. */
export const bridgeHost = "nexus.pylon";
export const nexusApi = `http://${bridgeHost}`;
/** The one path under NEXUS_API. Each call POSTs a PylonApiRequest (src/probe/pylon-api.ts). */
export const bridgeRequestPath = "/v1/request";

export const sessionKinds = ["session.turn-started", "session.heartbeat", "session.turn-ended", "session.waiting", "session.ended"] as const;
export const maxSessionLength = 200;
export const maxEventMessageLength = 2048;
/** Set by the pylon's outbox on each event, and kept when it sends the event again. */
export const eventIdPattern = /^[0-9a-z-]{1,64}$/;

/** What the control plane writes to pylonInfoFile, and `nexus info` prints. */
export interface PylonInfo {
  pylonId: string;
  threadId: string;
  project: string;
  node: string;
  api: string;
  allowedHosts: readonly string[];
  previews: readonly { service: string; url: string }[];
  logins: readonly ("claude" | "chatgpt")[];
  dotfiles?: { repo: string; ref: string };
}

/**
 * What the control plane hands `nexus-claude-hook answer`: the session and question texts that name the ask, the
 * call's ID, and Claude's `answers` and `annotations`. An answer maps each question's text to the picked labels and
 * the person's own answer, joined with ", ".
 */
export interface AskAnswer {
  session: string;
  questions: readonly string[];
  toolUseId: string;
  answers: Readonly<Record<string, string>>;
  annotations: Readonly<Record<string, { notes?: string }>>;
}

/**
 * `nexus-claude-hook answer`'s exit codes. A delivery also prints answerDelivered, since the hook of an image from
 * before asks exits 0 for a kind it does not know.
 */
export const answerExits = { delivered: 0, nobodyWaits: 20, answeredOtherwise: 21, malformed: 64 } as const;
export const answerDelivered = "delivered";

/** The most `nexus-claude-hook asks` prints. */
export const maxAsksBytes = 1 << 20;

/** The control plane expects this ID for the latest session.turn-started it recorded, so the hook stamps both with `at`. */
export const claudeTurn = (session: string, at: number): string => `claude:${session}:${at}`;
