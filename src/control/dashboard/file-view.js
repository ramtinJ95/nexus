import { request } from "./request.js";
import { pylonRoutes } from "../../contract/pylon.ts";
import { chunk, el, present } from "./page.js";
import { bases } from "./checkout-text.js";
import { kept, keptForTab, narrow, storageKeys } from "./contract.ts";
import { badge, canRead, checkout, counts, factsNow, thread, unreadable } from "./checkout.js";
import { changedFiles, isViewed, markViewed, readChanges } from "./changes-tree.js";
import { activeTab, fileView, openFile, openTabs, tabShows } from "./tab-bar.js";
import { annotate, reviewBox } from "./review-notes.js";

let diffLayout = kept.read(storageKeys.diffLayout) === "split" ? "split" : "unified";
/** A window as narrow as a phone's, which draws unified, as split leaves each side too few characters to read. */
const phone = matchMedia(narrow);
/**
 * The open diff as last read, so a change of layout or Load more rows draws it again without reading the pylon:
 * `text` is the pylon's diff, and `more` how many times the reader loaded more rows of it.
 */
let openDiff = null;
/** The path of a file stepped to, whose diff takes the keyboard once drawn, so the reader can go on with the keys. */
let focusOnDraw = null;
/**
 * The file tab open as the page last went, with the rows the reader loaded and the scroll, which its first draw after
 * a reload goes back to. The first draw of any file uses it up, so it never moves a diff the reader opened afterwards.
 */
const placeKey = storageKeys.tabPlace(thread);
let place = JSON.parse(keptForTab.read(placeKey) ?? "null");
addEventListener("pagehide", () => {
  keptForTab.write(placeKey, typeof activeTab === "string" ? JSON.stringify({ path: activeTab, more: openDiff?.path === activeTab ? openDiff.more : 0, top: fileView.scrollTop }) : null);
});

function layoutPicker() {
  const picker = el("span", { className: "fv-layout" }, ...["unified", "split"].map((layout) => {
    const button = el("button", { type: "button", value: layout, textContent: layout === "unified" ? "Unified" : "Split" });
    button.setAttribute("aria-pressed", String(layout === diffLayout));
    button.addEventListener("click", () => pickLayout(layout));
    return button;
  }));
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Diff layout");
  return picker;
}

function pickLayout(layout) {
  diffLayout = layout;
  kept.write(storageKeys.diffLayout, layout);
  for (const button of fileView.querySelectorAll(".fv-layout button")) button.setAttribute("aria-pressed", String(button.value === layout));
  redrawDiff();
}

/** Draws the open diff again without reading the pylon. While a read is under way, it draws in the new layout when done. */
function redrawDiff() {
  if (openDiff === null || openDiff.read !== diffRead) return;
  openDiff = { ...openDiff, read: ++diffRead };
  void drawDiff(openDiff);
}
phone.addEventListener("change", redrawDiff);
// The head script has painted the theme, so the picker's module loads after the page's own.
void chunk(import("./theme.js")).then(({ onThemeChange, startThemes }) => {
  startThemes();
  onThemeChange(redrawDiff);
});

/** Draws the next stretch of the open diff's rows, keeping the reader's place in it. */
async function loadMore() {
  if (openDiff === null || openDiff.read !== diffRead) return;
  const { diffOf, maxDiffRows } = await chunk(import("./diff.js"));
  if (openDiff.read !== diffRead) return;
  const more = openDiff.more + 1;
  const top = fileView.scrollTop;
  const read = ++diffRead;
  openDiff = { ...openDiff, read, more, shown: diffOf(openDiff.text, maxDiffRows * (more + 1)) };
  await drawDiff(openDiff);
  if (read !== diffRead) return;
  fileView.scrollTop = top;
  fileView.querySelector(".diff-view")?.focus({ preventScroll: true });
}

async function drawDiff({ read, head, shown, truncated, more }) {
  try {
    const { diffView, imagePair, maxDiffRows } = await chunk(import("./diff.js"));
    const view = shown.kind === "lines" ? await chunk(diffView(shown.files, phone.matches ? "unified" : diffLayout)) : null;
    if (read !== diffRead) return;
    const typing = document.activeElement?.matches?.(".note-text") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    head.querySelector(".fv-layout").hidden = view === null;
    fileView.replaceChildren(...present([head, reviewBox,
      shown.kind !== "none" && shown.meta.length > 0 && el("div", { className: "fv-meta dim small" }, ...shown.meta.map((line) => el("div", { textContent: line }))),
      shown.kind === "lines" && shown.cut && moreRows(maxDiffRows * (more + 1), shown.rows),
      truncated && !(shown.kind === "lines" && shown.cut) && el("p", { className: "dim small fv-note", textContent: "Only the start of the diff shows, because the whole of it is too long to show." }),
      view?.node ?? ((shown.kind === "binary" && imagePair(openTabs.find((f) => f.path === fileView.dataset.path), checkout.base, thread))
        || el("p", { className: "empty fv-note", textContent: shown.kind === "binary" ? "The file is binary, so there is no diff to show." : shown.kind === "meta" ? "No lines changed." : "The file has no changes now." }))]));
    annotate(view, fileView.dataset.path, shown.files);
    if (place?.path === fileView.dataset.path) fileView.scrollTop = place.top;
    place = null;
    if (focusOnDraw === fileView.dataset.path) view?.node.focus({ preventScroll: true });
    focusOnDraw = null;
    const text = typing === null ? null : fileView.querySelector(".note-text");
    text?.focus({ preventScroll: true });
    text?.setSelectionRange(...typing);
  } catch (err) {
    if (read !== diffRead) return;
    fileView.replaceChildren(head, el("p", { className: "error fv-note", textContent: err.message }));
  }
}

