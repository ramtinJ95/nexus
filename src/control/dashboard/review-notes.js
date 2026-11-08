import { afterSend, emptyReview, formatReview, kinds, linesLabel, noteOn, place, rangeOf, readReview, rowsOf } from "./review.js";
import { el, present, showError } from "./page.js";
import { kept, storageKeys } from "./contract.ts";
import { thread } from "./checkout.js";
import { activeTab, fileView, showTab } from "./tab-bar.js";

// The review: notes on rows of the open diff, kept per thread until they go to the composer and are sent, or are
// discarded.
// After t3code's AnnotatableCodeView and DiffCommentAnnotation. Copyright (c) 2026 T3 Tools Inc., MIT licence; see THIRD_PARTY_NOTICES.md.
const reviewKey = storageKeys.review(thread);
export let review = readReview(kept.read(reviewKey));
const saveReview = () => kept.write(reviewKey, JSON.stringify(review));
const newNoteId = () => `note:${Date.now().toString(36)}${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
/** The diff on show, `{ view, path, rows }` with each entry's rows, or null when no diff's lines are drawn. */
let annotated = null;
/** The rows the reader selected, `{ entry, anchor, head }` as places in that entry's rows. `head` moves with the keyboard. */
let selection = null;
let dragging = false;
export const reviewBox = el("div", { className: "fv-review" });
const picker = el("div", { className: "note-pick", hidden: true });
picker.setAttribute("role", "toolbar");
picker.setAttribute("aria-label", "Add a note");

const selectedRange = () => selection === null ? null
  : { entry: selection.entry, first: Math.min(selection.anchor, selection.head), last: Math.max(selection.anchor, selection.head) };
const unified = (entry, first, last) => ({ entry, from: annotated.rows[entry][first].index, to: annotated.rows[entry][last].index });

function showSelection() {
  if (annotated === null) return;
  const range = selectedRange();
  annotated.view.select(range && unified(range.entry, range.first, range.last));
  annotated.view.cursor(selection && { entry: selection.entry, index: annotated.rows[selection.entry][selection.head].index });
  placePicker(range);
}

/** Shows the kinds of note under the selection's last row, unless a note is being written. */
function placePicker(range) {
  const row = range && review.draft === null ? annotated.view.rowElement(range.entry, annotated.rows[range.entry][range.last].index) : null;
  picker.hidden = row === null;
  if (row === null) return;
  const rows = annotated.rows[range.entry].slice(range.first, range.last + 1);
  const lines = noteOn({ id: "", kind: "comment", path: "", entry: 0, rows, first: 0, last: rows.length - 1 }).lines;
  picker.replaceChildren(el("span", { className: "dim small", textContent: linesLabel(lines) }), ...Object.entries(kinds).map(([kind, { label, key }]) => {
    const button = el("button", { type: "button", className: "btn btn-xs", textContent: label, title: `${label} (${key.toUpperCase()})` });
    button.addEventListener("click", () => startDraft(kind));
    return button;
  }));
  if (picker.parentElement !== fileView) fileView.append(picker);
  const view = fileView.getBoundingClientRect();
  const at = row.getBoundingClientRect();
  picker.style.top = `${at.bottom - view.top + fileView.scrollTop + 4}px`;
  picker.style.left = `${Math.max(12, at.left - view.left + 12)}px`;
}

function startDraft(kind) {
  const range = selectedRange();
  if (range === null || annotated === null) return;
  review.draft = noteOn({ id: newNoteId(), kind, path: annotated.path, entry: range.entry, rows: annotated.rows[range.entry], first: range.first, last: range.last });
  saveReview();
  decorate();
  focusDraft();
}
const focusDraft = () => {
  const text = fileView.querySelector(".note-text");
  text?.focus({ preventScroll: true });
  text?.setSelectionRange(text.value.length, text.value.length);
  text?.scrollIntoView({ block: "nearest", inline: "nearest" });
};

function saveDraft() {
  const body = review.draft?.body.trim() ?? "";
  if (body === "") return;
  const note = { ...review.draft, body };
  const at = review.notes.findIndex((n) => n.id === note.id);
  review.notes = at === -1 ? [...review.notes, note] : review.notes.with(at, note);
  if (at !== -1 && review.composed !== null) review.composed = { ...review.composed, ids: review.composed.ids.filter((id) => id !== note.id) };
  review.draft = null;
  selection = null;
  saveReview();
  decorate();
  annotated?.view.node.focus({ preventScroll: true });
}

function cancelDraft() {
  review.draft = null;
  saveReview();
  decorate();
  annotated?.view.node.focus({ preventScroll: true });
}

/** Marks a note's rows while the reader points at or focuses its card, and the selection again after. */
function marksRows(card, entry, range) {
  if (range === null) return;
  const on = () => annotated?.view.select(unified(entry, range.first, range.last));
  const off = () => showSelection();
  card.addEventListener("mouseenter", on);
  card.addEventListener("mouseleave", off);
  card.addEventListener("focusin", on);
  card.addEventListener("focusout", off);
}

/** A saved note, with its quote when the diff no longer shows its rows. */
function noteCard(note, entry = null, range = null) {
  const edit = el("button", { type: "button", className: "btn btn-xs btn-ghost", textContent: "Edit" });
  edit.addEventListener("click", () => {
    if (review.draft !== null && review.draft.id !== note.id && review.draft.body.trim() !== "" && !confirm("Discard the note you are writing?")) return;
    review.draft = { ...note };
    saveReview();
    decorate();
    focusDraft();
  });
  const remove = el("button", { type: "button", className: "btn btn-xs btn-ghost danger", textContent: "Delete" });
  remove.addEventListener("click", () => {
    review.notes = review.notes.filter((n) => n.id !== note.id);
    saveReview();
    decorate();
  });
  const card = el("div", { className: `rnote rnote-${note.kind}` },
    el("div", { className: "note-head" }, el("span", { className: "note-kind", textContent: kinds[note.kind].label }),
      el("span", { className: "dim small", textContent: `${range === null ? `${note.path} ` : ""}${linesLabel(note.lines)}` }), edit, remove),
    range === null && el("pre", { className: "note-quote", textContent: note.quote.join("\n") }),
    el("p", { className: "note-body", textContent: note.body }));
  marksRows(card, entry, range);
  return card;
}

/** The note being written: its kind, which the reader can change, and its text. */
function draftCard(draft, entry = null, range = null) {
  const label = () => `${kinds[review.draft.kind].label} on ${linesLabel(draft.lines)}`;
  const title = el("span", { className: "note-kind", textContent: label() });
  const text = el("textarea", { className: "note-text", rows: 3, value: draft.body, placeholder: "Write the note. Ctrl+Enter saves it, Esc cancels." });
  text.setAttribute("aria-label", label());
  const save = el("button", { type: "button", className: "btn btn-xs btn-primary", textContent: "Save", disabled: draft.body.trim() === "" });
  const cancel = el("button", { type: "button", className: "btn btn-xs btn-ghost", textContent: "Cancel" });
  const picks = Object.entries(kinds).map(([kind, { label: name }]) => {
    const button = el("button", { type: "button", value: kind, textContent: name });
    button.setAttribute("aria-pressed", String(kind === draft.kind));
    button.addEventListener("click", () => {
      review.draft.kind = kind;
      saveReview();
      for (const b of picks) b.setAttribute("aria-pressed", String(b.value === kind));
      title.textContent = label();
      text.setAttribute("aria-label", label());
      text.focus();
    });
    return button;
  });
  const choice = el("span", { className: "fv-layout note-kinds" }, ...picks);
  choice.setAttribute("role", "group");
  choice.setAttribute("aria-label", "Kind of note");
  text.addEventListener("input", () => {
    review.draft.body = text.value;
    save.disabled = text.value.trim() === "";
    saveReview();
  });
  text.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDraft();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      saveDraft();
    }
  });
  save.addEventListener("click", saveDraft);
  cancel.addEventListener("click", cancelDraft);
  const card = el("div", { className: `rnote note-draft rnote-${draft.kind}` },
    el("div", { className: "note-head" }, title, choice),
    range === null && el("pre", { className: "note-quote", textContent: draft.quote.join("\n") }),
    text, el("div", { className: "note-actions" }, cancel, save));
  marksRows(card, entry, range);
  return card;
}

/**
 * Draws the review: each note under its last row in the open diff, the draft where it was started, and above the
 * diff the review's bar and the notes on this file whose rows the diff no longer shows.
 */
function decorate() {
  const typing = document.activeElement?.matches?.(".note-text") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const path = activeTab !== null && fileView?.dataset.path === activeTab ? activeTab : null;
  let draftPlaced = false;
  const editing = review.draft?.id;
  const notes = review.notes.filter((n) => n.id !== editing);
  const gone = [];
  if (annotated !== null && annotated.path === path && annotated.view.node.isConnected) {
    const groups = new Map();
    annotated.rows.forEach((rows, entry) => {
      const { placed, outdated } = place(notes, rows, path, entry);
      gone.push(...outdated);
      const cards = placed.map(({ note, first, last }) => [note, noteCard(note, entry, { first, last })]);
      const draft = review.draft?.path === path && review.draft.entry === entry ? review.draft : null;
      const at = draft && rangeOf(draft, rows);
      if (at !== null && at !== undefined) {
        cards.push([draft, draftCard(draft, entry, at)]);
        draftPlaced = true;
      }
      const names = annotated.view.slots(entry, cards.map(([note]) => note.end));
      cards.forEach(([, card], i) => groups.set(names[i], [...(groups.get(names[i]) ?? []), card]));
    });
    annotated.view.node.replaceChildren(...[...groups].map(([name, cards]) => Object.assign(el("div", { className: "notes" }, ...cards), { slot: name })));
  } else if (path !== null) {
    gone.push(...notes.filter((n) => n.path === path));
  }
  const count = review.notes.length;
  const add = el("button", { type: "button", className: "btn btn-xs btn-primary", textContent: "Add to message" });
  add.addEventListener("click", composeReview);
  const discard = el("button", { type: "button", className: "btn btn-xs btn-ghost danger", textContent: "Discard" });
  discard.addEventListener("click", () => {
    if (!confirm(`Discard the review's ${count === 1 ? "note" : `${count} notes`}?`)) return;
    review = emptyReview();
    saveReview();
    selection = null;
    decorate();
  });
  reviewBox.replaceChildren(...present([
    count > 0 && el("div", { className: "review-bar" },
      el("span", { textContent: `Review: ${count} ${count === 1 ? "note" : "notes"}${review.composed !== null ? ", in the message box" : ""}` }), add, discard),
    gone.length > 0 && el("div", { className: "notes-outdated" },
      el("p", { className: "dim small", textContent: "The diff no longer shows these lines as quoted. The notes stay in the review with their quotes." }),
      ...gone.map((note) => noteCard(note))),
    review.draft !== null && !draftPlaced && el("div", { className: "notes-outdated" },
      el("p", { className: "dim small", textContent: `A note on ${review.draft.path} is not saved. Save or cancel it to start another.` }),
      draftCard(review.draft)),
  ]));
  showSelection();
  for (const button of document.querySelectorAll(".tree-file")) {
    button.querySelector(".note-count")?.remove();
    const count = noteCount(button.dataset.path);
    if (count !== false) button.lastElementChild.before(count);
  }
  const text = typing === null ? null : fileView.querySelector(".note-text");
  if (text !== null && text !== document.activeElement) {
    text.focus({ preventScroll: true });
    text.setSelectionRange(...typing);
  }
}

