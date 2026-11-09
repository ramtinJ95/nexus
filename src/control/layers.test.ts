import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const src = resolve(import.meta.dirname, "..");
const files = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" }).filter((file) => /\.(ts|js)$/.test(file));
/** Every quoted relative path, whatever the import, export or dynamic import() around it, so no spelling of an import slips past. */
const relativePath = /["'`](\.\.?\/[^"'`\n]+)["'`]/g;

test("src/control imports nothing from src/cli, tests included, so control tests assert what the API serves, not how the CLI renders it", () => {
  const cli = files.flatMap((file) => [...readFileSync(join(import.meta.dirname, file), "utf8").matchAll(relativePath)]
    .map((match) => relative(src, resolve(dirname(join(import.meta.dirname, file)), match[1]!)))
    .filter((target) => target.startsWith("cli/"))
    .map((target) => `${file} imports ${target}`));
  assert.deepEqual(cli, []);
  assert.ok(files.includes("review.test.ts") && files.includes("api-streams.test.ts") && files.includes(join("dashboard", "dashboard.test.ts")));
});
