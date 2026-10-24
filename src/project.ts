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
import { createHash } from "node:crypto";
import { isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
import type { LiveHash, NodeName, PylonId } from "./protocol.ts";
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
/** The name a port linked with `nexus preview <port>` is reported and previewed under. */
export const linkedName = (port: number): ServiceName => `port-${port}`;
/** The port of a service named as linkedName names one, or null for any other name. */
export function linkedPort(service: ServiceName): number | null {
  const m = /^port-([1-9]\d{0,4})$/.exec(service);
  return m === null ? null : Number(m[1]);
}
/**
 * Nexus's own listeners in every pylon: the sshd that Gondolin's enableSsh starts for streams and terminals. They
 * are never reported as listening, and never linked.
 */
export const reservedPorts: ReadonlySet<number> = new Set([22]);
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

/**
 * The boundary for .nexus/services.yaml: callers trust the result. Throws on a file over 1 MiB, duplicate
 * keys, a key that is not a string (`1:` and `"1":` would collapse), more than 20 alias expansions, any field
 * or value the schema does not allow, a duplicate fixed port, and an env value whose `${services.`
 * reference is malformed, names a service without a preview, or closes a cycle.
 * Every file it accepts is one the pi-sandbox-derived backend in src/pylon-vm/contracts.ts accepts, so this
 * mirrors that schema's restrictions, its Amp-derived ones included. Omitted fields stay omitted: the
 * defaults in ServiceDecl are applied where the service runs.
 */
export function parseServicesFile(yamlText: string): ServicesFile {
  if (Buffer.byteLength(yamlText) > maxServicesFileBytes) throw new Error(`invalid .nexus/services.yaml: larger than ${maxServicesFileBytes} bytes`);
  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`invalid .nexus/services.yaml: ${document.errors.map((e) => e.message).join("; ")}`);
  visit(document, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error(`invalid .nexus/services.yaml: key ${String(pair.key)} is not a string`);
    },
  });
  const parsed = servicesFileSchema.safeParse(document.toJS({ maxAliasCount: 20 }));
  if (!parsed.success) throw new Error(`invalid .nexus/services.yaml:\n${z.prettifyError(parsed.error)}`);
  // Zod types an optional field as `T | undefined`, but it never adds a key the file lacks.
  return parsed.data as ServicesFile;
}

const maxServicesFileBytes = 1_048_576;
const serviceName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const isManaged = (name: string): boolean => (managedEnv as readonly string[]).includes(name) || name.startsWith("NEXUS_");
// The name checks are on the record, not the key schema, because Zod reports a failed key only as "Invalid key in record".
const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).superRefine((vars, ctx) => {
  for (const name of Object.keys(vars)) {
    if (isManaged(name)) ctx.addIssue({ code: "custom", path: [name], message: `${name} is managed by Nexus` });
    // The backend refuses Amp's thread variable.
    if (name === "AMP_THREAD_ID") ctx.addIssue({ code: "custom", path: [name], message: "AMP_THREAD_ID is not available" });
  }
});
/** The backend refuses Amp's identity placeholder in any preview url, title or description. */
const previewText = z.string().refine((s) => !s.includes("$AMP_USER_EMAIL"), "$AMP_USER_EMAIL is not available");
/** A path on the service's own origin, or an absolute http(s) URL, as pi-sandbox allows. */
const previewUrl = previewText.refine((s) => {
  if (s.startsWith("/")) return !s.startsWith("//");
  return URL.canParse(s) && ["http:", "https:"].includes(new URL(s).protocol);
}, "must be a path starting with / or an http(s) URL");
const previewLink = z.strictObject({ url: previewUrl, title: previewText.min(1), description: previewText.optional() });
/** One service as the services file declares it. The in-pylon API parses `service-start` with it too. */
export const serviceDecl = z.strictObject({
  command: z.string().min(1),
  cwd: z.string().refine((s) => !s.includes("\0") && !s.startsWith("/") && !s.split("/").includes(".."), "must be a path inside the repo").optional(),
  port: z.int().min(1).max(65535).optional(),
  env: env.optional(),
  health: z.union([z.templateLiteral(["/", z.string()]), z.literal("process")]).optional(),
  preview: z.union([
    z.boolean(),
    z.strictObject({ url: previewUrl.optional(), title: previewText.min(1).optional(), description: previewText.optional() }),
  ]).optional(),
  previews: z.array(z.union([previewLink, z.strictObject({ folder: z.string().min(1), links: z.array(previewLink).min(1) })]))
    .refine((links) => {
      const folders = links.flatMap((link) => "folder" in link ? [link.folder] : []);
      return new Set(folders).size === folders.length;
    }, "folder names must be unique")
    .optional(),
  platforms: z.array(z.enum(["linux", "darwin"])).min(1).optional(),
  timeoutMs: z.int().min(100).max(120_000).optional(),
});

