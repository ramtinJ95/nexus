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
 * that a file's extension follows, so __init__.py does too. An emphasis or a link closes at its first closer.
 */
type Emphasis = { marker: string; tag: "strong" | "em"; opens: (t: string, i: number) => boolean; closes: (t: string, i: number) => boolean };

const space = (c: string | undefined) => c !== undefined && /\s/u.test(c);
const word = (c: string) => /[\p{L}\p{N}]/u.test(c);
const letter = (c: string) => /\p{L}/u.test(c);
const codePointBefore = (t: string, i: number) => i === 0 ? "" : /[\uDC00-\uDFFF]/.test(t[i - 1]!) && /[\uD800-\uDBFF]/.test(t[i - 2] ?? "") ? t.slice(i - 2, i) : t[i - 1]!;
const codePointAt = (t: string, i: number) => i < t.length ? String.fromCodePoint(t.codePointAt(i)!) : "";
const underEnd = (t: string, i: number) => !word(codePointAt(t, i)) && t[i] !== "_" && !(t[i] === "." && letter(codePointAt(t, i + 1)));

/** At one place, a marker that two of these start with is tried longest first. */
const emphases: readonly Emphasis[] = [
  { marker: "**", tag: "strong", opens: (t, i) => !space(t[i + 2]) && t[i + 2] !== "*", closes: (t, i) => !space(t[i - 1]) && t[i - 1] !== "*" },
  { marker: "__", tag: "strong",
    opens: (t, i) => !word(codePointBefore(t, i)) && t[i - 1] !== "_" && !space(t[i + 2]) && t[i + 2] !== "_",
    closes: (t, i) => !space(t[i - 1]) && t[i - 1] !== "_" && underEnd(t, i + 2) },
  { marker: "*", tag: "em",
    opens: (t, i) => !word(codePointBefore(t, i)) && t[i - 1] !== "*" && !space(t[i + 1]) && t[i + 1] !== "*",
    closes: (t, i) => !space(t[i - 1]) && t[i - 1] !== "*" && !word(codePointAt(t, i + 1)) && t[i + 1] !== "*" },
  { marker: "_", tag: "em",
    opens: (t, i) => !word(codePointBefore(t, i)) && t[i - 1] !== "_" && !space(t[i + 1]) && t[i + 1] !== "_",
    closes: (t, i) => !space(t[i - 1]) && t[i - 1] !== "_" && underEnd(t, i + 1) },
];

/** Characters the inline scanner has visited, all calls together, so a test can show the work grows with the text and no faster. */
export let inlineSteps = 0;

const none = -1;

/**
 * Where each closer is next found, so every opener finds its closer in one lookup and parsing stays linear in the
 * text's length, however many openers never close. From a place where content may end, `closer[k][i]` is the first
 * place at or after it where emphasis k closes, stepping over code spans when they are on. `label[i]` is the same
 * for a link's `]`, which no `[` may come before. `url[i]` is where a link's address that starts at i ends.
 */
function closers(t: string, code: boolean) {
  const n = t.length;
  const tick = new Int32Array(n + 1).fill(none);
  const closer = emphases.map(() => new Int32Array(n + 1).fill(none));
  const label = new Int32Array(n + 1).fill(none);
  const stop = new Int32Array(n + 1).fill(n);
  const url = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    inlineSteps++;
    const c = t[i]!;
    tick[i] = c === "`" ? i : tick[i + 1]!;
    const pastCode = c !== "`" || !code ? i + 1 : tick[i + 1] === none ? none : tick[i + 1]! + 1;
    emphases.forEach((e, k) => { closer[k]![i] = t.startsWith(e.marker, i) && e.closes(t, i) ? i : pastCode === none ? none : closer[k]![pastCode]!; });
    label[i] = c === "]" ? i : c === "[" || pastCode === none ? none : label[pastCode]!;
    const special = c === "(" || c === ")" || space(c);
    stop[i] = special ? i : stop[i + 1]!;
    url[i] = !special ? url[i + 1]! : c === "(" && t[stop[i + 1]!] === ")" ? url[stop[i + 1]! + 1]! : i;
  }
  return { tick, closer, label, url };
}

// An odd count of backticks leaves one unmatched, so every backtick stays as written.
export function inline(t: string, code = t.split("`").length % 2 === 1): Part[] {
  const { tick, closer, label, url } = closers(t, code);
  // Emphasis holds at least one character, or one code span when they are on.
  const closeOf = (k: number, start: number) => {
    const from = start >= t.length ? none : t[start] !== "`" || !code ? start + 1 : tick[start + 1] === none ? none : tick[start + 1]! + 1;
    return from === none ? none : closer[k]![from]!;
  };
  const out: Part[] = [];
  let at = 0;
  const take = (start: number, end: number, part: Part) => { out.push(t.slice(at, start), part); at = end; };
  for (let i = 0; i < t.length;) {
    inlineSteps++;
    const c = t[i]!;
    if (c === "`" && code) {
      const end = tick[i + 1]!;
      if (end !== none) { take(i, end + 1, html`<code>${t.slice(i + 1, end)}</code>`); i = at; continue; }
    } else if (c === "[") {
      const close = label[i + 1]!;
      const href = close === none || close === i + 1 || t[close + 1] !== "(" ? none : close + 2;
      const end = href === none ? none : url[href]!;
      if (end !== none && end > href && t[end] === ")") {
        const address = t.slice(href, end);
        take(i, end + 1, /^https?:\/\//i.test(address)
          ? html`<a class="link" href="${address}" target="_blank" rel="noopener noreferrer">${inline(t.slice(i + 1, close), code)}</a>`
          : t.slice(i, end + 1));
        i = at;
        continue;
      }
    } else {
      const k = emphases.findIndex((e, k) => t.startsWith(e.marker, i) && e.opens(t, i) && closeOf(k, i + e.marker.length) !== none);
      if (k !== none) {
        const { marker, tag } = emphases[k]!;
        const end = closeOf(k, i + marker.length);
        const body = inline(t.slice(i + marker.length, end), code);
        take(i, end + marker.length, tag === "strong" ? html`<strong>${body}</strong>` : html`<em>${body}</em>`);
        i = at;
        continue;
      }
    }
    i++;
  }
  out.push(t.slice(at));
  return out;
}
