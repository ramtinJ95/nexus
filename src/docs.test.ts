import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const docs = readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".md"))
  .map((path) => join(root, "docs", path));
const roadmapFile = join(root, "docs/roadmap.md");
const read = (file: string) => readFileSync(file, "utf8");
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const anchors = (file: string) => new Set([...read(file).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1]!)));

test("every link from docs/ to an anchor of the roadmap names a heading there", () => {
  const broken = docs.flatMap((file) => [...read(file).matchAll(/\]\(([^)\s#]*\.md)#([^)\s]+)\)/g)]
    .map((match) => ({ target: resolve(dirname(file), match[1]!), anchor: match[2]!, from: relative(root, file) }))
    .filter(({ target, anchor }) => target === roadmapFile && !anchors(target).has(anchor))
    .map(({ target, anchor, from }) => `${from} -> ${relative(root, target)}#${anchor}`));
  assert.deepEqual(broken, []);
});
