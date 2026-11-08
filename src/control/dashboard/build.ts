/**
 * Bundles the dashboard client into dist/dashboard, which src/control/api/dashboard-routes.ts serves. The output is outside
 * src, so release.sh hashes only sources, and a release builds its own. Each module the client imports only
 * dynamically, such as a language's grammar, becomes a chunk of its own that a page fetches when it needs it.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { bundle, entry } from "./assets.ts";

/** Writes the bundle into `out` with its metafile, which src/control/dashboard/assets.ts serves it by. */
export async function buildDashboard(out = fileURLToPath(bundle)): Promise<Metafile> {
  await rm(out, { recursive: true, force: true });
  const { metafile } = await build({
    entryPoints: [fileURLToPath(new URL(`./${entry}`, import.meta.url))],
    outdir: out,
    bundle: true,
    format: "esm",
    splitting: true,
    minify: true,
    entryNames: "[name]",
    chunkNames: "[name]-[hash]",
    metafile: true,
    // The terminal's stylesheet goes into the page with the chunk that needs it.
    loader: { ".css": "text" },
    logLevel: "warning",
  });
  await writeFile(join(out, "metafile.json"), JSON.stringify(metafile));
  return metafile;
}

if (import.meta.main) await buildDashboard();
