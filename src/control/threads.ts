import { randomBytes } from "node:crypto";
import { fullCommit } from "../deploy/model.ts";
import type { HarnessHost } from "../harness/host.ts";
import { chooseTemplate, setupHashOf, type ImageId, type ProjectMirror, type SetupInputs, type TemplateId, type ThreadSetup } from "../images.ts";
import { bootSecrets, effectiveAllowedHosts, hasRemote, liveHashOf, withHttpsHosts, type BootInputs, type Project, type ProjectId, type PylonOverlay, type RemoteProject, type RepoInit } from "../project.ts";
import type { NodeName, PylonId } from "../protocol.ts";
import { newPylonRecord, type PylonRecord } from "../tick.ts";
import { HttpError } from "./http-error.ts";
import { placeAuto, type Placement } from "./placement.ts";
import { pylonLive } from "./live.ts";
import type { Registry, StartKey, Thread, ThreadId } from "./registry.ts";

/**
 * What starts a thread. `claude` makes it a Claude worker with that first prompt, which gets `/poteto-mode` in front
 * unless `raw`, as for the review loop's reviewers. A `bare` thread has neither agent, as a check thread needs only
 * its pylon. Only the control plane itself asks for `raw` or `bare`. `node` names a node, or is `auto` for the one
 * where the pylon fits best. `resources` overrides the project's size field by field. `drive` gives a Nexus agent thread
 * the drive tools. `parent` is the thread whose `nexus_start` asks, which only the drive tools set.
 */
export interface StartRequest {
  project: string; title: string; node?: string | undefined; branch?: string | undefined; commit?: string | undefined; claude?: string | undefined; model?: string | undefined; raw?: boolean; bare?: boolean;
  resources?: { [K in keyof BootInputs["resources"]]?: BootInputs["resources"][K] | undefined } | undefined;
  drive?: boolean | undefined; parent?: ThreadId | undefined;
}

/** How many children a thread may have that are not archived or deleted. A child has no drive tools, so it starts none. */
export const maxChildren = 3;

/** `pylon-<id>` must fit in 40 characters. */
export const newThreadId = () => `th-${randomBytes(6).toString("hex")}` as ThreadId;

const claudePromptOf = (request: StartRequest) =>
  request.claude === undefined || request.raw === true || /^\/poteto-mode(?:\s|$)/.test(request.claude) ? request.claude : `/poteto-mode ${request.claude}`;

/** What a start refuses before it places anything, which a queued start is checked against when it is queued too. */
export function checkStart(registry: Registry, request: StartRequest): Project {
  const claudePrompt = claudePromptOf(request);
  if (claudePrompt !== undefined && claudePrompt.length > 16_384) throw new HttpError(400, "Claude prompt including /poteto-mode exceeds 16384 characters");
  const project = registry.project(request.project as ProjectId);
  if (project === undefined) throw new HttpError(404, `no project ${request.project}`);
  if (request.node !== undefined && request.node !== "auto" && registry.node(request.node as NodeName) === undefined) throw new HttpError(400, `no node ${request.node}`);
  if (!hasRemote(project) && request.commit !== undefined) throw new HttpError(400, `project ${project.id} is a scratch project, so it has no commit to check out`);
  checkLineage(registry, request);
  return project;
}

/**
 * Who may have the drive tools, and who may start a child. A start checks first and again just before it writes the
 * thread, with no wait in between, so two starts from one parent at once cannot both take its last place.
 */
function checkLineage(registry: Registry, request: StartRequest) {
  if (request.drive === true && (request.claude !== undefined || request.bare === true)) throw new HttpError(400, "the drive tools are Nexus agent tools, so a Claude worker or a bare thread cannot have them");
  if (request.parent === undefined) return;
  if (request.drive === true) throw new HttpError(400, "a thread a tool starts gets no drive tools");
  const parent = registry.thread(request.parent);
  if (parent === undefined) throw new HttpError(404, `no thread ${request.parent}`);
  if (parent.drive !== true) throw new HttpError(403, `thread ${parent.id} has no drive tools. Only a thread a person starts with them may start threads, and a thread a tool started never has them`);
  if (parent.status === "archived" || parent.status === "deleted") throw new HttpError(409, `thread ${parent.id} is ${parent.status}, so it starts nothing`);
  checkRoom(registry, parent.id);
}

/** Refuses a start or an unarchive that would give `parent` more than maxChildren live children. */
export function checkRoom(registry: Registry, parent: ThreadId) {
  const live = registry.children(parent).filter((t) => t.status === "active" || t.status === "idle");
  if (live.length >= maxChildren) throw new HttpError(409, `thread ${parent} has ${live.length} live children (${live.map((t) => t.id).join(", ")}), the most a thread may have. A child counts until it is archived or deleted`);
}

