import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { diffOf, imageSides, maxDiffRows } from "./diff.js";
import { imageTypes } from "../../image-types.ts";

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

const endings = (from, to) => `diff --git a/notes.txt b/notes.txt
index 1111111..2222222 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1,2 +1,2 @@
-one${from}
-two${from}
+one${to}
+two${to}
`;

test("a change from LF to CRLF line endings says so beside its lines", () => {
  const shown = diffOf(endings("", "\r"));
  assert.equal(shown.kind, "lines");
  assert.deepEqual(shown.meta, ["line endings changed from LF to CRLF"]);
});

test("a change from CRLF to LF line endings says so beside its lines", () => {
  assert.deepEqual(diffOf(endings("\r", "")).meta, ["line endings changed from CRLF to LF"]);
});

test("an edit to a file with CRLF line endings says nothing of them", () => {
  assert.deepEqual(diffOf(endings("\r", " again\r")).meta, []);
});

test("a CRLF file that loses its last newline says nothing of line endings", () => {
  assert.deepEqual(diffOf(`diff --git a/notes.txt b/notes.txt
index 1111111..2222222 100644
--- a/notes.txt
+++ b/notes.txt
@@ -1 +1 @@
-one\r
+one
\\ No newline at end of file
`).meta, []);
});

test("a changed image shows its before at the base and its after in the working tree, each where it has one", () => {
  const file = (status, path, oldPath = null) => ({ path, oldPath, status, additions: null, deletions: null });
  assert.deepEqual(imageSides(file("modified", "shots/home.png"), "head"), [
    { label: "Before", query: { source: "file", path: "shots/home.png", base: "head" } },
    { label: "After", query: { source: "file", path: "shots/home.png" } },
  ]);
  assert.deepEqual(imageSides(file("renamed", "new.JPG", "old.jpg"), "start")?.[0], { label: "Before", query: { source: "file", path: "old.jpg", base: "start" } });
  assert.deepEqual(imageSides(file("added", "a.webp"), "turn"), [{ label: "Before", none: "none, the file is new" }, { label: "After", query: { source: "file", path: "a.webp" } }]);
  assert.deepEqual(imageSides(file("deleted", "b.gif"), "start")?.[1], { label: "After", none: "none, the file was deleted" });
  assert.equal(imageSides(file("modified", "font.woff2"), "start"), null);
  for (const extension of Object.keys(imageTypes)) assert.notEqual(imageSides(file("modified", `a${extension}`), "start"), null, extension);
  assert.notEqual(imageSides(file("modified", "shots/.png"), "start"), null, "a name that is only the extension");
  assert.equal(imageSides(undefined, "start"), null);
});

const client = await readFile(new URL("./client.js", import.meta.url), "utf8");
const slice = (from, to) => client.slice(client.indexOf(from), client.indexOf(to));
/**
 * The changes pane's and the diff's texts from client.js: `bases`, and `unreadable` for a pylon in `facts`, run with
 * `el` making plain objects and `wanted` saying whether the reader asked to wake the pylon.
 */
function checkoutTexts(wanted = false) {
  const el = (tag, props, ...children) => ({ tag, ...props, children, addEventListener(kind, listener) { this[kind] = listener; } });
  const code = `${slice("const bases = {", "\nconst checkout = {")}\n${slice("function unreadable(", "\nfunction changesUnreadable(")}\n({ bases, unreadable })`;
  return runInNewContext(code, { el, checkout: { wanted } });
}
const said = (nodes) => Array.from(nodes, (n) => n.tag === "button" ? `[${n.textContent}]` : n.textContent);

test("each base names itself, its empty tree, an empty list and a diff's comparison", () => {
  const { bases } = checkoutTexts();
  assert.deepEqual(JSON.parse(JSON.stringify(bases)), {
    start: { label: "Since the pylon booted", emptyTree: "an empty repository", unchanged: "Nothing has changed since the pylon booted.", vs: "vs boot" },
    head: { label: "Since the last commit", emptyTree: "no commit yet", unchanged: "No uncommitted changes.", vs: "vs last commit" },
    turn: { label: "Since the latest turn began", emptyTree: "an empty repository", unchanged: "Nothing has changed since the latest turn began.", vs: "vs turn start" },
  });
});

test("the changes pane and the diff say the same of a checkout they cannot read, a deleted thread's included", () => {
  const paused = { status: "idle", pylon: "paused" };
  for (const [noun, texts] of [
    ["its changes", ["Reading its changes wakes it.", "Waking the pylon to read its changes.", "its changes can't be read"]],
    ["the diff", ["Reading the diff wakes it.", "Waking the pylon to read the diff.", "the diff can't be read"]],
  ]) {
    let woke = 0;
    const wake = checkoutTexts().unreadable(paused, noun, () => { woke += 1; });
    assert.deepEqual(said(wake), [`The pylon is paused. ${texts[0]}`, "[Wake and read]"], noun);
    wake[1].click();
    assert.equal(woke, 1, "the button wakes the pylon");
    assert.deepEqual(said(checkoutTexts(true).unreadable(paused, noun, () => {})), [texts[1]], `${noun}, once the reader asked to wake it`);
    assert.deepEqual(said(checkoutTexts().unreadable({ status: "archived", pylon: "paused" }, noun, () => {})),
      [`An archived thread's pylon stays paused, so ${texts[2]} until the thread is unarchived.`]);
    assert.deepEqual(said(checkoutTexts().unreadable({ status: "deleted", pylon: "paused" }, noun, () => {})), ["The thread is deleted, so its checkout is gone."], `${noun} of a deleted thread`);
    assert.equal(woke, 1);
  }
});