/** Puts the review in the composer, in place of the review put there before if the composer still holds it. */
function composeReview() {
  const prompt = document.getElementById("prompt-text");
  if (prompt === null) return showError("action-error", new Error("This thread takes no messages now, so the review can't go to the composer."));
  const text = formatReview(review.notes);
  const before = review.composed?.text;
  prompt.value = before !== undefined && prompt.value.includes(before) ? prompt.value.replace(before, () => text)
    : prompt.value.trim() === "" ? text : `${prompt.value.trimEnd()}\n\n${text}`;
  review.composed = { text, ids: review.notes.map((n) => n.id) };
  saveReview();
  decorate();
  showTab(null);
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
}

/** After a message from the composer is sent, drops the notes it carried. A note cut from it, or edited since, stays. */
export function reviewSent(sent, text) {
  const after = afterSend(review, sent, text);
  if (after === review) return;
  review = after;
  saveReview();
  decorate();
}

/** The place in an entry's rows of the row an event is on, or null. */
function rowAt(event) {
  const row = annotated?.view.rowOf(event);
  if (row === null || row === undefined) return null;
  const at = annotated.rows[row.entry].findIndex((r) => r.index === row.index);
  return at === -1 ? null : { ...row, at };
}

/**
 * Lets the reader select rows of a newly drawn diff by their line numbers and with the keyboard. A null `view`
 * is a diff with no lines drawn, which keeps the review's notes on the file above it.
 */
