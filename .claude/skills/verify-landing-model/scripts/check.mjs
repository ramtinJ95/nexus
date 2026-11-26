#!/usr/bin/env node
// Runs every check of the landing model with a pinned TLC and compares each result with what coverage.json expects.
// Exit code 0: every check gave the expected result. 1: a check differs. 2: the checks could not run.
// 3: the checks are as expected, but a covered file is not what the model was last confirmed against.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = join(skill, "model");
const coverage = JSON.parse(readFileSync(join(skill, "coverage.json"), "utf8"));

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

function java() {
  const bin = process.env.JAVA ?? "java";
  const probe = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) fail(`No Java found as "${bin}". TLC needs Java 11 or later. Install one, or set JAVA to a java binary.`);
  const major = Number(/version "(\d+)/.exec(probe.stderr + probe.stdout)?.[1] ?? 0);
  if (major < 11) fail(`"${bin}" is Java ${major}. TLC needs Java 11 or later. Set JAVA to a newer java binary.`);
  return bin;
}

async function jar() {
  if (process.env.TLA2TOOLS) return process.env.TLA2TOOLS;
  const { version, url, sha256 } = coverage.tlc;
  const dir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "nexus-verify-landing-model");
  const file = join(dir, `tla2tools-${version}.jar`);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (existsSync(file) && digest(readFileSync(file)) === sha256) return file;
  console.error(`Downloading TLC ${version} to ${file}`);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    fail(`Could not download ${url}: ${error.cause?.message ?? error.message}. A pylon's network allows only the hosts its project lists. Run this on a machine that reaches github.com, or set TLA2TOOLS to a copy of tla2tools.jar ${version}.`);
  }
  if (!response.ok) fail(`Could not download ${url}: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== sha256) fail(`${url} has SHA-256 ${digest(bytes)}, not the pinned ${sha256}. Nothing was saved.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.part`, bytes);
  renameSync(`${file}.part`, file);
  return file;
}

/** The rules TLC says broke in one run: each invariant it names, and NoDeadlock for a state with no step out. */
function broken(output) {
  const rules = new Set([...output.matchAll(/Invariant (\w+) is violated/g)].map((m) => m[1]));
  if (/Deadlock reached/.test(output)) rules.add("NoDeadlock");
  return [...rules].sort();
}

const digestOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The repository's root, or null outside a git checkout. */
function root() {
  const top = spawnSync("git", ["-C", skill, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return top.status === 0 ? top.stdout.trim() : null;
}

/** The covered files whose content is not what the model was last confirmed against. */
function changed(top) {
  return Object.entries(coverage.covers).filter(([file, digest]) => !existsSync(join(top, file)) || digestOf(join(top, file)) !== digest).map(([file]) => file);
}

function drift(top, files) {
  if (files.length === 0) return "The covered files are as they were when the model was last confirmed to describe them.";
  const log = spawnSync("git", ["-C", top, "log", "--oneline", `${coverage.syncCommit}..HEAD`, "--", ...files], { encoding: "utf8" });
  const commits = log.status !== 0 || log.stdout.trim() === "" ? [] : log.stdout.trim().split("\n");
  return [
    "The covered code changed since the model was last confirmed to describe it. A pass below proves the rules for the code only if the model still describes it:",
    ...files.map((f) => `  ${f}`),
    ...commits.length ? [`Commits since ${coverage.syncCommit.slice(0, 12)} that touched them:`, ...commits.slice(0, 20).map((c) => `  ${c}`), ...commits.length > 20 ? [`  and ${commits.length - 20} more`] : []] : [],
    "Read SKILL.md, \"When you change covered code\".",
  ].join("\n");
}

const top = root();
if (top === null) fail("This is no git checkout, so the script cannot find the covered files.");

// Records the covered files as confirmed: their digests, and the commit of the release branch they build on.
if (process.argv.includes("--confirm")) {
  for (const file of Object.keys(coverage.covers)) coverage.covers[file] = digestOf(join(top, file));
  const base = spawnSync("git", ["-C", top, "merge-base", "HEAD", "origin/main"], { encoding: "utf8" });
  if (base.status === 0) coverage.syncCommit = base.stdout.trim();
  writeFileSync(join(skill, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
  console.log(`Recorded the covered files as confirmed, on top of ${coverage.syncCommit.slice(0, 12)}. Run the check again.`);
  process.exit(0);
}

const javaBin = java();
const jarFile = await jar();
const out = mkdtempSync(join(tmpdir(), "landing-model-"));
let differs = 0;
const drifted = changed(top);
console.log(drift(top, drifted));
console.log("");
for (const check of coverage.checks) {
  const name = check.config.replace(/\.cfg$/, "");
  const run = spawnSync(javaBin, [
    "-XX:+UseParallelGC", `-Djava.io.tmpdir=${out}`, "-cp", jarFile, "tlc2.TLC",
    "-config", check.config, "-workers", "1", "-metadir", join(out, `${name}.states`), "Landing.tla",
  ], { cwd: model, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const output = `${run.stdout}${run.stderr}`;
  writeFileSync(join(out, `${name}.out`), output);
  const rules = broken(output);
  const finished = /Model checking completed|Invariant \w+ is violated|Deadlock reached/.test(output);
  const states = /(\d[\d,]*) distinct states found/.exec(output)?.[1] ?? "?";
  const expected = check.breaks ?? [];
  const same = finished && JSON.stringify(rules) === JSON.stringify([...expected].sort());
  if (!same) differs++;
  const got = !finished ? "TLC did not finish" : rules.length ? `breaks ${rules.join(", ")}` : "every rule holds";
  const want = expected.length ? `breaks ${expected.join(", ")}${check.finding ? ` (finding ${check.finding})` : ""}` : "every rule holds";
  console.log(`${same ? "as expected" : "DIFFERS    "}  ${check.config}: ${got}${same ? "" : `, expected: ${want}`}  [${states} states]`);
  console.log(`             ${check.says}`);
}
console.log("");
if (differs > 0) {
  console.log(`${differs} check${differs === 1 ? " differs" : "s differ"}. TLC's output for each run is in ${out}. Read SKILL.md, "When a check differs".`);
  process.exit(1);
}
if (drifted.length > 0) {
  console.log("Every check gave the expected result, but the covered code changed. Once the model describes it, run this script with --confirm.");
  process.exit(3);
}
console.log("Every check gave the expected result.");
