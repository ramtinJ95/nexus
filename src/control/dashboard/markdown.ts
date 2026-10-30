/** Renders an agent's markdown as safe HTML. */
import { Html, html, type Part } from "./view.ts";

/**
 * A reply or prompt's markdown, with `end` after its last character, where a streaming reply's caret goes. Every poll
 * and stream frame renders the same finished texts again, so their markdown is kept by text, the most recently shown.
 */
export function prose(text: string, end: Part = null): Html {
  if (end !== null) return markdownView(parseMarkdown(text.split(/\r?\n/)), end);
  const kept = proseKept.get(text);
  proseKept.delete(text);
  const out = kept ?? markdownView(parseMarkdown(text.split(/\r?\n/)), null);
  proseKept.set(text, out);
  if (proseKept.size > proseKeeps) proseKept.delete(proseKept.keys().next().value!);
  return out;
}
const proseKept = new Map<string, Html>();
const proseKeeps = 2_000;

/** A block of the markdown that replies and prompts are written in. A list's `start` is null for bullets. */
type Markdown =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; start: number | null; items: Markdown[][] }
  | { kind: "quote"; body: Markdown[] }
  | { kind: "rule" }
  | { kind: "para"; text: string };

const fenceLine = /^ {0,3}(`{3,})[^`]*$/;
const headingLine = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const ruleLine = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const quoteLine = /^ {0,3}> ?(.*)$/;
const itemLine = /^( *)([-*+]|(\d{1,9})[.)])[ \t]+(.*)$/;
const isBlank = (line: string) => line.trim() === "";
const indentOf = (line: string) => line.length - line.trimStart().length;
const startsBlock = (line: string) => [fenceLine, headingLine, ruleLine, quoteLine, itemLine].some((re) => re.test(line));
/** Quotes and lists nested deeper read as typed, since a reply is untrusted and each level parses and renders a call deeper. */
const maxNesting = 16;

