/**
 * The image store: each recorded image, in `images`, each template, in `templates`, and the current image, the previous
 * image and the latest image build or rollout, in the `current`, `previous-image` and `image-operation` settings.
 */
import { json, jsonOrNull, type Db, type Row } from "./db.ts";
import type { JobId, NodeName, ProjectId, TailnetNodeId } from "../ids.ts";
import type { ImageId, ImageManifest, TemplateId } from "../images.ts";
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
   * done: the node's observation lists the image. skipped: the node was offline when the rollout began, so it fetches
   * the image on first use (planPylon's missing-artifact rule).
   */
  state: "pending" | "running" | "done" | "failed" | "skipped";
  /** The job last sent for this step, saved before it is sent, so a restarted control plane asks the probe about it. */
  job: { id: JobId; notAfter: string } | null;
  reason: string | null;
}

export type Outcome = { state: "running" } | { state: "done"; finishedAt: number } | { state: "failed"; finishedAt: number; reason: string };

/**
 * A build has one step, on the image build node, and keeps the release whose recipe it sent, which a control plane
 * deployed while it runs must not record in its place. A rollout has one step per registry node.
 */
export type ImageOperation = ({ kind: "build"; release: string | null } | { kind: "rollout" }) & {
  image: ImageId;
  requestedBy: TailnetNodeId;
  requestedAt: number;
  steps: readonly ImageStep[];
} & Outcome;

/** A row written before images recorded their release has none. */
function recordedImage(r: Row): RecordedImage {
  const image = json<ImageManifest & { release?: string | null }>(r.manifest);
  return { ...image, release: image.release ?? null };
}

export type ImageStore = ReturnType<typeof imageStore>;

export function imageStore(db: Db) {
  const { transaction, sql, setting, setSetting } = db;
  function image(id: ImageId): RecordedImage | undefined {
    const row = sql("SELECT manifest FROM images WHERE id = ?").get(id);
    return row && recordedImage(row);
  }
  return {
    /** Kept in the manifest column, so a control plane older than `release` still reads the row. */
    saveImage(manifest: ImageManifest, release: string | null) { sql("INSERT INTO images (id, manifest) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET manifest = excluded.manifest").run(manifest.id, JSON.stringify({ ...manifest, release })); },
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

    saveTemplate(template: TemplateRecord) { sql("INSERT INTO templates (id, project, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record").run(template.id, template.key.project, JSON.stringify(template)); },
    templates: (project: ProjectId) => (sql("SELECT record FROM templates WHERE project = ? ORDER BY id").all(project) as Row[]).map((r) => json<TemplateRecord>(r.record)),
    /** The builds the node's loop pass moves along, in every project. */
    buildingTemplates: (node: NodeName) => (sql("SELECT record FROM templates WHERE json_extract(record, '$.state') = 'building' AND json_extract(record, '$.on') = ? ORDER BY id").all(node) as Row[]).map((r) => json<BuildingTemplate>(r.record)),
    deleteTemplate(id: TemplateId) { sql("DELETE FROM templates WHERE id = ?").run(id); },
  };
}
