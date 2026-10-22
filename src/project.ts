/**
 * Project config contract: what the repo declares, what Nexus stores, and what a pylon is told.
 *
 * Ownership:
 * - The repo owns how to build and run the project: .nexus/setup, .nexus/resume, .nexus/services.yaml.
 *   Nexus has its own directory, so no other tool that auto-runs `.agents/setup` (pi-sandbox runs it as
 *   root) fights over the same files.
 * - Nexus owns where and with what access: the Project record. Secret values live only on nodes.
 * - The control plane renders everything the agent sees about its pylon (the overlay) from records and
 *   ships it in the spawn job. The probe writes those files without reading them.
 */
import type { NodeName, PylonId } from "./protocol.ts";
import type { CheckpointId, ImageId, TemplateId } from "./images.ts";

export type ProjectId = string & { readonly __project: unique symbol };
export type SessionHarness = "claude-code" | "pi" | "shell";

// The services file, .nexus/services.yaml.

/**
 * Nexus's own schema. It starts from pi-sandbox's `services` schema (src/contracts.ts serviceSchema),
 * so the pi-sandbox-derived backend needs only a path rewrite. The word is "preview" in the file, the
 * records, the CLI and the dashboard.
 */
export interface ServicesFile {
  services: Record<ServiceName, ServiceDecl>;
}
export type ServiceName = string; // /^[a-z0-9][a-z0-9-]{0,31}$/
export interface ServiceDecl {
  command: string; // foreground, run as `user` through a login shell
  cwd?: string; // relative to the repo root, default "."
  port?: number; // omitted: a sticky free port. Fixed ports must be unique
  env?: Record<string, string>; // may contain ${services.<name>.publicURL}. That service starts first and must have a preview
  health?: `/${string}` | "process"; // HTTP GET 2xx or 3xx, or the supervisor is alive. Default: TCP connect
  preview?: boolean | { url?: string; title?: string; description?: string };
  previews?: readonly (PreviewLink | { folder: string; links: readonly PreviewLink[] })[];
  platforms?: readonly ("linux" | "darwin")[];
  timeoutMs?: number; // readiness deadline, default 30000
}
export interface PreviewLink { url: string; title: string; description?: string }

/** Names `env` may not set. PUBLIC_URL is the https tailnet URL, because the guest sees x-forwarded-proto: http (S4). */
export const managedEnv = ["PORT", "PUBLIC_URL"] as const; // plus every NEXUS_* name, such as NEXUS_THREAD_ID

export function parseServicesFile(yamlText: string): ServicesFile {
  // TODO: strict YAML (unique keys, alias cap), schema check, reference cycle check. Boundary: callers trust the result.
  throw new Error("not implemented");
}

// The Project record, stored in Nexus.

export interface Project {
  id: ProjectId;
  repoUrl: string; // SSH. Git over SSH is terminated on the host, and the key never enters a pylon
  defaultBranch: string;
  defaultNode: NodeName;
  resources: { cpus: number; memoryGiB: number; diskGiB: number };
  allowedHosts: readonly string[];
  secrets: readonly SecretGrant[];
  logins: readonly LoginKind[];
  /** A script stored in Nexus, not the repo. It runs as user before .nexus/setup, so a project can be set up without a commit. */
  preSetup: string | null;
}
/** A secret is a name plus the hosts it may be sent to. The value lives in each node's secret file. */
export interface SecretGrant { name: string; hosts: readonly string[] }
export type LoginKind = "claude" | "chatgpt";

/** One table of the hosts each interactive login needs. Evidence: S2 and S5. */
export const loginHosts: { readonly [K in LoginKind]: readonly string[] } = {
  claude: ["api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com", "downloads.claude.ai"],
  chatgpt: ["auth.openai.com", "chatgpt.com", "api.openai.com"],
};

/** project.allowedHosts, plus loginHosts for project.logins, plus every SecretGrant host, sorted and deduped. */
export function effectiveAllowedHosts(project: Project): readonly string[] {
  return [...new Set([
    ...project.allowedHosts,
    ...project.logins.flatMap((login) => loginHosts[login]),
    ...project.secrets.flatMap((grant) => grant.hosts),
  ])].sort();
}

// What a spawn carries, split by when it applies.

