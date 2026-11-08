import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cliDoc, declaration, generated, generatedDocs, marker } from "../scripts/docs-gen.ts";
import { minControlVersion } from "./cli/config.ts";
import { version } from "./version.ts";

const root = resolve(import.meta.dirname, "..");
const docs = readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".md"))
  .map((path) => join(root, "docs", path));
const linking = [...docs, join(root, "README.md"), join(root, "deploy/README.md")];
const changelogFile = join(root, "docs/changelog.md");
const read = (file: string) => readFileSync(file, "utf8");
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const headings = (file: string) => [...read(file).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]!);
const anchors = (file: string) => new Set(headings(file).map(slug));
const parts = (v: string) => v.split(".").map(Number);
const compare = (a: string, b: string) => parts(a).reduce((order, n, i) => order || n - parts(b)[i]!, 0);
const entries = () => [...read(changelogFile).matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map((match) => ({ version: match[1]!, text: match[2]! }));

test("every link to an anchor of a doc names a heading there", () => {
  const broken = linking.flatMap((file) => [...read(file).matchAll(/\]\((?!\w+:)([^)\s#]*)#([^)\s]+)\)/g)]
    .map((match) => ({ target: match[1] ? resolve(dirname(file), match[1]) : file, anchor: match[2]!, from: relative(root, file) }))
    .filter(({ target, anchor }) => target.endsWith(".md") && (!existsSync(target) || !anchors(target).has(anchor)))
    .map(({ target, anchor, from }) => `${from} -> ${relative(root, target)}#${anchor}`));
  assert.deepEqual(broken, []);
});

test("no heading in docs/ carries the version that added it, so its anchor outlives the version", () => {
  const versioned = docs.flatMap((file) => headings(file).filter((h) => /\(\d+\.\d+\.\d+\)\s*$/.test(h)).map((h) => `${relative(root, file)}: ${h}`));
  assert.deepEqual(versioned, []);
});

test("the changelog has one entry per version, newest first, and the newest is src/version.ts", () => {
  const versions = entries().map((entry) => entry.version);
  assert.equal(versions[0], version);
  for (const v of versions) assert.match(v, /^\d+\.\d+\.\d+$/);
  const unordered = versions.filter((v, i) => i > 0 && compare(versions[i - 1]!, v) <= 0);
  assert.deepEqual(unordered, []);
});

test("only the changelog says what an older control plane does, and only above the CLI's floor", () => {
  const elsewhere = docs.filter((file) => file !== changelogFile && /A control plane older than \d/.test(read(file))).map((file) => relative(root, file));
  assert.deepEqual(elsewhere, []);
  const belowFloor = [...read(changelogFile).matchAll(/A control plane older than (\d+\.\d+\.\d+)/g)]
    .map((match) => match[1]!)
    .filter((v) => compare(v, minControlVersion) <= 0);
  assert.deepEqual(belowFloor, []);
});

test("the docs' type blocks and holds table are the source they name, which node scripts/docs-gen.ts writes", () => {
  for (const doc of generatedDocs) assert.equal(read(doc), generated(read(doc)), relative(root, doc));
});

test("every TypeScript block in docs/cli.md names the declarations it shows, so none is a hand copy", () => {
  assert.equal([...read(cliDoc).matchAll(marker)].length, [...read(cliDoc).matchAll(/^```ts$/gm)].length);
});

test("docs-gen copies a declaration whole, with its TSDoc and its last line's comment", () => {
  const source = [
    "/** Not this. */",
    "export const x = 1;",
    "/** A quote. */",
    'export type Quoted = "say\\";more" | `a;${"b"}`; // trailing',
    "export interface Generic<T = () => void> extends Base<{ a: 1 }> {",
    "  /** } and ; in a comment. */",
    "  value: T; // ;",
    "}",
    "export type After = 1; // last",
  ].join("\n");
  assert.equal(declaration(source, "Quoted"), '/** A quote. */\ntype Quoted = "say\\";more" | `a;${"b"}`; // trailing');
  assert.equal(declaration(source, "Generic"), source.split("\n").slice(4, 8).join("\n").replace("export ", ""));
  assert.equal(declaration(source, "After"), "type After = 1; // last");
  assert.equal(declaration("/** A file's header. */\n\nexport type First = 1;", "First"), "type First = 1;");
  assert.equal(declaration("/** The first type. */\nexport type First = 1;", "First"), "/** The first type. */\ntype First = 1;");
});

