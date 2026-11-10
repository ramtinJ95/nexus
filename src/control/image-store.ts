import { isDeepStrictEqual } from "node:util";
import { json, jsonOrNull, type Db, type Holding, type Row } from "./db.ts";
import type { ImageId, JobId, NodeName, ProjectId, TailnetNodeId, TemplateId } from "../ids.ts";
import type { ImageManifest } from "../protocol/images.ts";
import type { BuildingTemplate, TemplateRecord } from "./templates.ts";

/**
 * An image's manifest and `release`, the full commit of the control plane release whose recipe built it. Null when that is
 * unknown, as for a build from a dev checkout or an image recorded through POST /v1/images.
 */
export type RecordedImage = ImageManifest & { release: string | null };

/** One node's part of an image operation. */
export interface ImageStep {
  node: NodeName;
  /**
   * done: the node's observation lists the image. skipped: the node was offline when the rollout began, so the control
   * plane sends it the image once it is back online, as an ImageFetch.
   */
  state: "pending" | "running" | "done" | "failed" | "skipped";
  /** The job last sent for this step, saved before it is sent, so a restarted control plane asks the probe about it. */
  job: { id: JobId; notAfter: string } | null;
  /** Why it failed or was skipped, or "recorded already" for a build that needed no job. */
  reason: string | null;
}

export type Outcome = { state: "running" } | { state: "done"; finishedAt: number } | { state: "failed"; finishedAt: number; reason: string };

/**
 * A build has one step, on the image build node, and keeps the release whose recipe it sent, which a control plane
 * deployed while it runs must not record in its place. A rollout has one step per registry node.
 */
export type ImageOperation = ({ kind: "build"; release: string | null } | { kind: "rollout" }) & {
  /** `img-` and 12 hex as `nexus image build` makes it. POST /v1/images takes `img-` and 1 to 40 lowercase letters or digits. */
  image: ImageId;
  /** The caller's stable tailnet node ID. */
  requestedBy: TailnetNodeId;
  /** Unix milliseconds. */
  requestedAt: number;
  steps: readonly ImageStep[];
} & Outcome;

/** The current image's copy to one online node that lacks it, which the image worker sends outside a rollout. */
export interface ImageFetch {
  node: NodeName;
  image: ImageId;
  /**
   * waiting: no job runs (before the first send, in the backoff after a failure, or while no other online node holds the
   * image). running: a fetch-artifact job was accepted. failed: maxImageFetches jobs in a row failed, or the probe
   * refused the job as invalid, so none is sent again until a rollout begins or the node goes offline and comes back.
   */
  state: "waiting" | "running" | "failed";
  /** The job last sent, saved before it is sent, so a restarted control plane asks the probe about it. */
  job: { id: JobId; notAfter: string } | null;
  /** Failed jobs in a row. */
  failures: number;
  /** Unix ms of the last failure, which the backoff counts from, or null. */
  failedAt: number | null;
  /** The last failure's reason, or why no job can be sent now, or null. */
  reason: string | null;
}

export const maxImageFetches = 3;

/** A row written before images recorded their release has none. */
function recordedImage(r: Row): RecordedImage {
  const image = json<ImageManifest & { release?: string | null }>(r.manifest);
  return { ...image, release: image.release ?? null };
}

export const holding = { tables: { images: {}, templates: {} }, settings: ["current", "previous-image", "image-operation", "image-fetches"] } as const satisfies Holding;

export function imageStore(db: Db) {
  const { transaction, sql } = db;
  const { setting, setSetting } = db.hold(holding);
  function image(id: ImageId): RecordedImage | undefined {
    const row = sql("SELECT manifest FROM images WHERE id = ?").get(id);
    return row && recordedImage(row);
  }
  return {
    /** Kept in the manifest column, so a control plane older than `release` still reads the row. */
    saveImage(manifest: ImageManifest, release: string | null) { sql("INSERT INTO images (id, manifest) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET manifest = excluded.manifest").run(manifest.id, JSON.stringify({ ...manifest, release })); },
    /**
     * Records an image that is new, as POST /v1/images does. An ID recorded already keeps its manifest and release, because
     * nodes verify the bytes they fetch against its sha256. False when the ID is recorded with another manifest.
     */
    addImage(manifest: ImageManifest): boolean {
      return transaction(() => {
        const recorded = image(manifest.id);
        if (recorded === undefined) {
          sql("INSERT INTO images (id, manifest) VALUES (?, ?)").run(manifest.id, JSON.stringify({ ...manifest, release: null }));
          return true;
        }
        const { release: _, ...was } = recorded;
        return isDeepStrictEqual(was, JSON.parse(JSON.stringify(manifest)));
      });
    },
    image,
    images: () => (sql("SELECT manifest FROM images ORDER BY id").all() as Row[]).map(recordedImage),
    /** The image every new pylon boots. Only a recorded image can become current, and the one it replaces becomes the previous image. */
    setCurrentImage(id: ImageId) {
      transaction(() => {
        if (image(id) === undefined) throw new Error(`no image ${id} is recorded`);
        const current = setting("current");
        if (current !== null && current !== id) setSetting("previous-image", current);
        setSetting("current", id);
      });
    },
    currentImage: (): ImageId | null => setting("current") as ImageId | null,
    previousImage: (): ImageId | null => setting("previous-image") as ImageId | null,
    /** The latest image build or rollout. One runs at a time, and it stays readable once it has finished. */
    imageOperation: (): ImageOperation | null => jsonOrNull<ImageOperation>(setting("image-operation")),
    saveImageOperation(operation: ImageOperation) { setSetting("image-operation", JSON.stringify(operation)); },
    /** One record per online node that lacks the current image, which the image worker keeps while no rollout runs. */
    imageFetches: (): ImageFetch[] => jsonOrNull<ImageFetch[]>(setting("image-fetches")) ?? [],
    saveImageFetches(fetches: readonly ImageFetch[]) { setSetting("image-fetches", JSON.stringify(fetches)); },

    saveTemplate(template: TemplateRecord) { sql("INSERT INTO templates (id, project, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record").run(template.id, template.key.project, JSON.stringify(template)); },
    templates: (project: ProjectId) => (sql("SELECT record FROM templates WHERE project = ? ORDER BY id").all(project) as Row[]).map((r) => json<TemplateRecord>(r.record)),
    /** The builds the node's loop pass moves along, in every project. */
    buildingTemplates: (node: NodeName) => (sql("SELECT record FROM templates WHERE json_extract(record, '$.state') = 'building' AND json_extract(record, '$.on') = ? ORDER BY id").all(node) as Row[]).map((r) => json<BuildingTemplate>(r.record)),
    deleteTemplate(id: TemplateId) { sql("DELETE FROM templates WHERE id = ?").run(id); },
  };
}
