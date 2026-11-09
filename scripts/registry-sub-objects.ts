/**
 * The codemod that moved the registry's stores off the flat Registry onto sub-objects: the thread store family in U102,
 * the rest in U103, whose stores the map below names. Run on the tree before U103, `node scripts/registry-sub-objects.ts`
 * rewrites every caller: `registry.node(name)` becomes `registry.nodes.node(name)`, a destructured member moves into its store's pattern, and a `Pick<Registry, ...>`
 * or `Registry["x"]` names the store. It finds members through the type checker, so a `thread` that is not the
 * registry's is left alone. registry.ts, and an object literal that stands in for registry members without spreading
 * one, are edited by hand.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { API } from "typescript/unstable/sync";
import { isBindingElement, isIdentifier, isIndexedAccessTypeNode, isLiteralTypeNode, isMethodDeclaration, isObjectBindingPattern, isObjectLiteralExpression, isPropertyAssignment, isShorthandPropertyAssignment, isSpreadAssignment, isPropertyAccessExpression, isQualifiedName, isStringLiteral, isTypeAliasDeclaration, isTypeReferenceNode, isUnionTypeNode, type Node, type SourceFile } from "typescript/unstable/ast";

const root = process.cwd();
const stores: Record<string, string> = {
  "src/control/placement-model.ts": "placement",
  "src/control/planning-store.ts": "planning",
  "src/control/judgment-store.ts": "judgments",
  "src/control/release-store.ts": "releases",
  "src/control/health-store.ts": "health",
  "src/control/node-store.ts": "nodes",
  "src/control/node-metrics-store.ts": "nodeMetrics",
  "src/control/project-store.ts": "projects",
  "src/control/pipeline-store.ts": "pipeline",
  "src/control/image-store.ts": "images",
};
/** The thread store family moved in U102; its files read the stores above through their own types, not the registry. */
const familyFiles = ["src/control/thread-store.ts", "src/control/claude-worker.ts", "src/control/review-store.ts", "src/control/question-store.ts",
  "src/control/nudge-store.ts", "src/control/pr-watch-store.ts", "src/control/queue-store.ts", "src/control/usage-store.ts"];

const api = new API({ cwd: root });
const project = api.updateSnapshot({ openProject: "tsconfig.json" }).getProjects()[0]!;
const { checker, program } = project;
const registryFile = program.getSourceFile(`${root}/src/control/registry.ts`)!;
let alias: Node | undefined;
registryFile.forEachChild((n) => { if (isTypeAliasDeclaration(n) && n.name.text === "Registry") alias = n.name; });
const members = checker.getPropertiesOfType(checker.getTypeAtLocation(alias!)!);

/** Each family member's declaration, keyed by file and node index, to the sub-object it moves to. */
const storeOf = new Map<string, string>();
const storeByName = new Map<string, string>();
for (const m of members) {
  // The registry's clock, which every store's caller reads, stays on the registry.
  if (m.name === "now") continue;
  for (const d of m.declarations) {
    const store = stores[relative(root, d.path)];
    if (store === undefined) continue;
    storeOf.set(`${d.path}#${d.index}`, store);
    storeByName.set(m.name, store);
  }
}

function familyStore(name: Node): string | undefined {
  const symbol = checker.getSymbolAtLocation(name);
  for (const d of symbol?.declarations ?? []) {
    const store = storeOf.get(`${d.path}#${d.index}`);
    if (store !== undefined) return store;
  }
  return undefined;
}

/** A replacing edit renders the nodes it keeps through `render`, which applies the edits inside them. */
interface Edit { start: number; end: number; text: string | ((render: (n: Node) => string) => string) }

