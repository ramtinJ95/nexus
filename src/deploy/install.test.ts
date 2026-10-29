import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { checkoutMerged, command, ReleaseInstaller, type InstallBoundary } from "./install.ts";

const commit = "a".repeat(40);
async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t: TestContext) {
  const prefix = await directory(t);
  await mkdir(join(prefix, "releases", "old"), { recursive: true });
  await mkdir(join(prefix, "releases", commit));
  await symlink("releases/old", join(prefix, "control-current"));
  await symlink("releases/old", join(prefix, "current"));
  const calls: string[] = [];
  const boundary: InstallBoundary = {
    async prepare(hash) { calls.push(`prepare:${hash}`); return `releases/${hash}`; },
    async restart(role) { calls.push(`restart:${role}`); },
    async healthy(role) { calls.push(`healthy:${role}`); return true; },
    async journal(role) { calls.push(`journal:${role}`); return "service failed to bind"; },
  };
  return { prefix, calls, boundary, installer: new ReleaseInstaller(prefix, "control", boundary) };
}

test("a healthy install switches only its role's link and records the full commit", async (t) => {
  const { prefix, calls, installer } = await fixture(t);
  const result = await installer.install(commit);
  assert.equal(result.state, "healthy");
  assert.equal(result.commit, commit);
  assert.equal(await readlink(join(prefix, "control-current")), `releases/${commit}`);
  assert.equal(await readlink(join(prefix, "current")), "releases/old");
  assert.deepEqual(calls, [`prepare:${commit}`, "restart:control", "healthy:control"]);
  assert.deepEqual(await installer.observed(), result);
});

test("failed health rolls back, keeps journal tail, and does not retry the bad release", async (t) => {
  const { prefix, boundary, installer } = await fixture(t);
  boundary.healthy = async () => await readlink(join(prefix, "control-current")) === "releases/old";
  const result = await installer.install(commit);
  assert.equal(result.state, "rolled-back");
  assert.match(result.reason!, /health check failed\nservice failed to bind/);
  assert.equal(await readlink(join(prefix, "control-current")), "releases/old");
  boundary.prepare = async () => { throw new Error("must not retry"); };
  assert.deepEqual(await installer.install(commit), result);
});

test("restart failure also restores the previous release", async (t) => {
  const { prefix, boundary, installer } = await fixture(t);
  boundary.restart = async () => {
    if (await readlink(join(prefix, "control-current")) !== "releases/old") throw new Error("restart failed");
  };
  assert.equal((await installer.install(commit)).state, "rolled-back");
});

test("a failed rollback is not reported as a successful rollback", async (t) => {
  const { boundary, installer } = await fixture(t);
  boundary.healthy = async () => false;
  boundary.journal = async () => { throw new Error("no journal"); };
  const result = await installer.install(commit);
  assert.equal(result.state, "failed");
  assert.match(result.reason!, /journal unavailable\nrollback failed: Error: previous release is not healthy/);
});

test("a process interrupted around the link swap recovers from its persistent transaction", async (t) => {
  const { prefix, boundary } = await fixture(t);
  for (const switched of [false, true]) {
    await writeFile(join(prefix, "control-deploy.json"), JSON.stringify({
      commit, previous: "releases/old", target: `releases/${commit}`, state: "installing", reason: null,
    }));
    if (switched) {
      await rm(join(prefix, "control-current"));
      await symlink(`releases/${commit}`, join(prefix, "control-current"));
    }
    const restarted = new ReleaseInstaller(prefix, "control", boundary);
    assert.equal((await restarted.recover()).state, "rolled-back");
    assert.equal(await readlink(join(prefix, "control-current")), "releases/old");
  }
});

test("a preparation failure never touches the running release", async (t) => {
  const { prefix, boundary, installer } = await fixture(t);
  boundary.prepare = async () => { throw new Error("build failed"); };
  await assert.rejects(installer.install(commit), /build failed/);
  assert.equal(await readlink(join(prefix, "control-current")), "releases/old");
  assert.equal(await installer.observed(), null);
});

