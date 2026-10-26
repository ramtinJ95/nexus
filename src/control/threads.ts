import { randomBytes } from "node:crypto";
import type { HarnessHost } from "../harness/host.ts";
import { chooseTemplate, setupHashOf, type ImageId, type ProjectMirror, type SetupInputs, type TemplateId, type ThreadSetup } from "../images.ts";
import { bootSecrets, effectiveAllowedHosts, hasRemote, liveHashOf, withHttpsHosts, type BootInputs, type Project, type ProjectId, type PylonOverlay, type RemoteProject, type RepoInit } from "../project.ts";
import type { NodeName, PylonId } from "../protocol.ts";
import { newPylonRecord, type PylonRecord } from "../tick.ts";
import { HttpError } from "./http-error.ts";
import { placeAuto, type Placement } from "./placement.ts";
import { pylonLive } from "./live.ts";
import type { Registry, Thread, ThreadId } from "./registry.ts";

/**
 * What starts a thread. `claude` makes it a Claude worker with that first prompt, which gets `/poteto-mode` in front
 * unless `raw`, as for the review loop's reviewers. A `bare` thread has neither agent, as a check thread needs only
 * its pylon. Only the control plane itself asks for `raw` or `bare`. `node` names a node, or is `auto` for the one
 * where the pylon fits best.
 */
export interface StartRequest { project: string; title: string; node?: string | undefined; branch?: string | undefined; commit?: string | undefined; claude?: string | undefined; model?: string | undefined; raw?: boolean; bare?: boolean }

/** `pylon-<id>` must fit in 40 characters. */
const newThreadId = () => `th-${randomBytes(6).toString("hex")}` as ThreadId;

/** A shorter ID or a ref name may resolve to another commit by the time the pylon boots. */
const fullCommitId = /^[0-9a-f]{40}$/;

/** What the mirror read for the thread's ref, or why the thread boots fresh without a template. */
type SetupRead = { project: RemoteProject; inputs: SetupInputs } | { fresh: string };