/** Every line is kept, so a paragraph's line breaks show as they were typed. */
function parseMarkdown(lines: readonly string[], depth = 0): Markdown[] {
  if (depth === maxNesting) return lines.some((l) => !isBlank(l)) ? [{ kind: "para", text: lines.join("\n") }] : [];
  const out: Markdown[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = fenceLine.exec(line);
    const heading = headingLine.exec(line);
    const item = itemLine.exec(line);
    if (isBlank(line)) i++;
    else if (fence !== null) {
      const closes = (l: string) => /^ {0,3}`{3,}[ \t]*$/.test(l) && l.trim().length >= fence[1]!.length;
      let end = i + 1;
      while (end < lines.length && !closes(lines[end]!)) end++;
      // A fence that never closes runs to the end, as a streaming reply's open code block does.
      out.push({ kind: "code", text: lines.slice(i + 1, end).join("\n") });
      i = end + 1;
    } else if (heading !== null) {
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
    } else if (ruleLine.test(line)) {
      out.push({ kind: "rule" });
      i++;
    } else if (quoteLine.test(line)) {
      const body: string[] = [];
      for (let q = quoteLine.exec(line); q !== null; q = i < lines.length ? quoteLine.exec(lines[i]!) : null) {
        body.push(q[1]!);
        i++;
      }
      out.push({ kind: "quote", body: parseMarkdown(body, depth + 1) });
    } else if (item !== null) {
      const ordered = item[3] !== undefined;
      const items: Markdown[][] = [];
      for (let m: RegExpExecArray | null = item; m !== null && (m[3] !== undefined) === ordered; m = i < lines.length ? itemLine.exec(lines[i]!) : null) {
        const own = m[1]!.length;
        const offset = m[0].length - m[4]!.length;
        const body = [m[4]!];
        for (i++; i < lines.length; i++) {
          const next = lines[i]!;
          if (isBlank(next)) {
            const after = lines.slice(i).findIndex((l) => !isBlank(l));
            if (after === -1) break;
            if (indentOf(lines[i + after]!) < offset) {
              // Blank lines between two items keep them in one list.
              if (itemLine.test(lines[i + after]!)) i += after;
              break;
            }
            body.push("");
          // An item indented past its parent's marker nests even short of the parent's text, as models often write them.
          } else if (indentOf(next) >= offset || itemLine.test(next) && indentOf(next) > own) body.push(next.slice(Math.min(indentOf(next), offset)));
          else if (!isBlank(body.at(-1)!) && !startsBlock(next)) body.push(next);
          else break;
        }
        items.push(parseMarkdown(body, depth + 1));
      }
      out.push({ kind: "list", start: ordered ? Number(item[3]) : null, items });
    } else {
      const start = i;
      do i++; while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!));
      out.push({ kind: "para", text: lines.slice(start, i).join("\n") });
    }
  }
  return out;
}

function markdownView(blocks: readonly Markdown[], end: Part): Html {
  return html`${blocks.map((block, i) => markdownBlock(block, i === blocks.length - 1 && end))}${blocks.length === 0 && end}`;
}

function markdownBlock(block: Markdown, end: Part): Html {
  switch (block.kind) {
    case "code": return html`<pre class="code">${block.text}${end}</pre>`;
    case "heading": {
      // A heading inside a message stays below the page's own.
      const tag = Math.min(block.level + 2, 6);
      return html`<h${tag} class="md-h">${inline(block.text)}${end}</h${tag}>`;
    }
    case "list": {
      const items = block.items.map((item, i) => html`<li>${markdownView(item, i === block.items.length - 1 && end)}</li>`);
      return block.start === null ? html`<ul>${items}</ul>` : html`<ol${block.start !== 1 && html` start="${block.start}"`}>${items}</ol>`;
    }
    case "quote": return html`<blockquote>${markdownView(block.body, end)}</blockquote>`;
    case "rule": return html`<hr>${end}`;
    case "para": return html`<p>${inline(block.text)}${end}</p>`;
  }
}

/**
 * Code spans, links and emphasis, by whether code spans are on. Emphasis and links take a code span whole, so no
 * marker inside one counts. A marker inside a word is text, so snake_case and 2*3*4 read as typed, and so is one
 * that a file's extension follows, so __init__.py does too.
 */
const inlinePatterns = [false, true].map((code) => {
  const any = code ? "(?:`[^`]*`|[^`])" : "[\\s\\S]";
  const label = code ? "(?:`[^`]*`|[^`\\[\\]])" : "[^\\[\\]]";
  const [stars, unders] = ["[\\p{L}\\p{N}*]", "[\\p{L}\\p{N}_]"];
  const underEnd = `(?!${unders}|\\.\\p{L})`;
  return new RegExp([
    code ? "`([^`]*)`" : "(?!)()",
    `\\[(${label}+?)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)\\)`,
    `\\*\\*(?![\\s*])(${any}+?)(?<![\\s*])\\*\\*`,
    `(?<!${unders})__(?![\\s_])(${any}+?)(?<![\\s_])__${underEnd}`,
    `(?<!${stars})\\*(?![\\s*])(${any}+?)(?<![\\s*])\\*(?!${stars})`,
    `(?<!${unders})_(?![\\s_])(${any}+?)(?<![\\s_])_${underEnd}`,
  ].join("|"), "gu");
});

// An odd count of backticks leaves one unmatched, so every backtick stays as written.
export function inline(text: string, code = text.split("`").length % 2 === 1): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(inlinePatterns[Number(code)]!)) {
    const [whole, span, label, url] = m;
    const strong = m[4] ?? m[5];
    out.push(text.slice(at, m.index),
      span !== undefined ? html`<code>${span}</code>`
      : url !== undefined ? /^https?:\/\//i.test(url) ? html`<a class="link" href="${url}" target="_blank" rel="noopener noreferrer">${inline(label!, code)}</a>` : whole
      : strong !== undefined ? html`<strong>${inline(strong, code)}</strong>`
      : html`<em>${inline((m[6] ?? m[7])!, code)}</em>`);
    at = m.index + whole.length;
  }
  out.push(text.slice(at));
  return out;
}
