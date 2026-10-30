/**
 * Recording, building, rolling out and rolling back the pylon image.
 */
import { z } from "zod";
import { HttpError } from "../http-error.ts";
import { canDeploy, type DeploymentOptions } from "../releases.ts";
import { imagesView, type ImageOperation, type ImageRollout } from "../image-rollout.ts";
import { isImageId, type NodeName, type TailnetNodeId } from "../../ids.ts";
import { pinsSchema, type ImageId, type ImageManifest } from "../../images.ts";
import { ok, created, parse, type Reply, type RouteEntry, type ApiKit } from "./kit.ts";

const imageSchema = z.strictObject({
  id: z.custom<ImageId>(isImageId, "must be an image ID"),
  gondolinBuildId: z.string().min(1),
  pins: pinsSchema,
  builtOn: z.string().min(1).transform((node) => node as NodeName),
  builtAt: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const rolloutSchema = z.strictObject({ image: imageSchema.shape.id });
const noFields = z.strictObject({});

export function imageRoutes(kit: ApiKit, options: { images?: ImageRollout | undefined; deployment?: DeploymentOptions | undefined }): readonly RouteEntry[] {
  const { registry } = kit;

  function recordImage(body: unknown): ImageManifest {
    const manifest: ImageManifest = parse(imageSchema, body);
    registry.saveImage(manifest, null);
    return manifest;
  }

  /** An image becomes what every new pylon boots, so building and rolling one out takes the same right as `nexus deploy`. */
  function imageRollout(caller: TailnetNodeId): ImageRollout {
    if (!canDeploy(registry, options.deployment, caller)) throw new HttpError(403, "caller may not build, roll out or roll back an image: only deployers may, never infrastructure nodes or pylons");
    if (options.images === undefined) throw new HttpError(409, "image builds are not configured");
    return options.images;
  }
  const started = (operation: ImageOperation): Reply => ({ status: operation.state === "running" ? 202 : 200, body: operation });

  return [
    ["GET", /^\/v1\/images$/, () => ok(imagesView(registry))],
    ["POST", /^\/v1\/images$/, { open: "recording an image boots nothing until a deployer rolls it out" }, async (_, r) => created(recordImage(await r.body()))],
    ["GET", /^\/v1\/images\/current$/, () => {
      const view = imagesView(registry);
      const entry = (id: ImageId | null) => view.images.find((image) => image.id === id) ?? null;
      return ok({ current: entry(view.current), previous: entry(view.previous) });
    }],
    ["POST", /^\/v1\/images\/build$/, { open: "deployers only, which imageRollout checks" }, async (_, r) => {
      const images = imageRollout(r.caller);
      parse(noFields, await r.body({}));
      return started(await images.build(r.caller));
    }],
    ["POST", /^\/v1\/images\/rollout$/, { open: "deployers only, which imageRollout checks" }, async (_, r) => {
      const images = imageRollout(r.caller);
      return started(images.rollout(parse(rolloutSchema, await r.body()).image, r.caller));
    }],
    ["POST", /^\/v1\/images\/rollback$/, { open: "deployers only, which imageRollout checks" }, async (_, r) => {
      const images = imageRollout(r.caller);
      parse(noFields, await r.body({}));
      return started(images.rollback(r.caller));
    }],
  ];
}
