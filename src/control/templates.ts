/** The control plane's template policy: which template a thread boots from, and which artifacts are garbage. */
import { canonicalSha256, type Checkout } from "../spawn.ts";
import { effectiveAllowedHosts, type Project, type RemoteProject } from "../project.ts";
import type { JobEnvelope } from "../protocol/jobs.ts";
import { isImageId, isTemplateId, type ArtifactId, type ImageId, type NodeName, type PortableArtifactId, type ProjectId, type TemplateId } from "../ids.ts";
import type { TemplateBuildInputs, TemplateKey } from "../images.ts";

/**
 * Where and when. Built only when a human runs `nexus image build`, on the node named by the control
 * plane's `imageBuildNode` setting (default infra-testbench, where S1 verified Docker access). A build that
 * passes its smoke boot is recorded, which changes nothing pylons use. `nexus image rollout` then sends
 * fetch-artifact to every online node that lacks the image, and makes it `current`, which every new pylon uses,
 * once each holds it. A node that was offline gets it from planPylon's missing-artifact rule on first use. The
 * image it replaces stays recorded as the previous one, which `nexus image rollback` rolls out again. Running and
 * paused pylons keep the image they booted from, because their disks depend on its rootfs.
 */
export interface ImageSettings { imageBuildNode: NodeName; current: ImageId }

export const templateMaxAgeMs = 72 * 3_600_000;

/** Read by the control plane from the project's remote, src/control/mirror.ts. No pylon is booted to learn these. */
export interface SetupInputs {
  commit: string; // the full commit ID the ref resolved to
  setupBlob: string | null; // git object ID of .nexus/setup at `commit`
}
export interface ProjectMirror {
  /** Resolves a branch's tip or a full commit ID on the remote, and reads .nexus/setup's object ID there. Throws when the remote cannot be read. */
  setupInputs(project: RemoteProject, ref: { branch: string } | { commit: string }, signal?: AbortSignal): Promise<SetupInputs>;
}

/** sha256 of setupBlob, project.preSetup and effectiveAllowedHosts(project), since the hosts setup can reach change what it can install. */
/** The disk size is in it because a template's disk is the pylon's, and a pylon's disk size is fixed once it exists. */
export function setupHashOf(project: Project, inputs: SetupInputs): string {
  return canonicalSha256({ setupBlob: inputs.setupBlob, preSetup: project.preSetup, allowedHosts: effectiveAllowedHosts(project), diskGiB: project.resources.diskGiB });
}
export function templateIdOf(key: TemplateKey, node: NodeName, startedAt: number): TemplateId {
  return `tpl-${canonicalSha256({ project: key.project, image: key.image, setupHash: key.setupHash, node, startedAt }).slice(0, 12)}`;
}

/**
 * A building record holds its job's inputs, and the envelope it last sent, saved before the submit as a pylon's is,
 * so a control plane that restarts mid-build asks the probe about it instead of building twice.
 */
export type TemplateRecord =
  | { id: TemplateId; key: TemplateKey; state: "building"; on: NodeName; inputs: TemplateBuildInputs; submitted: JobEnvelope | null }
  | { id: TemplateId; key: TemplateKey; state: "ready"; builtOn: NodeName; builtAt: number; commit: string }
  | { id: TemplateId; key: TemplateKey; state: "failed"; on: NodeName; failedAt: number; logTail: string };

type ReadyTemplate = Extract<TemplateRecord, { state: "ready" }>;
export type BuildingTemplate = Extract<TemplateRecord, { state: "building" }>;

export type TemplateChoice =
  | { kind: "reuse"; template: TemplateId; builtAt: number }
  | { kind: "build"; template: TemplateId; on: NodeName; inputs: TemplateBuildInputs }
  | { kind: "wait"; template: TemplateId } // another thread's build of this key is running on the node
  | { kind: "fresh"; reason: string }; // the last build of this key on the node failed: boot the image and run setup inline

/** How a thread's pylon got its setup, decided once when the thread starts. */
export type ThreadSetup =
  | { how: "template"; template: TemplateId; builtAt: number; commit: string } // commit: the full ID the pylon checks out over the template
  | { how: "fresh"; reason: string; building?: TemplateId }; // building: the build this start asked for or found running, for the next thread