export function annotate(view, path, files) {
  if (view === null) {
    annotated = null;
    return decorate();
  }
  annotated = { view, path, rows: files.map(rowsOf) };
  selection = null;
  view.node.tabIndex = 0;
  view.node.setAttribute("aria-label", "Diff. Up and Down move between lines, Shift with them extends the selection, C, Q, S or R starts a comment, question, suggestion or requested change on it, and Escape clears it.");
  view.node.addEventListener("pointerdown", (event) => {
    const row = rowAt(event);
    if (row === null || !row.number || event.button !== 0) return;
    event.preventDefault();
    selection = event.shiftKey && selection?.entry === row.entry ? { ...selection, head: row.at } : { entry: row.entry, anchor: row.at, head: row.at };
    dragging = true;
    view.node.focus({ preventScroll: true });
    showSelection();
  });
  view.node.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const row = rowAt(event);
    if (row === null || row.entry !== selection.entry || row.at === selection.head) return;
    selection = { ...selection, head: row.at };
    showSelection();
  });
  view.node.addEventListener("keydown", (event) => {
    if (event.target !== view.node || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[key];
    const kind = Object.keys(kinds).find((k) => kinds[k].key === key);
    if (step !== undefined) {
      event.preventDefault();
      moveSelection(step, event.shiftKey);
    } else if (key === "Escape" && selection !== null) {
      selection = null;
      showSelection();
    } else if (kind !== undefined && review.draft !== null) {
      event.preventDefault();
      focusDraft();
    } else if (kind !== undefined && selection !== null) {
      event.preventDefault();
      startDraft(kind);
    }
  });
  decorate();
}
addEventListener("pointerup", () => { dragging = false; });
// Another tab on this thread changed the review, so this one draws that review rather than saving over it.
addEventListener("storage", (event) => {
  if (event.key !== reviewKey) return;
  review = readReview(event.newValue);
  decorate();
});

/** Moves the keyboard's row one step, into the next entry at an entry's end, and extends the selection with Shift. */
function moveSelection(step, extend) {
  const { rows } = annotated;
  if (selection === null) {
    const entry = rows.findIndex((r) => r.length > 0);
    if (entry === -1) return;
    selection = { entry, anchor: 0, head: 0 };
  } else {
    let { entry, head } = selection;
    head += step;
    if (head < 0 || head >= rows[entry].length) {
      if (extend) return;
      do entry += step; while (entry >= 0 && entry < rows.length && rows[entry].length === 0);
      if (entry < 0 || entry >= rows.length) return;
      head = step > 0 ? 0 : rows[entry].length - 1;
    }
    selection = extend ? { ...selection, head } : { entry, anchor: head, head };
  }
  showSelection();
  annotated.view.rowElement(selection.entry, rows[selection.entry][selection.head].index)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** How many of the review's notes are on a file, beside its name in the tree. */
export function noteCount(path) {
  const count = review.notes.filter((n) => n.path === path).length;
  return count > 0 && el("span", { className: "note-count", title: `${count} ${count === 1 ? "note" : "notes"} in the review`, textContent: String(count) });
}
