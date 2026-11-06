/**
 * The repo paths that something outside the import graph names: systemd units, installers, the merge policy, the
 * deployer and the docs. A file move breaks none of them at typecheck, so each is checked here. The reserved cases
 * each tracked file can hold for, and the files that reach into the pylon-vm fork, are pinned in
 * contracts.snapshot.json. NEXUS_UPDATE_CONTRACTS=1 rewrites it, and the diff shows what a change moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { headHolds } from "./control/policy.ts";
import { testReview } from "./control/test-kit.ts";

const root = resolve(import.meta.dirname, "..");
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
const trackedSet = new Set(tracked);
const read = (path: string) => readFileSync(join(root, path), "utf8");
const isTracked = (path: string) => trackedSet.has(path) || tracked.some((file) => file.startsWith(path.endsWith("/") ? path : `${path}/`));
const missing = (paths: Iterable<string>) => [...new Set(paths)].filter((path) => !isTracked(path));

const snapshotFile = join(import.meta.dirname, "contracts.snapshot.json");
const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as Record<string, string[]>;
const updating = process.env["NEXUS_UPDATE_CONTRACTS"] === "1";
/** Fails with the lines `actual` adds to or drops from the snapshot's `key`, or writes them when updating. */
const pinned = (key: string, actual: string[]) => {
  const was = snapshot[key] ?? [];
  snapshot[key] = actual;
  if (updating) return writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  const changed = [...actual.filter((line) => !was.includes(line)).map((line) => `+ ${line}`), ...was.filter((line) => !actual.includes(line)).map((line) => `- ${line}`)];
  assert.deepEqual(changed, [], `${key} moved. If that is meant, rerun with NEXUS_UPDATE_CONTRACTS=1 and review the snapshot's diff`);
};

/** Type-only imports are erased when Node strips types, so they load nothing. */
const typeOnly = /\b(?:import|export)\s+type\s[^;]*?\bfrom\s*["'][^"']+["']/g;
const specifiers = (source: string, types: boolean) =>
  [...(types ? source : source.replace(typeOnly, "")).matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]!);

/** The repo files `entry` loads at run time, and the packages it names outside the repo. */
function closure(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of specifiers(read(file), false)) {
      if (specifier.startsWith(".")) walk(relative(root, resolve(root, dirname(file), specifier)));
      else packages.add(`${file} imports ${specifier}`);
    }
  };
  walk(entry);
  return { files: [...files].sort(), packages: [...packages] };
}

/** Where a script or unit names a repo path: bare, under a shell variable such as $repo, or under an installed release. */
const repoPath = /(?:(?<![\w.$/-])|(?:\$\{?\w+\}?|\/opt\/nexus)(?:\/[\w.-]+)*?\/)((?:src|deploy|images)\/[\w./-]*\w)/g;

test("every repo path a unit, installer or deploy script names is tracked", () => {
  const named = tracked.filter((file) => file.startsWith("deploy/")).flatMap((file) => [...read(file).matchAll(repoPath)].map((match) => match[1]!));
  assert.ok(named.includes("src/control/main.ts") && named.includes("src/deploy/worker.ts"), named.join(" "));
  assert.deepEqual(missing(named), []);
});

test("every path code names inside an installed release is tracked", () => {
  const named = tracked.filter((file) => /^(src|images)\/.*\.[jt]s$/.test(file))
    .flatMap((file) => [...read(file).matchAll(/\/opt\/nexus\/[\w-]+\/((?:src|deploy|images)\/[\w./-]*\w)/g)].map((match) => match[1]!));
  assert.ok(named.includes("src/control/login.ts") && named.includes("src/control/backup.ts"), named.join(" "));
  assert.deepEqual(missing(named), []);
});

test("every path the merge policy names is a tracked file or folder", () => {
  const named = [...read("src/control/policy.ts").matchAll(/"([\w.-]*\/[\w./-]*|[\w-]+\.json)"/g)].map((match) => match[1]!).filter((path) => !path.startsWith("./"));
  assert.ok(named.includes("src/probe/redact.ts") && named.includes(".nexus/check"), named.join(" "));
  assert.deepEqual(missing(named), []);
});