/** Matches every `${services.`. The group is set only for a whole reference, so a typo or a missing `}` cannot pass as a literal. */
const serviceReference = /\$\{services\.(?:([a-z0-9][a-z0-9-]{0,31})\.publicURL\})?/g;
const hasPreview = (decl: z.output<typeof serviceDecl>): boolean => Boolean(decl.preview) || (decl.previews?.length ?? 0) > 0;

const servicesFileSchema = z.strictObject({ services: z.record(serviceName, serviceDecl) }).superRefine(({ services }, ctx) => {
  const portOwner = new Map<number, string>();
  for (const [name, decl] of Object.entries(services)) {
    if (decl.port === undefined) continue;
    const owner = portOwner.get(decl.port);
    if (owner !== undefined) ctx.addIssue({ code: "custom", path: ["services", name, "port"], message: `port ${decl.port} is also fixed by ${owner}` });
    portOwner.set(decl.port, name);
  }

  const dependencies = new Map<string, string[]>();
  for (const [name, decl] of Object.entries(services)) {
    const names: string[] = [];
    for (const [key, value] of Object.entries(decl.env ?? {})) {
      for (const [whole, target] of value.matchAll(serviceReference)) {
        const path = ["services", name, "env", key];
        if (target === undefined) ctx.addIssue({ code: "custom", path, message: `${JSON.stringify(value)} has a \${services. that is not a whole \${services.<name>.publicURL} reference` });
        else if (services[target] === undefined || !hasPreview(services[target])) ctx.addIssue({ code: "custom", path, message: `${whole} names ${target}, which is not a declared service with a preview` });
        else names.push(target);
      }
    }
    dependencies.set(name, names);
  }

  // Depth-first search. A service met again while it is still on the stack closes a cycle.
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (done.has(name)) return;
    const at = stack.indexOf(name);
    if (at !== -1) {
      ctx.addIssue({ code: "custom", path: ["services", name, "env"], message: `publicURL references form a cycle: ${[...stack.slice(at), name].join(" -> ")}` });
      return;
    }
    stack.push(name);
    for (const next of dependencies.get(name)!) visit(next);
    stack.pop();
    done.add(name);
  };
  for (const name of dependencies.keys()) visit(name);
});

// The Project record, stored in Nexus.

export interface Project {
  id: ProjectId;
  /**
   * SSH or HTTPS, or null for a scratch project: its pylons start from `git init` on defaultBranch, nothing is
   * fetched, and nothing is kept once the thread is deleted unless the agent pushed it somewhere. Git over SSH is
   * terminated on the host, and the key never enters a pylon.
   */
  repoUrl: string | null;
  /** The branch threads check out, or the first branch of a scratch project's empty repository. */
  defaultBranch: string;
  defaultNode: NodeName;
  resources: { cpus: number; memoryGiB: number; diskGiB: number };
  allowedHosts: readonly string[];
  secrets: readonly SecretGrant[];
  logins: readonly LoginKind[];
  /** A script stored in Nexus, not the repo. It runs as user before .nexus/setup, so a project can be set up without a commit. */
  preSetup: string | null;
}
/** Templates mirror a remote, so they take a project that has one. */
export type RemoteProject = Project & { repoUrl: string };
export const hasRemote = (project: Project): project is RemoteProject => project.repoUrl !== null;
/** A secret is a name plus the hosts it may be sent to. The value lives in each node's secret file. */
export interface SecretGrant { name: string; hosts: readonly string[] }
/** The grant `gh`, and git through gh's credential helper, need to create GitHub repositories and push to them. */
export const githubTokenGrant: SecretGrant = { name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] };
export type LoginKind = "claude" | "chatgpt";

