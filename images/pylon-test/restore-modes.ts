// build.sh's step between Gondolin's build and the tag's removal: buildImage's mode fix, for the test image.
//   node images/pylon-test/restore-modes.ts <Docker tag> <Gondolin assets directory> <container label>
import { restoreModes } from "../../src/image-build.ts";
import { JobFailure } from "../../src/backend.ts";

const [tag, assets, label] = process.argv.slice(2);
if (tag === undefined || assets === undefined || label === undefined) {
  console.error("usage: node images/pylon-test/restore-modes.ts <Docker tag> <assets directory> <container label>");
  process.exit(64);
}
try {
  await restoreModes(tag, assets, label, AbortSignal.timeout(10 * 60_000));
} catch (err) {
  if (err instanceof JobFailure) console.error(`${err.message}\n${err.logTail}`);
  throw err;
}
