import { test } from "node:test";
import assert from "node:assert/strict";
import { diffOf, maxDiffRows } from "./diff.js";

const edit = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ export function top() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
`;
/** The lines a diff of kind "lines" shows, as the reader sees them: each with its sign. */
const linesOf = (shown) => shown.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.hunkContent.flatMap((part) => part.type === "context"
  ? file.additionLines.slice(part.additionLineIndex, part.additionLineIndex + part.lines).map((line) => ` ${line}`)
  : [...file.deletionLines.slice(part.deletionLineIndex, part.deletionLineIndex + part.deletions).map((line) => `-${line}`),
    ...file.additionLines.slice(part.additionLineIndex, part.additionLineIndex + part.additions).map((line) => `+${line}`)])))
  .map((line) => line.replace(/\n$/, ""));

test("an edit shows its lines under the file's name", () => {
  const shown = diffOf(edit);
  assert.equal(shown.kind, "lines");
  assert.equal(shown.files[0].name, "src/a.ts");
  assert.deepEqual(shown.meta, []);
  assert.deepEqual(linesOf(shown), [" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export { a };"]);
});

test("a deleted file shows its removed lines and says it was deleted", () => {
  const shown = diffOf(`diff --git a/old.py b/old.py
deleted file mode 100644
index 3333333..0000000
--- a/old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-print("one")
-print("two")
`);
  assert.equal(shown.kind, "lines");
  assert.equal(shown.files[0].type, "deleted");
  assert.deepEqual(shown.meta, ["deleted file mode 100644"]);
  assert.deepEqual(linesOf(shown), ['-print("one")', '-print("two")']);
});

test("a pure rename has no lines, only what it says of the file", () => {
  assert.deepEqual(diffOf(`diff --git a/a.md b/b.md
similarity index 100%
rename from a.md
rename to b.md
`), { kind: "meta", meta: ["similarity index 100%", "rename from a.md", "rename to b.md"] });
});

test("a rename with edits shows its lines, its old name and the rename", () => {
  const shown = diffOf(`diff --git a/lib/x.js b/lib/y.js
similarity index 80%
rename from lib/x.js
rename to lib/y.js
index 4444444..5555555 100644
--- a/lib/x.js
+++ b/lib/y.js
@@ -1,2 +1,2 @@
 export const x = 1;
-export const y = 2;
+export const y = 3;
`);
  assert.equal(shown.kind, "lines");
  assert.equal(shown.files[0].name, "lib/y.js");
  assert.equal(shown.files[0].prevName, "lib/x.js");
  assert.deepEqual(shown.meta, ["similarity index 80%", "rename from lib/x.js", "rename to lib/y.js"]);
  assert.deepEqual(linesOf(shown), [" export const x = 1;", "-export const y = 2;", "+export const y = 3;"]);
});

test("a mode change has no lines, only the old and new mode", () => {
  assert.deepEqual(diffOf(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`), { kind: "meta", meta: ["old mode 100644", "new mode 100755"] });
});

test("a binary file says it is binary", () => {
  assert.deepEqual(diffOf(`diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..6666666
Binary files /dev/null and b/logo.png differ
`), { kind: "binary", meta: ["new file mode 100644"] });
});

test("an empty diff has nothing to show", () => {
  assert.deepEqual(diffOf(""), { kind: "none" });
});

test("a diff cut short still shows the lines it has", (t) => {
  t.mock.method(console, "error", () => {});
  const shown = diffOf(edit.split("\n").slice(0, 7).join("\n") + "\n");
  assert.equal(shown.kind, "lines");
  assert.deepEqual(linesOf(shown), [" const a = 1;", "-const b = 2;"]);
});

test("a file that became a symlink shows its removal and its addition", () => {
  const shown = diffOf(`diff --git a/link b/link
deleted file mode 100644
index 94954ab..0000000
--- a/link
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
diff --git a/link b/link
new file mode 120000
index 0000000..4cbb553
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+target.txt
\\ No newline at end of file
`);
  assert.equal(shown.kind, "lines");
  assert.deepEqual(shown.files.map((file) => file.type), ["deleted", "new"]);
  assert.deepEqual(linesOf(shown), ["-hello", "-world", "+target.txt"]);
  assert.deepEqual(shown.meta, ["deleted file mode 100644", "new file mode 120000"]);
});

test("a diff longer than the row cap is cut to it before it is parsed, and says so", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const lines = Array.from({ length: 500_000 }, (_, i) => `+row ${i}`);
  const shown = diffOf(`diff --git a/rows.csv b/rows.csv
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/rows.csv
@@ -0,0 +1,500000 @@
${lines.join("\n")}
`);
  assert.equal(shown.kind, "lines");
  assert.equal(shown.cut, true);
  assert.equal(linesOf(shown).length, maxDiffRows);
  assert.equal(linesOf(shown).at(-1), `+row ${maxDiffRows - 1}`);
  assert.equal(errors.mock.callCount(), 0, "the cut hunk's header matches its lines");
});

test("a diff within the row cap is not cut", () => {
  assert.equal(diffOf(edit).cut, false);
});

test("a cut that keeps none of a hunk's added lines claims no unchanged lines before the hunk", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const old = Array.from({ length: maxDiffRows + 10 }, (_, i) => `-old ${i}`);
  const now = Array.from({ length: maxDiffRows + 10 }, (_, i) => `+new ${i}`);
  const shown = diffOf(`diff --git a/gen.ts b/gen.ts
index 1111111..2222222 100644
--- a/gen.ts
+++ b/gen.ts
@@ -1,${old.length} +1,${now.length} @@
${old.join("\n")}
${now.join("\n")}
`);
  assert.equal(shown.cut, true);
  assert.equal(shown.files[0].hunks[0].collapsedBefore, 0);
  assert.equal(errors.mock.callCount(), 0);
});
