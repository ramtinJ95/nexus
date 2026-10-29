// The diff of one changed file as the dashboard shows it, highlighted by @pierre/diffs. client.js imports this
// module only once a diff opens, so the library loads then, and each language's grammar once a file needs it.
import { DiffHunksRenderer, parsePatchFiles, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs";
import { themeValue } from "./theme.js";

/** A diff this long is shown up to here, so a huge one does not stall the page. */
export const maxDiffRows = 2_000;
/** What a diff says of a file beyond its lines, such as a rename or a new mode. */
const metaLine = /^(old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to) /;

/**
 * The patch up to its first maxDiffRows lines of hunks, and whether it went further. A cut hunk's header takes the
 * counts of the lines kept, so the parser reads a whole hunk and the highlighter never sees the rest.
 */
function cutPatch(patch) {
  const lines = patch.split("\n");
  let rows = 0;
  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^@@ /.test(lines[i])) header = i;
    else if (header !== -1 && /^[ +-]/.test(lines[i]) && ++rows > maxDiffRows) {
      const kept = lines.slice(header + 1, i).filter((line) => /^[ +-]/.test(line));
      const old = kept.filter((line) => line[0] !== "+").length;
      const added = kept.filter((line) => line[0] !== "-").length;
      const at = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)$/.exec(lines[header]);
      // A side with no lines names the line before it, so a side the cut emptied starts a line earlier.
      const start = (from, count, kept) => kept === 0 && count !== ",0" ? Number(from) - 1 : from;
      lines[header] = `@@ -${start(at[1], at[2], old)},${old} +${start(at[3], at[4], added)},${added} @@${at[5]}`;
      return { patch: lines.slice(0, i).join("\n") + "\n", cut: true };
    } else if (/^diff --git /.test(lines[i])) header = -1;
  }
  return { patch, cut: false };
}

/** A line's ending, or none for a last line with no newline. */
const ending = (line) => line.endsWith("\r\n") ? "CRLF" : line.endsWith("\n") ? "LF" : null;

/**
 * The meta line that says a file's changed lines went from LF to CRLF endings or back, which the diff draws as every
 * line removed and added again with the same text, or none.
 */
function endingsChange(file) {
  const parts = file.hunks.flatMap((hunk) => hunk.hunkContent).filter((part) => part.type === "change");
  const endings = (lines, at, count) => parts.flatMap((part) => lines.slice(part[at], part[at] + part[count]).map(ending)).filter((e) => e !== null);
  const removed = new Set(endings(file.deletionLines, "deletionLineIndex", "deletions"));
  const added = new Set(endings(file.additionLines, "additionLineIndex", "additions"));
  if (removed.size !== 1 || added.size !== 1) return [];
  const [from] = removed;
  const [to] = added;
  return from === to ? [] : [`line endings changed from ${from} to ${to}`];
}

/**
 * What the pylon's diff of one file has to show: its lines, or that it is binary, or only what it says of the file
 * beyond its lines, or nothing. Every kind but the last has those lines of meta. A file whose type changed, such as
 * a file that became a symlink, has two entries, its removal and its addition, and both are its lines.
 */
export function diffOf(text) {
  const meta = text.split("\n").filter((line) => metaLine.test(line));
  const { patch, cut } = cutPatch(text);
  const files = parsePatchFiles(patch).flatMap((p) => p.files).filter((file) => file.hunks.length > 0);
  if (files.length > 0) return { kind: "lines", files, meta: [...meta, ...files.flatMap(endingsChange)], cut };
  if (/^Binary files /m.test(text)) return { kind: "binary", meta };
  return meta.length > 0 ? { kind: "meta", meta } : { kind: "none" };
}

const sheet = (css) => {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
};

/**
 * The library's syntax tree as DOM. The page's CSP blocks every style attribute in markup, and the library's own
 * component writes its rows, token colours included, as markup. A style set through CSSOM is allowed, so this sets
 * each one that way. The paths and lines are the guest's, so they only ever go in as text or attribute values.
 */
function toDom(node) {
  if (node.type === "text") return document.createTextNode(node.value);
  if (node.type !== "element") return null;
  const el = document.createElement(node.tagName);
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    const text = value === true ? "" : Array.isArray(value) ? value.join(" ") : String(value);
    if (name === "style") el.style.cssText = text;
    else el.setAttribute(name === "className" ? "class" : name, text);
  }
  for (const child of node.children ?? []) {
    const dom = toDom(child);
    if (dom !== null) el.append(dom);
  }
  return el;
}

/** The slot a file's notes after a row go in. The light DOM fills it, so a note is drawn by the page's own styles. */
const slotName = (entry, side, line) => `note-${entry}-${side}-${line}`;

const cursorSheet = `[data-line][data-cursor] { box-shadow: inset 2px 0 0 light-dark(var(--diffs-modified-light), var(--diffs-modified-dark)); }
[data-column-number] { user-select: none; }`;

