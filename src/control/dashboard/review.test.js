import { test } from "node:test";
import assert from "node:assert/strict";
import { DiffHunksRenderer } from "@pierre/diffs";
import { diffOf } from "./diff.js";
import { afterSend, emptyReview, formatReview, maxQuoteRows, noteOn, place, readReview, rowsOf } from "./review.js";

const patch = `diff --git a/src/a.go b/src/a.go
--- a/src/a.go
+++ b/src/a.go
@@ -1,4 +1,4 @@
 package a
-func One() int { return 1 }
+func One() int { return 10 }
${" "}
 // Two is two.
@@ -10,3 +10,5 @@ func Nine() {
 func Ten() {
+\treturn
+}
 // end
`;
const [file] = diffOf(patch).files;
const rows = rowsOf(file);
const at = (line) => rows.findIndex((row) => row.new === line && row.type !== "deletion");
const note = (kind, first, last, body, id = kind) => noteOn({ id, kind, path: "src/a.go", entry: 0, rows, first, last, body });

/** Each row @pierre/diffs draws in a layout, as `index:line-type:line`, from the markup it renders. */
async function drawnRows(layout) {
  const renderer = new DiffHunksRenderer({ diffStyle: layout, disableFileHeader: true });
  const ast = renderer.renderFullAST(await renderer.asyncRender(file));
  const found = [];
  (function walk(node) {
    const props = node.properties ?? {};
    if (props["data-line"] !== undefined) found.push(`${String(props["data-line-index"]).split(",")[0]}:${props["data-line-type"]}:${props["data-line"]}`);
    for (const child of node.children ?? []) walk(child);
  })(ast);
  return found.sort();
}

test("a file's rows have the index, kind and line numbers the drawn diff gives them in either layout", async () => {
  assert.deepEqual(rows.map(({ index, type, old, new: now, text }) => [index, type, old, now, text]), [
    [0, "context", 1, 1, "package a"],
    [1, "deletion", 2, null, "func One() int { return 1 }"],
    [2, "addition", null, 2, "func One() int { return 10 }"],
    [3, "context", 3, 3, ""],
    [4, "context", 4, 4, "// Two is two."],
    [10, "context", 10, 10, "func Ten() {"],
    [11, "addition", null, 11, "\treturn"],
    [12, "addition", null, 12, "}"],
    [13, "context", 11, 13, "// end"],
  ]);
  const type = { context: "context", deletion: "change-deletion", addition: "change-addition" };
  const unified = rows.map((row) => `${row.index}:${type[row.type]}:${row.type === "deletion" ? row.old : row.new}`).sort();
  assert.deepEqual(await drawnRows("unified"), unified);
  // Split draws a context row on each side, numbered by that side's file.
  const split = rows.flatMap((row) => row.type === "context" ? [`${row.index}:context:${row.old}`, `${row.index}:context:${row.new}`]
    : [`${row.index}:${type[row.type]}:${row.type === "deletion" ? row.old : row.new}`]).sort();
  assert.deepEqual(await drawnRows("split"), split);
});

test("a note keeps its rows as anchors, its lines and a quote of the rows with their signs", () => {
  const n = note("change", 1, 3, "Keep it 1.");
  assert.deepEqual(n.start, { side: "deletions", line: 2 });
  assert.deepEqual(n.end, { side: "additions", line: 3 });
  assert.deepEqual(n.lines, { from: 2, to: 3, removed: false });
  assert.deepEqual(n.quote, ["-func One() int { return 1 }", "+func One() int { return 10 }", " "]);
  assert.deepEqual(note("comment", 1, 1, "x").lines, { from: 2, to: 2, removed: true });
});

test("a note is placed on its rows while they read as quoted, and is outdated once they change", () => {
  const kept = note("comment", at(11), at(12), "Why return here?");
  const elsewhere = { ...kept, id: "other", path: "src/b.go" };
  assert.deepEqual(place([kept, elsewhere], rows, "src/a.go", 0), { placed: [{ note: kept, first: 6, last: 7 }], outdated: [] });
  assert.deepEqual(place([kept], rows, "src/a.go", 1), { placed: [], outdated: [] });

  const [edited] = diffOf(patch.replace("+}\n", "+} // done\n")).files;
  assert.deepEqual(place([kept], rowsOf(edited), "src/a.go", 0), { placed: [], outdated: [kept] });
});

test("a note is outdated once its rows move to other lines, though they read the same", () => {
  const kept = note("comment", at(11), at(12), "Why return here?");
  const [moved] = diffOf(patch.replace("@@ -10,3 +10,5 @@", "@@ -10,3 +11,5 @@")).files;
  assert.deepEqual(place([kept], rowsOf(moved), "src/a.go", 0).outdated, [kept]);
});

test("the review lists the notes in file and line order, quoted, with tabs as spaces", () => {
  const notes = [
    note("question", at(11), at(12), "Why return\there?", "q"),
    { ...note("comment", 0, 0, "Fine.", "c"), path: "README.md" },
    note("suggestion", 1, 1, "Name it Uno.", "s"),
  ];
  assert.equal(formatReview(notes), `I reviewed the diff in the Nexus dashboard. Please address these notes, and answer the questions.

1. **[COMMENT]** \`README.md\` line 1

   \`\`\`diff
    package a
   \`\`\`

   Fine.

2. **[SUGGESTION]** \`src/a.go\` removed line 2

   \`\`\`diff
   -func One() int { return 1 }
   \`\`\`

   Name it Uno.

3. **[QUESTION]** \`src/a.go\` lines 11-12

   \`\`\`diff
   +    return
   +}
   \`\`\`

   Why return    here?`);
  assert.doesNotMatch(formatReview(notes), /\t/);
});

