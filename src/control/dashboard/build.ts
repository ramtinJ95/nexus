/**
 * Bundles the dashboard client into dist/dashboard, which src/control/dashboard.ts serves. The output is outside
 * src, so release.sh hashes only sources, and a release builds its own. Each module the client imports only
 * dynamically, such as a language's grammar, becomes a chunk of its own that a page fetches when it needs it.
 */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";

export const outdir = fileURLToPath(new URL("../../../dist/dashboard/", import.meta.url));

/** Builds the client into `out`, replacing whatever was there, and returns esbuild's account of the output. */
export async function buildDashboard(out = outdir): Promise<Metafile> {
  await rm(out, { recursive: true, force: true });
  const { metafile } = await build({
    entryPoints: [fileURLToPath(new URL("./client.js", import.meta.url))],
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
  return metafile;
}

if (import.meta.main) await buildDashboard();