/**
 * Only records on targetNode count, and a ready one only while `held`, the node's last reported artifacts, lists it:
 * the registry records no template's sha256, so no copy from another node could be verified. Rules, first match wins:
 * - ready with this key, built on targetNode less than templateMaxAgeMs ago, and held: reuse.
 * - building with this key on targetNode: wait.
 * - failed with this key on targetNode: fresh, with its log, so the thread's agent can see and fix the failing setup.
 * - otherwise: build on targetNode, so the first spawn copies nothing. The build checks out `checkout`,
 *   the commit setupInputs resolved for the thread that asked, under a new ID minted from `now`.
 * reuse and wait return the ID of the record they found.
 */
export function chooseTemplate(project: RemoteProject, key: TemplateKey, checkout: Checkout, templates: readonly TemplateRecord[], targetNode: NodeName, held: readonly ArtifactId[], now: number): TemplateChoice {
  const records = templates.filter((t) => t.key.project === key.project && t.key.image === key.image && t.key.setupHash === key.setupHash);
  const reusable = records
    .filter((t): t is ReadyTemplate => t.state === "ready" && t.builtOn === targetNode && held.includes(t.id) && now - t.builtAt < templateMaxAgeMs)
    .sort((a, b) => b.builtAt - a.builtAt)[0];
  if (reusable !== undefined) return { kind: "reuse", template: reusable.id, builtAt: reusable.builtAt };
  const building = records.find((t) => t.state === "building" && t.on === targetNode);
  if (building !== undefined) return { kind: "wait", template: building.id };
  const failed = records.find((t): t is Extract<TemplateRecord, { state: "failed" }> => t.state === "failed" && t.on === targetNode);
  if (failed !== undefined) return { kind: "fresh", reason: `the build of template ${failed.id} failed on ${failed.on}: ${failed.logTail}` };
  return {
    kind: "build",
    template: templateIdOf(key, targetNode, now),
    on: targetNode,
    inputs: {
      key,
      repo: { url: project.repoUrl, ...checkout },
      preSetup: project.preSetup,
      allowedHosts: effectiveAllowedHosts(project),
      resources: project.resources,
    },
  };
}

/**
 * Garbage, computed by the control plane per node and sent as drop-artifact jobs: templates past
 * templateMaxAgeMs that are not their project's newest ready one, and images that are not current and back
 * no held template or checkpoint. The type cannot name a checkpoint. A wiped registry knows no templates,
 * so it may drop templates and images it does not know. ArtifactStore.drop refuses any image a local
 * checkpoint still needs, and the rest can be rebuilt.
 *
 * A building template and its image are kept, and a template whose only record is failed is garbage like one the registry does
 * not know. A held template backs its image until it is dropped, even in this same pass, so an image goes
 * on a later pass, after its templates. A checkpoint ID does not name its image, so this function cannot
 * see that dependency, and ArtifactStore.drop's refusal enforces it.
 */
export function garbage(held: readonly ArtifactId[], templates: readonly TemplateRecord[], images: ImageSettings, now: number): readonly PortableArtifactId[] {
  const newestReady = new Map<ProjectId, ReadyTemplate>();
  for (const t of templates) {
    if (t.state !== "ready") continue;
    const newest = newestReady.get(t.key.project);
    if (newest === undefined || t.builtAt > newest.builtAt) newestReady.set(t.key.project, t);
  }
  const keepTemplate = (id: TemplateId): boolean => templates.some((t) => t.id === id && (
    t.state === "building"
    || (t.state === "ready" && (now - t.builtAt < templateMaxAgeMs || newestReady.get(t.key.project) === t))
  ));
  const heldTemplates = held.filter(isTemplateId);
  const backsTemplate = (id: ImageId): boolean => templates.some((t) => t.key.image === id && (t.state === "building" || heldTemplates.includes(t.id)));
  return held.filter((id): id is PortableArtifactId => isTemplateId(id)
    ? !keepTemplate(id)
    : isImageId(id) && id !== images.current && !backsTemplate(id));
}
