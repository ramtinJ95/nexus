/** The IDs every module shares. This file imports nothing, so any module can take its IDs from here without a cycle. */

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

export type ProjectId = string & { readonly __project: unique symbol };

/** img-<sha256 of the recipe>[:12]. The same inputs give the same ID, so a rebuild of unchanged inputs is a no-op. */
export type ImageId = `img-${string}`;
/**
 * tpl-<sha256 of the TemplateKey, the node that builds it and the build's start time in ms>[:12]. An ID names one build,
 * not one key: the same key built twice, or on two nodes at once, gives two IDs, so a node's bytes under one ID never change.
 */
export type TemplateId = `tpl-${string}`;
/** ckpt-<thread id>-<n>, minted by the control plane for each pause. */
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
