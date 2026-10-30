// The review a reader writes on a thread's diffs: notes on rows of a file's diff, kept in the browser until they go
// to the composer as one message and are sent, or are discarded. client.js draws it. Its format follows the
// review-pane mod's prepared review in claude-mods, so a review reads the same whichever client wrote it.

/** The kinds of note, in the order the page offers them, each with the key that starts one. */
export const kinds = {
  comment: { label: "Comment", key: "c" },
  question: { label: "Question", key: "q" },
  suggestion: { label: "Suggestion", key: "s" },
  change: { label: "Requested change", key: "r" },
};

/** A quote this long is cut, so a note on a whole new file does not make the message huge. */
export const maxQuoteRows = 40;

const trimEnd = (line) => line.replace(/\r?\n$/, "");

/**
 * The rows a file's diff draws, in the order the unified layout draws them. `index` is the row's place in that
 * layout, the first part of the `data-line-index` @pierre/diffs gives each row in either layout, counting the
 * unchanged lines folded between hunks. `old` and `new` are the row's line numbers in the old and new file.
 */
export function rowsOf(file) {
  const rows = [];
  for (const hunk of file.hunks) {
    let index = hunk.unifiedLineStart;
    let old = hunk.deletionStart;
    let now = hunk.additionStart;
    for (const part of hunk.hunkContent) {
      if (part.type === "context") {
        for (let i = 0; i < part.lines; i++) rows.push({ index: index++, type: "context", old: old++, new: now++, text: trimEnd(file.additionLines[part.additionLineIndex + i]) });
        continue;
      }
      for (let i = 0; i < part.deletions; i++) rows.push({ index: index++, type: "deletion", old: old++, new: null, text: trimEnd(file.deletionLines[part.deletionLineIndex + i]) });
      for (let i = 0; i < part.additions; i++) rows.push({ index: index++, type: "addition", old: null, new: now++, text: trimEnd(file.additionLines[part.additionLineIndex + i]) });
    }
  }
  return rows;
}

/**
 * Where a row is in its file, as a note keeps it: a removed row by its old line number, any other by its new one.
 * The new file is the working tree on every base, so a note on it finds its rows again after the base changes.
 */
const anchorOf = (row) => row.type === "deletion" ? { side: "deletions", line: row.old } : { side: "additions", line: row.new };
const sameAnchor = (a, b) => a.side === b.side && a.line === b.line;
const sign = { context: " ", deletion: "-", addition: "+" };
const quoteOf = (rows) => rows.map((row) => `${sign[row.type]}${row.text}`);

/** The lines a range of rows covers: its new line numbers, or its old ones when it holds only removed rows. */
function linesOf(rows) {
  const added = rows.filter((row) => row.type !== "deletion");
  return added.length > 0 ? { from: added[0].new, to: added.at(-1).new, removed: false } : { from: rows[0].old, to: rows.at(-1).old, removed: true };
}

export const linesLabel = ({ from, to, removed }) => `${removed ? "removed " : ""}${from === to ? `line ${from}` : `lines ${from}-${to}`}`;

/**
 * A note of `kind` on rows `first` to `last` of a file's diff, with the rows quoted as they stand now. `entry` is the
 * file's place among the diff's entries, as a file whose type changed has two.
 */
export function noteOn({ id, kind, path, entry, rows, first, last, body = "" }) {
  const range = rows.slice(first, last + 1);
  return { id, kind, path, entry, start: anchorOf(range[0]), end: anchorOf(range.at(-1)), lines: linesOf(range), quote: quoteOf(range), body };
}

/** Where a note's rows are in a file's rows now, or null when they are gone or no longer read as quoted. */
export function rangeOf(note, rows) {
  const first = rows.findIndex((row) => sameAnchor(anchorOf(row), note.start));
  const last = rows.findIndex((row) => sameAnchor(anchorOf(row), note.end));
  if (first === -1 || last < first) return null;
  const now = quoteOf(rows.slice(first, last + 1));
  return now.length === note.quote.length && now.every((line, i) => line === note.quote[i]) ? { first, last } : null;
}

/**
 * The notes on one entry of a file's diff, each with the rows it covers, and those whose rows the diff no longer
 * shows, which still go in the review with their quote.
 */
export function place(notes, rows, path, entry) {
  const placed = [];
  const outdated = [];
  for (const note of notes) {
    if (note.path !== path || note.entry !== entry) continue;
    const range = rangeOf(note, rows);
    if (range === null) outdated.push(note);
    else placed.push({ note, ...range });
  }
  return { placed, outdated };
}

