/**
 * The base pylon image's recipe. The control plane reads images/pylon/ with loadImageRecipe and sends the recipe
 * inline in a build-image job, which buildImage in build.ts runs.
 */
import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare } from "../util/compare.ts";
import { pinsSchema, type ImageRecipe } from "./images.ts";

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
  "dotfiles/README.md",
  "gondolin.json",
  "nexus",
  "nexus-ask.ts",
  "nexus-claude-hook",
  "nexus-contract.ts",
  "nexus-heartbeat.ts",
  "nexus-kvm",
  "nexus-outbox.ts",
  "nexus-turn.ts",
  "rootfs-init-extra.sh",
];

/** Image inputs kept beside the control plane, which runs them too. The Claude hook snapshots turns with the checkout helper. */
const sharedFiles = ["checkout-files.py"];

/**
 * `paths` under `dir`, and the shared files, sorted by path, each executable when its owner may execute it, as git
 * checks it out, and pins.json parsed.
 */
export async function loadImageRecipe(dir: string = pylonRecipeDir, paths: readonly string[] = recipePaths): Promise<ImageRecipe> {
  const files: ImageRecipe["files"][number][] = [];
  const load = async (path: string, from: string | URL) => {
    files.push({ path, mode: ((await stat(from)).mode & 0o100) === 0 ? 0o644 : 0o755, content: await readFile(from, "utf8") });
  };
  for (const path of sharedFiles) await load(path, new URL(`../${path}`, import.meta.url));
  for (const path of paths) {
    if (!(await lstat(join(dir, path))).isFile()) throw new Error(`${path} in ${dir} is not a regular file`);
    await load(path, join(dir, path));
  }
  files.sort((a, b) => compare(a.path, b.path));
  return { files, pins: pinsSchema.parse(JSON.parse(await readFile(join(dir, "pins.json"), "utf8"))) };
}
