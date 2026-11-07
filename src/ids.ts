/**
 * Every Nexus ID and request-ID namespace, minted and parsed here so each format is written once. This file imports
 * only Node builtins, so any module, the bootstrap included, can take its IDs from here without a cycle.
 */
import { createHash, randomBytes } from "node:crypto";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NodeName = Brand<string, "NodeName">; // "rj-firebat", "infra-testbench"
/** `pylon-${threadId}`. At most 40 characters, the pi-sandbox name limit, so thread IDs are at most 34. */
export type PylonId = Brand<string, "PylonId">;
export const maxPylonIdLength = 40;
export type JobId = Brand<string, "JobId">; // UUID minted by the control plane
/** sha256 of the canonical LiveSpec. Observations echo it, so the planner sees drift without a counter. */
export type LiveHash = Brand<string, "LiveHash">;
/** Tailscale's stable node ID, as LocalAPI whois reports it. It survives renames and address changes. */
export type TailnetNodeId = Brand<string, "TailnetNodeId">;

/** At most 34 characters, so `pylon-<id>` fits pi-sandbox's 40. */
export type ThreadId = Brand<string, "ThreadId">;
export type ProjectId = string & { readonly __project: unique symbol };
/** it-<12 hex>: random for an item `nexus item add` adds, or a hash of the question for one a planning proposal became. */
export type ItemId = Brand<string, "ItemId">;

/** img-<sha256 of the recipe>[:12]. The same inputs give the same ID, so a rebuild of unchanged inputs is a no-op. */
export type ImageId = `img-${string}`;
/**
 * tpl-<sha256 of the TemplateKey, the node that builds it and the build's start time in ms>[:12]. An ID names one build,
 * not one key: the same key built twice, or on two nodes at once, gives two IDs, so a node's bytes under one ID never change.
 */
export type TemplateId = `tpl-${string}`;
/** ckpt-<thread id>-<n>, minted by the control plane for each pause, or ckpt-<thread id>-shutdown-<epoch ms> by a probe draining for its node's shutdown. */
export type CheckpointId = `ckpt-${string}`;
export type ArtifactId = ImageId | TemplateId | CheckpointId;
/** What drop-artifact may name. A checkpoint leaves a node only through delete of its pylon. */
export type PortableArtifactId = Exclude<ArtifactId, CheckpointId>;
/**
 * Image and template IDs as the control plane mints them, a kind and a few lowercase letters or digits. They
 * name directories in a node's artifact store, so an ID with a separator or a dot is refused before it is used.
 */
export const isImageId = (id: unknown): id is ImageId => typeof id === "string" && /^img-[a-z0-9]{1,40}$/.test(id);
export const isTemplateId = (id: unknown): id is TemplateId => typeof id === "string" && /^tpl-[a-z0-9]{1,40}$/.test(id);
export const isPortableArtifactId = (id: unknown): id is PortableArtifactId => isImageId(id) || isTemplateId(id);

/** A tailnet machine name, which is one DNS label. `auto` is what `start --node auto` asks for, so no node may be named it. */
export const isNodeName = (name: unknown): name is NodeName => typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) && name !== "auto";

export const newThreadId = () => `th-${randomBytes(6).toString("hex")}` as ThreadId;
export const pylonIdOf = (thread: ThreadId | string) => `pylon-${thread}` as PylonId;
export const isPylonId = (id: unknown): id is PylonId => typeof id === "string" && id.length <= maxPylonIdLength && /^[a-z][a-z0-9-]*$/.test(id);
/** The thread a pylon ID names, read back out of `pylon-<thread>`. An ID without the prefix is returned as it is. */
export const threadOfPylon = (pylon: PylonId) => pylon.replace(/^pylon-/, "") as ThreadId;

export const newItemId = () => `it-${randomBytes(6).toString("hex")}` as ItemId;
/** The same seed always gives the same item, so an item made from a question needs no stored link back to it. */
export const itemIdFrom = (seed: string) => `it-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}` as ItemId;
export const isItemId = (id: unknown): id is ItemId => typeof id === "string" && /^it-[0-9a-f]{12}$/.test(id);

export const checkpointId = (thread: ThreadId | string, pause: number): CheckpointId => `ckpt-${thread}-${pause}`;
export const shutdownCheckpointId = (pylon: PylonId, at: number): CheckpointId => `ckpt-${threadOfPylon(pylon)}-shutdown-${at}`;
export const isCheckpointId = (id: unknown): id is CheckpointId => typeof id === "string" && id.startsWith("ckpt-");
export const isArtifactId = (id: unknown): id is ArtifactId => isPortableArtifactId(id) || isCheckpointId(id);

/**
 * Request IDs Nexus mints itself, each `<namespace>:<what it is for>`. A start under a `pipeline:` request ID is the
 * thread an item became, so a caller may not start one under that namespace.
 */
export const requestIds = {
  pipeline: (item: ItemId) => `pipeline:${item}`,
  brief: (thread: ThreadId) => `brief:${thread}`,
  queued: (thread: ThreadId) => `queued:${thread}`,
  nudge: (thread: ThreadId, turn: number) => `nudge:${thread}:${turn}`,
  resume: (thread: ThreadId, turn: number) => `resume:${thread}:${turn}`,
} as const;
export const isPipelineRequestId = (requestId: string) => requestId.startsWith("pipeline:");
