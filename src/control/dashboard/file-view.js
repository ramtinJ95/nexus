import { request } from "./request.js";
import { pylonRoutes } from "../../contract/pylon.ts";
import { el, present } from "./page.js";
import { bases } from "./checkout-text.js";
import { kept, narrow, storageKeys } from "./contract.ts";
import { badge, canRead, checkout, counts, factsNow, thread, unreadable } from "./checkout.js";
import { readChanges } from "./changes-tree.js";
import { fileView, openTabs, tabShows } from "./tab-bar.js";
import { annotate, reviewBox } from "./review-notes.js";

let diffLayout = kept.read(storageKeys.diffLayout) === "split" ? "split" : "unified";
/** A window as narrow as a phone's, which draws unified, as split leaves each side too few characters to read. */
const phone = matchMedia(narrow);
/** The open diff as last read, so a change of layout draws it again without reading the pylon. */
let openDiff = null;

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
void import("./theme.js").then(({ onThemeChange, startThemes }) => {
  startThemes();
  onThemeChange(redrawDiff);
});

async function drawDiff({ read, head, shown, truncated }) {
  try {
    const { diffView, imagePair } = await import("./diff.js");
    const view = shown.kind === "lines" ? await diffView(shown.files, phone.matches ? "unified" : diffLayout) : null;
    if (read !== diffRead) return;
    const typing = document.activeElement?.matches?.(".note-text") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    head.querySelector(".fv-layout").hidden = view === null;
    fileView.replaceChildren(...present([head, reviewBox,
      shown.kind !== "none" && shown.meta.length > 0 && el("div", { className: "fv-meta dim small" }, ...shown.meta.map((line) => el("div", { textContent: line }))),
      (truncated || (shown.kind === "lines" && shown.cut)) && el("p", { className: "dim small fv-note", textContent: "Only the start of the diff shows, because the whole of it is too long to show." }),
      view?.node ?? ((shown.kind === "binary" && imagePair(openTabs.find((f) => f.path === fileView.dataset.path), checkout.base, thread))
        || el("p", { className: "empty fv-note", textContent: shown.kind === "binary" ? "The file is binary, so there is no diff to show." : shown.kind === "meta" ? "No lines changed." : "The file has no changes now." }))]));
    annotate(view, fileView.dataset.path, shown.files);
    const text = typing === null ? null : fileView.querySelector(".note-text");
    text?.focus({ preventScroll: true });
    text?.setSelectionRange(...typing);
  } catch (err) {
    if (read !== diffRead) return;
    fileView.replaceChildren(head, el("p", { className: "error fv-note", textContent: err.message }));
  }
}

let diffRead = 0;
export async function readDiff(path) {
  const file = openTabs.find((f) => f.path === path);
  if (file === undefined || fileView === null) return;
  const read = ++diffRead;
  const dir = file.path.slice(0, file.path.lastIndexOf("/") + 1);
  const head = el("header", { className: "fv-head" }, badge(file.status),
    el("span", { className: "fv-path", title: file.path }, dir !== "" && el("span", { className: "fv-dir", textContent: dir }), el("span", { className: "fv-name", textContent: file.path.slice(dir.length) })),
    el("span", { className: "dim small", textContent: bases[checkout.base].vs }), counts(file.additions, file.deletions), layoutPicker());
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
    const [{ diff, truncated }, { diffOf }] = await Promise.all([request(pylonRoutes.diff, { thread, query: { base: checkout.base, paths } }), import("./diff.js")]);
    if (read !== diffRead) return;
    openDiff = { read, head, shown: diffOf(diff), truncated };
    await drawDiff(openDiff);
  } catch (err) {
    if (read !== diffRead) return;
    fileView.replaceChildren(head, el("p", { className: "error fv-note", textContent: err.message }));
  }
}
tabShows.file = readDiff;
