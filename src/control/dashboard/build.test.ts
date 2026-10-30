import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDashboard } from "./build.ts";

const root = resolve(import.meta.dirname, "../../..");
const out = await mkdtemp(join(tmpdir(), "nexus-dashboard-build-"));
const { outputs } = await buildDashboard(out);
test.after(() => rm(out, { recursive: true, force: true }));

const entry = Object.keys(outputs).find((path) => path.endsWith("/client.js"))!;
/** The outputs reached from `start` through imports of the given kinds. */
function reached(start: string, kinds: readonly string[]): Set<string> {
  const seen = new Set([start]);
  for (const path of seen) for (const { path: next, kind } of outputs[path]!.imports) if (kinds.includes(kind) && next in outputs) seen.add(next);
  return seen;
}
/** What a page loads before a diff opens: client.js and what it imports statically. */
const page = reached(entry, ["import-statement"]);
const inputsOf = (paths: Iterable<string>) => [...paths].flatMap((path) => Object.keys(outputs[path]!.inputs));

test("a page loads a small client with no grammar until a diff opens", () => {
  assert.ok(entry !== undefined, "the build writes client.js");
  assert.deepEqual(inputsOf(page).filter((input) => input.includes("@shikijs/langs")), []);
  const bytes = [...page].reduce((sum, path) => sum + outputs[path]!.bytes, 0);
  assert.ok(bytes < 53_000, `a page loads ${bytes} bytes of script`);
});

test("a language's grammar is a chunk of its own, which a page reaches only by importing it when a file needs it", () => {
  const grammar = Object.keys(outputs).filter((path) => Object.keys(outputs[path]!.inputs).some((input) => input.endsWith("@shikijs/langs/dist/typescript.mjs")));
  assert.equal(grammar.length, 1, "one chunk holds the typescript grammar");
  assert.ok(reached(entry, ["import-statement", "dynamic-import"]).has(grammar[0]!), "the client can load it");
  const diff = Object.keys(outputs).filter((path) => Object.keys(outputs[path]!.inputs).some((input) => input.endsWith("src/control/dashboard/diff.js")));
  assert.equal(diff.length, 1, "one chunk holds the diff view");
  assert.ok(!reached(diff[0]!, ["import-statement"]).has(grammar[0]!), "opening a diff does not load the grammar for every file");
});

test("every package bundled into the client is named in THIRD_PARTY_NOTICES.md with its version", async () => {
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const packages = new Set(inputsOf(Object.keys(outputs)).flatMap((input) => {
    const m = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    return m === null ? [] : [m[0]];
  }));
  const missing: string[] = [];
  for (const dir of packages) {
    const { name, version } = JSON.parse(await readFile(join(root, dir, "package.json"), "utf8")) as { name: string; version: string };
    if (!notices.includes(`| \`${name}\` | ${version} |`)) missing.push(`${name} ${version}`);
  }
  assert.deepEqual(missing, []);
});