/**
 * One table of the hosts each interactive login needs. Evidence: S2 and S5, and for Claude Code the required hosts
 * that code.claude.com/docs/en/network-config lists for a claude.ai login. platform.claude.com takes the OAuth
 * token exchange and refresh too. Its optional hosts are left out, such as Datadog telemetry and claude.ai connectors.
 */
export const loginHosts: { readonly [K in LoginKind]: readonly string[] } = {
  claude: ["api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com", "downloads.claude.ai"],
  chatgpt: ["auth.openai.com", "chatgpt.com", "api.openai.com"],
};

/**
 * project.allowedHosts, plus the host of an HTTPS repoUrl, plus loginHosts for project.logins, plus every
 * SecretGrant host, sorted and deduped. Setup clones the repo through the allowlist, so a project always
 * reaches its own HTTPS host. An SSH repoUrl adds nothing: SSH egress reaches only the pylon's own remotes.
 * A scratch project adds nothing either.
 */
export function effectiveAllowedHosts(project: Project): readonly string[] {
  return withHttpsHosts([
    ...project.allowedHosts,
    ...project.logins.flatMap((login) => loginHosts[login]),
    ...project.secrets.flatMap((grant) => grant.hosts),
  ], project.repoUrl === null ? [] : [project.repoUrl]);
}

/** A repo or dotfiles URL as Nexus accepts it, so withHttpsHosts can read the host of any HTTPS one. */
export const gitUrl = z.string().min(1).refine((url) => !url.startsWith("https://") || URL.canParse(url), "an https:// git URL must be a valid URL");

/** `hosts` plus the host of each HTTPS git URL in `urls`, sorted and deduped. */
export function withHttpsHosts(hosts: readonly string[], urls: readonly string[]): readonly string[] {
  const httpsHosts = urls.flatMap((url) => url.startsWith("https://") ? [new URL(url).hostname] : []);
  return [...new Set([...hosts, ...httpsHosts])].sort();
}

// What a spawn carries, split by when it applies.

export type PylonSource =
  | { kind: "template"; template: TemplateId }
  | { kind: "resume"; checkpoint: CheckpointId } // the pylon's own disk on this node
  | { kind: "fresh"; preSetup: Project["preSetup"] }; // image only: clone or init, preSetup and .nexus/setup inline. Used when no template exists

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
  pylonId: PylonId;
  image: ImageId;
  source: PylonSource;
  resources: Project["resources"];
  network: { allowedHosts: readonly string[]; secrets: readonly SecretGrant[] };
  repo: RepoInit; // set up on template and fresh boots only
  dotfiles: PylonOverlay["dotfiles"]; // pulled on every boot
}

/** Applied on every spawn, including to a running pylon. Hashed into LiveHash. */
export interface LiveSpec {
  previews: readonly PreviewAssignment[];
  overlay: readonly OverlayFile[];
}
/** sha256 of the LiveSpec with sorted keys, so equal specs hash equally however they were built. */
export function liveHashOf(live: LiveSpec): LiveHash {
  const canonical = (value: unknown): unknown => typeof value !== "object" || value === null ? value
    : Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return createHash("sha256").update(JSON.stringify(canonical(live))).digest("hex") as LiveHash;
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
  /** The pylon's frozen BootInputs.repo, so the guide describes this checkout. */
  repo: RepoInit;
  /** Names and hosts, never values, so the guide can say what each token is for. From BootInputs.network.secrets. */
  secrets: readonly SecretGrant[];
}

