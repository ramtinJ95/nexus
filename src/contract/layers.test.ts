import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const src = resolve(import.meta.dirname, "..");
/** The parsers need zod, so they stay in -parse.ts files, which only Node loads. */
const bundled = readdirSync(import.meta.dirname).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("-parse.ts"));
/** `import … from`, a bare `import "x"`, or a dynamic `import("x")`, but not `import type`. */
const runtimeImport = /^import\s+(?!type\s)[^;]*?\bfrom\s+["']([^"']+)["']|^import\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm;

test("src/contract imports nothing at run time beyond itself and src/util, so a browser can bundle it, its parsers aside", () => {
  const outside = bundled.flatMap((file) => [...readFileSync(join(import.meta.dirname, file), "utf8").matchAll(runtimeImport)]
    .map((match) => match[1] ?? match[2] ?? match[3]!)
    .map((target) => target.startsWith(".") ? relative(src, resolve(import.meta.dirname, target)) : target)
    .filter((target) => dirname(target) !== "contract" && dirname(target) !== "util")
    .map((target) => `${file} imports ${target}`));
  assert.deepEqual(outside, []);
  assert.ok(["threads.ts", "route.ts", "pylon.ts", "streams.ts", "watch.ts", "release.ts", "reports.ts", "projects.ts", "reviews.ts"].every((file) => bundled.includes(file)));
});
