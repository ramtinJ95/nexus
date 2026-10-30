/**
 * Project config contract: what the repo declares, what Nexus stores, and what a pylon is told.
 *
 * Ownership:
 * - Nexus owns where and with what access: the Project record. Secret values live only on nodes.
 * - The control plane renders everything the agent sees about its pylon (the overlay) from records and
 *   ships it in the spawn job. The probe writes those files without reading them.
 */
import { z } from "zod";
import type { NodeName, ProjectId, PylonId } from "./ids.ts";
import type { ServiceName } from "./services-file.ts";
import { shellQuote } from "./shell.ts";
import { chatgptTokenGrant, githubTokenGrant, type SecretGrant } from "./secret-grants.ts";
import type { GitIdentity, OverlayFile, PylonResources, RepoInit } from "./spawn.ts";

// Temporary: ProjectId moved to ids.ts, and E1 deletes this re-export.
export type { ProjectId } from "./ids.ts";

// The Project record, stored in Nexus.

export interface Project {
  gitIdentity?: GitIdentity | null | undefined;
  id: ProjectId;
  /**
   * SSH or HTTPS, or null for a scratch project: its pylons start from `git init` on defaultBranch, nothing is
   * fetched, and nothing is kept once the thread is deleted unless the agent pushed it somewhere. Git over SSH is
   * terminated on the host, and the key never enters a pylon.
   */
  repoUrl: string | null;
  /** The branch threads check out, or the first branch of a scratch project's empty repository. */
  defaultBranch: string;
  /** `auto` boots each thread that names no node where its pylon fits best. */
  defaultNode: NodeName | "auto";
  resources: PylonResources;
  allowedHosts: readonly string[];
  secrets: readonly SecretGrant[];
  logins: readonly LoginKind[];
  /** A script stored in Nexus, not the repo. It runs as user before .nexus/setup, so a project can be set up without a commit. */
  preSetup: string | null;
  /**
   * Whether the review loop starts on its own for each builder's pull request, and lands it once approved. Only a
   * person sets it, and `enabledBy` is the caller who did, on whose behalf a landing merges and deploys.
   */
  autoReview?: AutoReview | null | undefined;
  /**
   * Whether the pipeline turns this project's items into queued threads, and whether it does so on its own or once the
   * person approves each item. Null is off, which a person set, and an absent field is off too.
   */
  pipeline?: PipelineSetting | null | undefined;
}
/** What `nexus project add` and the dashboard's new-project dialog give a project unless told otherwise. */
export const defaultProjectResources: Readonly<Project["resources"]> = { cpus: 2, memoryGiB: 6, diskGiB: 10 };
export interface AutoReview { land: boolean; enabledBy: string }
export interface PipelineSetting { autoStart: boolean }
/** Templates mirror a remote, so they take a project that has one. */
export type RemoteProject = Project & { repoUrl: string };
export const hasRemote = (project: Project): project is RemoteProject => project.repoUrl !== null;
/** What a new thread's pylon is granted: the project's grants, plus the ChatGPT token when the project has the chatgpt login. */
export function bootSecrets(project: Project): readonly SecretGrant[] {
  return project.logins.includes("chatgpt") ? [...project.secrets, chatgptTokenGrant] : project.secrets;
}
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

// The pylon overlay, rendered by the control plane.

