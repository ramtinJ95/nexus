/**
 * The base pylon image's recipe. The control plane reads images/pylon/ with loadImageRecipe and sends the recipe
 * inline in a build-image job, which buildImage in build.ts runs.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, pinsSchema, type ImageRecipe } from "./images.ts";

export const pylonRecipeDir = fileURLToPath(new URL("../../images/pylon/", import.meta.url));

/** build.sh only runs a build. pins.json becomes ImageRecipe.pins. */
const notRecipeFiles = new Set(["build.sh", "pins.json"]);

/** Image inputs kept beside the control plane, which runs them too. The Claude hook snapshots turns with the checkout helper. */
const sharedFiles = ["checkout-files.py"];

/**
 * Every file under `dir` except build.sh, and the shared files, sorted by path, each executable when its owner may
 * execute it, as git checks it out, and pins.json parsed.
 */
export async function loadImageRecipe(dir: string = pylonRecipeDir): Promise<ImageRecipe> {
  const files: ImageRecipe["files"][number][] = [];
  const load = async (path: string, from: string | URL) => {
    files.push({ path, mode: ((await stat(from)).mode & 0o100) === 0 ? 0o644 : 0o755, content: await readFile(from, "utf8") });
  };
  for (const path of sharedFiles) await load(path, new URL(`../${path}`, import.meta.url));
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (!entry.isFile()) throw new Error(`${path} in ${dir} is not a regular file`);
    if (!notRecipeFiles.has(path)) await load(path, join(dir, path));
  }
  files.sort((a, b) => compare(a.path, b.path));
  return { files, pins: pinsSchema.parse(JSON.parse(await readFile(join(dir, "pins.json"), "utf8"))) };
}
