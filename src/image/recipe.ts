/**
 * The base pylon image's recipe. The control plane reads images/pylon/ with loadImageRecipe and sends the recipe
 * inline in a build-image job, which buildImage in build.ts runs.
 */
import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare } from "../util/compare.ts";
import { pinsSchema, type ImageRecipe } from "../protocol/images.ts";

export const pylonRecipeDir = fileURLToPath(new URL("../../images/pylon/", import.meta.url));

/**
 * The files under images/pylon that make the image, so that a file joins it only when it is named here. The rest
 * are build.sh, which only runs a build, and pins.json, which becomes ImageRecipe.pins.
 */
export const recipePaths = [
  "Dockerfile",
  "agent-setup/install.ts",
  "agent-setup/manifest.json",
  "agent-setup/manifest.ts",
  "checkout-files.py",
  "dotfiles/README.md",
  "gondolin.json",
  "nexus",
  "nexus-ask.ts",
  "nexus-claude-hook",
  "nexus-claude-hook.mjs",
  "nexus-contract.ts",
  "nexus-heartbeat.ts",
  "nexus-kvm",
  "nexus-outbox.ts",
  "nexus-turn.ts",
  "rootfs-init-extra.sh",
];

/** `paths` under `dir` sorted by path, each executable when its owner may execute it, as git checks it out, and pins.json parsed. */
export async function loadImageRecipe(dir: string = pylonRecipeDir, paths: readonly string[] = recipePaths): Promise<ImageRecipe> {
  const files: ImageRecipe["files"][number][] = [];
  for (const path of paths) {
    const from = join(dir, path);
    if (!(await lstat(from)).isFile()) throw new Error(`${path} in ${dir} is not a regular file`);
    files.push({ path, mode: ((await stat(from)).mode & 0o100) === 0 ? 0o644 : 0o755, content: await readFile(from, "utf8") });
  }
  files.sort((a, b) => compare(a.path, b.path));
  return { files, pins: pinsSchema.parse(JSON.parse(await readFile(join(dir, "pins.json"), "utf8"))) };
}
