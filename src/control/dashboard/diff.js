// The diff of one changed file as the dashboard shows it, highlighted by @pierre/diffs. client.js imports this
// module only once a diff opens, so the library loads then, and each language's grammar once a file needs it.
import { DiffHunksRenderer, parsePatchFiles, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs";

/** A diff this long is shown up to here, so a huge one does not stall the page. */
export const maxDiffRows = 20_000;
/** What a diff says of a file beyond its lines, such as a rename or a new mode. */
const metaLine = /^(old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to) /;

/**
 * What the pylon's diff of one file has to show: its lines, or that it is binary, or only what it says of the file
 * beyond its lines, or nothing. Every kind but the last has those lines of meta.
 */
export function diffOf(patch) {
  const meta = patch.split("\n").filter((line) => metaLine.test(line));
  const file = parsePatchFiles(patch).flatMap((p) => p.files)[0];
  if (file !== undefined && file.hunks.length > 0) return { kind: "lines", file, meta };
  if (/^Binary files /m.test(patch)) return { kind: "binary", meta };
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

/** A file's lines in the given layout, "unified" or "split", and whether they were cut at maxDiffRows. */
export async function diffView(file, layout) {
  const renderer = new DiffHunksRenderer({ diffStyle: layout, disableFileHeader: true });
  const result = await renderer.asyncRender(file, { startingLine: 0, totalLines: maxDiffRows, bufferBefore: 0, bufferAfter: 0 });
  const node = document.createElement("div");
  node.className = "diff-view";
  const root = node.attachShadow({ mode: "open" });
  root.adoptedStyleSheets = [sheet(wrapCoreCSS(result.css)), sheet(wrapThemeCSS(result.themeStyles, "system"))];
  root.append(toDom(renderer.renderFullAST(result)));
  const rows = file.hunks.reduce((sum, hunk) => sum + (layout === "split" ? hunk.splitLineCount : hunk.unifiedLineCount), 0);
  return { node, cut: rows > maxDiffRows };
}
