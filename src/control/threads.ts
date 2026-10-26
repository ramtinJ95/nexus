import { randomBytes } from "node:crypto";
import type { HarnessHost } from "../harness/host.ts";
import { effectiveAllowedHosts, hasRemote, liveHashOf, withHttpsHosts, type BootInputs, type ProjectId, type PylonOverlay, type RepoInit } from "../project.ts";
import type { NodeName, PylonId } from "../protocol.ts";
import { newPylonRecord } from "../tick.ts";
import { HttpError } from "./http-error.ts";
import { pylonLive } from "./live.ts";
import type { Registry, Thread, ThreadId } from "./registry.ts";

/**
 * What starts a thread. `claude` makes it a Claude worker with that first prompt, which gets `/poteto-mode` in front
 * unless `raw`, as for the review loop's reviewers. A `bare` thread has neither agent, as a check thread needs only
 * its pylon. Only the control plane itself asks for `raw` or `bare`.
 */
export interface StartRequest { project: string; title: string; node?: string | undefined; branch?: string | undefined; commit?: string | undefined; claude?: string | undefined; model?: string | undefined; raw?: boolean; bare?: boolean }

/** `pylon-<id>` must fit in 40 characters. */
const newThreadId = () => `th-${randomBytes(6).toString("hex")}` as ThreadId;

export function threadStarter(options: { registry: Registry; harness: Pick<HarnessHost, "startThread">; dotfiles: PylonOverlay["dotfiles"]; gitIdentity?: BootInputs["gitIdentity"]; wake(node: NodeName): void }) {
  const { registry, harness, dotfiles, gitIdentity, wake } = options;
  /**
   * Templates come later, so every pylon boots fresh from the current image and runs setup inline. The
   * conversation is created before the registry row, as HarnessHost.startThread requires.
   */
  return async function startThread(request: StartRequest, caller: string): Promise<Thread> {
    const claudePrompt = request.claude === undefined || request.raw === true || /^\/poteto-mode(?:\s|$)/.test(request.claude) ? request.claude : `/poteto-mode ${request.claude}`;
    if (claudePrompt !== undefined && claudePrompt.length > 16_384) throw new HttpError(400, "Claude prompt including /poteto-mode exceeds 16384 characters");
    const project = registry.project(request.project as ProjectId);
    if (project === undefined) throw new HttpError(404, `no project ${request.project}`);
    const node = (request.node ?? project.defaultNode) as NodeName;
    if (registry.node(node) === undefined) throw new HttpError(400, `no node ${node}`);
    const image = registry.currentImage();
    if (image === null) throw new HttpError(409, "no image is current yet, so a pylon has nothing to boot");
    const branch = request.branch ?? project.defaultBranch;
    if (!hasRemote(project) && request.commit !== undefined) throw new HttpError(400, `project ${project.id} is a scratch project, so it has no commit to check out`);
    // The one place a thread's repository is decided. It is frozen into the pylon's boot.
    const repo: RepoInit = hasRemote(project)
      ? { kind: "clone", url: project.repoUrl, checkout: { branch, commit: request.commit ?? `origin/${branch}` } }
      : { kind: "empty", branch };

    const now = Date.now();
    const id = newThreadId();
    const pylonId = `pylon-${id}` as PylonId;
    const conversationId = request.claude === undefined && request.bare !== true ? await harness.startThread({ threadId: id, pylonId }) : null;
    const t: Thread = {
      id, title: request.title, project: project.id, pylonId, status: "active", conversationId: conversationId === null ? null : String(conversationId), startedBy: caller, createdAt: now,
      // Starting a thread is human activity, so its pylon is wanted at once.
      agentTurnRunning: false, lastAgentActivityAt: 0, lastHumanActivityAt: now, seenAt: null, lastReplyAt: null,
    };
    const boot: Omit<BootInputs, "source"> = {
      pylonId, image, resources: project.resources,
      gitIdentity: project.gitIdentity ?? gitIdentity,
      // Every boot pulls the dotfiles through the allowlist. A template build pulls none, so their host stays out of the setup hash.
      network: { allowedHosts: withHttpsHosts(effectiveAllowedHosts(project), [dotfiles.repo]), secrets: project.secrets },
      repo,
      dotfiles,
    };
    // Ports are allocated once the pylon reports the services that want a preview.
    const live = pylonLive({ pylonId, thread: id, node, boot }, project, []);
    const { desired: _, ...pylon } = newPylonRecord({
      thread: id, pylonId, node, desired: "running",
      boot,
      firstBoot: { kind: "fresh", preSetup: project.preSetup },
      live,
      liveHash: liveHashOf(live),
    });
    registry.createThread(t, pylon, claudePrompt, request.model);
    wake(node);
    return t;
  };
}
