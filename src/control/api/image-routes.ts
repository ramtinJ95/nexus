import { imagesView } from "../image-rollout.ts";
import { feature, type Features } from "../features.ts";
import type { ImageOperation } from "../image-store.ts";
import type { ImageId } from "../../ids.ts";
import type { ImageManifest } from "../../protocol/images.ts";
import { ok, created, on, parse, type RouteEntry, type ApiKit } from "./kit.ts";
import { anyAllowed, type Policy } from "./access.ts";
import { imageRoutes as routes } from "../../contract/release.ts";
import { imageSchema, noFields, rolloutSchema } from "../../contract/release-parse.ts";

/** An image becomes what every new pylon boots, so building and rolling one out takes the same right as `nexus deploy`. */
const roll = { role: "deployer", action: "build, roll out or roll back an image" } satisfies Policy;

export function imageRoutes(kit: ApiKit, features: Features): readonly RouteEntry[] {
  const { registry } = kit;

  function recordImage(body: unknown): ImageManifest {
    const manifest: ImageManifest = parse(imageSchema, body);
    registry.images.saveImage(manifest, null);
    return manifest;
  }

  const imageRollout = () => feature(features, "images");
  const started = (operation: ImageOperation) => ({ status: operation.state === "running" ? 202 : 200, body: operation });

  return [
    on(routes.list, anyAllowed, () => ok(imagesView(registry))),
    on(routes.record, { role: "allowed", why: "recording an image boots nothing until a deployer rolls it out" }, async (_, r) => created(recordImage(await r.body()))),
    on(routes.current, anyAllowed, () => {
      const view = imagesView(registry);
      const entry = (id: ImageId | null) => view.images.find((image) => image.id === id) ?? null;
      return ok({ current: entry(view.current), previous: entry(view.previous) });
    }),
    on(routes.build, roll, async (_, r) => {
      const images = imageRollout();
      parse(noFields, await r.body({}));
      return started(await images.build(r.caller));
    }),
    on(routes.rollout, roll, async (_, r) => {
      const images = imageRollout();
      return started(images.rollout(parse(rolloutSchema, await r.body()).image, r.caller));
    }),
    on(routes.rollback, roll, async (_, r) => {
      const images = imageRollout();
      parse(noFields, await r.body({}));
      return started(images.rollback(r.caller));
    }),
  ];
}
