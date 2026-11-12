/**
 * The pylon boot policy, for every backend: what each boot runs before setup or resume, the setup a new disk runs
 * once, and the resume each boot from a disk runs. The pylon VM backend hands these commands to its instance's
 * controller (src/pylon-vm/runtime.ts), which runs each as root, and the Docker double runs them in its container.
 */
import { shellQuote as q } from "../shell.ts";
import { asUser, coreStartMs, ensureCore } from "../guest-contract.ts";
import { JobFailure } from "../protocol/jobs.ts";
import type { PylonId } from "../ids.ts";
import type { BootInputs, CloneRepo, RepoInit } from "../protocol/spawn.ts";
import type { TemplateBuildInputs } from "../protocol/images.ts";
import { agentKinds, sessionHarnessSchema, type SessionHarness } from "../protocol/agent-kinds.ts";
import { launchers } from "../probe/guest/launchers.ts";
import { bakedDotfilesDir, checkoutDir, dotfilesDir, home, workspaceDir } from "../../images/pylon/nexus-contract.ts";

/** A login shell as `user`, in `cwd`, as one command string. Both backends run boot commands, and the fork its guest commands, as root. */
export const asUserIn = (script: string, cwd: string) => asUser(`cd ${q(cwd)} && ${script}`).map(q).join(" ");

/**
 * Every boot, as user, before setup or resume. A failed or slow pull keeps what the disk has, which is the
 * image's baked copy until a pull succeeds. A boot without a dotfiles repository pulls nothing and keeps it too. Then the layer's install runs.
 * Each step's outcome (pull, install) is one `dotfiles:` line in the pylon's log, and none fails the boot. The fetch has its own limit,
 * so the fork's 120 s hook deadline never cuts off what follows it.
 */
function dotfilesPull(dotfiles: BootInputs["dotfiles"]): string {
  const at = `$(git -C ${dotfilesDir} rev-parse --short HEAD 2>/dev/null || echo nothing)`;
  const pull = dotfiles === undefined ? [`echo 'dotfiles: no repository is set, keeping' "${at}"`] : [
    `if timeout 60 git -C ${dotfilesDir} fetch --quiet --depth 1 ${q(dotfiles.repo)} ${q(dotfiles.ref)} && git -C ${dotfilesDir} checkout --quiet --detach FETCH_HEAD`,
    `then echo ${q(`dotfiles: pulled ${dotfiles.repo} ${dotfiles.ref} at`)} "${at}"`,
    `else echo ${q(`dotfiles: the pull of ${dotfiles.repo} ${dotfiles.ref} failed, keeping`)} "${at}"`,
    "fi",
  ];
  return asUserIn([
    `test -d ${dotfilesDir}/.git || git clone --quiet ${bakedDotfilesDir} ${dotfilesDir} || git init --quiet ${dotfilesDir}`,
    ...pull,
    `if ! test -x ${dotfilesDir}/install; then echo 'dotfiles: no install script'`,
    `elif (cd ${dotfilesDir} && ./install); then echo 'dotfiles: installed'`,
    `else echo "dotfiles: install exited $?"; fi`,
  ].join("\n"), home);
}

/** Starts Herdr Core, which every session runs in, once the login environment it hands its terminals is settled. One `herdr-core:` line. */
const coreStart = asUserIn(`if ${ensureCore}; then echo 'herdr-core: running'; else echo 'herdr-core: did not start within ${coreStartMs / 1000} s'; fi`, home);

/**
 * Every boot's hooks, in order. The agents' logins follow the dotfiles pull, whose install may replace their files, and
 * the core starts last, so its terminals get what they set.
 */
export function bootHooks(boot: Pick<BootInputs, "dotfiles" | "gitIdentity" | "network">): string[] {
  const granted = (harness: SessionHarness) => agentKinds[harness].signIn?.grants.some((grant) => boot.network.secrets.some((s) => s.name === grant.name)) ?? false;
  return [
    dotfilesPull(boot.dotfiles),
    ...sessionHarnessSchema.options.flatMap((harness) => {
      const login = launchers[harness]?.login;
      return login !== undefined && granted(harness) ? [asUserIn(login, home)] : [];
    }),
    ...boot.gitIdentity === undefined ? [] : [asUserIn(`git config --global user.name ${q(boot.gitIdentity.name)} && git config --global user.email ${q(boot.gitIdentity.email)}`, home)],
    coreStart,
  ];
}

/**
 * Records what the pylon booted at as refs/nexus/base, which the Changes view diffs against (checkout-files.ts): the
 * commit it checked out, or the empty tree of an empty repository, which has no commit.
 */
const recordBase = (repo: string, object: string) => `git -C ${q(repo)} update-ref refs/nexus/base ${object}`;

/**
 * Runs as root from the workspace once, on a fresh disk or in a template build. 20-minute limit.
 * A clone fetches and checks out. An empty repository is only initialized, so a scratch pylon fetches nothing.
 */
