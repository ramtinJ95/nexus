import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("every file the services import is in the release that deploy/release.sh packages", async () => {
  const script = await readFile(join(root, "deploy/release.sh"), "utf8");
  const packaged = /tar -C "\$repo" -cf - ([^|]+)\|/.exec(script)?.[1]?.trim().split(/\s+/);
  assert.ok(packaged !== undefined, "release.sh's tar line was not found");

  const sources = (await readdir(join(root, "src"), { recursive: true }))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .map((path) => join(root, "src", path));
  const outside: string[] = [];
  for (const source of sources) {
    for (const [, specifier] of (await readFile(source, "utf8")).matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      const target = relative(root, resolve(dirname(source), specifier!));
      if (!packaged.some((entry) => target === entry || target.startsWith(`${entry}/`))) outside.push(`${relative(root, source)} imports ${target}`);
    }
  }
  assert.deepEqual(outside, []);
});

test("a release builds the dashboard client after it is hashed and before its dev dependencies are dropped", async () => {
  const script = await readFile(join(root, "deploy/release.sh"), "utf8");
  const at = (pattern: RegExp) => {
    const index = script.search(pattern);
    assert.notEqual(index, -1, `release.sh has ${pattern}`);
    return index;
  };
  const hashed = at(/^\s*release=\$\(cd "\$staging" && find /m);
  const installed = at(/npm ci (?!.*--omit=dev)/);
  const built = at(/npm run build/);
  const pruned = at(/npm prune --omit=dev/);
  assert.ok(hashed < installed && installed < built && built < pruned, "hash, then npm ci with dev dependencies, then the build, then the prune");
});