test("git accepts merged commits, refuses a fetched non-main commit, and rejects revisions before running git", async (t) => {
  const dir = await directory(t);
  const remote = join(dir, "remote");
  const clone = join(dir, "clone");
  await mkdir(remote);
  const git = (args: string[]) => command("git", args, remote);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["commit", "--allow-empty", "-m", "initial"]);
  const merged = await git(["rev-parse", "HEAD"]);
  await checkoutMerged(clone, merged, command, remote);
  assert.equal(await command("git", ["rev-parse", "HEAD"], clone), merged);
  await git(["checkout", "-b", "unmerged"]);
  await git(["commit", "--allow-empty", "-m", "unmerged"]);
  const unmerged = await git(["rev-parse", "HEAD"]);
  await command("git", ["fetch", remote, "unmerged"], clone);
  await assert.rejects(checkoutMerged(clone, unmerged, command, remote), /not an ancestor of origin\/main/);
  assert.equal(await command("git", ["rev-parse", "HEAD"], clone), merged);
  for (const revision of ["main", "--upload-pack=evil", "../elsewhere", "a".repeat(39)]) {
    await assert.rejects(checkoutMerged(clone, revision, async () => { assert.fail("git must not run"); }), /full lower-case commit hash/);
  }
});

test("a failed final idle fence never switches or restarts the running release", async (t) => {
  const { prefix, boundary, installer, calls } = await fixture(t);
  boundary.beforeSwitch = async () => { throw new Error("new turn entered after lease expiry"); };
  await assert.rejects(installer.install(commit), /new turn entered/);
  assert.equal(await readlink(join(prefix, "control-current")), "releases/old");
  assert.deepEqual(calls, [`prepare:${commit}`]);
  assert.equal(await installer.observed(), null);
});

test("deployment child commands include the administrative paths the probe installer needs", async (t) => {
  const dir = await directory(t);
  const path = await command(process.execPath, ["-p", "process.env.PATH"], dir);
  assert.deepEqual(path.split(":"), ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]);
});

test("an install leaves its journal as the transaction's JSON, private to its owner, with no temporary file beside it", async (t) => {
  const { prefix, installer } = await fixture(t);
  const before = new Set(await readdir(prefix));
  const result = await installer.install(commit);
  assert.deepEqual(JSON.parse(await readFile(join(prefix, "control-deploy.json"), "utf8")), result);
  assert.equal((await stat(join(prefix, "control-deploy.json"))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(prefix)).filter((name) => !before.has(name)), ["control-deploy.json"]);
});

test("a journal that is not JSON is refused rather than read as no deployment", async (t) => {
  const { prefix, installer } = await fixture(t);
  await writeFile(join(prefix, "control-deploy.json"), "{\"commit\":");
  await assert.rejects(installer.observed(), SyntaxError);
  await assert.rejects(installer.install(commit), SyntaxError);
});

/** Each file under `root`, with its bytes, mode, owner and modification time. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await Promise.all((await readdir(root, { recursive: true })).map(async (name) => {
    const s = await stat(join(root, name));
    return s.isDirectory() ? [] : [[name, `${(await readFile(join(root, name))).toString("base64")} ${(s.mode & 0o777).toString(8)} ${s.uid}:${s.gid} ${s.mtimeMs}`]];
  }));
  return Object.fromEntries(entries.flat());
}

/**
 * The role installers of this checkout, run as the deployer runs them, with stdin open and never written. Only what
 * needs root is stood in for: release.sh's helpers, and every command that changes the system, which logs instead.
 */
