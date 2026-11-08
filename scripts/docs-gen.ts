/**
 * Regenerates the parts of the docs that copy the source. A TypeScript block follows a line
 * `<!-- types: <file> <Name> ... <file> <Name> ... -->`, and its body is each declaration as the file before its name has
 * it, with the TSDoc directly above it. A file's header comment stands apart from its first declaration by a blank line.
 * The table after `<!-- holds -->` is each hold's rule from src/control/holds.ts.
 * `node scripts/docs-gen.ts` rewrites the pages, and src/docs.test.ts fails when a page and the source differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { holdCodes, holdRule, remedyOf, waivedName } from "../src/control/holds.ts";

const root = resolve(import.meta.dirname, "..");
export const cliDoc = resolve(root, "docs/cli.md");
export const generatedDocs = [cliDoc, resolve(root, "docs/merge-policy.md")];
export const marker = /^<!-- types: (.+) -->\n```ts\n[\s\S]*?\n```$/gm;
const holdsMarker = /^<!-- holds -->\n(?:\|.*\n?)*/gm;

/** The declaration of `name` in `source`, with the TSDoc above it and without `export`. */
export function declaration(source: string, name: string): string {
  const head = new RegExp(`^(?:export )?(?:interface|type|const) ${name}\\b`, "m").exec(source);
  if (head === null) throw new Error(`no declaration of ${name}`);
  const doc = /\/\*\*(?:[^*]|\*(?!\/))*\*\/\n$/.exec(source.slice(0, head.index));
  const start = doc?.index ?? head.index;
  const isInterface = head[0].includes("interface");
  let angle = 0;
  let depth = 0;
  for (let i = head.index; i < source.length; i++) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") i = (source.indexOf("\n", i) + 1 || source.length) - 2;
    else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) + 1;
    else if (c === '"' || c === "'" || c === "`") while (source[++i] !== c) i += source[i] === "\\" ? 1 : 0;
    else if (isInterface && depth === 0 && (c === "<" || c === ">" && source[i - 1] !== "=")) angle += c === "<" ? 1 : -1;
    else if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) {
      depth--;
      if (isInterface && depth === 0 && angle === 0 && c === "}") return text(start, i + 1);
    } else if (c === ";" && depth === 0 && !isInterface) return text(start, i + 1);
  }
  throw new Error(`unterminated declaration of ${name}`);

  function text(from: number, to: number): string {
    const comment = /^ *\/\/.*/.exec(source.slice(to))?.[0] ?? "";
    return source.slice(from, to + comment.length).replace(/^export /m, "");
  }
}

/**
 * One row per hold code, and one for each family of codes that differ only by their reserved case, which share a rule.
 */
function holdsTable(): string {
  const yes = (b: boolean) => b ? "Yes" : "No";
  const rows = new Map<string, string>();
  for (const code of holdCodes) {
    const family = code.replace(/:.*/, ":<case>");
    const { waivable, holdsAgain, why } = holdRule(code);
    const name = !waivable ? "" : family === code ? waivedName(code) : `the case's name, such as ${waivedName(code)}`;
    const cells = [`\`${family}\``, name, yes(waivable), yes(holdsAgain), remedyOf(code) ?? "", why];
    const row = `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
    const first = rows.get(family) ?? row;
    if (first.replace(/such as [^|]*/, "") !== row.replace(/such as [^|]*/, "")) throw new Error(`${code} has another rule than the rest of ${family}`);
    rows.set(family, first);
  }
  return [
    "<!-- holds -->",
    "| Hold | A waiver names it | The person may waive it | It meets every landing of the head again | The loop's own remedy | Why, as the Land card tells the person |",
    "|---|---|---|---|---|---|",
    ...rows.values(),
  ].join("\n") + "\n";
}

/** The page with each marked block rebuilt from the source. */
export function generated(page: string): string {
  return page.replace(holdsMarker, holdsTable).replace(marker, (_block, refs: string) => {
    let file = "";
    const body = refs.trim().split(/\s+/).map((ref) => {
      if (!ref.endsWith(".ts")) return declaration(readFileSync(resolve(root, file), "utf8"), ref);
      file = ref;
      return `// ${file}`;
    });
    return `<!-- types: ${refs} -->\n\`\`\`ts\n${body.join("\n")}\n\`\`\``;
  });
}

if (import.meta.main) for (const doc of generatedDocs) writeFileSync(doc, generated(readFileSync(doc, "utf8")));