test("a review without questions asks only for the notes, and a requested change is tagged as one", () => {
  const text = formatReview([note("change", 2, 2, "Return 1.\n\nIt broke the tests.")]);
  assert.match(text, /^I reviewed the diff in the Nexus dashboard\. Please address these notes\.\n/);
  assert.match(text, /1\. \*\*\[REQUESTED CHANGE\]\*\* `src\/a\.go` line 2\n/);
  assert.match(text, /\n   Return 1\.\n\n   It broke the tests\.$/);
});

test("a quote's fence is longer than any run of backticks in it, and a long quote is cut", () => {
  const [fenced] = diffOf("diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -0,0 +1,3 @@\n+```js\n+x\n+```\n").files;
  const fencedRows = rowsOf(fenced);
  assert.match(formatReview([noteOn({ id: "f", kind: "comment", path: "x.md", entry: 0, rows: fencedRows, first: 0, last: 2, body: "b" })]),
    /\n   ````diff\n   \+```js\n   \+x\n   \+```\n   ````\n/);

  const long = Array.from({ length: maxQuoteRows + 5 }, (_, i) => `+row ${i}`).join("\n");
  const [big] = diffOf(`diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,${maxQuoteRows + 5} @@\n${long}\n`).files;
  const bigRows = rowsOf(big);
  const text = formatReview([noteOn({ id: "b", kind: "comment", path: "big.txt", entry: 0, rows: bigRows, first: 0, last: bigRows.length - 1, body: "Too long." })]);
  assert.match(text, new RegExp(`\\+row ${maxQuoteRows - 1}\\n   \`\`\`\\n   \\(5 more lines not quoted\\)\\n`));
  assert.doesNotMatch(text, new RegExp(`row ${maxQuoteRows}\\b`));
});

/** The review with `notes` composed into the message box, and what the composer held as a send of it began. */
function composedReview(notes) {
  const composed = { text: formatReview(notes), ids: notes.map((n) => n.id) };
  return { review: { notes, draft: null, composed }, sent: { composed, notes } };
}
/** The composed text without the numbered entry that starts with `header`, as a reader cuts it before sending. */
const cut = (text, header) => text.split(/\n(?=\d+\. )/).filter((entry) => !entry.includes(`${header}\n`)).join("\n");

test("a send drops the notes whose entries it holds, and keeps one cut from it and any note not composed", () => {
  const [one, twelve, later] = [note("comment", at(1), at(1), "One.", "one"), note("comment", at(12), at(12), "Twelve.", "twelve"), note("question", 1, 1, "Later?", "later")];
  const { review, sent } = composedReview([one, twelve]);
  const text = cut(review.composed.text, "line 1");
  assert.doesNotMatch(text, /One\./, "the line 1 entry is cut, though its header is the start of line 12's");
  const after = afterSend({ ...review, notes: [...review.notes, later] }, sent, text);
  assert.deepEqual(after.notes.map((n) => n.id), ["one", "later"]);
  assert.equal(after.composed, null);
});

test("notes with the same header are dropped only if the message holds an entry for each", () => {
  const notes = [note("comment", at(11), at(12), "First.", "first"), note("comment", at(11), at(12), "Second.", "second")];
  const { review, sent } = composedReview(notes);
  assert.deepEqual(afterSend(review, sent, review.composed.text).notes, []);
  const one = review.composed.text.split(/\n(?=2\. )/)[0];
  assert.deepEqual(afterSend(review, sent, one).notes.map((n) => n.id), ["first", "second"]);
});

test("a note edited while its send was out stays, with its edit, and a review composed meanwhile stays composed", () => {
  const notes = [note("comment", 0, 0, "Old.", "c"), note("question", 1, 1, "Why?", "q")];
  const { review, sent } = composedReview(notes);
  const edited = { ...notes[0], body: "New." };
  const recomposed = { text: "again", ids: ["c", "q"] };
  const after = afterSend({ ...review, notes: [edited, notes[1]], composed: recomposed }, sent, review.composed.text);
  assert.deepEqual(after.notes, [edited]);
  assert.equal(after.composed, recomposed);
});

test("a send with no review composed leaves the notes", () => {
  const notes = [note("comment", 0, 0, "Fine.", "c")];
  const review = { notes, draft: null, composed: null };
  assert.equal(afterSend(review, { composed: null, notes: [] }, formatReview(notes)), review);
});

test("a stored review reads back, and anything else reads as no review", () => {
  const saved = { notes: [note("comment", 0, 0, "One."), note("question", 0, 0, " ")], draft: note("change", 2, 2, ""), composed: { text: "t", ids: ["comment"] } };
  assert.deepEqual(readReview(JSON.stringify(saved)), { notes: [saved.notes[0]], draft: saved.draft, composed: saved.composed });
  for (const text of [null, "", "{", "[]", "42", JSON.stringify({ notes: "x" })]) assert.deepEqual(readReview(text), emptyReview());
  assert.deepEqual(readReview(JSON.stringify({ notes: [{ ...saved.notes[0], kind: "issue" }, { ...saved.notes[0], start: { side: "left", line: 1 } }], draft: { body: "x" }, composed: "t" })), emptyReview());
});