function moreRows(shownRows, rows) {
  const button = el("button", { type: "button", className: "btn btn-xs", textContent: "Load more rows" });
  button.addEventListener("click", () => { void loadMore(); });
  const count = (n) => n.toLocaleString("en-US");
  return el("p", { className: "dim small fv-note fv-more" },
    el("span", { textContent: `The first ${count(shownRows)} of ${count(rows)} rows show, as drawing many more at once stalls the page.` }), button);
}

/**
 * The open file's place among the changed files, as the tree lists them, with the steps to the files beside it and
 * its viewed mark. A file no longer changed has none.
 */
function steps(file) {
  const files = changedFiles();
  const at = files.findIndex((f) => f.path === file.path);
  if (at === -1) return null;
  const step = (label, key, to) => {
    const button = el("button", { type: "button", className: "btn btn-xs btn-ghost", textContent: key === "[" ? "‹" : "›", title: `${label} (${key})`, disabled: to === undefined });
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => stepFile(key === "[" ? -1 : 1));
    return button;
  };
  const box = el("input", { type: "checkbox", checked: isViewed(files[at]) });
  box.addEventListener("change", () => markViewed(files[at], box.checked));
  return el("span", { className: "fv-steps" },
    step("Previous changed file", "[", files[at - 1]), el("span", { className: "dim small fv-place", textContent: `${at + 1} of ${files.length}` }),
    step("Next changed file", "]", files[at + 1]), el("label", { className: "fv-viewed small" }, box, " Viewed"));
}

/** Opens the changed file `step` places from the open one, in the open one's tab. */
function stepFile(step) {
  const files = changedFiles();
  const at = files.findIndex((f) => f.path === activeTab);
  const next = at === -1 ? undefined : files[at + step];
  if (next === undefined) return;
  focusOnDraw = next.path;
  openFile(next, activeTab);
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "[" && event.key !== "]") return;
  if (fileView === null || fileView.hidden || event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]") !== null) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]") !== null) return;
  event.preventDefault();
  stepFile(event.key === "[" ? -1 : 1);
});

let diffRead = 0;
export async function readDiff(path) {
  const file = openTabs.find((f) => f.path === path);
  if (file === undefined || fileView === null) return;
  const read = ++diffRead;
  if (focusOnDraw !== path) focusOnDraw = null;
  const dir = file.path.slice(0, file.path.lastIndexOf("/") + 1);
  const head = el("header", { className: "fv-head" }, badge(file.status),
    el("span", { className: "fv-path", title: file.path }, dir !== "" && el("span", { className: "fv-dir", textContent: dir }), el("span", { className: "fv-name", textContent: file.path.slice(dir.length) })),
    el("span", { className: "dim small", textContent: bases[checkout.base].vs }), counts(file.additions, file.deletions), steps(file), layoutPicker());
  // A diff reaches into the pylon as the changes do, so a paused one is woken only when the reader says to, and
  // the read of the changes that wakes it reads the open diff again.
  const facts = factsNow();
  if (!canRead(facts)) {
    return fileView.replaceChildren(head, el("div", { className: "fv-note" }, ...unreadable(facts, "the diff", () => {
      void readChanges(true);
      void readDiff(path);
    })));
  }
  if (fileView.dataset.path !== path || fileView.querySelector(".diff-view") === null) fileView.replaceChildren(head, el("p", { className: "empty fv-note", textContent: "Reading the diff…" }));
  fileView.dataset.path = path;
  // A renamed file's old path goes too, or the diff shows it as added.
  const paths = [file.path, ...(file.oldPath === null ? [] : [file.oldPath])];
  try {
    const [{ diff, truncated }, { diffOf, maxDiffRows }] = await Promise.all([request(pylonRoutes.diff, { thread, query: { base: checkout.base, paths } }), chunk(import("./diff.js"))]);
    if (read !== diffRead) return;
    // A read of the same file again, as after a turn or the first after a reload, keeps the rows the reader loaded.
    const more = openDiff?.path === path ? openDiff.more : place?.path === path ? place.more : 0;
    openDiff = { read, head, path, text: diff, more, shown: diffOf(diff, maxDiffRows * (more + 1)), truncated };
    await drawDiff(openDiff);
  } catch (err) {
    if (read !== diffRead) return;
    fileView.replaceChildren(head, el("p", { className: "error fv-note", textContent: err.message }));
  }
}
tabShows.file = readDiff;