function setupCommands(repo: RepoInit, preSetup: string | null): string[] {
  return [
    `chown user:user ${q(workspaceDir)}`,
    asUserIn(repoInitCommand(repo), workspaceDir),
    ...(preSetup === null ? [] : [asUserIn(`bash -c ${q(preSetup)}`, checkoutDir)]),
    asUserIn("if test -e .nexus/setup; then ./.nexus/setup; fi", checkoutDir),
  ];
}

/** Makes the pylon's checkout at `dir` on its first boot. Tests run it to make a checkout as a pylon does. */
export function repoInitCommand(repo: RepoInit, dir = checkoutDir): string {
  switch (repo.kind) {
    case "clone": return `git clone --no-checkout ${q(repo.url)} ${q(dir)} && git -C ${q(dir)} checkout -B ${q(repo.checkout.branch)} ${q(repo.checkout.commit)} && ${recordBase(dir, "HEAD")}`;
    case "empty": return `git init --quiet --initial-branch=${q(repo.branch)} ${q(dir)} && ${recordBase(dir, `"$(git -C ${q(dir)} hash-object -t tree -w /dev/null)"`)}`;
  }
}

/** What a template boot's checkout exits with when the remote it fetched does not have its commit, which no retry changes. */
export const commitMissing = 66;

/**
 * The setup of a pylon booted from a template, run once: the template's clone moves to the pylon's remote and commit.
 * A commit no branch has is fetched by itself, and one the remote says it does not have, as after a force-push took it
 * off the branch, exits `commitMissing`. Any other failed fetch may pass. Tests run it in `dir` to check out as a pylon does.
 */
export function templateCheckout({ url, checkout }: CloneRepo, dir = checkoutDir): string {
  const [commit, git] = [q(checkout.commit), `git -C ${q(dir)}`];
  return [
    `templateCommit=$(${git} rev-parse HEAD)`,
    `${git} remote set-url origin ${q(url)} && ${git} fetch --quiet origin`,
    `{ ${git} cat-file -e ${commit}^{commit} 2>/dev/null || fetched=$(${git} fetch --quiet origin ${commit} 2>&1) || { echo "$fetched"; case $fetched in *"not our ref"*|*"unadvertised object"*) echo ${q(`${checkout.commit} is not on ${url}`)}; exit ${commitMissing};; esac; exit 1; }; }`,
    `${git} checkout --quiet -B ${q(checkout.branch)} ${commit} && ${recordBase(dir, "HEAD")}`,
    `checkoutCommit=$(${git} rev-parse HEAD)`,
    `if test "$templateCommit" != "$checkoutCommit" && ! test -e ${q(`${dir}/.nexus/resume`)}; then echo "setup: template checkout $templateCommit -> $checkoutCommit; no .nexus/resume: dependencies may be stale. Refresh dependencies for this commit before running tests."; fi`,
  ].join(" && ");
}

/**
 * The setup a boot's new disk runs once, as root from the workspace. `retry` marks a template boot's, which is only
 * Nexus's checkout and fails for reasons that pass, such as a fetch during an outage.
 */
export function diskSetup(boot: BootInputs & { source: { kind: "fresh" | "template" } }): { commands: string[]; retry: boolean } {
  switch (boot.source.kind) {
    case "fresh": return { commands: setupCommands(boot.repo, boot.source.preSetup), retry: false };
    case "template":
      if (boot.repo.kind === "empty") throw new JobFailure("invalid", `${boot.pylonId} boots from template ${boot.source.template}, but its project is scratch, which has no template`);
      return { commands: [asUserIn(templateCheckout(boot.repo), checkoutDir)], retry: true };
  }
}

export const templateSetup = ({ repo, preSetup }: Pick<TemplateBuildInputs, "repo" | "preSetup">) =>
  setupCommands({ kind: "clone", url: repo.url, checkout: { branch: repo.branch, commit: repo.commit } }, preSetup);

/** Every boot from a disk runs it, each wake and a template boot after its checkout, as root from the workspace. */
export const resumeCommands: readonly string[] = [asUserIn("if test -e .nexus/resume; then ./.nexus/resume; fi", checkoutDir)];

/**
 * What a boot fails with when its setup, which exited `exitCode` if known, failed on a disk that holds nothing of the
 * user's, which its backend therefore removed. A template boot's checkout (`retry`) boots from the template again on
 * the job's retry, unless its commit is missing from the remote. A fresh boot's failure stays final, and a human retry
 * boots the pylon fresh.
 */
export function setupRemoved(pylonId: PylonId, retry: boolean, startupError: string, logTail: string, exitCode?: number): JobFailure {
  if (retry && exitCode === commitMissing) return new JobFailure("setup-failed", `${pylonId}: ${startupError}. Its commit is not on its remote, so it was removed, and no retry can check it out`, logTail);
  if (!retry) return new JobFailure("setup-failed", `${pylonId}: ${startupError}. Its instance had no checkpoint, so it was removed, and a retry boots the pylon fresh`, logTail);
  return new JobFailure("backend", `${pylonId} could not check out its commit on its template's disk, so it was removed and boots from the template again: ${startupError}`, logTail);
}
