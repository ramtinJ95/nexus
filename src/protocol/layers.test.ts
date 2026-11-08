import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const src = resolve(import.meta.dirname, "..");
const protocol = readdirSync(import.meta.dirname).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
const specifier = /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

test("src/protocol imports only Node, zod, the ID and parse foundations, the image's guest contract, src/util, and itself, type-only imports included", () => {
  const outside = new Set(protocol.flatMap((file) => [...readFileSync(join(import.meta.dirname, file), "utf8").matchAll(specifier)]
    .map((match) => match[1]!)
    .filter((target) => !target.startsWith("node:") && target !== "zod")
    .map((target) => relative(src, resolve(import.meta.dirname, target)))
    .filter((target) => dirname(target) !== "protocol" && dirname(target) !== "util")));
  assert.deepEqual([...outside].sort(), ["../images/pylon/nexus-contract.ts", "ids.ts", "parse.ts"]);
});