/**
 * The lines of a diff's files in the given layout, "unified" or "split", with long lines wrapped, in a view that draws
 * a slot under each row a note ends on, marks rows as selected, and says which row a pointer is over.
 */
export async function diffView(files, layout) {
  const syntax = themeValue("--syntax");
  const node = document.createElement("div");
  node.className = "diff-view";
  const root = node.attachShadow({ mode: "open" });
  const entries = [];
  let selected = null;
  let cursor = null;
  const paint = (attr, at) => {
    for (const el of root.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
    if (at === null) return;
    const { rows } = entries[at.entry];
    for (let i = at.from; i <= at.to; i++) for (const el of rows.get(i) ?? []) el.setAttribute(attr, "");
  };
  const redraw = (drawnFile) => {
    const pre = drawn(drawnFile.renderer.renderFullAST(drawnFile.renderer.renderDiff(drawnFile.file)), drawnFile.entry);
    drawnFile.pre.replaceWith(pre);
    Object.assign(drawnFile, { pre, rows: rowElements(pre) });
    paint("data-selected-line", selected);
    paint("data-cursor", cursor);
  };

  for (const [entry, file] of files.entries()) {
    let update = () => {};
    const renderer = new DiffHunksRenderer({ diffStyle: layout, overflow: "wrap", disableFileHeader: true, theme: { light: syntax, dark: syntax } }, (a) => slotName(entry, a.side, a.lineNumber), () => update());
    // renderDiff keeps what it highlighted for the redraws a note's slot needs, which asyncRender does not. Until the
    // file's grammar has loaded, it draws nothing or the plain text, and says when the highlighted lines are ready or
    // that they failed.
    let result = renderer.renderDiff(file);
    if (result === undefined) {
      await new Promise((resolve, reject) => {
        update = resolve;
        renderer.onHighlightError = reject;
      });
      result = renderer.renderDiff(file);
    }
    if (root.adoptedStyleSheets.length === 0) root.adoptedStyleSheets = [sheet(wrapCoreCSS(result.css)), sheet(wrapThemeCSS(result.themeStyles, "system")), sheet(cursorSheet)];
    const pre = drawn(renderer.renderFullAST(result), entry);
    root.append(pre);
    const drawnFile = { entry, file, renderer, pre, rows: rowElements(pre), slotKey: "[]" };
    entries.push(drawnFile);
    update = () => redraw(drawnFile);
  }

  return {
    node,
    /** Draws a slot under each of these rows of file `entry`, `{ side, line }` as a note keeps them, and returns their names. */
    slots(entry, anchors) {
      const names = anchors.map((a) => slotName(entry, a.side, a.line));
      const key = JSON.stringify([...new Set(names)].sort());
      const drawnFile = entries[entry];
      if (key === drawnFile.slotKey) return names;
      drawnFile.slotKey = key;
      drawnFile.renderer.setLineAnnotations(anchors.map((a) => ({ side: a.side, lineNumber: a.line })));
      redraw(drawnFile);
      return names;
    },
    /** Marks rows `from` to `to` of file `entry` by their unified index as selected, or none when given null. */
    select(range) {
      selected = range;
      paint("data-selected-line", range);
    },
    /** Marks the row the keyboard is on, `{ entry, index }`, or none. */
    cursor(at) {
      cursor = at === null ? null : { entry: at.entry, from: at.index, to: at.index };
      paint("data-cursor", cursor);
    },
    /** The row of an event in the view, `{ entry, index, number }`, where `number` says it was on a line number. */
    rowOf(event) {
      const path = event.composedPath();
      const row = path.find((el) => el instanceof Element && el.hasAttribute("data-line-index"));
      const pre = path.find((el) => el instanceof Element && el.hasAttribute("data-entry"));
      if (row === undefined || pre === undefined) return null;
      return { entry: Number(pre.dataset.entry), index: Number(row.getAttribute("data-line-index").split(",")[0]), number: row.hasAttribute("data-column-number") };
    },
    /** The drawn row of file `entry` at a unified index, for placing and scrolling to it. */
    rowElement(entry, index) {
      return entries[entry]?.rows.get(index)?.find((el) => el.hasAttribute("data-line")) ?? null;
    },
  };
}

function drawn(ast, entry) {
  const pre = toDom(ast);
  pre.dataset.entry = String(entry);
  pre.setAttribute("data-interactive-line-numbers", "");
  return pre;
}

/** Each row's elements by unified index: its line number and its line, on each side it shows in. */
function rowElements(pre) {
  const rows = new Map();
  for (const el of pre.querySelectorAll("[data-line-index]")) {
    const index = Number(el.getAttribute("data-line-index").split(",")[0]);
    if (!rows.has(index)) rows.set(index, []);
    rows.get(index).push(el);
  }
  return rows;
}