async function roleInstallers(t: TestContext) {
  const dir = await directory(t);
  const root = join(dir, "root");
  const etc = join(root, "etc", "nexus");
  const checkout = join(dir, "checkout");
  const shims = join(dir, "bin");
  const log = join(dir, "log");
  const real = resolve(import.meta.dirname, "../..");
  await mkdir(join(checkout, "deploy"), { recursive: true });
  await mkdir(join(root, "opt", "nexus", "deployer"), { recursive: true });
  for (const name of ["install-control.sh", "install-probe.sh", "secrets.example.env", "nexus-control.service", "nexus-probe.service"]) {
    await copyFile(join(real, "deploy", name), join(checkout, "deploy", name));
  }
  await writeFile(join(checkout, "deploy", "release.sh"), `. "${real}/deploy/release.sh"
prefix="${root}/opt/nexus"
etc="${etc}"
install_release() { release=test; echo install_release >>"${log}"; }
link_release() { echo "link_release $*" >>"${log}"; }
install_unit() { echo "install_unit $2" >>"${log}"; }
start_unit() { echo "start_unit $1" >>"${log}"; }
make_state() { echo "make_state $1" >>"${log}"; }
`);
  await mkdir(shims);
  for (const name of ["id", "useradd", "usermod", "tailscale", "install", "chown", "rm", "getent", "groupdel", "systemctl", "flock", "runuser", "node", "ssh-keygen", "ssh-keyscan", "journalctl"]) {
    await writeFile(join(shims, name), `#!/bin/sh\necho "${name} $*" >>"${log}"\n${name === "id" ? '[ "$1" != -u ] || echo 0\n' : name === "getent" ? "exit 2\n" : ""}`, { mode: 0o755 });
  }

  const credential = async (path: string, text: string, mode: number) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text, { mode });
    await chmod(path, mode);
  };
  const harness = join(root, "var", "lib", "nexus-control", "harness-credentials.json");
  await credential(join(etc, "control.json"), `${JSON.stringify({ harness: { credentials: harness }, github: { tokenFile: join(etc, "github-token") } })}\n`, 0o644);
  await credential(harness, `${JSON.stringify({ deviceId: "8c1c3a51-7d5e-4a8e-9a43-2b1f4c1e0d9a", credentials: { openai: { type: "oauth" } } })}\n`, 0o600);
  await credential(join(etc, "secrets.env"), "CLAUDE_CODE_OAUTH_TOKEN=a\nGH_TOKEN=b\n", 0o640);
  await credential(join(etc, "github-token"), "b\n", 0o640);
  await credential(join(etc, "git_ed25519"), "a key\n", 0o400);
  await credential(join(etc, "git_known_hosts"), "github.com ssh-ed25519 AAAA\n", 0o644);

  const run = (role: "control" | "probe", prepare: boolean) => new Promise<{ code: number | null; timedOut: boolean; stderr: string }>((done) => {
    const env = { PATH: `${shims}:${process.env.PATH}`, ...prepare ? { NEXUS_PREPARE: "1", NEXUS_COMMIT: commit } : {} };
    const child = spawn("bash", [join(checkout, "deploy", `install-${role}.sh`)], { env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      done({ code, timedOut: code === null, stderr });
    });
  });
  return { root, etc, run, ran: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n") };
}

test("the deployer's preparation runs both role installers without reading input, and changes no credential", async (t) => {
  const m = await roleInstallers(t);
  const before = await snapshot(m.root);
  for (const role of ["control", "probe"] as const) {
    const result = await m.run(role, true);
    assert.deepEqual([result.code, result.timedOut], [0, false], result.stderr);
  }
  assert.deepEqual(await snapshot(m.root), before);
  const ran = await m.ran();
  assert.ok(!ran.some((line) => /^(node|runuser|ssh-keygen|ssh-keyscan|systemctl (re)?start|start_unit|link_release)\b/.test(line)), ran.join("\n"));
  const credentials = /secrets\.env|github-token|git_ed25519|git_known_hosts|harness-credentials/;
  assert.deepEqual(ran.filter((line) => credentials.test(line)), [`chown root:nexus ${m.etc}/secrets.env`], "only the owner secrets.env must already have");
});

test("outside preparation the same stand-ins see the role installers switch and start their services", async (t) => {
  const m = await roleInstallers(t);
  const result = await m.run("probe", false);
  assert.equal(result.code, 0, result.stderr);
  const ran = await m.ran();
  assert.ok(ran.includes(`link_release ${m.root}/opt/nexus/current`), ran.join("\n"));
  assert.ok(ran.includes("start_unit nexus-probe.service"), ran.join("\n"));
});