/**
 * Renders three files:
 * - /etc/profile.d/nexus.sh: NEXUS_PYLON=1, NEXUS_PYLON_ID, NEXUS_THREAD_ID, NEXUS_PROJECT, NEXUS_NODE, NEXUS_API.
 * - /home/user/.nexus/pylon.json: the same facts for `nexus info --json`.
 * - /home/user/.nexus/PYLON.md: prose for the agent. It is in a pylon, where its repository came from and how to
 *   commit and publish from it, which hosts it can reach and that everything else is blocked, the names and hosts
 *   of its secrets, its preview URLs, that work survives sleep only on disk, how to declare
 *   outputs, and that logins use the device-code flow (S5: the browser callback listens inside the guest).
 *   The image imports this file from ~/.claude/CLAUDE.md and links it as ~/.pi/agent/AGENTS.md, so the
 *   overlay never edits dotfiles.
 */
export function renderOverlay(overlay: PylonOverlay): readonly OverlayFile[] {
  const env = {
    NEXUS_PYLON: "1",
    NEXUS_PYLON_ID: overlay.pylonId,
    NEXUS_THREAD_ID: overlay.threadId,
    NEXUS_PROJECT: overlay.project,
    NEXUS_NODE: overlay.node,
    NEXUS_API: nexusApi,
  };
  const info = {
    pylonId: overlay.pylonId,
    threadId: overlay.threadId,
    project: overlay.project,
    node: overlay.node,
    api: nexusApi,
    allowedHosts: overlay.allowedHosts,
    previews: overlay.previews,
    logins: overlay.logins,
    dotfiles: overlay.dotfiles,
  };
  return [
    { path: "/etc/profile.d/nexus.sh", mode: 0o644, owner: "root", content: Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}\n`).join("") },
    { path: "/home/user/.nexus/pylon.json", mode: 0o644, owner: "user", content: JSON.stringify(info, null, 2) + "\n" },
    { path: "/home/user/.nexus/PYLON.md", mode: 0o644, owner: "user", content: pylonGuide(overlay) },
  ];
}

/** What NEXUS_API is set to. See PylonApiRequest. */
export const nexusApi = "http://nexus.pylon";

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

function pylonGuide(o: PylonOverlay): string {
  const list = (items: readonly string[]): string => items.map((item) => `- ${item}\n`).join("");
  const previews = o.previews.length === 0
    ? "No previews are published yet. `nexus services ensure --json` starts the services in .nexus/services.yaml and prints their URLs, and `nexus preview <port>` publishes a port that is already listening.\n"
    : `Each preview is reachable from the human's tailnet devices:\n\n${list(o.previews.map((p) => `${p.service}: ${p.url}`))}`;
  const logins = o.logins.length === 0
    ? "This project has no interactive logins.\n"
    : `This project allows these logins: ${o.logins.join(", ")}. Sign in with the device-code flow, which shows a code to enter in a browser on another device. A browser-callback login fails, because its callback listens inside this pylon, where that browser cannot reach it.\n`;
  const secrets = o.secrets.length === 0 ? "" : `## Secrets

Login shells have these variables. Each holds a placeholder that is swapped for the real value only in requests to the hosts listed, and the placeholder changes on every boot, so never write one into a file, a git config or a remote URL.

${list(o.secrets.map((grant) => `${grant.name}: ${grant.hosts.join(", ")}`))}
`;
  return `# You are in a Nexus pylon

This machine is a pylon, a microVM that Nexus runs for one thread. You run as \`user\`, who has passwordless sudo.

- Thread: ${o.threadId}
- Project: ${o.project}
- Node: ${o.node}
- Pylon: ${o.pylonId}

\`nexus info --json\` prints these facts, and /home/user/.nexus/pylon.json holds them.

${repositorySection(o)}
## Network

Only these hosts are reachable. Every other host is blocked, so an HTTP request to it gets \`403 blocked by policy\`. Ask the human to add a host to the project if you need one.

${list(o.allowedHosts)}
${secrets}## Previews

${previews}
## Sleep

Nexus pauses this pylon when the thread goes idle and wakes it on the next message, terminal attach or preview visit. A pause saves the disk and stops the VM, so only files on disk survive it. Processes, services and anything held in memory stop. On wake, Nexus runs .nexus/resume, starts the services again and relaunches the open sessions.

## Outputs

Nexus records pushed branches, an uncommitted working tree and ready previews as outputs on its own. Declare anything else:

\`\`\`sh
nexus output add file artifacts/screenshot.png --title "Checkout page"
nexus output add diff                      # snapshot the working tree as a diff output
nexus output list
\`\`\`

## Logins

${logins}
## Services

\`\`\`sh
nexus services ensure --json               # start what .nexus/services.yaml declares, wait for health and preview URLs
nexus service logs web --lines 200
nexus service restart web
nexus service start storybook --command "pnpm storybook --port \\$PORT" --preview
nexus preview 6006 --title Storybook       # publish a port that is already listening
nexus unpreview 6006                       # stop publishing it
\`\`\`
`;
}

/** Where the checkout came from, how to set a git author, which no pylon has, and how to publish with a GitHub grant. */
function repositorySection(o: PylonOverlay): string {
  const github = o.secrets.some((grant) => grant.name === githubTokenGrant.name);
  const origin = o.repo.kind === "clone"
    ? `/home/user/workspace/repo is a clone of ${o.repo.url}, on branch ${o.repo.checkout.branch} from ${o.repo.checkout.commit}.`
    : `/home/user/workspace/repo is a new repository on branch ${o.repo.branch} with no commits and no remote. Nothing in this pylon is kept when the thread is deleted, so publish anything worth keeping.`;
  const author = github
    ? `Git has no author here. Commit as the GitHub account that owns GH_TOKEN:

\`\`\`sh
git config --global user.name "$(gh api user --jq .login)"
git config --global user.email "$(gh api user --jq '"\\(.id)+\\(.login)@users.noreply.github.com"')"
\`\`\``
    : "Git has no author here. Before your first commit, ask the human which name and email to commit as, and set them with `git config --global user.name` and `git config --global user.email`.";
  const token = "`gh` reads GH_TOKEN, and git over HTTPS asks `gh` for it on each push, so never store the token: no `gh auth login`, no credential store. Use HTTPS remotes, because git over SSH reaches only the remotes this pylon booted with.";
  const publish = o.repo.kind === "clone" ? (github ? [token] : [])
    : github ? [`${token} To publish this repository:

\`\`\`sh
git add -A && git commit -m "feat: first version"
gh repo create <owner>/<name> --private --source . --remote origin --push
git push                                   # every later push
\`\`\``]
    : [`This project has no GitHub token, and a project's secrets are fixed when it is created. To publish from a pylon, ask the human for a project with GitHub access: \`nexus project add <id> --scratch --secret ${githubTokenGrant.name}:${githubTokenGrant.hosts.join(",")}\`.`];
  return `## Repository\n\n${[origin, author, ...publish].join("\n\n")}\n`;
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
  | { op: "unpreview"; port: number }
  | { op: "output-add"; output: { kind: "file"; path: string; title?: string } | { kind: "diff"; title?: string } }
  | { op: "output-list" };

/**
 * `services ensure` and `preview` wait up to 30 s for a preview URL. A new preview needs an https port,
 * which only the control plane allocates. The probe reports the new service, the control plane sends a
 * spawn with a new LiveSpec, the probe publishes and warms the URL (S4's first request timed out), and only
 * then does the command return it. Declared outputs are recorded in the guest under /home/user/.nexus/outputs/
 * and surface through the next observation. Responses are the CLI's --json output.
 */