// After t3code's formatReviewCommentFence. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
function fence(lines) {
  const longest = Math.max(0, ...lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return [`${ticks}diff`, ...lines, ticks];
}

// A Claude worker refuses a message with a tab, which its prompt would swallow.
const untab = (text) => text.replaceAll("\t", "    ");

/** The line that opens a note's entry in the review, after its number. */
const noteHeader = (note) => `**[${kinds[note.kind].label.toUpperCase()}]** \`${note.path}\` ${linesLabel(note.lines)}`;

/**
 * The review after a message is sent: `sent` is what the composer held when the send began, the review composed into
 * it and its notes as they were then. A note is done if the message holds its entry's header line and the note has
 * not changed since. Notes whose headers are the same are done only if the message holds that line once for each, so
 * cutting one of them from the message keeps them all, as the page cannot tell which was cut.
 */
export function afterSend(review, sent, text) {
  if (sent.composed === null) return review;
  const headers = text.split("\n").map((line) => /^\d+\. (.*)$/.exec(line)?.[1]).filter((header) => header !== undefined);
  const groups = Map.groupBy(sent.notes, noteHeader);
  const done = new Map([...groups].filter(([header, group]) => headers.filter((h) => h === header).length >= group.length)
    .flatMap(([, group]) => group.map((note) => [note.id, JSON.stringify(note)])));
  return {
    ...review,
    notes: review.notes.filter((note) => done.get(note.id) !== JSON.stringify(note)),
    composed: review.composed === sent.composed ? null : review.composed,
  };
}

/** The review as a message for the reader to edit and send: one numbered entry per note, in file and line order. */
export function formatReview(notes) {
  const ordered = [...notes].sort((a, b) => a.path.localeCompare(b.path) || a.entry - b.entry || a.lines.from - b.lines.from);
  const asks = notes.some((note) => note.kind === "question");
  const output = [`I reviewed the diff in the Nexus dashboard. Please address these notes${asks ? ", and answer the questions" : ""}.`, ""];
  ordered.forEach((note, i) => {
    const marker = `${i + 1}. `;
    const indent = (line) => line === "" ? "" : `${" ".repeat(marker.length)}${line}`;
    const quote = note.quote.slice(0, maxQuoteRows).map(untab);
    const left = note.quote.length - quote.length;
    output.push(`${marker}${noteHeader(note)}`, "");
    output.push(...fence(quote).map(indent));
    if (left > 0) output.push(indent(`(${left} more ${left === 1 ? "line" : "lines"} not quoted)`));
    output.push("", ...untab(note.body).split("\n").map(indent));
    if (i < ordered.length - 1) output.push("");
  });
  return output.join("\n");
}

export const emptyReview = () => ({ notes: [], draft: null, composed: null });

const isAnchor = (a) => typeof a === "object" && a !== null && ["additions", "deletions"].includes(a.side) && Number.isInteger(a.line);
const isNote = (n) => typeof n === "object" && n !== null && typeof n.id === "string" && Object.hasOwn(kinds, n.kind)
  && typeof n.path === "string" && Number.isInteger(n.entry) && isAnchor(n.start) && isAnchor(n.end)
  && typeof n.lines === "object" && n.lines !== null && Number.isInteger(n.lines.from) && Number.isInteger(n.lines.to) && typeof n.lines.removed === "boolean"
  && Array.isArray(n.quote) && n.quote.every((line) => typeof line === "string") && typeof n.body === "string";

/**
 * A thread's review as localStorage kept it. `draft` is the note being written, so a half-written one survives a
 * reload and a redraw of the diff. `composed` is what was last put in the composer, its text and the notes it holds,
 * or null if the review is not there. Anything else, such as a value an older page wrote, reads as no review rather than breaking the page.
 */
export function readReview(text) {
  let saved;
  try {
    saved = JSON.parse(text ?? "null");
  } catch {
    return emptyReview();
  }
  if (typeof saved !== "object" || saved === null || !Array.isArray(saved.notes)) return emptyReview();
  const composed = saved.composed;
  return {
    notes: saved.notes.filter((note) => isNote(note) && note.body.trim() !== ""),
    draft: isNote(saved.draft) ? saved.draft : null,
    composed: typeof composed?.text === "string" && Array.isArray(composed.ids) && composed.ids.every((id) => typeof id === "string") ? composed : null,
  };
}
