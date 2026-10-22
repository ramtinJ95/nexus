/**
 * Child process entry for image-build.ts: `node src/gondolin-build.ts <config.json> <output dir> <work dir>`.
 * It calls Gondolin's buildAssets rather than its CLI, which also imports every build into Gondolin's own
 * image store, and it runs apart from the probe so that a job's deadline can kill a stalled build.
 */
import { readFileSync } from "node:fs";
import { buildAssets, parseBuildConfig } from "@earendil-works/gondolin";

const [configFile, outputDir, workDir] = process.argv.slice(2);
if (configFile === undefined || outputDir === undefined || workDir === undefined) {
  console.error("usage: node src/gondolin-build.ts <config.json> <output dir> <work dir>");
  process.exit(64);
}
// The OCI rootfs is extracted by a non-root tar, which applies the umask. A fixed one makes the bits it drops
// exactly the ones image-build.ts lists and restores.
process.umask(0o022);
await buildAssets(parseBuildConfig(readFileSync(configFile, "utf8")), { outputDir, workDir });
