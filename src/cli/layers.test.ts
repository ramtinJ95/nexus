import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const src = resolve(import.meta.dirname, "..");
const files = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
/** `import … from`, `import type … from`, a bare `import "x"`, or a dynamic `import("x")`. */
const anyImport = /^import\s[^;]*?\bfrom\s+["']([^"']+)["']|^import\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm;

test("src/cli imports nothing from src/control, types included, but the wording a later change moves, so the CLI renders what the API serves", () => {
  const control = files.flatMap((file) => [...readFileSync(join(import.meta.dirname, file), "utf8").matchAll(anyImport)]
    .map((match) => relative(src, resolve(dirname(join(import.meta.dirname, file)), match[1] ?? match[2] ?? match[3]!)))
    .filter((target) => target.startsWith("control/"))
    .map((target) => `${file} imports ${target}`));
  assert.deepEqual(control, ["thread-text.ts imports control/wording.ts"]);
});
