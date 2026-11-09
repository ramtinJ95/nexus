import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const src = resolve(import.meta.dirname, "..");
const files = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" }).filter((file) => /\.(ts|js)$/.test(file));
/** `import … from`, `import type … from`, a bare `import "x"`, or a dynamic `import("x")`. */
const anyImport = /^import\s[^;]*?\bfrom\s+["']([^"']+)["']|^import\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm;

test("src/control imports nothing from src/cli, tests included, so control tests assert what the API serves, not how the CLI renders it", () => {
  const cli = files.flatMap((file) => [...readFileSync(join(import.meta.dirname, file), "utf8").matchAll(anyImport)]
    .map((match) => match[1] ?? match[2] ?? match[3]!)
    .filter((target) => target.startsWith("."))
    .map((target) => relative(src, resolve(dirname(join(import.meta.dirname, file)), target)))
    .filter((target) => target.startsWith("cli/"))
    .map((target) => `${file} imports ${target}`));
  assert.deepEqual(cli, []);
  assert.ok(files.includes("review.test.ts") && files.includes("api-streams.test.ts") && files.includes(join("dashboard", "dashboard.test.ts")));
});
