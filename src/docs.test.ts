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
const sections = (file: string) => read(file).split(/^## /m).slice(1)
  .map((section) => ({ title: section.slice(0, section.indexOf("\n")), body: section.slice(section.indexOf("\n")).trim() }));

test("every link from docs/ to an anchor of the roadmap names a heading there", () => {
  const broken = docs.flatMap((file) => [...read(file).matchAll(/\]\(([^)\s#]*\.md)#([^)\s]+)\)/g)]
    .map((match) => ({ target: resolve(dirname(file), match[1]!), anchor: match[2]!, from: relative(root, file) }))
    .filter(({ target, anchor }) => target === roadmapFile && !anchors(target).has(anchor))
    .map(({ target, anchor, from }) => `${from} -> ${relative(root, target)}#${anchor}`));
  assert.deepEqual(broken, []);
});

test("the roadmap's current wave is the maintenance wave, with the install wave done", () => {
  const roadmap = sections(roadmapFile);
  assert.deepEqual(roadmap.filter(({ body }) => body.startsWith("The current wave.")).map(({ title }) => title), ["The maintenance wave"]);
  assert.ok(!roadmap.some(({ title }) => title === "The install wave"), "the install wave has left the roadmap");
  assert.match(read(join(root, "docs/design.md")), /^\| 2026-10-31 \| The install wave is done\. .*Bobble.*nexus-demo/m);
});