/** A shorter ID or a ref name may resolve to another commit by the time the pylon boots. */

/** What the mirror read for the thread's ref, or why the thread boots fresh without a template. */
type SetupRead = { project: RemoteProject; inputs: SetupInputs } | { fresh: string };

export function threadStarter(options: { registry: Registry; harness: Pick<HarnessHost, "startThread">; mirror: ProjectMirror; dotfiles: PylonOverlay["dotfiles"]; gitIdentity?: BootInputs["gitIdentity"]; wake(node: NodeName): void }) {
  const { registry, harness, mirror, dotfiles, gitIdentity, wake } = options;

  async function readSetup(project: Project, branch: string, commit: string | undefined): Promise<SetupRead> {
    if (!hasRemote(project)) return { fresh: "the project is scratch, so it has no template" };
    if (commit !== undefined && !fullCommit.test(commit)) return { fresh: `the start named commit ${commit}, and only a full commit ID or a branch tip can use a template` };
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

  /**
   * The conversation is created before the registry row, as HarnessHost.startThread requires. `queuedId` is a queued
   * thread's, whose queue record the registry marks started with the row. `key` is stored with the row.
   */
  return async function startThread(request: StartRequest, caller: string, queuedId?: ThreadId, key?: StartKey): Promise<Thread> {
    const project = checkStart(registry, request);
    const claudePrompt = claudePromptOf(request);
    const named = request.node !== undefined && request.node !== "auto";
    const image = registry.currentImage();
    if (image === null) throw new HttpError(409, "no image is current yet, so a pylon has nothing to boot");
    const branch = request.branch ?? project.defaultBranch;
    // The repository as a fresh boot makes it. setUp pins a template boot's commit, and the pylon's boot freezes either.
    const freshRepo: RepoInit = hasRemote(project)
      ? { kind: "clone", url: project.repoUrl, checkout: { branch, commit: request.commit ?? `origin/${branch}` } }
      : { kind: "empty", branch };
    // Every boot pulls the dotfiles through the allowlist. A template build pulls none, so their host stays out of the setup hash.
    const network = { allowedHosts: withHttpsHosts(effectiveAllowedHosts(project), [dotfiles.repo]), secrets: bootSecrets(project) };

    const size = request.resources ?? {};
    const resources = { cpus: size.cpus ?? project.resources.cpus, memoryGiB: size.memoryGiB ?? project.resources.memoryGiB, diskGiB: size.diskGiB ?? project.resources.diskGiB };
    const id = queuedId ?? newThreadId();
    const pylonId = `pylon-${id}` as PylonId;
    const placement: Placement = named ? { how: "named", node: request.node as NodeName }
      : (request.node ?? project.defaultNode) === "auto" ? placeAuto(registry, { image, resources, network, repo: freshRepo, dotfiles })
      : { how: "default", node: project.defaultNode as NodeName };
    const { node } = placement;
    const release = registry.reserve(pylonId, node, resources);
    try {
      // A template's disk is its project's size, and a pylon's disk size is fixed once it exists.
      const read: SetupRead = resources.diskGiB !== project.resources.diskGiB
        ? { fresh: `the start asked for a ${resources.diskGiB} GiB disk, and this project's templates have ${project.resources.diskGiB} GiB` }
        : await readSetup(project, branch, request.commit);

      const conversationId = request.claude === undefined && request.bare !== true ? await harness.startThread({ threadId: id, pylonId, ...request.drive === true ? { drive: true } : {} }) : null;
      const now = Date.now();
      const { setup, firstBoot, repo } = setUp(project, read, freshRepo, image, branch, node, now);
      const boot: Omit<BootInputs, "source"> = { pylonId, image, resources, gitIdentity: project.gitIdentity ?? gitIdentity, network, repo, dotfiles };
      const t: Thread = {
        id, title: request.title, project: project.id, pylonId, status: "active", conversationId: conversationId === null ? null : String(conversationId), startedBy: caller, createdAt: now,
        // Starting a thread is human activity, so its pylon is wanted at once.
        agentTurnRunning: false, working: false, lastAgentActivityAt: 0, lastHumanActivityAt: now, seenAt: null, lastReplyAt: null, placement, setup,
        ...request.parent === undefined ? {} : { parent: request.parent }, ...request.drive === true ? { drive: true as const } : {},
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
      checkLineage(registry, request);
      registry.createThread(t, pylon, claudePrompt, request.model, queuedId !== undefined, key);
      wake(node);
      return t;
    } finally {
      // Once the pylon's row exists, placement counts it from there.
      release();
    }
  };
}
