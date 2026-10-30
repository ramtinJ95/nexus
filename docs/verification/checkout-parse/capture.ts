/**
 * Prints what a pylon's agent, the control plane and a person can observe of the code issues #220, #221, #223 and
 * #224 change: a declared diff output, its file and whether it applies, a Changes read, their refusals, the git
 * commands each runs, and the error text of malformed replies and leave-out flags. It imports the checkout given as
 * its argument, so run.sh runs it unchanged against main and against the branch.
 *
 *   node docs/verification/checkout-parse/capture.ts <checkout>
 */
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(process.argv[2] ?? ".");
const src = (path: string) => import(join(root, "src", path));
const work = await mkdtemp(join(tmpdir(), "nexus-capture-"));
const lines: string[] = [];
const say = (line: string) => lines.push(line.replaceAll(work, "<tmp>"));
const section = (title: string) => say(`\n## ${title}`);
const outcome = async (label: string, run: () => Promise<unknown>) => {
  try {
    say(`${label}: resolves ${JSON.stringify(await run())}`);
  } catch (err) {
    say(`${label}: rejects ${(err as Error).constructor.name} ${JSON.stringify((err as Error).message)}`);
  }
};

const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const gitLog = join(work, "git.log");
await mkdir(join(work, "bin"));
await writeFile(join(work, "bin", "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`);
await chmod(join(work, "bin", "git"), 0o755);
Object.assign(process.env, {
  PATH: `${join(work, "bin")}:${process.env.PATH}`,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2026-10-30T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-30T00:00:00Z",
});
/** The git commands run since the last call, each without the checkout's path and the helper's fixed options. */
async function gitRuns(label: string) {
  const runs = (await readFile(gitLog, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  await rm(gitLog, { force: true });
  say(`${label}: ${runs.length} git commands`);
  for (const run of runs) say(`  git ${run.replace(/^-C \S+ /, "").replace("-c core.quotePath=false --literal-pathspecs --no-pager ", "")}`);
}

const run = promisify(execFile);
const home = "/home/user";
const guestHome = join(work, "home");
const checkout = join(guestHome, "workspace", "repo");
const git = async (...args: string[]) => (await run(realGit, ["-C", checkout, ...args])).stdout;

const { fakeGuest } = await src("fake-guest.ts");
const { addOutput, outputsDir } = await src("outputs.ts");
/** Runs each exec on this machine with /home/user moved under the scratch directory, both ways, as outputs.test.ts does. */
const guest = fakeGuest(() => { throw new Error("unused"); });
guest.exec = (argv: readonly string[], { cwd, timeoutMs }: { cwd: string; timeoutMs: number }) => new Promise((done) => {
  const inward = (s: string) => s.replaceAll(home, guestHome);
  execFile(argv[0]!, argv.slice(1).map(inward), { cwd: inward(cwd), timeout: timeoutMs }, (err, stdout, stderr) => {
    const exitCode = err === null ? 0 : typeof err.code === "number" ? err.code : 127;
    done({ exitCode, output: (stdout + stderr).replaceAll(guestHome, home), truncated: false });
  });
});
const declare = () => addOutput(guest, { kind: "diff", title: "capture" });

section("A declared diff of a tree that holds an edit, a rename with an edit, a binary edit, an untracked file and a force-added ignored file");
await mkdir(join(checkout, "src"), { recursive: true });
await git("init", "-q", "--initial-branch=main");
await writeFile(join(checkout, "app.txt"), "one\ntwo\n");
await writeFile(join(checkout, "src", "old.ts"), "export const a = 1;\n".repeat(20));
await writeFile(join(checkout, "pixel.bin"), Buffer.from([0, 1, 2]));
await writeFile(join(checkout, ".gitignore"), "dist/\n*.log\n");
await git("add", "-A");
await git("commit", "-q", "-m", "first");
await git("update-ref", "refs/nexus/base", "HEAD");
// The agent's own config, which must not change what either read says.
await git("config", "diff.renames", "false");
await git("config", "diff.noprefix", "true");
await git("config", "color.diff", "always");
await writeFile(join(checkout, "app.txt"), "one\n2\nthree\n");
await git("mv", "src/old.ts", "src/new.ts");
await writeFile(join(checkout, "src", "new.ts"), "export const a = 1;\n".repeat(19) + "export const b = 2;\n");
await writeFile(join(checkout, "pixel.bin"), Buffer.from([0, 3, 4, 5]));
await writeFile(join(checkout, "notes.md"), "untracked\n");
await mkdir(join(checkout, "dist"));
await writeFile(join(checkout, "dist", "bundle.js"), "ignored\n");
await writeFile(join(checkout, "kept.log"), "force-added\n");
await git("add", "-f", "kept.log");
const indexBefore = await readFile(join(checkout, ".git", "index"));
await rm(gitLog, { force: true });

const output = await declare();
await gitRuns("addOutput diff");
say(`record: ${JSON.stringify({ ...output, id: "<id>" })}`);
say(`record base is HEAD: ${output.base === (await git("rev-parse", "HEAD")).trim()}`);
const file = join(guestHome, outputsDir.slice(home.length + 1), `${output.id}.diff`);
say("diff file:");
for (const line of (await readFile(file, "utf8")).split("\n")) say(`  | ${line}`);
const applied = join(work, "applied");
await git("worktree", "add", "-q", "--detach", applied, output.base);
await outcome("git apply to its base", async () => (await run(realGit, ["apply", file], { cwd: applied })).stdout);
for (const path of ["app.txt", "src/new.ts", "src/old.ts", "pixel.bin", "notes.md", "kept.log", "dist/bundle.js"]) {
  const [want, got] = await Promise.all([readFile(join(checkout, path)).catch(() => null), readFile(join(applied, path)).catch(() => null)]);
  say(`  ${path}: ${want === null ? "absent in the checkout" : "in the checkout"}, ${got === null ? "absent after apply" : want !== null && got.equals(want) ? "same bytes after apply" : "different after apply"}`);
}
await rm(gitLog, { force: true });

section("The Changes view of the same tree");
const { checkoutReader } = await src("checkout-files.ts");
const { processStream } = await src("process-stream.ts");
const open = async (argv: readonly string[]) => processStream(argv[0]!, argv.slice(1), (text: string) => say(`  stderr: ${text.trim()}`));
const reader = checkoutReader(open, checkout);
const changes = await reader.changes("head");
await gitRuns("changes head");
say(`base kind: ${changes.base.kind}, base is HEAD: ${changes.base.commit === (await git("rev-parse", "HEAD")).trim()}`);
for (const f of changes.files) say(`  ${JSON.stringify(f)}`);
say(`agent's index unchanged: ${indexBefore.equals(await readFile(join(checkout, ".git", "index")))}`);
await outcome("changes start", async () => (await reader.changes("start")).files.map((f: { path: string; status: string }) => `${f.status} ${f.path}`));
await rm(gitLog, { force: true });

section("Refusals that name their base kind");
await outcome("blob start missing", () => reader.blob("start", "notes.md"));
await outcome("blob head directory", () => reader.blob("head", "src"));
await outcome("changes turn with no snapshot", () => reader.changes("turn"));
await git("update-ref", "-d", "refs/nexus/base");
await outcome("diff start with no refs/nexus/base", () => reader.diff("start", []));

section("Declared diff refusals");
await git("add", "-A");
await git("commit", "-q", "-m", "everything");
await outcome("a clean tree", declare);
await rm(checkout, { recursive: true });
await mkdir(checkout, { recursive: true });
await git("init", "-q");
await outcome("no commits and no files", declare);
await rm(join(checkout, ".git"), { recursive: true });
await outcome("not a git repository", declare);
await rm(checkout, { recursive: true });
await outcome("no checkout", declare);

section("Malformed guest replies");
const { gitFacts } = await src("git-facts.ts");
await outcome("git facts, not JSON", () => gitFacts(fakeGuest(() => ({ exitCode: 0, output: "bad JSON", truncated: false }))));
await outcome("git facts, wrong shape", () => gitFacts(fakeGuest(() => ({ exitCode: 0, output: "{}", truncated: false }))));
const { readAgentUsage } = await src("agent-usage.ts");
const printing = (reply: string) => async () => processStream("sh", ["-c", `cat > /dev/null; ${reply}`], () => {});
await outcome("agent usage, end record of the wrong shape", () => readAgentUsage(printing("printf '{}'"), new Map(), undefined, 5000));
await outcome("agent usage, a call that is not JSON", () => readAgentUsage(printing(`printf 'x\\n{"offsets":{},"more":false}'`), new Map(), undefined, 5000));

section("Leave-out flags");
const { leaveOuts, parseLeaveOut } = await src("agent-setup.ts");
for (const flag of ["claude-plugin:x", "pi-package:npm:@me/x", "skill:x", "pi-extension:x", "shepherdr-profile:x", "plugin:x", "toString:x"]) {
  await outcome(`--leave-out ${flag}`, async () => parseLeaveOut(flag));
}
say(`settled leave-outs: ${leaveOuts.map((rule: { kind: string; name: string }) => `${rule.kind}:${rule.name}`).join(", ")}`);

await rm(work, { recursive: true, force: true });
console.log(lines.join("\n").trimStart());
