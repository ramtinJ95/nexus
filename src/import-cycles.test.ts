import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = ["src", "images"].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((path) => /\.[jt]s$/.test(path) && !path.split("/").includes("node_modules"))
    .map((path) => join(root, dir, path)),
);
const known = new Set(files);
const specifier = /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const edges = new Map(files.map((file) => [file, [...readFileSync(file, "utf8").matchAll(specifier)]
  .map((match) => resolve(dirname(file), match[1]!)).filter((target) => known.has(target))]));

test("no import cycle runs through src/ or images/, tests and type-only imports included", () => {
  const done = new Set<string>();
  const walk = (file: string, path: string[]) => {
    if (done.has(file)) return;
    const at = path.indexOf(file);
    if (at >= 0) assert.fail(`import cycle: ${[...path.slice(at), file].map((step) => relative(root, step)).join(" -> ")}`);
    for (const target of edges.get(file)!) walk(target, [...path, file]);
    done.add(file);
  };
  for (const file of files) walk(file, []);
});
