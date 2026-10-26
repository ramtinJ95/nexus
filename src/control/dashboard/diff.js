// The diff of one changed file as the dashboard shows it, highlighted by @pierre/diffs. client.js imports this
// module only once a diff opens, so the library loads then, and each language's grammar once a file needs it.
import { DiffHunksRenderer, parsePatchFiles, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs";

/** A diff this long is shown up to here, so a huge one does not stall the page. */
export const maxDiffRows = 20_000;
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
      const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[header]);
      lines[header] = `@@ -${at[1]},${old} +${at[2]},${added} @@${at[3]}`;
      return { patch: lines.slice(0, i).join("\n") + "\n", cut: true };
    } else if (/^diff --git /.test(lines[i])) header = -1;
  }
  return { patch, cut: false };
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
  if (files.length > 0) return { kind: "lines", files, meta, cut };
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

/** The lines of a diff's files in the given layout, "unified" or "split". */
export async function diffView(files, layout) {
  const node = document.createElement("div");
  node.className = "diff-view";
  const root = node.attachShadow({ mode: "open" });
  for (const file of files) {
    const renderer = new DiffHunksRenderer({ diffStyle: layout, disableFileHeader: true });
    const result = await renderer.asyncRender(file);
    if (root.adoptedStyleSheets.length === 0) root.adoptedStyleSheets = [sheet(wrapCoreCSS(result.css)), sheet(wrapThemeCSS(result.themeStyles, "system"))];
    root.append(toDom(renderer.renderFullAST(result)));
  }
  return node;
}