export function threadStarter(options: { registry: Registry; harness: Pick<HarnessHost, "startThread">; mirror: ProjectMirror; dotfiles: PylonOverlay["dotfiles"]; gitIdentity?: BootInputs["gitIdentity"]; wake(node: NodeName): void }) {
  const { registry, harness, mirror, dotfiles, gitIdentity, wake } = options;

  async function readSetup(project: Project, branch: string, commit: string | undefined): Promise<SetupRead> {
    if (!hasRemote(project)) return { fresh: "the project is scratch, so it has no template" };
    if (commit !== undefined && !fullCommitId.test(commit)) return { fresh: `the start named commit ${commit}, and only a full commit ID or a branch tip can use a template` };
    try {
      return { project, inputs: await mirror.setupInputs(project, commit === undefined ? { branch } : { commit }) };
    } catch (err) {
      return { fresh: `the control plane could not read .nexus/setup at ${commit ?? branch}: ${(err as Error).message}` };
    }
  }

  /**
   * The pylon boots from a template of its setup that its node holds, or fresh. A template boot checks out the commit
   * the setup was read at, so a branch that moved since cannot give the pylon a .nexus/setup its template did not run.
   * A build this start asks for is recorded here, synchronously with the choice, so a concurrent start of the same
   * setup on the node finds it and waits instead of building it twice.
   */
  function setUp(project: Project, read: SetupRead, repo: RepoInit, image: ImageId, branch: string, node: NodeName, now: number): { setup: ThreadSetup; firstBoot: PylonRecord["firstBoot"]; repo: RepoInit } {
    const fresh = (reason: string, building?: TemplateId) => ({
      setup: { how: "fresh" as const, reason, ...building === undefined ? {} : { building } }, firstBoot: { kind: "fresh" as const, preSetup: project.preSetup }, repo,
    });
    if ("fresh" in read) return fresh(read.fresh);
    const { project: remote, inputs } = read;
    const key = { project: remote.id, image, setupHash: setupHashOf(remote, inputs) };
    const choice = chooseTemplate(remote, key, { branch, commit: inputs.commit }, registry.templates(remote.id), node, registry.node(node)?.observation?.artifacts ?? [], now);
    switch (choice.kind) {
      case "reuse": return {
        setup: { how: "template", template: choice.template, builtAt: choice.builtAt, commit: inputs.commit },
        firstBoot: { kind: "template", template: choice.template },
        repo: { kind: "clone", url: remote.repoUrl, checkout: { branch, commit: inputs.commit } },
      };
      case "build":
        registry.saveTemplate({ id: choice.template, key, state: "building", on: choice.on, inputs: choice.inputs, submitted: null });
        return fresh(`no template of this setup is on ${node} yet`, choice.template);
      case "wait": return fresh(`template ${choice.template} of this setup is still building on ${node}`, choice.template);
      case "fresh": return fresh(choice.reason);
    }
  }

  /** The conversation is created before the registry row, as HarnessHost.startThread requires. */
  return async function startThread(request: StartRequest, caller: string): Promise<Thread> {
    const claudePrompt = request.claude === undefined || request.raw === true || /^\/poteto-mode(?:\s|$)/.test(request.claude) ? request.claude : `/poteto-mode ${request.claude}`;
    if (claudePrompt !== undefined && claudePrompt.length > 16_384) throw new HttpError(400, "Claude prompt including /poteto-mode exceeds 16384 characters");
    const project = registry.project(request.project as ProjectId);
    if (project === undefined) throw new HttpError(404, `no project ${request.project}`);
    const named = request.node !== undefined && request.node !== "auto";
    if (named && registry.node(request.node as NodeName) === undefined) throw new HttpError(400, `no node ${request.node}`);
    const image = registry.currentImage();
    if (image === null) throw new HttpError(409, "no image is current yet, so a pylon has nothing to boot");
    const branch = request.branch ?? project.defaultBranch;
    if (!hasRemote(project) && request.commit !== undefined) throw new HttpError(400, `project ${project.id} is a scratch project, so it has no commit to check out`);
    // The repository as a fresh boot makes it. setUp pins a template boot's commit, and the pylon's boot freezes either.
    const freshRepo: RepoInit = hasRemote(project)
      ? { kind: "clone", url: project.repoUrl, checkout: { branch, commit: request.commit ?? `origin/${branch}` } }
      : { kind: "empty", branch };
    // Every boot pulls the dotfiles through the allowlist. A template build pulls none, so their host stays out of the setup hash.
    const network = { allowedHosts: withHttpsHosts(effectiveAllowedHosts(project), [dotfiles.repo]), secrets: bootSecrets(project) };

    const id = newThreadId();
    const pylonId = `pylon-${id}` as PylonId;
    const placement: Placement = request.node === "auto" ? placeAuto(registry, { image, resources: project.resources, network, repo: freshRepo, dotfiles })
      : named ? { how: "named", node: request.node as NodeName } : { how: "default", node: project.defaultNode };
    const { node } = placement;
    const read = await readSetup(project, branch, request.commit);

    const conversationId = request.claude === undefined && request.bare !== true ? await harness.startThread({ threadId: id, pylonId }) : null;
    const now = Date.now();
    const { setup, firstBoot, repo } = setUp(project, read, freshRepo, image, branch, node, now);
    const boot: Omit<BootInputs, "source"> = { pylonId, image, resources: project.resources, gitIdentity: project.gitIdentity ?? gitIdentity, network, repo, dotfiles };
    const t: Thread = {
      id, title: request.title, project: project.id, pylonId, status: "active", conversationId: conversationId === null ? null : String(conversationId), startedBy: caller, createdAt: now,
      // Starting a thread is human activity, so its pylon is wanted at once.
      agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: now, seenAt: null, lastReplyAt: null, placement, setup,
    };
    // Ports are allocated once the pylon reports the services that want a preview.
    const live = pylonLive({ pylonId, thread: id, node, boot }, project, []);
    const { desired: _, ...pylon } = newPylonRecord({
      thread: id, pylonId, node, desired: "running",
      boot,
      firstBoot,
      live,
      liveHash: liveHashOf(live),
    });
    registry.createThread(t, pylon, claudePrompt, request.model);
    wake(node);
    return t;
  };
}
