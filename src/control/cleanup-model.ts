/**
 * What a node could delete, and the question that asks the person about it: the templates and images garbage() picks
 * that no pylon on the node boots from, and the releases nothing keeps (releaseKeeps). Pure, so the cleanup pass, the
 * delete and the deployer's route read one rule.
 */
import { createHash } from "node:crypto";
import { isImageId, isTemplateId, type ArtifactId, type ImageId, type NodeName, type ProjectId, type PylonId, type TemplateId } from "../ids.ts";
import type { DeleteOutcome } from "../protocol/cleanup.ts";
import { releaseKeeps, type ReleaseInventory } from "../deploy/release-cleanup.ts";
import { garbage, templateMaxAgeMs, type TemplateRecord } from "./templates.ts";

export type CleanupItem =
  | { kind: "template"; id: TemplateId; project: ProjectId | null; bytes: number }
  | { kind: "image"; id: ImageId; bytes: number }
  | { kind: "release"; name: string; commit: string | null; bytes: number };

/** An item before its size is read. */
export type Candidate = { [K in CleanupItem["kind"]]: Omit<Extract<CleanupItem, { kind: K }>, "bytes"> }[CleanupItem["kind"]];

/** The items asked about, and what each delete did once the person agreed, by itemKey. */
export interface Cleanup { items: readonly CleanupItem[]; outcomes: Readonly<Record<string, DeleteOutcome>> }

/** The question's options. Delete deletes every item, and Keep deletes none. */
export const cleanupOptions = ["Delete", "Keep"] as const;

export const itemKey = (item: Candidate): string => item.kind === "release" ? `release-${item.name}` : item.id;

/** What the registry knows of a node when the pass looks at it. */
export interface NodeFacts {
  /** The images and templates its last observation lists, or null while it is offline. */
  held: readonly ArtifactId[] | null;
  /** Each template build on the node. */
  templates: readonly TemplateRecord[];
  current: ImageId | null;
  previous: ImageId | null;
  /** The image of the latest image build or rollout, which a rollout copies to the nodes before it becomes current. */
  operated: ImageId | null;
  /**
   * What the node's pylons boot from: the image of each its observation lists, whose disk is an overlay on it, and the
   * image and first boot's template of each pylon of an open thread it does not list yet, such as a start's.
   */
  boots: readonly { pylon: PylonId; image: ImageId; template: TemplateId | null }[];
  /** What the node's deployer last reported, or null for a node whose deployer reports none. */
  releases: ReleaseInventory | null;
}

/** A pylon on the node that boots from the artifact, as a start that picked up a template does until it boots. */
function bootedBy(facts: NodeFacts, id: ArtifactId): string | null {
  const boot = facts.boots.find((b) => b.image === id || b.template === id);
  return boot === undefined ? null : `pylon ${boot.pylon} boots from it`;
}

/**
 * Images and templates garbage() picks, keeping the previous image a rollback rolls out again, less the image of the
 * latest build or rollout and any a pylon on the node boots from. Then releases nothing keeps. Templates come before
 * images, so an image goes after its templates.
 */
export function cleanupCandidates(node: NodeName, facts: NodeFacts, now: number): Candidate[] {
  const artifacts = facts.held === null || facts.current === null ? []
    : garbage(facts.held, facts.templates, { imageBuildNode: node, current: facts.current, previous: facts.previous }, now)
      .filter((id) => id !== facts.operated && bootedBy(facts, id) === null);
  const keeps = facts.releases === null ? new Map() : releaseKeeps(facts.releases);
  return [
    ...artifacts.filter(isTemplateId).map((id) => ({ kind: "template" as const, id, project: facts.templates.find((t) => t.id === id)?.key.project ?? null })),
    ...artifacts.filter(isImageId).map((id) => ({ kind: "image" as const, id })),
    ...(facts.releases?.releases ?? []).filter((r) => !keeps.has(r.name)).map((r) => ({ kind: "release" as const, name: r.name, commit: r.commit })),
  ];
}

/**
 * Why an image or template the person agreed to delete stays, read again at delete time: a pylon boots from it, or
 * garbage() would keep it now. One the node no longer lists is judged as if it did, since an observation can lag a
 * copy that brought it back. Null when it is still a candidate.
 */
export function artifactKept(node: NodeName, facts: NodeFacts, id: ImageId | TemplateId, now: number): string | null {
  const booted = bootedBy(facts, id);
  if (booted !== null) return booted;
  const held = facts.held === null || facts.held.includes(id) ? facts.held : [...facts.held, id];
  if (cleanupCandidates(node, { ...facts, held }, now).some((c) => itemKey(c) === id)) return null;
  if (id === facts.current) return "it is the current image";
  if (id === facts.previous) return "it is the previous image, which a rollback rolls out again";
  if (id === facts.operated) return "the latest image build or rollout is of it";
  const record = facts.templates.find((t) => t.id === id);
  if (record?.state === "building") return "a template build runs on it";
  if (record?.state === "ready" && now - record.builtAt < templateMaxAgeMs) return "it is under 72 hours old";
  if (record?.state === "ready") return "it is its project's newest ready template";
  return isImageId(id) ? "a template or a template build on the node needs it" : "Nexus keeps it now";
}

/** Whether the candidates hold one the latest question did not ask about, which is when the person is asked again. */
export const grew = (candidates: readonly Candidate[], latest: { cleanup: Cleanup } | undefined): boolean =>
  candidates.some((c) => !latest?.cleanup.items.some((i) => itemKey(i) === itemKey(c)));

/** The items the person agreed to delete that no delete has reported on yet. */
export const undeleted = (q: { cleanup: Cleanup; answer: { option: string } | null }): CleanupItem[] =>
  q.answer?.option === "Delete" ? q.cleanup.items.filter((i) => q.cleanup.outcomes[itemKey(i)] === undefined) : [];

export const freedBytes = (cleanup: Cleanup): number =>
  Object.values(cleanup.outcomes).reduce((sum, o) => sum + (o.state === "deleted" ? o.bytes : 0), 0);

export function bytesText(bytes: number): string {
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit < 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

export function itemText(item: CleanupItem): string {
  switch (item.kind) {
    case "template": return `template ${item.id}${item.project === null ? "" : ` of project ${item.project}`}`;
    case "image": return `image ${item.id}`;
    case "release": return `release ${item.name}${item.commit === null || item.commit === item.name ? "" : ` (commit ${item.commit.slice(0, 12)})`}`;
  }
}

/**
 * One ID per node, set of items and asking, so a set asked again after the node's latest question names a new question
 * rather than an answered one of the same set.
 */
export const cleanupQuestionId = (node: NodeName, items: readonly CleanupItem[], askedAt: number) =>
  `cleanup-${node}-${createHash("sha256").update(JSON.stringify([items.map(itemKey).sort(), askedAt])).digest("hex").slice(0, 12)}`;

export function cleanupQuestion(node: NodeName, items: readonly CleanupItem[], askedAt: number) {
  const total = items.reduce((sum, i) => sum + i.bytes, 0);
  return {
    id: cleanupQuestionId(node, items, askedAt),
    node,
    text: `${node} holds ${items.length === 1 ? "one thing" : `${items.length} things`} nothing needs any more, which ${items.length === 1 ? "takes" : "take"} ${bytesText(total)}. Delete ${items.length === 1 ? "it" : "them"}?\n\n${items.map((i) => `- ${itemText(i)}, ${bytesText(i.bytes)}`).join("\n")}`,
    options: [...cleanupOptions],
    reserved: null,
    answerer: "person" as const,
    askedAt,
    cleanup: { items, outcomes: {} },
  };
}
