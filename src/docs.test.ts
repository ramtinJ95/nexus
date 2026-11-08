import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cliDoc, declaration, generated, generatedDocs, marker } from "../scripts/docs-gen.ts";
import { commands } from "./cli/commands/index.ts";
import { minControlVersion } from "./cli/config.ts";
import { openDb } from "./control/db.ts";
import { reservedCases, reservedNames } from "./contract/reserved.ts";
import { version } from "./version.ts";

const root = resolve(import.meta.dirname, "..");
const docs = readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".md"))
  .map((path) => join(root, "docs", path));
const linking = [...docs, join(root, "README.md"), join(root, "deploy/README.md")];
const changelogFile = join(root, "docs/changelog.md");
const read = (file: string) => readFileSync(file, "utf8");
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const headings = (file: string) => [...read(file).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]!);
const anchors = (file: string) => new Set(headings(file).map(slug));
const parts = (v: string) => v.split(".").map(Number);
const compare = (a: string, b: string) => parts(a).reduce((order, n, i) => order || n - parts(b)[i]!, 0);
const entries = () => [...read(changelogFile).matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map((match) => ({ version: match[1]!, text: match[2]! }));

test("every link to an anchor of a doc names a heading there", () => {
  const broken = linking.flatMap((file) => [...read(file).matchAll(/\]\((?!\w+:)([^)\s#]*)#([^)\s]+)\)/g)]
    .map((match) => ({ target: match[1] ? resolve(dirname(file), match[1]) : file, anchor: match[2]!, from: relative(root, file) }))
    .filter(({ target, anchor }) => target.endsWith(".md") && (!existsSync(target) || !anchors(target).has(anchor)))
    .map(({ target, anchor, from }) => `${from} -> ${relative(root, target)}#${anchor}`));
  assert.deepEqual(broken, []);
});

test("no heading in docs/ carries the version that added it, so its anchor outlives the version", () => {
  const versioned = docs.flatMap((file) => headings(file).filter((h) => /\(\d+\.\d+\.\d+\)\s*$/.test(h)).map((h) => `${relative(root, file)}: ${h}`));
  assert.deepEqual(versioned, []);
});

test("the changelog has one entry per version, newest first, and the newest is src/version.ts", () => {
  const versions = entries().map((entry) => entry.version);
  assert.equal(versions[0], version);
  for (const v of versions) assert.match(v, /^\d+\.\d+\.\d+$/);
  const unordered = versions.filter((v, i) => i > 0 && compare(versions[i - 1]!, v) <= 0);
  assert.deepEqual(unordered, []);
});

test("only the changelog says what an older control plane does, and only above the CLI's floor", () => {
  const elsewhere = docs.filter((file) => file !== changelogFile && /A control plane older than \d/.test(read(file))).map((file) => relative(root, file));
  assert.deepEqual(elsewhere, []);
  const belowFloor = [...read(changelogFile).matchAll(/A control plane older than (\d+\.\d+\.\d+)/g)]
    .map((match) => match[1]!)
    .filter((v) => compare(v, minControlVersion) <= 0);
  assert.deepEqual(belowFloor, []);
});

test("the docs' type blocks and holds table are the source they name, which node scripts/docs-gen.ts writes", () => {
  for (const doc of generatedDocs) assert.equal(read(doc), generated(read(doc)), relative(root, doc));
});

test("every TypeScript block in docs/cli.md names the declarations it shows, so none is a hand copy", () => {
  assert.equal([...read(cliDoc).matchAll(marker)].length, [...read(cliDoc).matchAll(/^```ts$/gm)].length);
});

test("docs-gen copies a declaration whole, with its TSDoc and its last line's comment", () => {
  const source = [
    "/** Not this. */",
    "export const x = 1;",
    "/** A quote. */",
    'export type Quoted = "say\\";more" | `a;${"b"}`; // trailing',
    "export interface Generic<T = () => void> extends Base<{ a: 1 }> {",
    "  /** } and ; in a comment. */",
    "  value: T; // ;",
    "}",
    "export type After = 1; // last",
  ].join("\n");
  assert.equal(declaration(source, "Quoted"), '/** A quote. */\ntype Quoted = "say\\";more" | `a;${"b"}`; // trailing');
  assert.equal(declaration(source, "Generic"), source.split("\n").slice(4, 8).join("\n").replace("export ", ""));
  assert.equal(declaration(source, "After"), "type After = 1; // last");
  assert.equal(declaration("/** A file's header. */\n\nexport type First = 1;", "First"), "type First = 1;");
  assert.equal(declaration("/** The first type. */\nexport type First = 1;", "First"), "/** The first type. */\ntype First = 1;");
});

/** The rows of the table whose header row starts with `| <first> |`, each as its cells. */
const table = (file: string, first: string) => {
  const rows = new RegExp(`^\\| ${first} \\|.*\\n\\|---.*\\n((?:\\|.*\\n?)*)`, "m").exec(read(file))![1]!.trim().split("\n");
  return rows.map((row) => row.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()));
};
const ticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

test("docs/cli.md's command table has a row for every command, with exactly the flags it parses", () => {
  const global = ["--json", "--url", "--socks"];
  const flags = (text: string) => [...text.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]).filter((flag) => !global.includes(flag));
  const names = Object.keys(commands).sort((a, b) => b.length - a.length);
  const documented = new Map<string, Set<string>>();
  for (const [cell] of table(cliDoc, "Command")) {
    const shown = ticked(cell!)[0];
    if (shown === undefined) continue;
    const name = names.find((n) => shown === n || shown.startsWith(`${n} `));
    assert.ok(name, `no command runs the row ${shown}`);
    documented.set(name, new Set([...documented.get(name) ?? [], ...flags(shown)]));
  }
  const wrong = Object.entries(commands).flatMap(([name, command]) => {
    if (!documented.has(name)) return [`${name}: no row`];
    const parsed = new Set(Object.keys(command.options ?? {}).map((option) => `--${option}`));
    const shown = documented.get(name)!;
    return [...[...parsed].filter((flag) => !shown.has(flag)).map((flag) => `${name}: ${flag} has no row`), ...[...shown].filter((flag) => !parsed.has(flag)).map((flag) => `${name}: ${flag} is not parsed`)];
  });
  assert.deepEqual(wrong, []);
});

test("docs/merge-policy.md's reserved-path table names every path and folder policy.ts reserves, and no src/ path it does not", () => {
  const policy = resolve(root, "docs/merge-policy.md");
  const code = new Map<string, Set<string>>();
  for (const entry of declaration(read(join(root, "src/control/policy.ts")), "reservedPaths").split("{ case: ").slice(2)) {
    const [reserved, ...literals] = [...entry.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
    code.set(reserved!, new Set([...code.get(reserved!) ?? [], ...literals.filter((literal) => /[/.]/.test(literal))]));
  }
  const doc = new Map(table(policy, "Reserved case").map(([name, ...cells]) => {
    const reserved = reservedCases.find((c) => reservedNames[c].endsWith(name!.toLowerCase()));
    assert.ok(reserved, `no reserved case is ${name}`);
    return [reserved, new Set(ticked(cells.join(" ")))] as const;
  }));
  const undocumented = [...code].flatMap(([reserved, paths]) => [...paths].filter((path) => !doc.get(reserved as never)?.has(path)).map((path) => `${reserved}: ${path}`));
  assert.deepEqual(undocumented, []);
  const stale = [...doc].flatMap(([reserved, paths]) => [...paths].filter((path) => path.startsWith("src/") && !code.get(reserved)?.has(path)).map((path) => `${reserved}: ${path}`));
  assert.deepEqual(stale, []);
});

test("docs/data-model.md's records name registry tables and source types that exist", () => {
  const db = openDb(":memory:");
  const tables = new Set(db.sql("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  db.db.close();
  const missing = table(join(root, "docs/data-model.md"), "Record").flatMap(([record, stored, type]) => [
    ...ticked(stored!).filter((name) => !tables.has(name)).map((name) => `${record}: table ${name}`),
    ...[...type!.matchAll(/\[`(\w+)`\]\(\.\.\/([^)]+)\)/g)].flatMap(([, name, file]) => {
      try { declaration(read(join(root, file!)), name!); return []; } catch { return [`${record}: ${file} ${name}`]; }
    }),
  ]);
  assert.deepEqual(missing, []);
});
