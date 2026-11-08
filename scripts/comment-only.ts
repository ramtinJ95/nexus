/**
 * Fails unless the diff from a base commit (default origin/main) to the working tree changes only comments in .ts and
 * .js files. Each changed file's code, its tokens with comments dropped and whitespace between them collapsed, must
 * match the base's, which catches type-only edits that esbuild erases, and esbuild's whitespace-minified output must
 * match too, which a parser rather than this lexer reads. The lexer reads a `/` right after `)` as division, so a
 * regex there, as in `if (x) /a/.test(s)`, could hide a type edit after it. A shell script, a .sh file or one whose
 * first line is a `sh` or `bash` shebang, must match bash's own reprint of it. `node scripts/comment-only.ts [base]
 * [path...]` checks the diff under the paths, and fails on a file added, deleted or renamed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { shellReprint } from "./shell-reprint.ts";

const [base = "origin/main", ...paths] = process.argv.slice(2);
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const files = git("diff", "--name-status", base, "--", ...paths).split("\n").filter(Boolean);

const emit = (path: string, source: string) =>
  transformSync(source, { loader: path.endsWith(".js") ? "js" : "ts", legalComments: "none", minifyWhitespace: true }).code;

// A `/` starts a regex unless it follows a value, so after these words it is a regex, as in `return /x/.test(s)`.
const beforeRegex = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await", "else", "do"]);

function code(source: string): string {
  let out = "";
  let i = 0;
  let space = false;
  // Each open template literal's depth of `{` inside its current `${`, innermost last.
  const templates: number[] = [];
  // A space matters only between two word characters, so `string/* old */|number` reads as `string|number`.
  const push = (text: string) => {
    if (space && /[\w$]$/.test(out) && /^[\w$]/.test(text)) out += " ";
    space = false;
    out += text;
  };
  const quoted = (end: string) => {
    const start = i++;
    while (i < source.length && source[i] !== end) i += source[i] === "\\" ? 2 : 1;
    push(source.slice(start, ++i));
  };
  // From the character after a template's opening "`" or the "}" that ends one of its `${`.
  const template = (start: number) => {
    while (i < source.length && source[i] !== "`" && !(source[i] === "$" && source[i + 1] === "{")) i += source[i] === "\\" ? 2 : 1;
    if (source[i] === "`") return push(source.slice(start, ++i));
    i += 2;
    templates.push(0);
    push(source.slice(start, i));
  };
  const regexAllowed = () => {
    const word = /([A-Za-z_$][\w$]*)$/.exec(out)?.[1];
    if (word !== undefined) return beforeRegex.has(word);
    // A `!` right after a value is TypeScript's non-null assertion, as in `timeout! / 1000`, not a negation.
    return !/[\w$)\].]!?$/.test(out);
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      space = true;
      i++;
    } else if (source.startsWith("//", i)) {
      while (i < source.length && !/[\n\r\u2028\u2029]/.test(source[i])) i++;
      space = true;
    } else if (source.startsWith("/*", i)) {
      i = source.indexOf("*/", i + 2) + 2 || source.length;
      space = true;
    } else if (c === "'" || c === '"') {
      quoted(c);
    } else if (c === "`") {
      template(i++);
    } else if (c === "}" && templates.at(-1) === 0) {
      templates.pop();
      template(i++);
    } else if (c === "/" && regexAllowed()) {
      const start = i++;
      let inClass = false;
      while (i < source.length && (inClass || source[i] !== "/")) {
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        i += source[i] === "\\" ? 2 : 1;
      }
      i++;
      while (/[a-z]/.test(source[i] ?? "")) i++;
      push(source.slice(start, i));
    } else {
      if (templates.length > 0 && c === "{") templates[templates.length - 1]++;
      if (templates.length > 0 && c === "}") templates[templates.length - 1]--;
      push(c);
      i++;
    }
  }
  return out;
}

const isShell = (path: string, source: string) => path.endsWith(".sh") || /^#!.*\b(ba)?sh\b/.test(source);

const firstDifference = (a: string, b: string) => {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return `${JSON.stringify(a.slice(Math.max(0, at - 40), at + 40))} became ${JSON.stringify(b.slice(Math.max(0, at - 40), at + 40))}`;
};

const failures: string[] = [];
for (const [status, path] of files.map((entry) => entry.split("\t"))) {
  const after = status === "M" ? readFileSync(path, "utf8") : "";
  if (status !== "M" || !(/\.(ts|js)$/.test(path) || isShell(path, after))) {
    failures.push(`${path}: ${status}, not a modified .ts, .js or shell file`);
    continue;
  }
  const before = git("show", `${base}:${path}`);
  if (!/\.(ts|js)$/.test(path)) {
    let reprints: [string, string];
    try {
      reprints = [shellReprint(before), shellReprint(after)];
    } catch (error) {
      failures.push(`${path}: bash cannot read it: ${(error as { stderr?: string }).stderr?.trim()}`);
      continue;
    }
    if (reprints[0] !== reprints[1]) failures.push(`${path}: commands differ: ${firstDifference(...reprints)}`);
  } else if (code(before) !== code(after)) failures.push(`${path}: code differs: ${firstDifference(code(before), code(after))}`);
  else if (emit(path, before) !== emit(path, after)) failures.push(`${path}: emitted code differs`);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`${files.length} files change only comments`);
