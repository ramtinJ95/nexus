/**
 * Regenerates the TypeScript blocks of docs/cli.md from the source declarations they show. A block follows a line
 * `<!-- types: <file> <Name> ... <file> <Name> ... -->`, and its body is each declaration as the file before its name has
 * it, TSDoc included.
 * `node scripts/docs-gen.ts` rewrites the page, and src/docs.test.ts fails when the page and the source differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const cliDoc = resolve(root, "docs/cli.md");
const marker = /^<!-- types: (.+) -->\n```ts\n[\s\S]*?\n```$/gm;

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
    if (c === "/" && source[i + 1] === "/") i = source.indexOf("\n", i) - 1;
    else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) + 1;
    else if (c === '"' || c === "'" || c === "`") i = source.indexOf(c, i + 1);
    else if (isInterface && depth === 0 && (c === "<" || c === ">")) angle += c === "<" ? 1 : -1;
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

/** The page with each marked block rebuilt from its declarations. */
export function generated(page: string): string {
  return page.replace(marker, (_block, refs: string) => {
    let file = "";
    const body = refs.trim().split(/\s+/).map((ref) => {
      if (!ref.endsWith(".ts")) return declaration(readFileSync(resolve(root, file), "utf8"), ref);
      file = ref;
      return `// ${file}`;
    });
    return `<!-- types: ${refs} -->\n\`\`\`ts\n${body.join("\n")}\n\`\`\``;
  });
}

if (import.meta.main) writeFileSync(cliDoc, generated(readFileSync(cliDoc, "utf8")));
