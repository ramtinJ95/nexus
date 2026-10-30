/** Nexus owns where and with what access: the Project record. Secret values live only on nodes. */
import { z } from "zod";
import type { NodeName, ProjectId } from "../ids.ts";
import { chatgptTokenGrant, type SecretGrant } from "../secret-grants.ts";
import type { GitIdentity, PylonResources } from "../spawn.ts";

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
