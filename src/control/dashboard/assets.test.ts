import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../../test-support/kit.ts";

// assets.ts names the bundle at a fixed path, which other suites read, so this one points its own copy at an empty one.
const dist = join(await tempDir("nexus-dashboard-assets-"), "dashboard");
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith("/src/control/dashboard/assets.ts")) return loaded;
    const source = String(loaded.source).replace(`"../../../dist/dashboard/"`, JSON.stringify(`${pathToFileURL(dist).href}/`));
    assert.notEqual(source, String(loaded.source), "the hook finds the bundle's path in assets.ts");
    return { ...loaded, source };
  },
});

test("the routes import without a built dashboard, which the first asset reads, and once it is built the next read serves it", async () => {
  await import("../api/dashboard-routes.ts");
  const { asset, assetUrl, entry } = await import("./assets.ts");
  assert.throws(() => asset(entry), /The dashboard client is not built/);
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, entry), "export {};");
  await writeFile(join(dist, "chunk-ABC.js"), "export {};");
  await writeFile(join(dist, "metafile.json"), JSON.stringify({ inputs: {}, outputs: { [`dist/dashboard/${entry}`]: {}, "dist/dashboard/chunk-ABC.js": {} } }));
  assert.match(assetUrl(entry), /^\/assets\/client\.js\?v=[0-9a-f]{12}$/);
  assert.equal(asset("chunk-ABC.js")?.version, null, "a chunk is named by its hash, so it carries no version");
  assert.equal(asset("metafile.json"), undefined, "the metafile is not served");
  assert.throws(() => assetUrl("chunk-ABC.js"), /links only the files assets.ts versions/);
});