export interface PylonOverlay {
  gitIdentity?: GitIdentity | undefined;
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
 *   outputs, that pi is signed in to ChatGPT when the pylon was granted the ChatGPT token, that other logins use
 *   the device-code flow (S5: the browser callback listens inside the guest), and that Claude Code has a shepherdr
 *   reviewer check its diff before a pull request, which runs only when pi is signed in.
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

function pylonGuide(o: PylonOverlay): string {
  const list = (items: readonly string[]): string => items.map((item) => `- ${item}\n`).join("");
  const previews = o.previews.length === 0
    ? "No previews are published yet. Nexus starts the services .nexus/services.yaml declares and publishes their previews on its own, `nexus services ensure --json` starts them now and prints the URLs, and `nexus preview <port>` publishes a port that is already listening.\n"
    : `Each preview is reachable from the human's tailnet devices:\n\n${list(o.previews.map((p) => `${p.service}: ${p.url}`))}`;
  // From the boot's grants, not the project's logins, as the boot hook that signs pi in reads them too.
  const chatgpt = o.secrets.some((grant) => grant.name === chatgptTokenGrant.name);
  const deviceCode = o.logins.filter((login) => !(chatgpt && login === "chatgpt"));
  const logins = [
    ...chatgpt ? ["pi is already signed in to ChatGPT as its `openai` provider, so models such as `openai/gpt-6-astra` work without a login. Nexus rewrites that entry of ~/.pi/agent/auth.json on every boot. pi's `openai-codex` provider is not signed in, and needs no `/login`."] : [],
    ...deviceCode.length === 0 ? [] : [`This project ${chatgpt ? "also " : ""}allows these logins: ${deviceCode.join(", ")}. Sign in with the device-code flow, which shows a code to enter in a browser on another device. A browser-callback login fails, because its callback listens inside this pylon, where that browser cannot reach it.`],
  ].map((paragraph) => `${paragraph}\n`).join("\n") || "This project has no interactive logins.\n";
  const reviewLogin = chatgpt
    ? "The reviewer runs on pi's `openai` provider, which is signed in here. If it stops on a login or model error anyway, say the review was skipped and why, and go on with the work."
    : "This pylon was not granted the ChatGPT token, so pi is not signed in and the reviewer stops with `Provider is not configured: openai`. Say in your reply and in the pull request that the review was skipped and why, and go on with the work. The human can add the `chatgpt` login to the project, which reaches threads started after that.";
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
A browser reaches a preview over HTTPS, but the app gets plain HTTP, with the public address in \`Host\` and \`X-Forwarded-Proto: https\`. Nexus turns the app's redirects to its own \`http://\` address into \`https://\`, and has the browser load the page's \`http://\` links over HTTPS. That includes links to other ports on the same name, so a preview cannot link to a plain-HTTP port there. A dev server that checks \`Host\` refuses the address until you allow it, as Vite's \`server.allowedHosts: [".ts.net"]\` does.

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
## Review before a pull request

This is for Claude Code, whose shepherdr mod gives it the \`mcp__shepherdr__agents\` tool. Before you open a pull request or push to one, have a shepherdr \`reviewer\` check the diff. Spawn it with \`agent_type: "reviewer"\`, the pull request's base branch as \`base\`, and a message that says what the change is for. The reviewer is a read-only pi worker in a new Herdr tab of this pylon, on the model the person's \`reviewer\` profile names. Fix the findings you accept. Then say in your reply, and in the pull request, which findings you accepted and which you rejected, and why. Without the tool, say the review was skipped.

${reviewLogin}

## Services

Nexus starts each service .nexus/services.yaml declares, one you add within seconds and one with a preview once its URL is assigned. A running service keeps its command and env until \`nexus service restart\`.

\`\`\`sh
nexus services ensure --json               # start them now, wait for health and preview URLs
nexus service logs web --lines 200
nexus service restart web
nexus service start storybook --command "pnpm storybook --port \\$PORT" --preview
nexus preview 6006 --title Storybook       # publish a port that is already listening
nexus unpreview 6006                       # stop publishing it
\`\`\`
`;
}

/** Where the checkout came from, the configured git author, and how to publish with a GitHub grant. */
function repositorySection(o: PylonOverlay): string {
  const github = o.secrets.some((grant) => grant.name === githubTokenGrant.name);
  const author = o.gitIdentity
    ? `Nexus sets git's global identity for user to ${o.gitIdentity.name} <${o.gitIdentity.email}> on every boot. Commit as this person; there is no separate agent account.`
    : "Nexus has no git identity configured. Git is left unchanged. If a commit needs an identity, ask the human; do not invent an identity or infer one from a token.";
  const token = "`gh` reads GH_TOKEN, and git over HTTPS asks `gh` for it on each push, so never store the token: no `gh auth login`, no credential store. Use HTTPS remotes, because git over SSH reaches only the remotes this pylon booted with.";
  let origin: string;
  let publish: string[];
  switch (o.repo.kind) {
    case "clone":
      origin = `/home/user/workspace/repo is a clone of ${o.repo.url}, on branch ${o.repo.checkout.branch} from ${o.repo.checkout.commit}.`;
      publish = github ? [token] : [];
      break;
    case "empty":
      origin = `/home/user/workspace/repo is a new repository on branch ${o.repo.branch} with no commits and no remote. Nothing in this pylon is kept when the thread is deleted, so publish anything worth keeping.`;
      publish = github ? [`${token} To publish this repository:

\`\`\`sh
git add -A && git commit -m "feat: first version"
gh repo create <owner>/<name> --private --source . --remote origin --push
git push                                   # every later push
\`\`\``]
        : [`This project has no GitHub token, and this pylon's secrets are fixed at thread creation. To publish from a pylon, ask the human for a project with GitHub access: \`nexus project add <id> --scratch --secret ${githubTokenGrant.name}:${githubTokenGrant.hosts.join(",")}\`.`];
      break;
  }
  return `## Repository\n\n${[origin, author, ...publish].join("\n\n")}\n`;
}