function rewrite(sf: SourceFile): Edit[] {
  const edits: Edit[] = [];
  const visit = (n: Node): void => {
    const name = isPropertyAccessExpression(n) ? n.name : isQualifiedName(n) ? n.right : undefined;
    if (name !== undefined && isIdentifier(name)) {
      const store = familyStore(name);
      if (store !== undefined) edits.push({ start: name.getStart(sf), end: name.getStart(sf), text: `${store}.` });
    } else if (isObjectLiteralExpression(n)) {
      edits.push(...overrides(sf, n));
    } else if (isObjectBindingPattern(n)) {
      edits.push(...binding(sf, n));
    } else if (isTypeReferenceNode(n) && n.typeName.getText(sf) === "Pick" && n.typeArguments?.[0]?.getText(sf) === "Registry") {
      edits.push(...pick(sf, n.typeArguments[1]!));
    } else if (isIndexedAccessTypeNode(n) && n.objectType.getText(sf) === "Registry" && isLiteralTypeNode(n.indexType) && isStringLiteral(n.indexType.literal)) {
      const store = storeByName.get(n.indexType.literal.text);
      if (store !== undefined) edits.push({ start: n.objectType.end, end: n.objectType.end, text: `["${store}"]` });
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return edits;
}

/** `{ node, thread, appendEvent: append }` becomes `{ node, threads: { thread, appendEvent: append } }`. */
function binding(sf: SourceFile, pattern: Node & { elements: readonly Node[] }): Edit[] {
  const moved = new Map<string, Node[]>();
  const kept: Node[] = [];
  for (const e of pattern.elements) {
    if (!isBindingElement(e)) return [];
    const key = e.propertyName ?? e.name;
    const store = isIdentifier(key) ? familyStore(key) : undefined;
    if (store === undefined) kept.push(e);
    else moved.set(store, [...moved.get(store) ?? [], e]);
  }
  if (moved.size === 0) return [];
  return [{ start: pattern.getStart(sf), end: pattern.end, text: (render) =>
    `{ ${[...kept.map(render), ...[...moved].map(([store, names]) => `${store}: { ${names.map(render).join(", ")} }`)].join(", ")} }` }];
}

/**
 * `{ ...registry, thread: spy }` becomes `{ ...registry, threads: { ...registry.threads, thread: spy } }`, since a
 * caller now reads the member off the store. A member counts when the spread object has it.
 */
function overrides(sf: SourceFile, literal: Node & { properties: readonly Node[] }): Edit[] {
  const spread = literal.properties.find(isSpreadAssignment);
  if (spread === undefined) return [];
  const type = checker.getTypeAtLocation(spread.expression);
  if (type === undefined) return [];
  const moved = new Map<string, Node[]>();
  for (const p of literal.properties) {
    if (!(isPropertyAssignment(p) || isShorthandPropertyAssignment(p) || isMethodDeclaration(p)) || !isIdentifier(p.name)) continue;
    const member = checker.getPropertyOfType(type, p.name.text);
    const store = member?.declarations.map((d) => storeOf.get(`${d.path}#${d.index}`)).find((s) => s !== undefined);
    if (store !== undefined) moved.set(store, [...moved.get(store) ?? [], p]);
  }
  const edits: Edit[] = [];
  for (const [store, props] of moved) {
    const [first, ...rest] = props;
    edits.push({ start: first!.getStart(sf), end: first!.end, text: (render) => `${store}: { ...${render(spread.expression)}.${store}, ${props.map(render).join(", ")} }` });
    for (const p of rest) {
      const i = literal.properties.indexOf(p);
      edits.push({ start: literal.properties[i - 1]!.end, end: p.end, text: "" });
    }
  }
  return edits;
}

/** Each family key in the union gives way to its store's key, at the place of the first. */
function pick(sf: SourceFile, keys: Node): Edit[] {
  const literals = isUnionTypeNode(keys) ? keys.types : [keys];
  const names = literals.map((l) => isLiteralTypeNode(l) && isStringLiteral(l.literal) ? l.literal.text : undefined);
  if (names.some((n) => n === undefined) || !names.some((n) => storeByName.has(n!))) return [];
  const out: string[] = [];
  for (const n of names as string[]) {
    const key = storeByName.get(n) ?? n;
    if (!out.includes(key)) out.push(key);
  }
  return [{ start: keys.getStart(sf), end: keys.end, text: out.map((k) => `"${k}"`).join(" | ") }];
}

const skip = new Set(["src/control/registry.ts", ...Object.keys(stores), ...familyFiles]);
let changed = 0;
for (const fileName of program.getSourceFileNames()) {
  const path = relative(root, fileName);
  if (path.startsWith("..") || path.includes("node_modules") || skip.has(path)) continue;
  const sf = program.getSourceFile(fileName)!;
  const edits = rewrite(sf);
  if (edits.length === 0) continue;
  const source = readFileSync(fileName, "utf8");
  // The outermost edits within [start, end), less one that spans it, which is the edit rendering it.
  const outermost = (start: number, end: number) => {
    const inside = edits.filter((e) => e.start >= start && e.end <= end && e.start < end && !(e.start === start && e.end === end));
    return inside.filter((e) => !inside.some((r) => r !== e && r.end > r.start && e.start >= r.start && e.end <= r.end && e.start < r.end));
  };
  const apply = (start: number, end: number): string => {
    let text = source.slice(start, end);
    for (const e of outermost(start, end).sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start - start) + (typeof e.text === "string" ? e.text : e.text(render)) + text.slice(e.end - start);
    }
    return text;
  };
  const render = (n: Node) => apply(n.getStart(sf), n.end);
  writeFileSync(fileName, apply(0, source.length));
  changed++;
  console.log(`${path}: ${edits.length}`);
}
console.log(`${changed} files`);
api.close();