export type PylonSource =
  | { kind: "template"; template: TemplateId }
  | { kind: "resume"; checkpoint: CheckpointId } // the pylon's own disk on this node
  | { kind: "fresh"; preSetup: Project["preSetup"] }; // image only: clone, preSetup and .nexus/setup inline. Used when no template exists

/** Applied only when the VM boots. Changing these on a running pylon takes effect at its next wake. */
export interface BootInputs {
  pylonId: PylonId;
  image: ImageId;
  source: PylonSource;
  resources: Project["resources"];
  network: { allowedHosts: readonly string[]; secrets: readonly SecretGrant[] };
  repo: { url: string; checkout: { branch: string; commit: string } }; // checked out on template and fresh boots only
}

/** Applied on every spawn, including to a running pylon. Hashed into LiveHash. */
export interface LiveSpec {
  previews: readonly PreviewAssignment[];
  overlay: readonly OverlayFile[];
}
/** The control plane allocates https ports from a per-node range. The probe publishes them with `tailscale serve`. */
export interface PreviewAssignment { service: ServiceName; httpsPort: number }
export interface OverlayFile { path: `/${string}`; mode: 0o644 | 0o755; owner: "user" | "root"; content: string }

// The pylon overlay, rendered by the control plane.

export interface PylonOverlay {
  pylonId: PylonId;
  threadId: string;
  project: ProjectId;
  node: NodeName;
  allowedHosts: readonly string[];
  previews: readonly { service: ServiceName; url: string }[]; // https://<node>.<tailnet>.ts.net:<port>/
  logins: readonly LoginKind[];
  /** The common dotfiles layer. Every boot pulls it before relaunching sessions. The image bakes a fallback copy. */
  dotfiles: { repo: string; ref: string };
}

/**
 * Renders three files:
 * - /etc/profile.d/nexus.sh: NEXUS_PYLON=1, NEXUS_PYLON_ID, NEXUS_THREAD_ID, NEXUS_PROJECT, NEXUS_NODE, NEXUS_API.
 * - /home/user/.nexus/pylon.json: the same facts for `nexus info --json`.
 * - /home/user/.nexus/PYLON.md: prose for the agent. It is in a pylon, which hosts it can reach and that
 *   everything else is blocked, its preview URLs, that work survives sleep only on disk, how to declare
 *   outputs, and that logins use the device-code flow (S5: the browser callback listens inside the guest).
 *   The common dotfiles layer imports this file from ~/.claude/CLAUDE.md and ~/.pi/agent/AGENTS.md,
 *   so the overlay never edits dotfiles.
 */
export function renderOverlay(overlay: PylonOverlay): readonly OverlayFile[] {
  throw new Error("not implemented");
}

// In-pylon commands. The `nexus` CLI in the image calls the probe at NEXUS_API.

/**
 * NEXUS_API is http://nexus.pylon. Gondolin's onRequest hook answers that host from the probe on the node
 * (pi-sandbox change 4), so the call never leaves the machine and needs no tailnet route. The probe knows
 * which pylon is calling from the VM the request came through, so the guest holds no token.
 * If change 4 is refused, the fallback is a file pair with one writer each: the CLI writes requests under
 * /run/nexus/requests/ and the probe polls them through Gondolin's file API and writes the replies.
 */
export type PylonApiRequest =
  | { op: "info" }
  | { op: "services"; action: "ensure" | "list" | "restart" | "stop"; name?: ServiceName }
  | { op: "service-logs"; name: ServiceName; lines: number }
  | { op: "service-start"; name: ServiceName; decl: ServiceDecl } // ad hoc. Rejects declared names
  | { op: "preview"; port: number; title?: string }
  | { op: "output-add"; output: { kind: "file"; path: string; title?: string } | { kind: "diff"; title?: string } }
  | { op: "output-list" };

/**
 * `services ensure` and `preview` wait up to 30 s for a preview URL. A new preview needs an https port,
 * which only the control plane allocates. The probe reports the new service, the control plane sends a
 * spawn with a new LiveSpec, the probe publishes and warms the URL (S4's first request timed out), and only
 * then does the command return it. Declared outputs are recorded in the guest under /home/user/.nexus/outputs/
 * and surface through the next observation. Responses are the CLI's --json output.
 */