test("every relative link in the repo's markdown names a tracked file or folder", () => {
  // The notices quote third-party packages, whose links name files in those packages.
  const docs = tracked.filter((file) => file.endsWith(".md") && file !== "THIRD_PARTY_NOTICES.md");
  const links = docs.flatMap((doc) => [...read(doc).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!.split("#")[0]!).filter((target) => target !== "" && !/^[a-z][a-z+.-]*:/i.test(target))
    .map((target) => ({ doc, path: relative(root, resolve(root, dirname(doc), decodeURI(target))) })));
  assert.ok(links.length > 200, `${links.length} links`);
  assert.deepEqual(links.filter(({ path }) => !isTracked(path)).map(({ doc, path }) => `${doc} -> ${path}`), []);
});

test("the modules other processes load as they are import nothing, so they need no node_modules or neighbours", () => {
  for (const file of ["src/control/schema.ts", "images/pylon/nexus-contract.ts", "images/pylon/agent-setup/manifest.ts"]) {
    assert.deepEqual(specifiers(read(file), true), [], file);
  }
});

test("the deployer reads the migrations of another release's src/control/schema.ts, which loads alone", async () => {
  assert.match(read("src/deploy/worker.ts"), /"src\/control\/schema\.ts"/);
  const dir = mkdtempSync(join(tmpdir(), "nexus-schema-"));
  try {
    mkdirSync(join(dir, "src/control"), { recursive: true });
    cpSync(join(root, "src/control/schema.ts"), join(dir, "src/control/schema.ts"));
    const alone = (await import(join(dir, "src/control/schema.ts"))) as { migrations: readonly string[] };
    const { migrations } = await import("./control/schema.ts");
    assert.equal(alone.migrations.length, migrations.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("what runs without node_modules imports only Node's builtins", () => {
  // The bootstrap deployer runs worker.ts, and deploy/install.sh and release.sh run setup.ts and control-plane.ts
  // from a checkout or release before npm ci.
  for (const entry of ["src/deploy/worker.ts", "src/deploy/setup.ts", "src/deploy/control-plane.ts"]) {
    const { packages } = closure(entry);
    assert.deepEqual(packages.filter((line) => !isBuiltin(line.split(" imports ")[1]!)), [], entry);
  }
});

test("install-deployer.sh copies every file the bootstrap worker loads", () => {
  const script = read("deploy/install-deployer.sh");
  const [, list, skip] = /^for source in (.+); do\n {2}\[\[ "\$source" = (\S+) \]\] \|\| install /m.exec(script) ?? assert.fail("the copy loop comes from the script");
  const copied = execFileSync("bash", ["-c", `for source in ${list}; do [[ "$source" = ${skip} ]] || echo "$source"; done`], { cwd: root, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(closure("src/deploy/worker.ts").files.filter((file) => !copied.includes(file)), []);
});

test("health.ts reads the release-commit file release.sh writes at the release's root", () => {
  assert.match(read("deploy/release.sh"), /> "\$staging\/release-commit"/);
  const dir = mkdtempSync(join(tmpdir(), "nexus-release-commit-"));
  try {
    const { files } = closure("src/deploy/health.ts");
    for (const file of files) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      cpSync(join(root, file), join(dir, file));
    }
    writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
    const commit = "c".repeat(40);
    writeFileSync(join(dir, "release-commit"), `${commit}\n`);
    const script = `const { runningCommit } = await import(${JSON.stringify(join(dir, "src/deploy/health.ts"))}); process.stdout.write(String(runningCommit));`;
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, encoding: "utf8" }), commit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the reserved cases each tracked file can hold a landing for are the snapshot's", () => {
  const review = testReview();
  const cases = tracked.map((path) => ({ path, codes: headHolds({ review, nexus: true, files: [{ path, previous: null, patch: "" }] }).map((hold) => hold.code).sort() }))
    .filter(({ codes }) => codes.length > 0).map(({ path, codes }) => `${path}: ${codes.join(" ")}`);
  assert.ok(cases.includes("src/probe/redact.ts: reserved-path:auth reserved-path:secrets"), cases.join("\n"));
  pinned("holdsByPath", cases);
});

test("the files outside src/pylon-vm that import the fork are the snapshot's", () => {
  const importers = tracked.filter((file) => /^(src|images)\/.*\.[jt]s$/.test(file) && !file.startsWith("src/pylon-vm/") && !/\.test\.[jt]s$/.test(file))
    .filter((file) => specifiers(read(file), true).some((specifier) => specifier.startsWith(".") && relative(root, resolve(root, dirname(file), specifier)).startsWith("src/pylon-vm/")));
  assert.ok(importers.includes("src/pylon-vm-backend.ts"), importers.join(" "));
  pinned("pylonVmImporters", importers);
});
