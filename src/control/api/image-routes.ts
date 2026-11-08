/**
 * Recording, building, rolling out and rolling back the pylon image.
 */
import { z } from "zod";
import { HttpError } from "../http-error.ts";
import { imagesView, type ImageRollout } from "../image-rollout.ts";
import type { ImageOperation } from "../image-store.ts";
import { type ImageId, isImageId, type NodeName } from "../../ids.ts";
import { pinsSchema, type ImageManifest } from "../../protocol/images.ts";
import { ok, created, parse, type Reply, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, type Policy } from "./access.ts";

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
/** An image becomes what every new pylon boots, so building and rolling one out takes the same right as `nexus deploy`. */
const roll: Policy = { role: "deployer", action: "build, roll out or roll back an image" };

export function imageRoutes(kit: ApiKit, options: { images?: ImageRollout | undefined }): readonly RouteEntry[] {
  const { registry } = kit;

  function recordImage(body: unknown): ImageManifest {
    const manifest: ImageManifest = parse(imageSchema, body);
    registry.saveImage(manifest, null);
    return manifest;
  }

  function imageRollout(): ImageRollout {
    if (options.images === undefined) throw new HttpError(409, "image builds are not configured");
    return options.images;
  }
  const started = (operation: ImageOperation): Reply => ({ status: operation.state === "running" ? 202 : 200, body: operation });

  return [
    ["GET", /^\/v1\/images$/, anyAllowed, () => ok(imagesView(registry))],
    ["POST", /^\/v1\/images$/, { role: "allowed", why: "recording an image boots nothing until a deployer rolls it out" }, async (_, r) => created(recordImage(await r.body()))],
    ["GET", /^\/v1\/images\/current$/, anyAllowed, () => {
      const view = imagesView(registry);
      const entry = (id: ImageId | null) => view.images.find((image) => image.id === id) ?? null;
      return ok({ current: entry(view.current), previous: entry(view.previous) });
    }],
    ["POST", /^\/v1\/images\/build$/, roll, async (_, r) => {
      const images = imageRollout();
      parse(noFields, await r.body({}));
      return started(await images.build(r.caller));
    }],
    ["POST", /^\/v1\/images\/rollout$/, roll, async (_, r) => {
      const images = imageRollout();
      return started(images.rollout(parse(rolloutSchema, await r.body()).image, r.caller));
    }],
    ["POST", /^\/v1\/images\/rollback$/, roll, async (_, r) => {
      const images = imageRollout();
      parse(noFields, await r.body({}));
      return started(images.rollback(r.caller));
    }],
  ];
}
